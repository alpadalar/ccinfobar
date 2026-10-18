import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import type { D1Database, D1PreparedStatement, Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { rebuildIndex } from '../../src/market/worker/store.js';
import { d1, hasSqlite, type TestD1 } from './d1-sqlite.js';
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
  /^SEARCH \w+ USING (?:INTEGER )?PRIMARY KEY \((?:k|handle|sha256|day|key|page|rowid)=\?\)$/,
  /^SEARCH \w+ USING (?:COVERING )?INDEX sqlite_autoindex_(?:entries|versions)_1 \(publisher=\? AND slug=\?(?: AND version=\?)?\)$/,
  /^SEARCH \w+ USING (?:COVERING )?INDEX sqlite_autoindex_publishers_1 \(github_id=\?\)$/,
  /^SEARCH \w+ USING COVERING INDEX tokens_by_handle \(handle=\? AND sha256=\?\)$/,
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

describe.skipIf(!hasSqlite)('worker write-side reads (CR-01)', () => {
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

describe.skipIf(!hasSqlite)('worker counts', () => {
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
