import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { parseIndex } from '../../src/market/protocol.js';
import type { D1Database, D1PreparedStatement, Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import worker from '../../src/market/worker/index.js';
import { REBUILD_GAP_MS, scheduled } from '../../src/market/worker/settle.js';
import { indexState, readIndexPage } from '../../src/market/worker/store.js';
import { d1, hasSqlite } from './d1-sqlite.js';
import { makeEnv, migrationFiles } from './worker-env.js';
import { seedPublisher, seedToken } from './worker-seed.js';

const BASE = 'http://w.test';
const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;
const DAY_MS = 86_400_000;

function publishBody(slug: string) {
  return { kind: 'preset', slug, name: `Name ${slug}`, description: '', author: '', content: preset() };
}

// fails the next batch that writes index pages; counts rebuilds
function flaky(db: D1Database) {
  const pages = new WeakSet<object>();
  const state = { fail: 0, rebuilds: 0 };
  const wrapped: D1Database = {
    prepare: (sql) => {
      const st = db.prepare(sql);
      if (sql.includes('INDEXED BY entries_live')) state.rebuilds++;
      if (!sql.includes('INSERT INTO index_pages')) return st;
      const bind = st.bind.bind(st);
      st.bind = (...a: unknown[]): D1PreparedStatement => {
        const b = bind(...a);
        pages.add(b);
        return b;
      };
      return st;
    },
    batch: async (list) => {
      if (state.fail > 0 && list.some((s) => pages.has(s))) {
        state.fail--;
        throw new Error('D1_ERROR: Worker exceeded CPU time limit');
      }
      return db.batch(list);
    },
    exec: (s) => db.exec(s),
  };
  return { db: wrapped, state };
}

async function setup(vars: Partial<Env> = {}) {
  const { env, clock } = await makeEnv(vars);
  const f = flaky(env.DB);
  const wenv = { ...env, DB: f.db } as Env;
  const handler = createHandler(wenv, { now: clock.now, fetch: () => Promise.reject(new Error('no fetch')) });
  const call = (method: string, p: string, token?: string, body?: unknown, headers = {}) =>
    handler.fetch(
      new Request(BASE + p, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const ids = async () =>
    parseIndex(await (await call('GET', '/v1/index.json')).json())!.entries.map((e) => e.id);
  const stored = async () =>
    parseIndex(JSON.parse((await readIndexPage(env.DB, 1))!.body))!.entries.map((e) => e.id);
  const account = async (handle: string, githubId: number, trusted = true) => {
    await seedPublisher(env.DB, { handle, githubId, trusted });
    return seedToken(env.DB, handle);
  };
  return { env: wenv, raw: env.DB, clock, call, ids, stored, account, state: f.state };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!hasSqlite)('worker index rebuilds (WR-03)', () => {
  it('a write whose rebuild fails still answers success, and the next read rebuilds the index', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await setup();
    const alp = await t.account('alp', 7);
    t.state.fail = 1;
    const r = await t.call('POST', '/v1/entries', alp, publishBody('mine'));
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 'alp/mine', version: 1 });
    expect(err.mock.calls).toEqual([['market: index']]);
    expect(await t.stored()).toEqual([]);
    const st = await indexState(t.raw);
    expect(st.dirty).toBeGreaterThan(st.built);
    expect(await t.ids()).toEqual(['alp/mine']);
    const after = await indexState(t.raw);
    expect(after.built).toBeGreaterThanOrEqual(after.dirty);
  });

  it('the next write rebuilds an index a failed rebuild left stale, also a pending one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await setup();
    const alp = await t.account('alp', 7);
    const bob = await t.account('bob', 8, false);
    t.state.fail = 1;
    expect((await t.call('DELETE', '/v1/entries/alp/none', alp)).status).toBe(404);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('mine'))).status).toBe(201);
    expect(await t.stored()).toEqual([]);
    expect((await t.call('POST', '/v1/entries', bob, publishBody('wait'))).status).toBe(201);
    expect(await t.stored()).toEqual(['alp/mine']);
  });

  it('a pending write leaves the index clean', async () => {
    const t = await setup();
    const bob = await t.account('bob', 8, false);
    expect((await t.call('POST', '/v1/entries', bob, publishBody('wait'))).status).toBe(201);
    const st = await indexState(t.raw);
    expect(st.dirty).toBe(0);
    expect(t.state.rebuilds).toBe(0);
  });

  it('past the daily rows budget, the index is rebuilt at most once per gap (DoS audit)', async () => {
    const t = await setup({ INDEX_REBUILD_ROWS: '1' });
    const alp = await t.account('alp', 7);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('a0'))).status).toBe(201);
    expect(t.state.rebuilds).toBe(1);
    for (let i = 1; i <= 5; i++) {
      t.clock.advance(1000);
      expect((await t.call('POST', '/v1/entries', alp, publishBody(`a${i}`))).status).toBe(201);
    }
    expect(await t.ids()).toEqual(['alp/a0']);
    expect(t.state.rebuilds).toBe(1);
    t.clock.advance(REBUILD_GAP_MS);
    expect(await t.ids()).toEqual(['alp/a0', 'alp/a1', 'alp/a2', 'alp/a3', 'alp/a4', 'alp/a5']);
    expect(t.state.rebuilds).toBe(2);
    // a new UTC day has a fresh budget
    t.clock.advance(DAY_MS);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('b'))).status).toBe(201);
    expect(await t.stored()).toContain('alp/b');
    expect(t.state.rebuilds).toBe(3);
  });

  it('the budget counts the rows each rebuild read', async () => {
    const t = await setup();
    const alp = await t.account('alp', 7);
    for (const s of ['a', 'b', 'c'])
      expect((await t.call('POST', '/v1/entries', alp, publishBody(s))).status).toBe(201);
    const st = await indexState(t.raw);
    expect(st.rows).toBe(2 + 3 + 4);
    expect(st.day).toBe(Math.floor(t.clock.now() / DAY_MS));
    expect(st.at).toBe(t.clock.now());
  });
});

describe.skipIf(!hasSqlite)('worker cron (WR-03, WR-05)', () => {
  it('deletes old salts and rate rows and rebuilds a stale index, even past the budget', async () => {
    const t = await setup({ INDEX_REBUILD_ROWS: '1' });
    const alp = await t.account('alp', 7);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('a'))).status).toBe(201);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('b'))).status).toBe(201);
    expect(await t.stored()).toEqual(['alp/a']);
    const now = t.clock.now() + 3 * DAY_MS;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    await t.raw.batch([
      t.raw
        .prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?1, ?2)')
        .bind(day(now - 3 * DAY_MS), 'old'),
      t.raw.prepare('INSERT INTO salts (day, salt) VALUES (?1, ?2)').bind(day(now), 'today'),
      ...Array.from({ length: 1100 }, (_, i) =>
        t.raw.prepare('INSERT INTO rate (key, win, n) VALUES (?1, ?2, 1)').bind(`w:${i}`, now - DAY_MS),
      ),
      t.raw.prepare('INSERT INTO rate (key, win, n) VALUES (?1, ?2, 1)').bind('w:new', now),
    ]);
    await scheduled(t.env, now);
    expect((await t.raw.prepare('SELECT day FROM salts').all()).results).toEqual([{ day: day(now) }]);
    expect((await t.raw.prepare("SELECT key FROM rate WHERE key LIKE 'w:%'").all()).results).toEqual([
      { key: 'w:new' },
    ]);
    expect(await t.stored()).toEqual(['alp/a', 'alp/b']);
  });

  it('runs from the default export through waitUntil', async () => {
    const { env } = await makeEnv();
    const waits: Promise<unknown>[] = [];
    worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
    expect(waits).toHaveLength(1);
    await expect(waits[0]).resolves.toBeUndefined();
  });

  it('0005 marks a database that already holds data for one rebuild', async () => {
    const db = d1();
    for (const m of migrationFiles()) if (m.name < '0005') await db.exec(m.sql);
    await db.exec("UPDATE counters SET n = 7 WHERE k = 'gen'");
    for (const m of migrationFiles()) if (m.name >= '0005') await db.exec(m.sql);
    expect(await indexState(db as unknown as D1Database)).toMatchObject({ dirty: 7, built: 0 });
    db.close();
  });
});
