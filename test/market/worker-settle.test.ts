import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { parseIndex } from '../../src/market/protocol.js';
import type { D1Database, D1PreparedStatement, Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import worker from '../../src/market/worker/index.js';
import { REBUILD_GAP_MS, REBUILD_LEASE_MS, scheduled } from '../../src/market/worker/settle.js';
import { claimHandle, indexState, readIndexPage } from '../../src/market/worker/store.js';
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

describe.skipIf(!hasSqlite)('worker takedowns past the budget (moderation audit)', () => {
  const ADMIN = 65018489;

  async function spent() {
    const t = await setup({ INDEX_REBUILD_ROWS: '1' });
    const alp = await t.account('alp', 7);
    const boss = await t.account('boss', ADMIN);
    for (const s of ['a', 'b', 'c']) {
      expect((await t.call('POST', '/v1/entries', alp, publishBody(s))).status).toBe(201);
    }
    // the budget is spent after the first rebuild: b and c wait
    expect(await t.stored()).toEqual(['alp/a']);
    return { ...t, alp, boss };
  }

  it('an admin remove leaves the index at once, budget or not', async () => {
    const t = await spent();
    expect((await t.call('POST', '/v1/admin/entries/alp/a/remove', t.boss, {})).status).toBe(200);
    expect(await t.stored()).not.toContain('alp/a');
  });

  it('a publisher withdraw leaves the index at once', async () => {
    const t = await spent();
    expect((await t.call('DELETE', '/v1/entries/alp/a', t.alp)).status).toBe(200);
    expect(await t.stored()).not.toContain('alp/a');
  });

  it('a ban hides the publisher in the index at once; an unban may wait for the budget', async () => {
    const t = await spent();
    expect((await t.call('POST', '/v1/admin/publishers/alp/ban', t.boss, {})).status).toBe(200);
    expect(await t.stored()).toEqual([]);
    t.clock.advance(1000);
    expect((await t.call('POST', '/v1/admin/publishers/alp/unban', t.boss, {})).status).toBe(200);
    expect(await t.stored()).toEqual([]);
    t.clock.advance(REBUILD_GAP_MS);
    expect(await t.ids()).toEqual(['alp/a', 'alp/b', 'alp/c']);
  });

  it('a takedown whose rebuild failed is rebuilt by the next read, budget or not', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await spent();
    t.state.fail = 1;
    expect((await t.call('POST', '/v1/admin/entries/alp/a/remove', t.boss, {})).status).toBe(200);
    expect(await t.stored()).toContain('alp/a');
    expect(await t.ids()).not.toContain('alp/a');
  });

  it('approve still pins the reviewed revision and needs the admin gate in the batch', async () => {
    const t = await setup();
    const bob = await t.account('bob', 8, false);
    const boss = await t.account('boss', ADMIN);
    expect((await t.call('POST', '/v1/entries', bob, publishBody('wait'))).status).toBe(201);
    const tag = (await t.call('GET', '/v1/admin/entries/bob/wait', boss)).headers.get('etag')!;
    expect(
      (await t.call('POST', '/v1/admin/entries/bob/wait/approve', bob, {}, { 'if-match': tag })).status,
    ).toBe(403);
    const v = await t.call(
      'POST',
      '/v1/entries/bob/wait/versions',
      bob,
      { content: preset('cwd') },
      {
        'if-match': '"1"',
      },
    );
    expect(v.status).toBe(201);
    expect(
      (await t.call('POST', '/v1/admin/entries/bob/wait/approve', boss, {}, { 'if-match': tag })).status,
    ).toBe(412);
    await scheduled(t.env, t.clock.now());
    expect(await t.ids()).toEqual([]);
    const st = await t.raw.prepare("SELECT state FROM entries WHERE slug = 'wait'").first('state');
    expect(st).toBe('pending');
  });
});

describe.skipIf(!hasSqlite)('worker hidden pending ids (IN-01)', () => {
  it('answers 403 for any id of another publisher, existing, pending or missing', async () => {
    const t = await setup({ ALLOW_OVERWRITE: 'true' });
    const alp = await t.account('alp', 7);
    const bob = await t.account('bob', 8, false);
    expect((await t.call('POST', '/v1/entries', bob, publishBody('wait'))).status).toBe(201);
    for (const slug of ['wait', 'nope']) {
      const body = { content: preset('cwd') };
      const v = await t.call('POST', `/v1/entries/bob/${slug}/versions`, alp, body, { 'if-match': '"1"' });
      expect(v.status, slug).toBe(403);
      expect((await t.call('PUT', `/v1/entries/bob/${slug}/versions/1`, alp, body)).status, slug).toBe(403);
      expect((await t.call('DELETE', `/v1/entries/bob/${slug}`, alp)).status, slug).toBe(403);
    }
    expect((await t.call('DELETE', '/v1/entries/alp/nope', alp)).status).toBe(404);
  });
});

describe.skipIf(!hasSqlite)('worker caps under concurrency (cap audit)', () => {
  const lease = (db: D1Database) => db.prepare("SELECT n FROM counters WHERE k = 'rebuilding'").first('n');

  async function stale() {
    const t = await setup({ INDEX_REBUILD_ROWS: '1' });
    const alp = await t.account('alp', 7);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('a'))).status).toBe(201);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('b'))).status).toBe(201);
    expect(t.state.rebuilds).toBe(1);
    t.clock.advance(REBUILD_GAP_MS);
    return t;
  }

  it('concurrent index reads past the budget run one rebuild, not one each', async () => {
    const t = await stale();
    const all = await Promise.all(Array.from({ length: 8 }, () => t.call('GET', '/v1/index.json')));
    expect(all.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(t.state.rebuilds).toBe(2);
    expect(await t.stored()).toEqual(['alp/a', 'alp/b']);
    expect(await lease(t.raw)).toBe(0);
  });

  it('a held lease stops a rebuild until it is released or 30 s old', async () => {
    const t = await stale();
    await t.raw.prepare("UPDATE counters SET n = ?1 WHERE k = 'rebuilding'").bind(t.clock.now()).run();
    expect(await t.ids()).toEqual(['alp/a']);
    t.clock.advance(REBUILD_LEASE_MS + 1);
    expect(await t.ids()).toEqual(['alp/a', 'alp/b']);
    expect(await lease(t.raw)).toBe(0);
  });

  it('a failed rebuild gives the lease back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await stale();
    t.state.fail = 1;
    expect(await t.ids()).toEqual(['alp/a']);
    expect(await lease(t.raw)).toBe(0);
    expect(await t.ids()).toEqual(['alp/a', 'alp/b']);
  });

  it('concurrent sign-ups never pass the publishers cap', async () => {
    const { env } = await makeEnv();
    await env.DB.prepare("UPDATE counters SET n = 9 WHERE k = 'publishers'").run();
    const got = await Promise.all(
      [1, 2, 3].map((id) =>
        claimHandle(env.DB, { id, login: `u${id}`, name: `U${id}` }, `u${id}`, 'now', 10),
      ),
    );
    expect(got.filter((g) => typeof g === 'object')).toHaveLength(1);
    expect(got.filter((g) => g === 'full')).toHaveLength(2);
    expect(await env.DB.prepare("SELECT n FROM counters WHERE k = 'publishers'").first('n')).toBe(10);
  });
});
