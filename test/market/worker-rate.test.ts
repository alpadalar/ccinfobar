import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { parseMeta } from '../../src/market/protocol.js';
import {
  REGISTERS_PER_MINUTE,
  retryAfterSeconds,
  WRITES_PER_MINUTE,
  windowOf,
} from '../../src/market/rules.js';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  Env,
  RateLimit,
} from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { buckets, cleanup, hit, ipHash, readAllowed } from '../../src/market/worker/rate.js';
import { START } from './conformance.js';
import { skipSqlite } from './d1-sqlite.js';
import { makeEnv } from './worker-env.js';
import { seedPublisher, seedToken } from './worker-seed.js';

const BASE = 'http://w.test';
const IP = '203.0.113.7';
const DAY = 86_400_000;
const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const publishBody = (slug: string, content: unknown = preset()) => ({
  kind: 'preset',
  slug,
  name: `Name ${slug}`,
  description: 'desc',
  author: 'Alp',
  content,
  note: 'first',
});

// a fixed request from one client address
const from = (ip: string | null, p = '/v1/index.json') =>
  new Request(BASE + p, { headers: ip ? { 'cf-connecting-ip': ip } : {} });

async function setup(vars: Partial<Env> = {}, reads?: RateLimit) {
  const { env, clock } = await makeEnv(vars);
  const db = env.DB;
  const batches: D1Result[][] = [];
  const counted: D1Database = {
    prepare: (s) => db.prepare(s),
    batch: async (list: D1PreparedStatement[]) => {
      const r = await db.batch(list);
      batches.push(r as D1Result[]);
      return r as never;
    },
    exec: (s) => db.exec(s),
  };
  const full = { ...env, DB: counted, ...(reads ? { READS: reads } : {}) } as Env;
  const handler = createHandler(full, {
    now: clock.now,
    fetch: () => Promise.reject(new Error('no fetch')),
  });
  const call = (
    method: string,
    p: string,
    o: { token?: string; body?: unknown; ip?: string | null; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const ip = o.ip === undefined ? IP : o.ip;
    if (ip) headers['cf-connecting-ip'] = ip;
    return handler.fetch(
      new Request(BASE + p, {
        method,
        headers,
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      }),
    );
  };
  let githubId = 100;
  const account = async (handle: string) => {
    await seedPublisher(db, { handle, githubId: githubId++, trusted: true });
    return seedToken(db, handle);
  };
  const rows = async (table: string) => (await db.prepare(`SELECT * FROM ${table}`).all()).results;
  const counter = async () =>
    Number(await db.prepare("SELECT n FROM counters WHERE k = 'bytes'").first<number>('n'));
  return { db, env: full, clock, call, account, rows, counter, batches };
}

async function error(r: Response): Promise<{ status: number; code: string; message: string }> {
  const b = (await r.json()) as { error: { code: string; message: string } };
  return { status: r.status, code: b.error.code, message: b.error.message };
}

describe('worker rate buckets', () => {
  const env = (vars: Partial<Env>) => vars as Env;

  it('use the reference defaults', () => {
    expect(buckets(env({}))).toEqual({
      write: { limit: WRITES_PER_MINUTE, ms: 60_000 },
      signIn: { limit: REGISTERS_PER_MINUTE, ms: 60_000 },
      report: { limit: 5, ms: 3_600_000 },
    });
  });

  it('take valid vars only', () => {
    const b = buckets(env({ WRITE_LIMIT: '3', SIGNIN_LIMIT: '2', REPORT_LIMIT: '9' }));
    expect([b.write.limit, b.signIn.limit, b.report.limit]).toEqual([3, 2, 9]);
    for (const v of ['0', '-1', 'x', '1.5', '']) {
      expect(buckets(env({ WRITE_LIMIT: v })).write.limit, v).toBe(WRITES_PER_MINUTE);
    }
  });

  it('read limits pass without the binding and never touch the database', async () => {
    const no = () => {
      throw new Error('no DB');
    };
    const bare = { DB: { prepare: no, batch: no, exec: no } } as unknown as Env;
    expect(await readAllowed(bare, from(IP), START)).toBe(true);
  });

  it('read keys are day-salted hashes, not addresses', async () => {
    const keys: string[] = [];
    const READS: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    const e = { READS } as unknown as Env;
    expect(await readAllowed(e, from(IP), START)).toBe(true);
    expect(await readAllowed(e, from(IP), START + 1000)).toBe(true);
    expect(await readAllowed(e, from(IP), START + DAY)).toBe(true);
    expect(await readAllowed(e, from(null), START)).toBe(true);
    expect(keys[0]).toMatch(/^r:[0-9a-f]{32}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(keys.join()).not.toContain(IP);
    expect(keys[0]).not.toBe(`r:${sha256(IP).slice(0, 32)}`);
  });

  it('a failing binding lets reads through', async () => {
    const READS: RateLimit = { limit: () => Promise.reject(new Error('down')) };
    expect(await readAllowed({ READS } as unknown as Env, from(IP), START)).toBe(true);
  });
});

describe.skipIf(skipSqlite)('worker rate limits', () => {
  it('hit counts in fixed windows and returns the reference retry-after', async () => {
    const { db } = await setup();
    const t = START + 20_000;
    expect(await hit(db, 'w:x', 2, 60_000, t)).toBeNull();
    expect(await hit(db, 'w:x', 2, 60_000, t)).toBeNull();
    expect(await hit(db, 'w:x', 2, 60_000, t + 5000)).toBe(retryAfterSeconds(windowOf(t), t + 5000));
    expect(await hit(db, 'w:y', 2, 60_000, t)).toBeNull();
    expect(await hit(db, 'w:x', 2, 60_000, t + 60_000)).toBeNull();
    // hourly windows
    expect(await hit(db, 'r:alp', 1, 3_600_000, t)).toBeNull();
    expect(await hit(db, 'r:alp', 1, 3_600_000, t)).toBe(
      retryAfterSeconds(windowOf(t, 3_600_000), t, 3_600_000),
    );
  });

  it('ipHash is stable per day, salted and 32 hex', async () => {
    const { db, rows } = await setup();
    const a = await ipHash(db, from(IP), START);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await ipHash(db, from(IP), START + 3_600_000)).toBe(a);
    expect(await ipHash(db, from('198.51.100.1'), START)).not.toBe(a);
    expect(await ipHash(db, from(null), START)).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(sha256(IP).slice(0, 32));
    const salts = await rows('salts');
    expect(salts).toHaveLength(1);
    expect(a).toBe(sha256(String(salts[0]!.salt) + IP).slice(0, 32));
    expect(String(salts[0]!.salt)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the 4th write in a window is 429 with the reference retry-after, then a new window passes', async () => {
    const w = await setup({ WRITE_LIMIT: '3' });
    const token = await w.account('alp');
    w.clock.advance(20_000);
    for (const s of ['a', 'b', 'c']) {
      expect((await w.call('POST', '/v1/entries', { token, body: publishBody(s) })).status).toBe(201);
    }
    const over = await w.call('POST', '/v1/entries', { token, body: publishBody('d') });
    const now = w.clock.now();
    expect(over.headers.get('retry-after')).toBe(String(retryAfterSeconds(windowOf(now), now)));
    expect(over.headers.get('retry-after')).toBe('40');
    expect(await error(over)).toMatchObject({ status: 429, code: 'rate-limited' });
    // the refused write stored nothing
    expect((await w.rows('entries')).map((r) => r.slug)).toEqual(['a', 'b', 'c']);
    w.clock.advance(40_000);
    expect((await w.call('POST', '/v1/entries', { token, body: publishBody('d') })).status).toBe(201);
  });

  it('counts every write route, signed in or not', async () => {
    const w = await setup({ WRITE_LIMIT: '4', ALLOW_OVERWRITE: 'false' });
    const token = await w.account('alp');
    expect((await w.call('POST', '/v1/entries', { body: publishBody('a') })).status).toBe(401);
    expect((await w.call('POST', '/v1/entries/alp/a/versions', { token, body: {} })).status).toBe(404);
    expect((await w.call('PUT', '/v1/entries/alp/a/versions/1', { token, body: {} })).status).toBe(403);
    expect((await w.call('DELETE', '/v1/entries/alp/a', { token })).status).toBe(404);
    expect((await w.call('DELETE', '/v1/entries/alp/a', { token })).status).toBe(429);
    // other clients are not affected
    expect(
      (await w.call('DELETE', '/v1/entries/alp/a', { token: undefined, ip: '198.51.100.1' })).status,
    ).toBe(401);
  });

  it('one address shares w: while each publisher has its own t: bucket', async () => {
    const w = await setup({ WRITE_LIMIT: '3' });
    const alp = await w.account('alp');
    const bob = await w.account('bob');
    expect((await w.call('POST', '/v1/entries', { token: alp, body: publishBody('a1') })).status).toBe(201);
    expect((await w.call('POST', '/v1/entries', { token: alp, body: publishBody('a2') })).status).toBe(201);
    expect((await w.call('POST', '/v1/entries', { token: bob, body: publishBody('b1') })).status).toBe(201);
    // the address is full for both tokens
    expect((await w.call('POST', '/v1/entries', { token: bob, body: publishBody('b2') })).status).toBe(429);
    const other = '198.51.100.1';
    expect(
      (await w.call('POST', '/v1/entries', { token: alp, body: publishBody('a3'), ip: other })).status,
    ).toBe(201);
    // alp's own bucket is full, bob's is not
    const full = await w.call('POST', '/v1/entries', { token: alp, body: publishBody('a4'), ip: other });
    expect(full.status).toBe(429);
    expect(
      (await w.call('POST', '/v1/entries', { token: bob, body: publishBody('b2'), ip: other })).status,
    ).toBe(201);
    const keys = (await w.rows('rate')).map((r) => String(r.key)).sort();
    expect(keys.filter((k) => k.startsWith('t:'))).toEqual(['t:alp', 't:bob']);
    expect(keys.filter((k) => k.startsWith('w:'))).toHaveLength(2);
    for (const k of keys.filter((k) => k.startsWith('w:'))) expect(k).toMatch(/^w:[0-9a-f]{32}$/);
  });

  it('stores no address anywhere', async () => {
    const w = await setup({ WRITE_LIMIT: '5' });
    const token = await w.account('alp');
    await w.call('POST', '/v1/entries', { token, body: publishBody('a') });
    await w.call('POST', '/v1/entries/alp/a/versions', {
      token,
      body: { content: preset('cwd'), note: 'n' },
      headers: { 'if-match': '"1"' },
    });
    await w.call('POST', '/v1/entries', { body: publishBody('b') });
    await w.call('DELETE', '/v1/entries/alp/a', { token });
    for (let i = 0; i < 4; i++) await w.call('POST', '/v1/entries', { token, body: publishBody(`x${i}`) });
    await w.call('GET', '/v1/index.json');
    await w.call('POST', '/v1/publishers', { body: { handle: 'zed' } });
    const tables = (
      await w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables).toContain('rate');
    const plain = sha256(IP);
    let cells = 0;
    for (const t of tables) {
      for (const row of await w.rows(t)) {
        for (const v of Object.values(row)) {
          if (typeof v !== 'string') continue;
          cells++;
          expect(v, t).not.toContain(IP);
          expect(v, t).not.toContain(plain.slice(0, 32));
        }
      }
    }
    expect(cells).toBeGreaterThan(10);
    expect((await w.rows('rate')).length).toBeGreaterThan(0);
  });

  it('cleanup drops salts older than yesterday and stale windows', async () => {
    const w = await setup();
    const token = await w.account('alp');
    await w.call('POST', '/v1/entries', { token, body: publishBody('a') });
    const before = (await w.rows('rate')).map((r) => String(r.key));
    expect(before).toHaveLength(2);
    const [old] = await w.rows('salts');
    // a fresh day keeps today's rows
    await cleanup(w.db, w.clock.now());
    expect(await w.rows('salts')).toHaveLength(1);
    expect(await w.rows('rate')).toHaveLength(2);
    w.clock.advance(DAY);
    await cleanup(w.db, w.clock.now());
    expect(await w.rows('salts')).toEqual([old]);
    expect(await w.rows('rate')).toHaveLength(0);
    await w.call('POST', '/v1/entries', { token, body: publishBody('b') });
    w.clock.advance(DAY);
    await w.call('POST', '/v1/entries', { token, body: publishBody('c') });
    expect(await w.rows('salts')).toHaveLength(3);
    await cleanup(w.db, w.clock.now());
    const salts = await w.rows('salts');
    expect(salts).toHaveLength(2);
    expect(salts).not.toContainEqual(old);
    // the same address gets a new, unlinkable key each day
    const keys = (await w.rows('rate')).map((r) => String(r.key)).filter((k) => k.startsWith('w:'));
    expect(keys).toHaveLength(1);
    expect(before).not.toContain(keys[0]);
  });

  it('GETs use the READS binding and write no rate rows', async () => {
    const seen: string[] = [];
    let ok = false;
    const READS: RateLimit = {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: ok };
      },
    };
    const w = await setup({}, READS);
    w.clock.advance(15_000);
    const r = await w.call('GET', '/v1/index.json');
    expect(await error(r)).toMatchObject({ status: 429, code: 'rate-limited' });
    expect(r.headers.get('retry-after')).toBe('45');
    expect((await w.call('GET', '/v1/meta.json')).status).toBe(429);
    ok = true;
    expect((await w.call('GET', '/v1/index.json')).status).toBe(200);
    expect(seen).toHaveLength(3);
    expect(seen.join()).not.toContain(IP);
    expect(await w.rows('rate')).toHaveLength(0);
    expect(await w.rows('salts')).toHaveLength(0);
  });

  it('GETs without READS pass and write nothing', async () => {
    const w = await setup();
    const token = await w.account('alp');
    await w.call('POST', '/v1/entries', { token, body: publishBody('a') });
    const rate = await w.rows('rate');
    for (let i = 0; i < 50; i++) expect((await w.call('GET', '/v1/index.json')).status).toBe(200);
    expect((await w.call('GET', '/v1/entries/alp/a.json')).status).toBe(200);
    expect((await w.call('GET', '/v1/meta.json')).status).toBe(200);
    expect(await w.rows('rate')).toEqual(rate);
  });
});

describe.skipIf(skipSqlite)('worker storage guard', () => {
  const big = () => ({ layout: { lines: [Array.from({ length: 150 }, () => ({ type: 'model' }))] } });

  it('MAX_DB_BYTES refuses new content once passed; withdraw and reads still work', async () => {
    const w = await setup({ MAX_DB_BYTES: '1' });
    const token = await w.account('alp');
    expect((await w.call('POST', '/v1/entries', { token, body: publishBody('a') })).status).toBe(201);
    const over = await w.call('POST', '/v1/entries', { token, body: publishBody('b') });
    expect(await error(over)).toEqual({
      status: 413,
      code: 'over-quota',
      message: 'marketplace storage is full',
    });
    const v = await w.call('POST', '/v1/entries/alp/a/versions', {
      token,
      body: { content: preset('cwd'), note: 'n' },
      headers: { 'if-match': '"1"' },
    });
    expect(await error(v)).toMatchObject({ status: 413, code: 'over-quota' });
    expect((await w.rows('entries')).map((r) => r.slug)).toEqual(['a']);
    expect((await w.rows('versions')).length).toBe(1);
    expect((await w.call('GET', '/v1/index.json')).status).toBe(200);
    expect((await w.call('GET', '/v1/entries/alp/a/1.json')).status).toBe(200);
    expect((await w.call('DELETE', '/v1/entries/alp/a', { token })).status).toBe(200);
    expect((await w.call('GET', '/v1/entries/alp/a.json')).status).toBe(200);
  });

  it('the overwrite path is guarded too', async () => {
    const w = await setup({ MAX_DB_BYTES: '1', ALLOW_OVERWRITE: 'true' });
    const token = await w.account('alp');
    expect((await w.call('POST', '/v1/entries', { token, body: publishBody('a') })).status).toBe(201);
    const r = await w.call('PUT', '/v1/entries/alp/a/versions/1', {
      token,
      body: { content: preset('cwd'), note: 'n' },
    });
    expect(await error(r)).toMatchObject({ status: 413, code: 'over-quota' });
  });

  it('PUBLISHER_BYTES refuses one publisher, not the others', async () => {
    const w = await setup({ PUBLISHER_BYTES: '2000' });
    const alp = await w.account('alp');
    const bob = await w.account('bob');
    const r = await w.call('POST', '/v1/entries', { token: alp, body: publishBody('big', big()) });
    expect(await error(r)).toEqual({
      status: 413,
      code: 'over-quota',
      message: 'publisher storage limit reached',
    });
    expect(await w.rows('entries')).toHaveLength(0);
    expect((await w.call('POST', '/v1/entries', { token: bob, body: publishBody('small') })).status).toBe(
      201,
    );
    // small entries add up to the cap
    let n = 0;
    for (; n < 100; n++) {
      const s = await w.call('POST', '/v1/entries', { token: alp, body: publishBody(`s${n}`) });
      if (s.status !== 201) {
        expect(await error(s)).toMatchObject({ status: 413, code: 'over-quota' });
        break;
      }
      w.clock.advance(60_000);
    }
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(100);
    const used = Number((await w.rows('publishers')).find((p) => p.handle === 'alp')!.bytes);
    expect(used).toBeLessThanOrEqual(2000);
  });

  it('a publish stores the size D1 reported after its batch', async () => {
    const w = await setup();
    const token = await w.account('alp');
    expect(await w.counter()).toBe(0);
    w.batches.length = 0;
    expect((await w.call('POST', '/v1/entries', { token, body: publishBody('a', big()) })).status).toBe(201);
    // salt, content, index read, index pages
    expect(w.batches).toHaveLength(4);
    const content = w.batches[1]!;
    const size = Math.max(...content.map((r) => r.meta.size_after));
    expect(size).toBeGreaterThan(0);
    expect(await w.counter()).toBe(size);
    const row = await w.db.prepare('SELECT bytes FROM publishers WHERE handle = ?1').bind('alp').first();
    expect(Number(row!.bytes)).toBeGreaterThan(2000);
  });

  it('meta advertises the publisher quota', async () => {
    const meta = async (vars: Partial<Env>) => {
      const w = await setup(vars);
      return (await w.call('GET', '/v1/meta.json')).json();
    };
    const d = await meta({});
    const q = { publisherBytes: 20_971_520, pendingEntries: 3, pendingBytes: 1_048_576, pendingTotal: 50 };
    expect(d.quota).toEqual(q);
    expect(parseMeta(d)?.quota).toEqual(q);
    expect((await meta({ PUBLISHER_BYTES: '2000' })).quota).toEqual({ ...q, publisherBytes: 2000 });
    expect((await meta({ PUBLISHER_BYTES: 'lots' })).quota).toEqual(q);
    const small = { PENDING_ENTRIES: '9', PENDING_PER_PUBLISHER: '1', PENDING_BYTES: '5000' };
    expect((await meta(small)).quota).toEqual({
      ...q,
      pendingEntries: 1,
      pendingBytes: 5000,
      pendingTotal: 9,
    });
    expect((await meta({ PENDING_BYTES: '0' })).quota).toEqual(q);
  });

  it('defaults to 400 MiB for the database', async () => {
    const w = await setup();
    const token = await w.account('alp');
    await w.db.prepare("UPDATE counters SET n = ?1 WHERE k = 'bytes'").bind(419_430_399).run();
    expect((await w.call('POST', '/v1/entries', { token, body: publishBody('a') })).status).toBe(201);
    await w.db.prepare("UPDATE counters SET n = ?1 WHERE k = 'bytes'").bind(419_430_400).run();
    const r = await w.call('POST', '/v1/entries', { token, body: publishBody('b') });
    expect(await error(r)).toMatchObject({ status: 413, code: 'over-quota' });
  });
});
