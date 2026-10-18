import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMe, parseSignIn } from '../../src/market/protocol.js';
import type { Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { START } from './conformance.js';
import { hasSqlite } from './d1-sqlite.js';
import { type FakeGitHubOpts, type FakeUser, fakeGitHub } from './fake-github.js';
import { makeEnv } from './worker-env.js';
import { seedEntry, seedPublisher, seedToken } from './worker-seed.js';

const BASE = 'http://w.test';
const CLIENT_ID = 'Ov23liVCN9Nf6VlLv3St';
const preset = { layout: { lines: [[{ type: 'model' }]] } } as never;

// fixtures only; never shaped like real provider tokens
const T1 = 'test_github_token_one_aaaaaaaaaa';
const T2 = 'test_github_token_two_bbbbbbbbbb';
const T3 = 'test_github_token_three_cccccccc';

const user = (id: number, login: string, extra: Partial<FakeUser> = {}): FakeUser => ({
  id,
  login,
  name: `${login} Name`,
  type: 'User',
  ...extra,
});

async function setup(gh: FakeGitHubOpts, vars: Partial<Env> = {}) {
  const { env, clock } = await makeEnv({
    SIGNIN_LIMIT: '50',
    ALLOW_UNVERIFIED_GITHUB_TOKENS: 'true',
    ...vars,
  });
  const fake = fakeGitHub(gh);
  const handler = createHandler(env, { now: clock.now, fetch: fake.fetch });
  const bodies: string[] = [];
  const call = async (
    method: string,
    p: string,
    o: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.9',
      ...o.headers,
    };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const r = await handler.fetch(new Request(BASE + p, { method, headers, ...(body ? { body } : {}) }));
    bodies.push(await r.clone().text());
    return r;
  };
  const signIn = (token: string) => call('POST', '/v1/auth/github', { body: { token } });
  const rows = async (table: string) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
  return { env, db: env.DB, clock, fake, call, signIn, rows, bodies };
}

async function error(r: Response) {
  const b = (await r.json()) as { error: { code: string; message: string } };
  return { status: r.status, code: b.error.code, message: b.error.message };
}

const ok = async (r: Response) => {
  expect(r.status).toBe(200);
  const body = await r.json();
  const parsed = parseSignIn(body);
  expect(parsed).not.toBeNull();
  return parsed!;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!hasSqlite)('worker GitHub sign-in', () => {
  it('maps a new GitHub id to its lowercase login and calls GitHub once with the required headers', async () => {
    const s = await setup({ users: { [T1]: user(1, 'Octo-Cat') } });
    const r = await s.signIn(T1);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const b = await ok(r);
    expect(b).toMatchObject({ handle: 'octo-cat', displayName: 'Octo-Cat Name', admin: false });
    expect(s.fake.calls).toHaveLength(1);
    const c = s.fake.calls[0]!;
    expect(c.method).toBe('GET');
    expect(c.url).toBe('https://api.github.com/user');
    expect(c.headers.authorization).toBe(`Bearer ${T1}`);
    expect(c.headers.accept).toBe('application/vnd.github+json');
    expect(c.headers['x-github-api-version']).toBe('2026-03-10');
    expect(c.headers['user-agent']).toBe('ccinfobar-market');
    const [p] = await s.rows('publishers');
    expect(p).toMatchObject({ handle: 'octo-cat', github_id: 1, github_login: 'Octo-Cat', trusted: 0 });
    const tokens = await s.rows('tokens');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.handle).toBe('octo-cat');
    expect(tokens[0]!.sha256).not.toBe(b.token);
    const me = await s.call('GET', '/v1/me', { token: b.token });
    expect(me.status).toBe(200);
  });

  it('keeps the handle of a known id across renames and updates login and name', async () => {
    const gh = { users: { [T1]: user(1, 'Octo-Cat') } };
    const s = await setup(gh);
    await ok(await s.signIn(T1));
    gh.users[T1] = user(1, 'newname', { name: 'New Name' });
    const b = await ok(await s.signIn(T1));
    expect(b.handle).toBe('octo-cat');
    expect(b.displayName).toBe('New Name');
    const pubs = await s.rows('publishers');
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({ handle: 'octo-cat', github_login: 'newname', display_name: 'New Name' });
  });

  it('gives a different id with a taken login the first free variant', async () => {
    const s = await setup({
      users: { [T1]: user(1, 'Octo-Cat'), [T2]: user(2, 'octo-cat'), [T3]: user(3, 'OCTO-CAT') },
    });
    expect((await ok(await s.signIn(T1))).handle).toBe('octo-cat');
    expect((await ok(await s.signIn(T2))).handle).toBe('octo-cat-2');
    expect((await ok(await s.signIn(T3))).handle).toBe('octo-cat-3');
  });

  it('cuts the base of a 39-character login so the variant fits', async () => {
    const long = `a${'b'.repeat(36)}-c`;
    expect(long).toHaveLength(39);
    const s = await setup({ users: { [T1]: user(1, long), [T2]: user(2, long.toUpperCase()) } });
    expect((await ok(await s.signIn(T1))).handle).toBe(long);
    const v = (await ok(await s.signIn(T2))).handle;
    expect(v).toHaveLength(39);
    expect(v).toBe(`a${'b'.repeat(36)}-2`);
  });

  it('skips handles that are already taken by seeded publishers', async () => {
    const s = await setup({ users: { [T1]: user(9, 'taken') } });
    await seedPublisher(s.db, { handle: 'taken', githubId: 500 });
    await seedPublisher(s.db, { handle: 'taken-2', githubId: 501 });
    expect((await ok(await s.signIn(T1))).handle).toBe('taken-3');
  });

  it('refuses when no variant is free', async () => {
    const s = await setup({ users: { [T1]: user(9, 'full') } });
    await seedPublisher(s.db, { handle: 'full', githubId: 600 });
    for (let n = 2; n <= 20; n++) await seedPublisher(s.db, { handle: `full-${n}`, githubId: 600 + n });
    expect(await error(await s.signIn(T1))).toMatchObject({ status: 409, code: 'conflict' });
    expect(await s.rows('tokens')).toHaveLength(0);
  });

  it('refuses a new publisher at the publishers cap, but signs known ones in (WR-02)', async () => {
    const s = await setup({ users: { [T1]: user(1, 'octo'), [T2]: user(2, 'known') } });
    await seedPublisher(s.db, { handle: 'known', githubId: 2 });
    await s.db.prepare("UPDATE counters SET n = 10000 WHERE k = 'publishers'").run();
    expect(await error(await s.signIn(T1))).toEqual({
      status: 413,
      code: 'over-quota',
      message: 'too many publishers',
    });
    expect(await s.rows('publishers')).toHaveLength(1);
    expect((await ok(await s.signIn(T2))).handle).toBe('known');
    await s.db.prepare("UPDATE counters SET n = 9999 WHERE k = 'publishers'").run();
    expect((await ok(await s.signIn(T1))).handle).toBe('octo');
    expect(await s.db.prepare("SELECT n FROM counters WHERE k = 'publishers'").first('n')).toBe(10000);
  });

  it('decides admin by numeric GitHub id only', async () => {
    const s = await setup({
      users: { [T1]: user(65018489, 'someone-else'), [T2]: user(77, 'alpadalar') },
    });
    const a = await ok(await s.signIn(T1));
    expect(a.admin).toBe(true);
    const b = await ok(await s.signIn(T2));
    expect(b.admin).toBe(false);
    const me = parseMe(await (await s.call('GET', '/v1/me', { token: a.token })).json());
    expect(me?.admin).toBe(true);
    const me2 = parseMe(await (await s.call('GET', '/v1/me', { token: b.token })).json());
    expect(me2?.admin).toBe(false);
  });

  it('reads a comma list of admin ids', async () => {
    const s = await setup({ users: { [T1]: user(42, 'x') } }, { ADMIN_GITHUB_IDS: ' 7 , 42,9' });
    expect((await ok(await s.signIn(T1))).admin).toBe(true);
  });

  it('falls back to the login when the name is missing or empty, and sanitizes it', async () => {
    const s = await setup({
      users: {
        [T1]: user(1, 'NoName', { name: null }),
        [T2]: user(2, 'Esc', { name: `\u001b[31mRed\u001b[0m ${'n'.repeat(80)}` }),
        [T3]: user(3, 'Blank', { name: '   ' }),
      },
    });
    expect((await ok(await s.signIn(T1))).displayName).toBe('NoName');
    const b = await ok(await s.signIn(T2));
    expect(b.displayName).not.toContain('\u001b');
    expect([...b.displayName].length).toBeLessThanOrEqual(64);
    expect(b.displayName.startsWith('Red n')).toBe(true);
    expect((await ok(await s.signIn(T3))).displayName).toBe('Blank');
  });

  it('refuses organizations and malformed users', async () => {
    const bad: Record<string, FakeUser> = {
      [T1]: user(1, 'acme', { type: 'Organization' }),
      [T2]: user(-5, 'neg'),
      [T3]: user(3, '-bad-'),
    };
    const s = await setup({ users: bad });
    expect(await error(await s.signIn(T1))).toMatchObject({ status: 401, code: 'unauthorized' });
    expect((await s.signIn(T2)).status).toBe(502);
    expect((await s.signIn(T3)).status).toBe(502);
    for (const u of [
      user(1.5, 'frac'),
      user(2 ** 60, 'big'),
      { id: 1, login: 'x' },
      user(4, 'a'.repeat(40)),
    ]) {
      const t = 'test_github_token_loop_dddddddd';
      const s2 = await setup({ users: { [t]: u } });
      expect([401, 502]).toContain((await s2.signIn(t)).status);
      expect(await s2.rows('publishers')).toHaveLength(0);
    }
    expect(await s.rows('publishers')).toHaveLength(0);
  });

  it('maps GitHub answers to fixed errors without GitHub text', async () => {
    const cases: [Partial<FakeGitHubOpts>, number, string][] = [
      [{ status: 401 }, 401, 'unauthorized'],
      [{ status: 500 }, 502, 'upstream'],
      [{ status: 503 }, 502, 'upstream'],
      [{ status: 404 }, 502, 'upstream'],
      [{ bigBody: true }, 502, 'upstream'],
    ];
    for (const [o, status, code] of cases) {
      const s = await setup({ users: { [T1]: user(1, 'a') }, ...o });
      const r = await s.signIn(T1);
      const text = await r.clone().text();
      expect(text).not.toContain('GitHub says no');
      expect(await error(r)).toMatchObject({ status, code });
      expect(await s.rows('publishers')).toHaveLength(0);
    }
    const unknown = await setup({ users: {} });
    expect(await error(await unknown.signIn(T1))).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('maps GitHub rate limits to 429 with retry-after', async () => {
    const reset = Math.floor(START / 1000) + 90;
    const a = await setup({ users: {}, status: 403, headers: { 'x-ratelimit-reset': String(reset) } });
    const r = await a.signIn(T1);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(89);
    expect(Number(r.headers.get('retry-after'))).toBeLessThanOrEqual(91);
    expect((await error(r)).code).toBe('rate-limited');
    const b = await setup({ users: {}, status: 429, headers: { 'retry-after': '17' } });
    const r2 = await b.signIn(T1);
    expect(r2.status).toBe(429);
    expect(r2.headers.get('retry-after')).toBe('17');
    const c = await setup({ users: {}, status: 429 });
    const r3 = await c.signIn(T1);
    expect(r3.status).toBe(429);
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('times out a slow GitHub after 8 s with 502 upstream', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const asked: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      asked.push(ms);
      return real(5);
    });
    const s = await setup({ users: { [T1]: user(1, 'a') }, delayMs: Number.POSITIVE_INFINITY });
    expect(await error(await s.signIn(T1))).toMatchObject({ status: 502, code: 'upstream' });
    expect(asked).toContain(8000);
    expect(await s.rows('publishers')).toHaveLength(0);
  });

  it('turns a failing fetch into 502 upstream', async () => {
    const { env, clock } = await makeEnv({ ALLOW_UNVERIFIED_GITHUB_TOKENS: 'true' });
    const h = createHandler(env, { now: clock.now, fetch: () => Promise.reject(new Error(`boom ${T1}`)) });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await h.fetch(
      new Request(`${BASE}/v1/auth/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: T1 }),
      }),
    );
    expect(await error(r)).toMatchObject({ status: 502, code: 'upstream' });
    expect(JSON.stringify(spy.mock.calls)).not.toContain(T1);
  });

  it('checks the body before calling GitHub', async () => {
    const s = await setup({ users: { [T1]: user(1, 'a') } });
    const bad: unknown[] = [{}, { token: 5 }, { token: 'short' }, { token: `${'a'.repeat(20)}-x` }, []];
    bad.push({ token: 'a'.repeat(256) });
    for (const body of bad) {
      expect(await error(await s.call('POST', '/v1/auth/github', { body }))).toMatchObject({
        status: 400,
        code: 'invalid',
      });
    }
    const r415 = await s.call('POST', '/v1/auth/github', {
      raw: JSON.stringify({ token: T1 }),
      headers: { 'content-type': 'text/plain' },
    });
    expect(r415.status).toBe(415);
    const big = await s.call('POST', '/v1/auth/github', {
      raw: JSON.stringify({ token: T1, pad: 'x'.repeat(5000) }),
    });
    expect(big.status).toBe(413);
    expect((await s.call('POST', '/v1/auth/github', { raw: '{nope' })).status).toBe(400);
    expect(s.fake.calls).toHaveLength(0);
  });

  it('refuses a banned publisher without issuing a token', async () => {
    const s = await setup({ users: { [T1]: user(321, 'bad') } });
    await seedPublisher(s.db, { handle: 'bad', githubId: 321, banned: true });
    expect(await error(await s.signIn(T1))).toMatchObject({ status: 403, code: 'banned' });
    expect(await s.rows('tokens')).toHaveLength(0);
  });

  it('keeps at most 10 tokens per publisher, the newest ones', async () => {
    const s = await setup({ users: { [T1]: user(1, 'many'), [T2]: user(2, 'other') } });
    const other = await ok(await s.signIn(T2));
    const issued: string[] = [];
    for (let i = 0; i < 11; i++) {
      issued.push((await ok(await s.signIn(T1))).token);
      s.clock.advance(1000);
    }
    const tokens = await s.rows('tokens');
    expect(tokens.filter((t) => t.handle === 'many')).toHaveLength(10);
    expect(tokens.filter((t) => t.handle === 'other')).toHaveLength(1);
    expect((await s.call('GET', '/v1/me', { token: issued[0] })).status).toBe(401);
    expect((await s.call('GET', '/v1/me', { token: issued[10] })).status).toBe(200);
    expect((await s.call('GET', '/v1/me', { token: other.token })).status).toBe(200);
  });

  it('keeps the newest token when sign-ins share a timestamp', async () => {
    const s = await setup({ users: { [T1]: user(1, 'same') } });
    let last = '';
    for (let i = 0; i < 12; i++) last = (await ok(await s.signIn(T1))).token;
    expect(await s.rows('tokens')).toHaveLength(10);
    expect((await s.call('GET', '/v1/me', { token: last })).status).toBe(200);
  });

  it('never stores, answers or logs the GitHub token', async () => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = await setup({ users: { [T1]: user(1, 'Keep'), [T2]: user(1, 'Keep') } });
    await ok(await s.signIn(T1));
    await ok(await s.signIn(T2));
    await s.signIn(T3);
    for (const table of ['publishers', 'tokens', 'rate', 'salts', 'counters', 'moderation']) {
      const text = JSON.stringify(await s.rows(table));
      for (const t of [T1, T2, T3]) expect(text, table).not.toContain(t);
    }
    for (const b of s.bodies) for (const t of [T1, T2, T3]) expect(b).not.toContain(t);
    const logged = JSON.stringify([logs.mock.calls, warn.mock.calls, log.mock.calls]);
    for (const t of [T1, T2, T3]) expect(logged).not.toContain(t);
  });

  it('rate limits sign-ins per address with SIGNIN_LIMIT', async () => {
    const s = await setup({ users: { [T1]: user(1, 'a') } }, { SIGNIN_LIMIT: '2' });
    await ok(await s.signIn(T1));
    await ok(await s.signIn(T1));
    const r = await s.signIn(T1);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(s.fake.calls).toHaveLength(2);
    const keys = (await s.rows('rate')).map((x) => String(x.key));
    expect(keys.some((k) => k.startsWith('a:'))).toBe(true);
    expect(keys.join()).not.toContain('203.0.113.9');
    s.clock.advance(60_000);
    await ok(await s.signIn(T1));
  });

  it('counts a refused body against the sign-in bucket', async () => {
    const s = await setup({ users: {} }, { SIGNIN_LIMIT: '1' });
    expect((await s.call('POST', '/v1/auth/github', { body: {} })).status).toBe(400);
    expect((await s.signIn(T1)).status).toBe(429);
  });

  it('cleans old salts and rate rows on sign-in', async () => {
    const s = await setup({ users: { [T1]: user(1, 'a') } });
    await s.db
      .prepare("INSERT INTO salts (day, salt) VALUES ('2000-01-01', 'old'), ('2000-01-02', 'old2')")
      .run();
    await s.db.prepare("INSERT INTO rate (key, win, n) VALUES ('w:old', 0, 1)").run();
    await ok(await s.signIn(T1));
    const days = (await s.rows('salts')).map((r) => r.day);
    expect(days).not.toContain('2000-01-01');
    expect((await s.rows('rate')).map((r) => r.key)).not.toContain('w:old');
  });
});

describe.skipIf(!hasSqlite)('worker check-token hardening', () => {
  const secret = 's3cret';
  const checked = (o: Partial<NonNullable<FakeGitHubOpts['checkToken']>> = {}) => ({
    users: { [T1]: user(1, 'Octo') },
    checkToken: { clientId: CLIENT_ID, secret, ...o },
  });

  it('verifies the token with the check-token API only, when the secret is set', async () => {
    const s = await setup(checked(), { GITHUB_CLIENT_SECRET: secret });
    const b = await ok(await s.signIn(T1));
    expect(b.handle).toBe('octo');
    expect(s.fake.calls).toHaveLength(2);
    const c = s.fake.calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);
    expect(c.headers.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:${secret}`)}`);
    expect(c.headers.accept).toBe('application/vnd.github+json');
    expect(c.headers['x-github-api-version']).toBe('2026-03-10');
    expect(c.headers['user-agent']).toBe('ccinfobar-market');
    expect(JSON.parse(c.body)).toEqual({ access_token: T1 });
    // then the token is revoked at GitHub (IN-03)
    const d = s.fake.calls[1]!;
    expect(d.method).toBe('DELETE');
    expect(d.url).toBe(c.url);
    expect(d.headers.authorization).toBe(c.headers.authorization);
    expect(JSON.parse(d.body)).toEqual({ access_token: T1 });
  });

  it('revokes the token also for a banned publisher, and a failed revoke never fails the sign-in', async () => {
    const s = await setup(checked(), { GITHUB_CLIENT_SECRET: secret });
    await seedPublisher(s.db, { handle: 'octo', githubId: 1, banned: true });
    expect((await s.signIn(T1)).status).toBe(403);
    expect(s.fake.calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    const failing = fakeGitHub(checked());
    const { env, clock } = await makeEnv({ GITHUB_CLIENT_SECRET: secret, SIGNIN_LIMIT: '50' });
    const h = createHandler(env, {
      now: clock.now,
      fetch: (async (i: RequestInfo | URL, o?: RequestInit) => {
        if (o?.method === 'DELETE') throw new Error('network down');
        return failing.fetch(i, o);
      }) as typeof fetch,
    });
    const r = await h.fetch(
      new Request(`${BASE}/v1/auth/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: T1 }),
      }),
    );
    expect(r.status).toBe(200);
  });

  it('answers 401 when GitHub does not know the token for our app', async () => {
    const s = await setup(checked(), { GITHUB_CLIENT_SECRET: secret });
    expect(await error(await s.signIn(T2))).toMatchObject({ status: 401, code: 'unauthorized' });
    const u = await setup(checked({ status: 422 }), { GITHUB_CLIENT_SECRET: secret });
    expect(await error(await u.signIn(T1))).toMatchObject({ status: 401, code: 'unauthorized' });
    expect(u.fake.calls.every((c) => c.method === 'POST')).toBe(true);
  });

  it('refuses a token GitHub reports for another app, or without an app', async () => {
    for (const appClientId of ['Ov23liOtherApp00000', null, '']) {
      const s = await setup(checked({ appClientId }), { GITHUB_CLIENT_SECRET: secret });
      expect(await error(await s.signIn(T1))).toMatchObject({ status: 401, code: 'unauthorized' });
      expect(s.fake.calls).toHaveLength(1);
      expect(await s.rows('publishers')).toHaveLength(0);
    }
  });

  it('uses check-token with the secret even without the opt-out', async () => {
    const s = await setup(checked(), {
      GITHUB_CLIENT_SECRET: secret,
      ALLOW_UNVERIFIED_GITHUB_TOKENS: undefined,
    });
    expect((await ok(await s.signIn(T1))).handle).toBe('octo');
    expect(s.fake.calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['POST', `/applications/${CLIENT_ID}/token`],
      ['DELETE', `/applications/${CLIENT_ID}/token`],
    ]);
  });

  it('answers 503 when neither the secret nor the opt-out is set, before any GitHub call or row write', async () => {
    for (const v of [undefined, 'false', '1', 'TRUE', ' true']) {
      const s = await setup(checked(), { ALLOW_UNVERIFIED_GITHUB_TOKENS: v });
      const r = await s.signIn(T1);
      expect(await error(r)).toEqual({
        status: 503,
        code: 'unavailable',
        message: 'sign-in is not configured',
      });
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(s.fake.calls).toHaveLength(0);
      for (const t of ['publishers', 'tokens', 'rate', 'salts']) expect(await s.rows(t)).toHaveLength(0);
    }
  });

  it('answers 503 when the secret is set without a valid client id', async () => {
    for (const id of [undefined, '', 'bad id!']) {
      const s = await setup(checked(), { GITHUB_CLIENT_SECRET: secret, GITHUB_CLIENT_ID: id });
      expect((await s.signIn(T1)).status).toBe(503);
      expect(s.fake.calls).toHaveLength(0);
    }
  });

  it('a token of another app is refused', async () => {
    const s = await setup(checked({ clientId: 'Ov23liOtherApp00000' }), { GITHUB_CLIENT_SECRET: secret });
    expect((await s.signIn(T1)).status).toBe(401);
  });

  it('a wrong secret is an upstream error, not the user', async () => {
    const s = await setup(checked(), { GITHUB_CLIENT_SECRET: 'wrong' });
    expect(await error(await s.signIn(T1))).toMatchObject({ status: 502, code: 'upstream' });
  });

  it('falls back to /user when the check-token answer has no user', async () => {
    const s = await setup(checked({ noUser: true }), { GITHUB_CLIENT_SECRET: secret });
    expect((await ok(await s.signIn(T1))).handle).toBe('octo');
    expect(s.fake.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `POST /applications/${CLIENT_ID}/token`,
      'GET /user',
      `DELETE /applications/${CLIENT_ID}/token`,
    ]);
  });

  it('uses /user only without the secret when the opt-out is set', async () => {
    const s = await setup(checked());
    await ok(await s.signIn(T1));
    expect(s.fake.calls.map((c) => new URL(c.url).pathname)).toEqual(['/user']);
  });

  it('never logs or stores the secret', async () => {
    const s = await setup(checked(), { GITHUB_CLIENT_SECRET: secret });
    await ok(await s.signIn(T1));
    for (const table of ['publishers', 'tokens', 'rate', 'salts']) {
      expect(JSON.stringify(await s.rows(table))).not.toContain(secret);
    }
    for (const b of s.bodies) expect(b).not.toContain(secret);
  });
});

describe.skipIf(!hasSqlite)('worker logout and /v1/me', () => {
  it('logout revokes only the presented token', async () => {
    const s = await setup({ users: { [T1]: user(1, 'octo') } });
    const a = await ok(await s.signIn(T1));
    const b = await ok(await s.signIn(T1));
    const r = await s.call('POST', '/v1/auth/logout', { token: a.token });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await s.call('GET', '/v1/me', { token: a.token })).status).toBe(401);
    expect((await s.call('GET', '/v1/me', { token: b.token })).status).toBe(200);
    expect(await error(await s.call('POST', '/v1/auth/logout', { token: a.token }))).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect((await s.call('POST', '/v1/auth/logout')).status).toBe(401);
    expect(s.fake.calls).toHaveLength(2);
  });

  it('/v1/me lists own pending and live entries only', async () => {
    const s = await setup({ users: {} });
    await seedPublisher(s.db, { handle: 'me', githubId: 10, trusted: true });
    await seedPublisher(s.db, { handle: 'you', githubId: 11 });
    const token = await seedToken(s.db, 'me');
    await seedEntry(s.db, { id: 'me/live-one', versions: [{ content: preset }, { content: preset }] });
    await seedEntry(s.db, { id: 'me/waiting', state: 'pending', versions: [{ content: preset }] });
    await seedEntry(s.db, { id: 'me/gone', state: 'withdrawn', versions: [{ content: preset }] });
    await seedEntry(s.db, { id: 'me/removed', state: 'removed', versions: [{ content: preset }] });
    await seedEntry(s.db, { id: 'you/theirs', versions: [{ content: preset }] });
    const r = await s.call('GET', '/v1/me', { token });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const body = await r.json();
    expect(body).toEqual({
      handle: 'me',
      displayName: 'ME',
      login: 'me',
      admin: false,
      trusted: true,
      entries: [
        { id: 'me/live-one', state: 'live', version: 2 },
        { id: 'me/waiting', state: 'pending', version: 1 },
      ],
    });
    expect(parseMe(body)).toEqual(body);
  });

  it('/v1/me needs a known token', async () => {
    const s = await setup({ users: {} });
    expect(await error(await s.call('GET', '/v1/me'))).toMatchObject({ status: 401, code: 'unauthorized' });
    expect((await s.call('GET', '/v1/me', { token: 'f'.repeat(64) })).status).toBe(401);
    expect((await s.call('GET', '/v1/me', { headers: { authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('/v1/me refuses a banned publisher', async () => {
    const s = await setup({ users: {} });
    await seedPublisher(s.db, { handle: 'gone', githubId: 12, banned: true });
    const token = await seedToken(s.db, 'gone');
    expect(await error(await s.call('GET', '/v1/me', { token }))).toMatchObject({
      status: 403,
      code: 'banned',
    });
  });

  it('other methods on the auth paths stay 404', async () => {
    const s = await setup({ users: {} });
    expect((await s.call('GET', '/v1/auth/github')).status).toBe(404);
    expect((await s.call('PUT', '/v1/auth/logout')).status).toBe(404);
    expect((await s.call('POST', '/v1/me')).status).toBe(404);
    expect((await s.call('GET', '/v1/auth/logout')).status).toBe(404);
  });
});
