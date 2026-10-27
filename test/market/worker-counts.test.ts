import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import type { D1Database, D1PreparedStatement, Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { cleanup } from '../../src/market/worker/rate.js';
import { CLEANUP_BATCH, cleanupStatements, rebuildIndex } from '../../src/market/worker/store.js';
import { d1, skipSqlite, type TestD1 } from './d1-sqlite.js';
import { makeEnv, migrationFiles } from './worker-env.js';
import { counts, ISO, seedEntry, seedPublisher, seedToken } from './worker-seed.js';

const BASE = 'http://w.test';
const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;
const ADMIN = 65018489;

function publishBody(slug: string) {
  return { kind: 'preset', slug, name: `Name ${slug}`, description: '', author: '', content: preset() };
}

interface Rec {
  sql: string;
  args: unknown[];
}

// keeps every statement the handler prepares or binds
function recorded(db: D1Database): { db: D1Database; list: Rec[] } {
  const list: Rec[] = [];
  return {
    list,
    db: {
      prepare: (sql) => {
        const st = db.prepare(sql);
        list.push({ sql, args: [] });
        const bind = st.bind.bind(st);
        st.bind = (...args: unknown[]): D1PreparedStatement => {
          list.push({ sql, args });
          return bind(...args);
        };
        return st;
      },
      batch: (l) => db.batch(l),
      exec: (s) => db.exec(s),
    },
  };
}

async function planOf(db: D1Database, sql: string, args: unknown[] = []): Promise<string[]> {
  const rows = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...args)
    .all<{ detail: string }>();
  return rows.results.map((r) => String(r.detail));
}

// trigger bodies with literals for new. and old.
async function triggerStatements(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger'")
    .all<{ sql: string }>();
  const lit: Record<string, string> = { state: "'live'", publisher: "'alp'", slug: "'x'", body: "'b'" };
  return rows.results.flatMap((r) => {
    const body = /\bBEGIN\b([\s\S]*)\bEND\s*$/.exec(r.sql)![1]!;
    return body
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\b(?:new|old)\.(\w+)/g, (_, c: string) => lit[c] ?? '1'));
  });
}

// a full key, one entry's versions or the 10 index pages; the rebuild reads the live summaries
// through one covering index and the banned publishers through a partial one
const BOUNDED = [
  /^SEARCH \w+ USING (?:INTEGER )?PRIMARY KEY \((?:k|handle|sha256|day|key|page|rowid)=\?\)(?: LEFT-JOIN)?$/,
  /^SEARCH \w+ USING (?:COVERING )?INDEX sqlite_autoindex_(?:entries|versions)_1 \(publisher=\? AND slug=\?(?: AND version=\?)?\)(?: LEFT-JOIN)?$/,
  /^SEARCH \w+ USING (?:COVERING )?INDEX sqlite_autoindex_publishers_1 \(github_id=\?\)$/,
  /^SEARCH \w+ USING COVERING INDEX tokens_by_handle \(handle=\? AND sha256=\?\)$/,
  // one publisher's live and pending entries, never their tombstones
  /^SEARCH \w+ USING (?:COVERING )?INDEX entries_by_state \(state=\? AND publisher=\?\)$/,
  /^SEARCH index_pages\b/,
  /^SCAN index_pages\b/,
  /^SCAN entries USING COVERING INDEX entries_live$/,
  /^SCAN publishers USING (?:COVERING )?INDEX publishers_banned$/,
  /^SCAN CONSTANT ROW$/,
  /^SCAN json_each VIRTUAL TABLE/,
];

// plan lines that read more than a bounded set of rows
async function scans(db: D1Database, list: Rec[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of list) {
    for (const d of await planOf(db, r.sql, r.args)) {
      if (/^(?:SCAN|SEARCH) /.test(d) && !BOUNDED.some((a) => a.test(d))) out.push(`${d} <- ${r.sql}`);
    }
  }
  return out;
}

// many publishers, live entries, tombstones and pending entries
async function crowd(db: D1Database, n: number): Promise<void> {
  for (let p = 0; p < n; p++) {
    const handle = `pub${p}`;
    await seedPublisher(db, { handle, githubId: 100 + p, trusted: p % 5 !== 0 });
    for (let s = 0; s < 6; s++) {
      const state = s < 3 ? 'live' : s < 5 ? 'withdrawn' : p % 5 === 0 ? 'pending' : 'removed';
      await seedEntry(
        db,
        { id: `${handle}/e${s}`, state, versions: [{ content: preset() }] },
        { rebuild: false },
      );
    }
  }
  await rebuildIndex(db, ISO);
}

async function setup(crowded: number) {
  const { env, clock } = await makeEnv();
  await crowd(env.DB, crowded);
  const rec = recorded(env.DB);
  const handler = createHandler({ ...env, DB: rec.db } as Env, {
    now: clock.now,
    fetch: () => Promise.reject(new Error('no fetch')),
  });
  const call = (method: string, p: string, token: string, body?: unknown, headers = {}) =>
    handler.fetch(
      new Request(BASE + p, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const account = async (handle: string, githubId: number, trusted: boolean) => {
    await seedPublisher(env.DB, { handle, githubId, trusted });
    return seedToken(env.DB, handle);
  };
  return { db: env.DB, list: rec.list, call, account, clock };
}

describe.skipIf(skipSqlite)('worker write-side reads (CR-01)', () => {
  it('a trusted publish and a new version only look rows up by key, besides the covering index read', async () => {
    const t = await setup(40);
    const token = await t.account('alp', 7, true);
    t.list.length = 0;
    expect((await t.call('POST', '/v1/entries', token, publishBody('mine'))).status).toBe(201);
    const published = [...t.list];
    expect(await scans(t.db, published)).toEqual([]);
    const rebuild = published.find((r) => r.sql.includes('INDEXED BY entries_live'));
    expect(await planOf(t.db, rebuild!.sql, rebuild!.args)).toContain(
      'SCAN entries USING COVERING INDEX entries_live',
    );
    t.list.length = 0;
    const v = await t.call(
      'POST',
      '/v1/entries/alp/mine/versions',
      token,
      { content: preset('cwd') },
      {
        'if-match': '"1"',
      },
    );
    expect(v.status).toBe(201);
    expect(await scans(t.db, t.list)).toEqual([]);
  });

  it('a refused or pending publish never reads the index', async () => {
    const t = await setup(40);
    const alp = await t.account('alp', 7, true);
    const bob = await t.account('bob', 8, false);
    expect((await t.call('POST', '/v1/entries', alp, publishBody('mine'))).status).toBe(201);
    for (const [token, slug, status] of [
      [alp, 'mine', 409],
      [bob, 'new', 201],
    ] as const) {
      t.list.length = 0;
      expect((await t.call('POST', '/v1/entries', token, publishBody(slug))).status).toBe(status);
      expect(t.list.some((r) => r.sql.includes('entries_live'))).toBe(false);
      expect(await scans(t.db, t.list)).toEqual([]);
    }
  });

  it('runs the same statements on a small and a crowded database', async () => {
    const sqls: string[][] = [];
    for (const n of [1, 60]) {
      const t = await setup(n);
      const token = await t.account('alp', 7, true);
      t.list.length = 0;
      expect((await t.call('POST', '/v1/entries', token, publishBody('mine'))).status).toBe(201);
      sqls.push(t.list.map((r) => r.sql));
    }
    expect(sqls[1]).toEqual(sqls[0]);
  });

  it('account and public reads are key lookups (DoS audit)', async () => {
    const t = await setup(40);
    const token = await seedToken(t.db, 'pub1');
    for (const p of ['/v1/me', '/v1/index.json', '/v1/entries/pub1/e0.json', '/v1/entries/pub1/e0/1.json']) {
      t.list.length = 0;
      expect((await t.call('GET', p, token)).status, p).toBe(200);
      expect(await scans(t.db, t.list), p).toEqual([]);
    }
  });

  it('cleanup deletes old rate rows in bounded batches through the window index (DoS audit)', async () => {
    const { env } = await makeEnv();
    const db = env.DB;
    const now = Date.UTC(2026, 9, 18, 12);
    await db.batch(
      Array.from({ length: 1200 }, (_, i) =>
        db.prepare('INSERT INTO rate (key, win, n) VALUES (?1, ?2, 1)').bind(`w:${i}`, now - 3 * 3_600_000),
      ),
    );
    await db.prepare('INSERT INTO rate (key, win, n) VALUES (?1, ?2, 1)').bind('w:fresh', now).run();
    const [, rate] = cleanupStatements(db, '2026-10-17', now - 7_200_000);
    const plan = await planOf(
      db,
      'DELETE FROM rate WHERE key IN (SELECT key FROM rate WHERE win < ?1 LIMIT ?2)',
      [now, CLEANUP_BATCH],
    );
    expect(plan).toContain('SEARCH rate USING COVERING INDEX rate_by_win (win<?)');
    expect(rate).toBeDefined();
    expect(await cleanup(db, now)).toBe(CLEANUP_BATCH);
    expect(await cleanup(db, now)).toBe(CLEANUP_BATCH);
    expect(await cleanup(db, now)).toBe(200);
    expect(await cleanup(db, now)).toBe(0);
    expect((await db.prepare('SELECT key FROM rate').all()).results).toEqual([{ key: 'w:fresh' }]);
  });

  it('trigger bodies are key lookups', async () => {
    const { env } = await makeEnv();
    const list = await triggerStatements(env.DB);
    expect(list.length).toBeGreaterThan(0);
    expect(
      await scans(
        env.DB,
        list.map((sql) => ({ sql, args: [] })),
      ),
    ).toEqual([]);
  });
});

async function upTo(db: TestD1, last: string): Promise<void> {
  for (const m of migrationFiles()) if (m.name <= last) await db.exec(m.sql);
}

async function after(db: TestD1, last: string): Promise<void> {
  for (const m of migrationFiles()) if (m.name > last) await db.exec(m.sql);
}

describe.skipIf(skipSqlite)('worker counts', () => {
  it('backfills the counts of a database that already holds 0001 data', async () => {
    const db = d1();
    await upTo(db, '0001_init.sql');
    const DB = db as unknown as D1Database;
    await seedPublisher(DB, { handle: 'alp', githubId: 7, trusted: true });
    await seedPublisher(DB, { handle: 'bob', githubId: 8 });
    await seedPublisher(DB, { handle: 'cem', githubId: 9 });
    const states = ['live', 'live', 'pending', 'withdrawn', 'removed'] as const;
    for (const [i, state] of states.entries()) {
      await seedEntry(DB, { id: `alp/a${i}`, state, versions: [{ content: preset() }] }, { rebuild: false });
    }
    await seedEntry(
      DB,
      { id: 'bob/b', state: 'pending', versions: [{ content: preset() }] },
      { rebuild: false },
    );
    await after(db, '0001_init.sql');
    const c = await counts(DB);
    expect(c.kept).toEqual(c.rows);
    expect(c.kept.publishers.alp!.bytes).toBeGreaterThan(c.kept.publishers.alp!.pendingBytes);
    expect(c.kept.publishers.bob!.pendingBytes).toBe(c.kept.publishers.bob!.bytes);
    expect(c.kept.publishers.bob!.bytes).toBeGreaterThan(0);
    expect(await DB.prepare("SELECT n FROM counters WHERE k = 'publishers'").first('n')).toBe(3);
    expect(c.kept).toMatchObject({
      live: 2,
      pending: 2,
      tombs: 2,
      publishers: { alp: { live: 2, pending: 1, tombs: 2 }, bob: { live: 0, pending: 1, tombs: 0 } },
    });
    db.close();
  });

  it('every write keeps the counts equal to the rows', async () => {
    const { env, clock } = await makeEnv();
    const db = env.DB;
    const handler = createHandler(env, {
      now: clock.now,
      fetch: () => Promise.reject(new Error('no fetch')),
    });
    const call = async (method: string, p: string, token: string, body?: unknown, headers = {}) => {
      const r = await handler.fetch(
        new Request(BASE + p, {
          method,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      clock.advance(1000);
      return r;
    };
    const check = async () => {
      const c = await counts(db);
      expect(c.kept).toEqual(c.rows);
      return c.kept;
    };
    await seedPublisher(db, { handle: 'boss', githubId: ADMIN, trusted: true });
    const boss = await seedToken(db, 'boss');
    await seedPublisher(db, { handle: 'alp', githubId: 7, trusted: true });
    const alp = await seedToken(db, 'alp');
    await seedPublisher(db, { handle: 'bob', githubId: 8 });
    const bob = await seedToken(db, 'bob');
    expect((await call('POST', '/v1/entries', alp, publishBody('one'))).status).toBe(201);
    expect((await call('POST', '/v1/entries', alp, publishBody('two'))).status).toBe(201);
    expect((await call('POST', '/v1/entries', bob, publishBody('wait'))).status).toBe(201);
    expect((await call('POST', '/v1/entries', bob, publishBody('drop'))).status).toBe(201);
    expect(await check()).toMatchObject({ live: 2, pending: 2, tombs: 0 });
    expect((await call('DELETE', '/v1/entries/alp/two', alp)).status).toBe(200);
    expect((await call('DELETE', '/v1/entries/bob/drop', bob)).status).toBe(200);
    expect(await check()).toMatchObject({ live: 1, pending: 1, tombs: 1 });
    const review = await handler.fetch(
      new Request(`${BASE}/v1/admin/entries/bob/wait`, { headers: { authorization: `Bearer ${boss}` } }),
    );
    const tag = review.headers.get('etag')!;
    expect(
      (await call('POST', '/v1/admin/entries/bob/wait/approve', boss, {}, { 'if-match': tag })).status,
    ).toBe(200);
    expect(await check()).toMatchObject({ live: 2, pending: 0, tombs: 1 });
    expect((await call('POST', '/v1/admin/entries/alp/one/remove', boss, {})).status).toBe(200);
    expect(await check()).toMatchObject({ live: 1, pending: 0, tombs: 2 });
  });
});

describe.skipIf(skipSqlite)('worker pending caps (WR-02)', () => {
  async function world(vars: Partial<Env> = {}, caps: { entries?: number } = {}) {
    const { env, clock } = await makeEnv(vars);
    const handler = createHandler(env, {
      now: clock.now,
      fetch: () => Promise.reject(new Error('no fetch')),
      caps,
    });
    const call = async (method: string, p: string, token: string, body?: unknown, headers = {}) => {
      const r = await handler.fetch(
        new Request(BASE + p, {
          method,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      clock.advance(1000);
      return r;
    };
    const account = async (handle: string, githubId: number, trusted: boolean) => {
      await seedPublisher(env.DB, { handle, githubId, trusted });
      return seedToken(env.DB, handle);
    };
    const err = async (r: Response) => ({ status: r.status, ...((await r.json()) as any).error });
    const check = async () => {
      const c = await counts(env.DB);
      expect(c.kept).toEqual(c.rows);
      return c.kept;
    };
    return { db: env.DB, call, account, err, check };
  }

  it('pending entries have their own small caps and leave the live caps alone', async () => {
    const w = await world({ PENDING_ENTRIES: '4' }, { entries: 1 });
    const alp = await w.account('alp', 7, true);
    const bob = await w.account('bob', 8, false);
    const cem = await w.account('cem', 9, false);
    for (const s of ['a', 'b', 'c'])
      expect((await w.call('POST', '/v1/entries', bob, publishBody(s))).status).toBe(201);
    expect(await w.err(await w.call('POST', '/v1/entries', bob, publishBody('d')))).toMatchObject({
      status: 413,
      code: 'over-quota',
      message: 'too many entries waiting for review for this publisher',
    });
    expect((await w.call('POST', '/v1/entries', cem, publishBody('a'))).status).toBe(201);
    expect(await w.err(await w.call('POST', '/v1/entries', cem, publishBody('b')))).toMatchObject({
      status: 413,
      message: 'too many entries waiting for review',
    });
    // four pending entries, yet the one live slot is free
    expect((await w.call('POST', '/v1/entries', alp, publishBody('one'))).status).toBe(201);
    expect(await w.err(await w.call('POST', '/v1/entries', alp, publishBody('two')))).toMatchObject({
      status: 413,
      message: 'too many entries',
    });
    expect(await w.check()).toMatchObject({ live: 1, pending: 4 });
  });

  it('pending content has its own storage cap', async () => {
    const w = await world({ PENDING_BYTES: '200', PUBLISHER_BYTES: '200' });
    const alp = await w.account('alp', 7, true);
    const bob = await w.account('bob', 8, false);
    expect((await w.call('POST', '/v1/entries', bob, publishBody('a'))).status).toBe(201);
    expect(await w.err(await w.call('POST', '/v1/entries', bob, publishBody('b')))).toMatchObject({
      status: 413,
      message: 'publisher review storage limit reached',
    });
    const v = await w.call(
      'POST',
      '/v1/entries/bob/a/versions',
      bob,
      { content: preset('cwd') },
      {
        'if-match': '"1"',
      },
    );
    expect(await w.err(v)).toMatchObject({ status: 413, message: 'publisher review storage limit reached' });
    expect((await w.call('POST', '/v1/entries', alp, publishBody('a'))).status).toBe(201);
    expect(await w.err(await w.call('POST', '/v1/entries', alp, publishBody('b')))).toMatchObject({
      status: 413,
      message: 'publisher storage limit reached',
    });
    const kept = await w.check();
    expect(kept.publishers.bob!.pendingBytes).toBe(kept.publishers.bob!.bytes);
    expect(kept.publishers.alp!.pendingBytes).toBe(0);
  });

  it('a ban deletes the pending entries, never public, and keeps the live ones', async () => {
    const w = await world();
    const boss = await w.account('boss', ADMIN, true);
    const bob = await w.account('bob', 8, false);
    expect((await w.call('POST', '/v1/entries', bob, publishBody('wait'))).status).toBe(201);
    expect((await w.call('POST', '/v1/entries', bob, publishBody('also'))).status).toBe(201);
    const v = await w.call(
      'POST',
      '/v1/entries/bob/also/versions',
      bob,
      { content: preset('cwd') },
      {
        'if-match': '"1"',
      },
    );
    expect(v.status).toBe(201);
    await seedEntry(w.db, { id: 'bob/old', versions: [{ content: preset() }] });
    expect(await w.check()).toMatchObject({ live: 1, pending: 2 });
    expect((await w.call('POST', '/v1/admin/publishers/bob/ban', boss, {})).status).toBe(200);
    const kept = await w.check();
    expect(kept).toMatchObject({ live: 1, pending: 0, tombs: 0 });
    expect(kept.publishers.bob).toMatchObject({ live: 1, pending: 0, pendingBytes: 0 });
    expect(kept.publishers.bob!.bytes).toBeGreaterThan(0);
    const left = await w.db
      .prepare("SELECT slug FROM versions WHERE publisher = 'bob'")
      .all<{ slug: string }>();
    expect(left.results.map((r) => r.slug)).toEqual(['old']);
    expect((await w.call('POST', '/v1/admin/publishers/bob/unban', boss, {})).status).toBe(200);
    expect(await w.check()).toMatchObject({ live: 1, pending: 0 });
  });

  it('reject, withdraw and approve keep the stored bytes equal to the bodies', async () => {
    const w = await world();
    const boss = await w.account('boss', ADMIN, true);
    const bob = await w.account('bob', 8, false);
    for (const s of ['a', 'b', 'c'])
      expect((await w.call('POST', '/v1/entries', bob, publishBody(s))).status).toBe(201);
    expect(
      (
        await w.call(
          'POST',
          '/v1/entries/bob/a/versions',
          bob,
          { content: preset('cwd') },
          { 'if-match': '"1"' },
        )
      ).status,
    ).toBe(201);
    expect((await w.call('POST', '/v1/admin/entries/bob/b/reject', boss, {})).status).toBe(200);
    expect((await w.call('DELETE', '/v1/entries/bob/c', bob)).status).toBe(200);
    await w.check();
    const review = await w.call('GET', '/v1/admin/entries/bob/a', boss);
    const tag = review.headers.get('etag')!;
    expect(
      (await w.call('POST', '/v1/admin/entries/bob/a/approve', boss, {}, { 'if-match': tag })).status,
    ).toBe(200);
    const kept = await w.check();
    expect(kept.publishers.bob).toMatchObject({ live: 1, pending: 0, pendingBytes: 0 });
    expect(kept.publishers.bob!.bytes).toBeGreaterThan(0);
    expect((await w.call('POST', '/v1/admin/entries/bob/a/remove', boss, {})).status).toBe(200);
    expect((await w.check()).publishers.bob).toMatchObject({ live: 0, tombs: 1, bytes: 0, pendingBytes: 0 });
  });
});
