import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import {
  adminActionPath,
  adminEntryPath,
  adminPendingPath,
  parseIndex,
  parseMe,
  parsePending,
  parseReview,
} from '../../src/market/protocol.js';
import type { D1Database, D1PreparedStatement, Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { hasSqlite } from './d1-sqlite.js';
import { type FakeUser, fakeGitHub } from './fake-github.js';
import { makeEnv } from './worker-env.js';

const BASE = 'http://w.test';
const IP = '203.0.113.9';
const ADMIN_ID = 65018489;
const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;

// fixtures only; never shaped like real provider tokens
const GH: Record<string, string> = {
  admin: 'test_github_token_admin_aaaaaaaa',
  pub: 'test_github_token_pub_bbbbbbbbbb',
  other: 'test_github_token_other_cccccccc',
  third: 'test_github_token_third_dddddddd',
};

const user = (id: number, login: string): FakeUser => ({ id, login, name: `${login} Name`, type: 'User' });

const USERS: Record<string, FakeUser> = {
  [GH.admin!]: user(ADMIN_ID, 'alpadalar'),
  [GH.pub!]: user(11, 'pub'),
  [GH.other!]: user(12, 'other'),
  [GH.third!]: user(13, 'third'),
};

function publishBody(slug: string, content: unknown = preset()) {
  return {
    kind: 'preset',
    slug,
    name: `Name ${slug}`,
    description: 'desc',
    author: 'Alp',
    content,
    note: 'n',
  };
}

// counts executed statements, batches included
function counted(db: D1Database): { db: D1Database; n: { v: number } } {
  const n = { v: 0 };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...v) => wrap(s.bind(...v)),
    first: ((col?: string) => {
      n.v++;
      return col === undefined ? s.first() : s.first(col);
    }) as D1PreparedStatement['first'],
    all: () => {
      n.v++;
      return s.all();
    },
    run: () => {
      n.v++;
      return s.run();
    },
    raw: (o) => {
      n.v++;
      return s.raw(o);
    },
    // the real statement, for batch
    ...{ inner: s },
  });
  return {
    n,
    db: {
      prepare: (sql) => wrap(db.prepare(sql)),
      batch: (list) => {
        n.v += list.length;
        return db.batch(list.map((s) => (s as unknown as { inner: D1PreparedStatement }).inner));
      },
      exec: (sql) => db.exec(sql),
    },
  };
}

async function setup(vars: Partial<Env> = {}) {
  const { env, clock } = await makeEnv({
    ALLOW_UNVERIFIED_GITHUB_TOKENS: 'true',
    SIGNIN_LIMIT: '50',
    ...vars,
  });
  const db = env.DB;
  const c = counted(db);
  const fake = fakeGitHub({ users: USERS });
  const handler = createHandler({ ...env, DB: c.db } as Env, { now: clock.now, fetch: fake.fetch });
  const call = async (
    method: string,
    p: string,
    o: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': IP };
    Object.assign(headers, o.headers);
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const body =
      o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    c.n.v = 0;
    return handler.fetch(new Request(BASE + p, { method, headers, ...(body === undefined ? {} : { body }) }));
  };
  const signIn = async (who: keyof typeof GH): Promise<string> => {
    const r = await call('POST', '/v1/auth/github', { body: { token: GH[who] } });
    expect(r.status).toBe(200);
    return ((await r.json()) as { token: string }).token;
  };
  const get = async (p: string, token?: string) => {
    const r = await call('GET', p, token ? { token } : {});
    return { status: r.status, json: (await r.json()) as any, headers: r.headers };
  };
  const indexIds = async () => parseIndex((await get('/v1/index.json')).json)!.entries.map((e) => e.id);
  const rows = async (table: string) =>
    (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  const entry = async (p: string, s: string) =>
    db
      .prepare('SELECT state, summary, doc FROM entries WHERE publisher = ?1 AND slug = ?2')
      .bind(p, s)
      .first();
  const versionRows = async (p: string, s: string) =>
    (await db.prepare('SELECT * FROM versions WHERE publisher = ?1 AND slug = ?2').bind(p, s).all()).results;
  const publisher = async (h: string) =>
    db.prepare('SELECT trusted, banned_at, bytes FROM publishers WHERE handle = ?1').bind(h).first();
  return {
    env,
    db,
    clock,
    call,
    signIn,
    get,
    indexIds,
    rows,
    entry,
    versionRows,
    publisher,
    statements: c.n,
  };
}

async function error(r: Response): Promise<{ status: number; code: string }> {
  const b = (await r.json()) as { error: { code: string } };
  return { status: r.status, code: b.error.code };
}

const action = (id: string, a: 'approve' | 'reject' | 'remove') => adminActionPath(id, a);

describe.skipIf(!hasSqlite)('worker review of new publishers', () => {
  it('holds a first publish as pending until an admin approves it', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    expect(await s.publisher('pub')).toMatchObject({ trusted: 0 });

    const r = await s.call('POST', '/v1/entries', { token: pub, body: publishBody('first') });
    expect(r.status).toBe(201);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({ id: 'pub/first', version: 1, pending: true });
    expect(await s.indexIds()).toEqual([]);
    expect((await s.get('/v1/entries/pub/first.json')).status).toBe(404);
    expect((await s.get('/v1/entries/pub/first/1.json')).status).toBe(404);
    const me = parseMe((await s.get('/v1/me', pub)).json);
    expect(me?.entries).toEqual([{ id: 'pub/first', state: 'pending', version: 1 }]);

    const v = await s.call('POST', '/v1/entries/pub/first/versions', {
      token: pub,
      headers: { 'if-match': '"1"' },
      body: { content: preset('cwd') },
    });
    expect(v.status).toBe(201);
    expect(((await s.entry('pub', 'first')) as { state: string }).state).toBe('pending');
    expect(await s.indexIds()).toEqual([]);

    const list = await s.get(adminPendingPath(), admin);
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    const pending = parsePending(list.json);
    expect(pending?.entries.map((e) => e.id)).toEqual(['pub/first']);
    expect(pending?.entries[0]).toMatchObject({ version: 2, name: 'Name first' });
    expect(typeof pending?.entries[0]?.createdAt).toBe('string');

    const rv = await s.get(adminEntryPath('pub/first'), admin);
    expect(rv.status).toBe(200);
    expect(rv.headers.get('cache-control')).toBe('no-store');
    const review = parseReview(rv.json);
    expect(review).not.toBeNull();
    expect(review!.entry.state).toBe('pending');
    expect(review!.entry.version).toBe(2);
    expect(review!.content).toEqual(preset('cwd'));
    expect(review!.hash).toBe(review!.entry.hash);

    const ok = await s.call('POST', action('pub/first', 'approve'), { token: admin, body: { note: 'fine' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.json()).toEqual({ id: 'pub/first', approved: true });
    expect(await s.indexIds()).toEqual(['pub/first']);
    expect((await s.get('/v1/entries/pub/first.json')).status).toBe(200);
    expect((await s.get('/v1/entries/pub/first/2.json')).status).toBe(200);
    expect(await s.publisher('pub')).toMatchObject({ trusted: 1 });
    expect(parsePending((await s.get(adminPendingPath(), admin)).json)?.entries).toEqual([]);

    const second = await s.call('POST', '/v1/entries', { token: pub, body: publishBody('second') });
    expect(second.status).toBe(201);
    const sb = (await second.json()) as Record<string, unknown>;
    expect(sb.pending).toBeUndefined();
    expect(Object.keys(sb).sort()).toEqual(['hash', 'id', 'version']);
    expect(await s.indexIds()).toEqual(['pub/first', 'pub/second']);
  });

  it('approve, reject and remove only fit the right states', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('one') });
    expect((await s.call('POST', action('pub/one', 'approve'), { token: admin })).status).toBe(200);
    expect(await error(await s.call('POST', action('pub/one', 'approve'), { token: admin }))).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect(await error(await s.call('POST', action('pub/one', 'reject'), { token: admin }))).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect((await s.get('/v1/entries/pub/one.json')).status).toBe(200);
    for (const a of ['approve', 'reject'] as const) {
      expect(await error(await s.call('POST', action('pub/nope', a), { token: admin }))).toEqual({
        status: 404,
        code: 'not-found',
      });
    }
    expect((await s.get(adminEntryPath('pub/nope'), admin)).status).toBe(404);
  });

  it('reject deletes the pending rows and frees the slug and the bytes', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('nope') });
    expect(Number((await s.publisher('pub'))!.bytes)).toBeGreaterThan(0);
    const r = await s.call('POST', action('pub/nope', 'reject'), { token: admin, body: { note: 'spam' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 'pub/nope', rejected: true });
    expect(await s.entry('pub', 'nope')).toBeNull();
    expect(await s.versionRows('pub', 'nope')).toEqual([]);
    expect(await s.publisher('pub')).toMatchObject({ trusted: 0, bytes: 0 });
    expect((await s.get(adminEntryPath('pub/nope'), admin)).status).toBe(404);
    const again = await s.call('POST', '/v1/entries', { token: pub, body: publishBody('nope') });
    expect(again.status).toBe(201);
    expect(((await again.json()) as { pending?: boolean }).pending).toBe(true);
  });

  it('a publisher withdrawing a pending entry deletes its rows', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('oops') });
    const r = await s.call('DELETE', '/v1/entries/pub/oops', { token: pub });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: 'pub/oops', withdrawn: true });
    expect(await s.entry('pub', 'oops')).toBeNull();
    expect(await s.versionRows('pub', 'oops')).toEqual([]);
    expect(await s.publisher('pub')).toMatchObject({ bytes: 0 });
    const log = await s.rows('moderation');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ admin: 'pub', action: 'withdraw-pending', target: 'pub/oops', note: '' });
    expect((await s.call('POST', '/v1/entries', { token: pub, body: publishBody('oops') })).status).toBe(201);
  });

  it('admin routes need a token and an admin GitHub id', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('one') });
    const routes: [string, string][] = [
      ['GET', adminPendingPath()],
      ['GET', adminEntryPath('pub/one')],
      ['POST', action('pub/one', 'approve')],
      ['POST', action('pub/one', 'reject')],
    ];
    for (const [m, p] of routes) {
      expect(await error(await s.call(m, p)), p).toEqual({ status: 401, code: 'unauthorized' });
      expect(await error(await s.call(m, p, { token: 'f'.repeat(64) })), p).toEqual({
        status: 401,
        code: 'unauthorized',
      });
      expect(await error(await s.call(m, p, { token: pub })), p).toEqual({ status: 403, code: 'not-admin' });
    }
    expect(((await s.entry('pub', 'one')) as { state: string }).state).toBe('pending');
    expect(await s.rows('moderation')).toEqual([]);
  });

  it('decides admin by the numeric id, not the login', async () => {
    const s = await setup({ ADMIN_GITHUB_IDS: '12' });
    const pub = await s.signIn('pub');
    const other = await s.signIn('other');
    const alp = await s.signIn('admin');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('one') });
    expect((await s.call('GET', adminPendingPath(), { token: alp })).status).toBe(403);
    expect((await s.call('GET', adminPendingPath(), { token: other })).status).toBe(200);
  });

  it('logs every admin action with the admin handle and a sanitized note', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('a') });
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('b') });
    const note = `\u001b[31mok\u001b[0m\n${'x'.repeat(300)}`;
    await s.call('POST', action('pub/a', 'approve'), { token: admin, body: { note } });
    await s.call('POST', action('pub/b', 'reject'), { token: admin });
    const log = (await s.rows('moderation')) as Record<string, unknown>[];
    expect(log.map((r) => [r.admin, r.action, r.target])).toEqual([
      ['alpadalar', 'approve', 'pub/a'],
      ['alpadalar', 'reject', 'pub/b'],
    ]);
    const n = String(log[0]!.note);
    expect(n).not.toMatch(/[\u0000-\u001f]/);
    expect(n.startsWith('ok x')).toBe(true);
    expect([...n].length).toBe(200);
    expect(log[1]!.note).toBe('');
    expect(typeof log[0]!.at).toBe('string');
  });

  it('refuses bad notes and bodies on admin actions without writing', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('a') });
    expect(
      (await s.call('POST', action('pub/a', 'approve'), { token: admin, body: { note: 5 } })).status,
    ).toBe(400);
    expect((await s.call('POST', action('pub/a', 'approve'), { token: admin, body: '[1]' })).status).toBe(
      400,
    );
    expect((await s.call('POST', action('pub/a', 'approve'), { token: admin, body: '{' })).status).toBe(400);
    expect(
      (
        await s.call('POST', action('pub/a', 'approve'), {
          token: admin,
          body: '{}',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(((await s.entry('pub', 'a')) as { state: string }).state).toBe('pending');
    expect(await s.rows('moderation')).toEqual([]);
    expect((await s.call('POST', action('pub/a', 'approve'), { token: admin, body: {} })).status).toBe(200);
  });

  it('keeps every admin request within the D1 statement budget', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    for (const slug of ['a', 'b'])
      await s.call('POST', '/v1/entries', { token: pub, body: publishBody(slug) });
    for (const [m, p] of [
      ['GET', adminPendingPath()],
      ['GET', adminEntryPath('pub/a')],
      ['POST', action('pub/a', 'approve')],
      ['POST', action('pub/b', 'reject')],
    ] as const) {
      const r = await s.call(m, p, { token: admin });
      expect(r.status, p).toBe(200);
      expect(s.statements.v, p).toBeGreaterThan(0);
      expect(s.statements.v, p).toBeLessThanOrEqual(50);
    }
  });

  it('bad ids on admin routes are 400 after the admin check', async () => {
    const s = await setup();
    const admin = await s.signIn('admin');
    expect((await s.call('GET', '/v1/admin/entries/Bad/x', { token: admin })).status).toBe(400);
    expect((await s.call('POST', '/v1/admin/entries/a/b%2F/approve', { token: admin })).status).toBe(400);
    expect((await s.call('POST', '/v1/admin/entries/Bad/x/approve')).status).toBe(401);
    expect((await s.call('POST', '/v1/admin/entries/a/b/frobnicate', { token: admin })).status).toBe(404);
    expect((await s.call('DELETE', adminPendingPath(), { token: admin })).status).toBe(404);
  });
});
