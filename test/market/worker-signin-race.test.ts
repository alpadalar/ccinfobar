import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { skipSqlite } from './d1-sqlite.js';
import { type FakeGitHubOpts, fakeGitHub } from './fake-github.js';
import { makeEnv } from './worker-env.js';

const BASE = 'http://w.test';
const LIMIT = 5;
const GOOD = 'test_github_token_good_aaaaaaaaa';
const bad = (i: number) => `test_github_token_nope_${i}_aaaaaaaa`;

async function setup(gh: FakeGitHubOpts, vars: Partial<Env> = {}, gate?: Promise<void>) {
  const { env, clock } = await makeEnv({
    SIGNIN_LIMIT: String(LIMIT),
    ALLOW_UNVERIFIED_GITHUB_TOKENS: 'true',
    ...vars,
  });
  const fake = fakeGitHub(gh);
  let waiting = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    waiting++;
    if (gate) await gate;
    return fake.fetch(input, init);
  }) as typeof fetch;
  const handler = createHandler(env, { now: clock.now, fetch: fetchFn });
  const signIn = (token: string, ip = '203.0.113.9') =>
    handler.fetch(
      new Request(`${BASE}/v1/auth/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ token }),
      }),
    );
  const fails = async () => {
    const rows = (await env.DB.prepare('SELECT n FROM rate WHERE key LIKE ?1').bind('a:%').all()).results;
    return rows.map((r) => Number((r as { n: unknown }).n));
  };
  return { env, fake, signIn, fails, waiting: () => waiting };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(skipSqlite)('sign-in failure slot', () => {
  it('refuses parallel failures beyond the limit before calling GitHub', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = await setup({ users: {} }, {}, gate);
    const all = Array.from({ length: 10 }, (_, i) => s.signIn(bad(i)));
    const settled: number[] = [];
    for (const p of all) void p.then((r) => settled.push(r.status));
    for (let i = 0; i < 100 && s.waiting() + settled.length < 10; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    const codes = (await Promise.all(all)).map((r) => r.status);
    expect(s.fake.calls.length).toBeLessThanOrEqual(LIMIT + 1);
    expect(codes.filter((c) => c === 429).length).toBe(10 - s.fake.calls.length);
    expect(codes.filter((c) => c === 401).length).toBe(s.fake.calls.length);
  });

  it('leaves the sequential behaviour as it was', async () => {
    const s = await setup({ users: { [GOOD]: { id: 1, login: 'a', name: 'A', type: 'User' } } });
    for (let i = 0; i < LIMIT; i++) expect((await s.signIn(bad(i))).status).toBe(401);
    expect(await s.fails()).toEqual([LIMIT]);
    expect((await s.signIn(GOOD)).status).toBe(200);
    expect(await s.fails()).toEqual([LIMIT]);
    const t = await setup({ users: {} });
    for (let i = 0; i < LIMIT + 1; i++) expect((await t.signIn(bad(i), '203.0.113.10')).status).toBe(401);
    expect((await t.signIn(bad(9), '203.0.113.10')).status).toBe(429);
    expect(await t.fails()).toEqual([LIMIT + 1]);
  });

  it('does not keep a slot for an error that is not a failed sign-in', async () => {
    const s = await setup({ users: {}, status: 500 });
    expect((await s.signIn(GOOD)).status).toBe(502);
    expect(await s.fails()).toEqual([]);
    const u = await setup(
      { users: { [GOOD]: { id: 1, login: 'a', name: 'A', type: 'User' } } },
      {
        SIGNIN_LIMIT: '1',
      },
    );
    expect((await u.signIn(GOOD)).status).toBe(200);
    expect((await u.signIn(GOOD)).status).toBe(429);
    expect(await u.fails()).toEqual([]);
  });
});
