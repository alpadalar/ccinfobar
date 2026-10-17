import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import {
  adminActionPath,
  adminEntryPath,
  adminPendingPath,
  adminPublisherPath,
  adminReportsPath,
  adminResolvePath,
  parseIndex,
  parseMe,
  parsePending,
  parseRemoteEntry,
  parseReports,
  parseReview,
  reportPath,
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
    for (const a of ['approve', 'reject', 'remove'] as const) {
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
      ['POST', action('pub/one', 'remove')],
      ['POST', adminPublisherPath('pub', 'ban')],
      ['POST', adminPublisherPath('pub', 'unban')],
      ['GET', adminReportsPath()],
      ['POST', adminResolvePath(1)],
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
      ['POST', action('pub/a', 'remove')],
      ['POST', adminPublisherPath('pub', 'ban')],
      ['POST', adminPublisherPath('pub', 'unban')],
      ['GET', adminReportsPath()],
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

describe.skipIf(!hasSqlite)('worker moderation', () => {
  // a trusted publisher with live entries
  async function live(vars: Partial<Env> = {}, slugs = ['one', 'two']) {
    const s = await setup(vars);
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    const other = await s.signIn('other');
    const [first, ...rest] = slugs;
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody(first!) });
    expect((await s.call('POST', action(`pub/${first}`, 'approve'), { token: admin })).status).toBe(200);
    for (const slug of rest) {
      expect((await s.call('POST', '/v1/entries', { token: pub, body: publishBody(slug) })).status).toBe(201);
    }
    return { ...s, pub, admin, other };
  }
  const reportOf = (s: Awaited<ReturnType<typeof live>>, id: string, reason: unknown, token = s.other) =>
    s.call('POST', reportPath(id), { token, body: { reason } });

  it('remove leaves a blanked tombstone, NULL bodies, freed bytes and resolved reports', async () => {
    const s = await live();
    expect((await reportOf(s, 'pub/one', 'bad')).status).toBe(201);
    expect((await reportOf(s, 'pub/two', 'other')).status).toBe(201);
    const r = await s.call('POST', action('pub/one', 'remove'), { token: s.admin, body: { note: 'abuse' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ id: 'pub/one', removed: true });
    expect(await s.indexIds()).toEqual(['pub/two']);
    const doc = await s.get('/v1/entries/pub/one.json');
    expect(doc.status).toBe(200);
    const e = parseRemoteEntry(doc.json)!;
    expect(e).toMatchObject({ name: '', description: '', author: '', withdrawn: true });
    expect(e.versions.every((v) => v.note === '')).toBe(true);
    expect(JSON.stringify(doc.json)).not.toContain('Name one');
    expect((await s.get('/v1/entries/pub/one/1.json')).status).toBe(410);
    expect(((await s.entry('pub', 'one')) as { state: string }).state).toBe('removed');
    expect((await s.versionRows('pub', 'one')).map((v) => v.body)).toEqual([null]);
    const reports = (await s.rows('reports')) as Record<string, unknown>[];
    expect(reports.map((x) => [x.slug, x.resolved_at === null])).toEqual([
      ['one', false],
      ['two', true],
    ]);
    const bytes = Number((await s.publisher('pub'))!.bytes);
    const left = (await s.versionRows('pub', 'two')).reduce(
      (n, v) => n + new TextEncoder().encode(String(v.body)).length,
      0,
    );
    expect(bytes).toBe(left);
    expect(
      await error(await s.call('POST', '/v1/entries', { token: s.pub, body: publishBody('one') })),
    ).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect(await error(await s.call('POST', action('pub/one', 'remove'), { token: s.admin }))).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect((await s.get(adminEntryPath('pub/one'), s.admin)).status).toBe(410);
    const log = (await s.rows('moderation')) as Record<string, unknown>[];
    expect(log.at(-1)).toMatchObject({
      admin: 'alpadalar',
      action: 'remove',
      target: 'pub/one',
      note: 'abuse',
    });
  });

  it('remove also takes a pending entry', async () => {
    const s = await setup();
    const pub = await s.signIn('pub');
    const admin = await s.signIn('admin');
    await s.call('POST', '/v1/entries', { token: pub, body: publishBody('wait') });
    expect((await s.call('POST', action('pub/wait', 'remove'), { token: admin })).status).toBe(200);
    expect(((await s.entry('pub', 'wait')) as { state: string }).state).toBe('removed');
    expect(parsePending((await s.get(adminPendingPath(), admin)).json)?.entries).toEqual([]);
    expect(parseMe((await s.get('/v1/me', pub)).json)?.entries).toEqual([]);
  });

  it('ban hides the entries and stops writes until unban', async () => {
    const s = await live();
    const before = (await s.get('/v1/index.json')).headers.get('etag');
    const b = await s.call('POST', adminPublisherPath('pub', 'ban'), {
      token: s.admin,
      body: { note: 'spam' },
    });
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ handle: 'pub', banned: true });
    expect((await s.get('/v1/index.json')).headers.get('etag')).not.toBe(before);
    expect(await s.indexIds()).toEqual([]);
    expect((await s.get('/v1/entries/pub/one.json')).status).toBe(404);
    expect((await s.get('/v1/entries/pub/one/1.json')).status).toBe(404);
    expect(
      await error(await s.call('POST', '/v1/entries', { token: s.pub, body: publishBody('new') })),
    ).toEqual({
      status: 403,
      code: 'banned',
    });
    expect((await s.call('DELETE', '/v1/entries/pub/one', { token: s.pub })).status).toBe(403);
    expect((await reportOf(s, 'pub/one', 'x')).status).toBe(404);
    expect((await reportOf(s, 'other/x', 'x', s.pub)).status).toBe(403);
    const at = (await s.publisher('pub'))!.banned_at;
    expect(typeof at).toBe('string');
    expect((await s.call('POST', adminPublisherPath('pub', 'ban'), { token: s.admin })).status).toBe(200);
    expect((await s.publisher('pub'))!.banned_at).toBe(at);

    const u = await s.call('POST', adminPublisherPath('pub', 'unban'), { token: s.admin });
    expect(u.status).toBe(200);
    expect(await u.json()).toEqual({ handle: 'pub', banned: false });
    expect(await s.indexIds()).toEqual(['pub/one', 'pub/two']);
    expect((await s.get('/v1/entries/pub/one.json')).status).toBe(200);
    expect((await s.call('POST', '/v1/entries', { token: s.pub, body: publishBody('new') })).status).toBe(
      201,
    );
    const log = (await s.rows('moderation')) as Record<string, unknown>[];
    expect(log.slice(-3).map((r) => [r.action, r.target, r.note])).toEqual([
      ['ban', 'pub', 'spam'],
      ['ban', 'pub', ''],
      ['unban', 'pub', ''],
    ]);
  });

  it('never bans an admin and answers 404 for unknown publishers', async () => {
    const s = await live({ ADMIN_GITHUB_IDS: `${ADMIN_ID},12` });
    expect(
      await error(await s.call('POST', adminPublisherPath('alpadalar', 'ban'), { token: s.admin })),
    ).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect(await error(await s.call('POST', adminPublisherPath('other', 'ban'), { token: s.admin }))).toEqual(
      {
        status: 409,
        code: 'conflict',
      },
    );
    expect(
      await error(await s.call('POST', adminPublisherPath('nobody', 'ban'), { token: s.admin })),
    ).toEqual({
      status: 404,
      code: 'not-found',
    });
    expect((await s.call('POST', '/v1/admin/publishers/Bad/ban', { token: s.admin })).status).toBe(400);
    expect((await s.call('POST', '/v1/admin/publishers/pub/mute', { token: s.admin })).status).toBe(404);
    expect((await s.publisher('alpadalar'))!.banned_at).toBeNull();
  });

  it('takes one short sanitized report per entry and reporter', async () => {
    const s = await live({}, ['one', 'two', 'three']);
    const r = await reportOf(s, 'pub/one', '  spam  ');
    expect(r.status).toBe(201);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const { id } = (await r.json()) as { id: number };
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(((await s.rows('reports')) as Record<string, unknown>[])[0]).toMatchObject({
      id,
      publisher: 'pub',
      slug: 'one',
      reporter: 'other',
      reason: 'spam',
      resolved_at: null,
    });
    expect(await error(await reportOf(s, 'pub/one', 'again'))).toEqual({ status: 409, code: 'conflict' });
    for (const bad of ['', '   ', 'x'.repeat(201), 5, null, '\u001b[31m\u001b[0m']) {
      expect(await error(await reportOf(s, 'pub/two', bad)), String(bad)).toEqual({
        status: 400,
        code: 'invalid',
      });
    }
    expect(await error(await s.call('POST', reportPath('pub/two'), { token: s.other, body: '[1]' }))).toEqual(
      {
        status: 400,
        code: 'invalid',
      },
    );
    expect((await reportOf(s, 'pub/two', `\u001b[31m${'y'.repeat(200)}\u001b[0m`)).status).toBe(201);
    expect((await reportOf(s, 'pub/three', 'x', s.pub)).status).toBe(201);
    expect(await error(await reportOf(s, 'pub/nope', 'x'))).toEqual({ status: 404, code: 'not-found' });
    expect(await error(await s.call('POST', reportPath('pub/one'), { body: { reason: 'x' } }))).toEqual({
      status: 401,
      code: 'unauthorized',
    });
    expect(
      (await s.call('POST', '/v1/entries/Bad/x/reports', { token: s.other, body: { reason: 'x' } })).status,
    ).toBe(400);
  });

  it('reports only reach live entries', async () => {
    const s = await live();
    await s.call('POST', '/v1/entries', { token: s.other, body: publishBody('wait') });
    expect(await error(await reportOf(s, 'other/wait', 'x', s.pub))).toEqual({
      status: 404,
      code: 'not-found',
    });
    await s.call('DELETE', '/v1/entries/pub/two', { token: s.pub });
    expect(await error(await reportOf(s, 'pub/two', 'x'))).toEqual({ status: 404, code: 'not-found' });
    expect(await s.rows('reports')).toEqual([]);
  });

  it('rate limits reports per reporter', async () => {
    const s = await live({ REPORT_LIMIT: '1' });
    expect((await reportOf(s, 'pub/one', 'x')).status).toBe(201);
    const r = await reportOf(s, 'pub/two', 'y');
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await reportOf(s, 'pub/two', 'y', s.admin)).status).toBe(201);
    s.clock.advance(3_600_000);
    expect((await reportOf(s, 'pub/two', 'y')).status).toBe(201);
  });

  it('admins list open reports newest first and resolve them', async () => {
    const s = await live();
    const third = await s.signIn('third');
    await reportOf(s, 'pub/one', 'first');
    s.clock.advance(1000);
    await reportOf(s, 'pub/two', 'second', third);
    const list = await s.get(adminReportsPath(), s.admin);
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    const parsed = parseReports(list.json)!;
    expect(parsed.reports.map((r) => [r.entry, r.reporter, r.reason])).toEqual([
      ['pub/two', 'third', 'second'],
      ['pub/one', 'other', 'first'],
    ]);
    expect(list.json).toEqual(parsed);
    const id = parsed.reports[1]!.id;
    const r = await s.call('POST', adminResolvePath(id), { token: s.admin, body: { note: 'checked' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id, resolved: true });
    expect(
      parseReports((await s.get(adminReportsPath(), s.admin)).json)!.reports.map((x) => x.entry),
    ).toEqual(['pub/two']);
    expect((await s.call('POST', adminResolvePath(id), { token: s.admin })).status).toBe(200);
    expect(await error(await s.call('POST', adminResolvePath(999), { token: s.admin }))).toEqual({
      status: 404,
      code: 'not-found',
    });
    expect((await s.call('POST', '/v1/admin/reports/0/resolve', { token: s.admin })).status).toBe(400);
    const log = (await s.rows('moderation')) as Record<string, unknown>[];
    expect(log.filter((x) => x.action === 'resolve').map((x) => [x.target, x.note])).toEqual([
      [`report/${id}`, 'checked'],
      [`report/${id}`, ''],
    ]);
  });

  it('keeps no IP address and no GitHub token in reports or the log', async () => {
    const s = await live();
    await reportOf(s, 'pub/one', 'spam');
    await s.call('POST', action('pub/one', 'remove'), { token: s.admin, body: { note: 'gone' } });
    await s.call('POST', adminPublisherPath('pub', 'ban'), { token: s.admin });
    const text = JSON.stringify([await s.rows('reports'), await s.rows('moderation')]);
    expect(text).not.toContain(IP);
    for (const t of Object.values(GH)) expect(text).not.toContain(t);
    for (const t of [s.pub, s.admin, s.other]) expect(text).not.toContain(t);
    const cols = (table: string) =>
      s.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
    expect((await cols('reports')).results.map((c) => c.name)).toEqual([
      'id',
      'publisher',
      'slug',
      'reporter',
      'reason',
      'created_at',
      'resolved_at',
    ]);
  });
});
