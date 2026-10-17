import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import {
  INDEX_PAGE,
  type MarketSummary,
  parseIndex,
  parseRemoteEntry,
  parseRemoteVersion,
} from '../../src/market/protocol.js';
import { order, tombOf, toSummary } from '../../src/market/rules.js';
import type { D1Database } from '../../src/market/worker/env.js';
import {
  EMPTY_INDEX,
  entryDocText,
  indexEtag,
  pageStatements,
  readEntryDoc,
  readIndexPage,
  readVersionDoc,
  rebuildIndex,
  summaryText,
} from '../../src/market/worker/store.js';
import { START } from './conformance.js';
import { hasSqlite } from './d1-sqlite.js';
import { makeRefTarget } from './ref-target.js';
import { makeEnv } from './worker-env.js';
import { ISO, seedEntry, seedPublisher, seedToken, storedEntry } from './worker-seed.js';

const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;
const at = (ms: number) => new Date(START + ms).toISOString();

async function gen(db: D1Database): Promise<number> {
  return Number(await db.prepare("SELECT n FROM counters WHERE k = 'gen'").first<number>('n'));
}

describe.skipIf(!hasSqlite)('worker store', () => {
  it('serves an empty index before any rebuild', async () => {
    const { env } = await makeEnv();
    const page = await readIndexPage(env.DB, 1);
    expect(page).toEqual({ body: EMPTY_INDEX, etag: '"g0"' });
    expect(parseIndex(JSON.parse(page!.body))!.entries).toEqual([]);
    expect(await indexEtag(env.DB)).toBe('"g0"');
    expect(await readIndexPage(env.DB, 2)).toBeNull();
    expect(await indexEtag(env.DB, 2)).toBeNull();
  });

  it('seeds publishers and sha256 tokens', async () => {
    const { env } = await makeEnv();
    await seedPublisher(env.DB, { handle: 'alp', githubId: 7, trusted: true, banned: true });
    const token = await seedToken(env.DB, 'alp');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const digest = createHash('sha256').update(token).digest('hex');
    expect(
      await env.DB.prepare('SELECT handle FROM tokens WHERE sha256 = ?1').bind(digest).first('handle'),
    ).toBe('alp');
    expect(await env.DB.prepare('SELECT trusted, banned_at FROM publishers').first()).toEqual({
      trusted: 1,
      banned_at: ISO,
    });
  });

  it('builds page 1 for an empty marketplace', async () => {
    const { env } = await makeEnv();
    await rebuildIndex(env.DB, ISO);
    const page = await readIndexPage(env.DB, 1);
    expect(page!.body).toBe(JSON.stringify({ entries: [], generatedAt: ISO }));
    expect(page!.etag).toBe('"g0"');
  });

  it('pages 501 entries at INDEX_PAGE in publisher, slug order', async () => {
    const { env } = await makeEnv();
    const ids: string[] = [];
    for (let i = 0; i < 501; i++) ids.push(`p${(i * 7) % 13}/s${i}`);
    for (const id of ids)
      await seedEntry(env.DB, { id, versions: [{ content: preset() }] }, { rebuild: false });
    await rebuildIndex(env.DB, ISO);
    const g = await gen(env.DB);
    expect(g).toBe(501);
    const one = (await readIndexPage(env.DB, 1))!;
    const two = (await readIndexPage(env.DB, 2))!;
    expect([one.etag, two.etag]).toEqual(['"g501"', '"g501"']);
    const p1 = parseIndex(JSON.parse(one.body))!;
    const p2 = parseIndex(JSON.parse(two.body), 2)!;
    expect(p1.entries).toHaveLength(INDEX_PAGE);
    expect(p1.next).toBe('index-2.json');
    expect(p2.entries).toHaveLength(1);
    expect(p2.next).toBeUndefined();
    expect(JSON.parse(two.body)).not.toHaveProperty('next');
    const got = [...p1.entries, ...p2.entries].map((e) => e.id);
    const want = ids
      .map((id) => ({ id }) as MarketSummary)
      .sort(order)
      .map((s) => s.id);
    expect(got).toEqual(want);
    expect(await readIndexPage(env.DB, 3)).toBeNull();
  });

  it('keeps pending, banned and withdrawn entries out of the index', async () => {
    const { env } = await makeEnv();
    await seedPublisher(env.DB, { handle: 'alp', githubId: 1, trusted: true });
    await seedPublisher(env.DB, { handle: 'bad', githubId: 2, banned: true });
    await seedEntry(env.DB, { id: 'alp/live', versions: [{ content: preset() }] });
    await seedEntry(env.DB, { id: 'alp/wait', state: 'pending', versions: [{ content: preset() }] });
    await seedEntry(env.DB, { id: 'bad/one', versions: [{ content: preset() }] });
    await seedEntry(env.DB, {
      id: 'alp/gone',
      state: 'withdrawn',
      versions: [{ content: preset(), note: 'first' }],
    });
    await seedEntry(env.DB, { id: 'alp/out', state: 'removed', versions: [{ content: preset() }] });
    const page = (await readIndexPage(env.DB, 1))!;
    expect(parseIndex(JSON.parse(page.body))!.entries.map((e) => e.id)).toEqual(['alp/live']);
    expect(page.body).not.toMatch(/wait|bad\/one|gone|alp\/out/);
    const tomb = (await readEntryDoc(env.DB, 'alp', 'gone'))!;
    expect(tomb.state).toBe('withdrawn');
    const e = parseRemoteEntry(JSON.parse(tomb.doc))!;
    expect(e).toMatchObject({ withdrawn: true, name: '', description: '', author: '' });
    expect(e.versions.map((v) => v.note)).toEqual(['']);
    expect(tomb.doc).not.toMatch(/Name gone|"desc"|"Alp"|"first"/);
    expect((await readEntryDoc(env.DB, 'bad', 'one'))!.banned).toBe(true);
    expect((await readEntryDoc(env.DB, 'alp', 'wait'))!.state).toBe('pending');
    expect(await readEntryDoc(env.DB, 'alp', 'nope')).toBeNull();
    const v = (await readVersionDoc(env.DB, 'alp', 'gone', 1))!;
    expect(v).toMatchObject({ state: 'withdrawn', found: true, body: null, hash: null });
  });

  it('never lets an older rebuild replace or add pages', async () => {
    const { env } = await makeEnv();
    for (let i = 0; i < 501; i++) {
      await seedEntry(
        env.DB,
        { id: `alp/s${String(i).padStart(3, '0')}`, versions: [{ content: preset() }] },
        { rebuild: false },
      );
    }
    await rebuildIndex(env.DB, ISO);
    const g = await gen(env.DB);
    const before = (await readIndexPage(env.DB, 1))!.body;
    await env.DB.batch(pageStatements(env.DB, ['{"entries":[]}', '{"entries":[]}', '{"entries":[]}'], g - 1));
    expect((await readIndexPage(env.DB, 1))!.body).toBe(before);
    expect((await readIndexPage(env.DB, 1))!.etag).toBe(`"g${g}"`);
    expect(await readIndexPage(env.DB, 3)).toBeNull();
    // a newer rebuild with fewer pages drops the old ones
    await env.DB.batch([
      env.DB.prepare("UPDATE entries SET state = 'removed' WHERE slug >= ?1").bind('s010'),
      env.DB.prepare("UPDATE counters SET n = n + 1 WHERE k = 'gen'"),
    ]);
    await rebuildIndex(env.DB, at(60_000));
    expect(await readIndexPage(env.DB, 2)).toBeNull();
    const now = (await readIndexPage(env.DB, 1))!;
    expect(now.etag).toBe(`"g${g + 1}"`);
    expect(parseIndex(JSON.parse(now.body))!.entries).toHaveLength(10);
  });

  it('stores the summary and entry text the reference shapes give', async () => {
    const { env } = await makeEnv();
    const spec = {
      id: 'alp/mine',
      versions: [
        { content: preset(), note: 'first' },
        { content: preset('cwd'), note: 'two', at: at(60_000) },
      ],
    };
    const doc = await seedEntry(env.DB, spec);
    const entry = storedEntry(spec);
    expect(doc).toEqual(entry);
    expect(summaryText(toSummary(entry))).toBe(JSON.stringify(toSummary(entry)));
    expect(entryDocText(entry)).toBe(JSON.stringify(entry));
    const row = (await readEntryDoc(env.DB, 'alp', 'mine'))!;
    expect(row.doc).toBe(JSON.stringify(entry));
    expect(row.etag).toBe(`"${entry.hash}-1"`);
    expect(parseRemoteEntry(JSON.parse(row.doc))).toEqual(parseRemoteEntry(entry));
    const index = parseIndex(JSON.parse((await readIndexPage(env.DB, 1))!.body))!;
    expect(index.entries).toEqual([toSummary(entry)]);
    const v2 = (await readVersionDoc(env.DB, 'alp', 'mine', 2))!;
    expect(v2.hash).toBe(entry.versions[1]!.hash);
    expect(parseRemoteVersion(JSON.parse(v2.body!))!.hash).toBe(v2.hash);
    const tomb = await seedEntry(env.DB, {
      ...spec,
      id: 'alp/old',
      state: 'withdrawn',
      withdrawnAt: at(120_000),
    });
    expect(tomb).toEqual(tombOf(storedEntry({ ...spec, id: 'alp/old' }), at(120_000)));
  });

  it('serves the same bytes as the reference server for the same calls', async () => {
    const t = await makeRefTarget();
    try {
      const token = await t.signIn('alp');
      const send = (method: string, p: string, body: unknown, extra: Record<string, string> = {}) =>
        fetch(`${t.url}${p}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
          body: JSON.stringify(body),
        });
      const base = { kind: 'preset', name: 'Name mine', description: 'desc', author: 'Alp' };
      expect(
        (await send('POST', '/v1/entries', { ...base, slug: 'mine', content: preset(), note: 'first' }))
          .status,
      ).toBe(201);
      expect(
        (await send('POST', '/v1/entries', { ...base, slug: 'old', content: preset(), note: 'first' }))
          .status,
      ).toBe(201);
      t.advance(60_000);
      const r = await send(
        'POST',
        '/v1/entries/alp/mine/versions',
        { content: preset('cwd'), note: 'two' },
        { 'if-match': '"1"' },
      );
      expect(r.status).toBe(201);
      t.advance(60_000);
      const w = await fetch(`${t.url}/v1/entries/alp/old`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(w.status).toBe(200);
      const ref = async (p: string) => (await (await fetch(`${t.url}${p}`)).text()).trimEnd();

      const { env } = await makeEnv();
      await seedEntry(env.DB, {
        id: 'alp/mine',
        versions: [
          { content: preset(), note: 'first' },
          { content: preset('cwd'), note: 'two', at: at(60_000) },
        ],
      });
      await seedEntry(env.DB, {
        id: 'alp/old',
        state: 'withdrawn',
        versions: [{ content: preset(), note: 'first' }],
        withdrawnAt: at(120_000),
      });
      expect((await readEntryDoc(env.DB, 'alp', 'mine'))!.doc).toBe(await ref('/v1/entries/alp/mine.json'));
      expect((await readEntryDoc(env.DB, 'alp', 'old'))!.doc).toBe(await ref('/v1/entries/alp/old.json'));
      expect((await readVersionDoc(env.DB, 'alp', 'mine', 2))!.body).toBe(
        await ref('/v1/entries/alp/mine/2.json'),
      );
      expect((await readVersionDoc(env.DB, 'alp', 'mine', 1))!.body).toBe(
        await ref('/v1/entries/alp/mine/1.json'),
      );
      expect((await readIndexPage(env.DB, 1))!.body).toBe(await ref('/v1/index.json'));
    } finally {
      await t.close();
    }
  });
});
