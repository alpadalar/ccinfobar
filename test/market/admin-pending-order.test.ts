import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import {
  entryDocText,
  entrySummaryText,
  type Held,
  heldStatements,
  pendingEntries,
  versionText,
} from '../../src/market/worker/store.js';
import { skipSqlite } from './d1-sqlite.js';
import { makeEnv } from './worker-env.js';
import { seedEntry, seedPublisher, storedEntry } from './worker-seed.js';

const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;
const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-02-01T00:00:00.000Z';
const HELD_AT = '2026-03-01T00:00:00.000Z';

describe.skipIf(skipSqlite)('admin pending order', () => {
  it('lists a held version by its hold time', async () => {
    const { env } = await makeEnv();
    const db = env.DB;
    await seedPublisher(db, { handle: 'alp', githubId: 1, trusted: true });
    await seedPublisher(db, { handle: 'bob', githubId: 2 });
    await seedEntry(db, { id: 'alp/old', versions: [{ content: preset(), at: OLD }] });
    await seedEntry(db, { id: 'bob/new', state: 'pending', versions: [{ content: preset(), at: NEW }] });
    const next = storedEntry({
      id: 'alp/old',
      versions: [
        { content: preset(), at: OLD },
        { content: preset('cwd'), at: HELD_AT },
      ],
    });
    const held: Held = {
      version: 2,
      hash: next.hash,
      at: HELD_AT,
      reason: 'new-link',
      links: ['example.com/x'],
      summary: entrySummaryText(next),
      doc: entryDocText(next),
    };
    await db.batch(
      heldStatements(db, {
        entry: next,
        expected: 1,
        expectedHash: next.versions[0]!.hash,
        body: versionText({ version: 2, content: preset('cwd'), hash: next.hash }),
        room: { live: 1e9, pending: 1e9, db: 1e12 },
        held,
      }),
    );
    const list = await pendingEntries(db, 10);
    expect(list.map((e) => (JSON.parse(e.summary) as { id: string }).id)).toEqual(['bob/new', 'alp/old']);
    expect(list.map((e) => e.at)).toEqual([NEW, HELD_AT]);
  });
});
