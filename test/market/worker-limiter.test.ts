import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryAfterSeconds, windowOf } from '../../src/market/rules.js';
import type { Env, RateLimit } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { MEMORY_LIMITS, MemoryLimiter, RateCounter } from '../../src/market/worker/limiter.js';
import { bindingAllowed } from '../../src/market/worker/rate.js';
import { START } from './conformance.js';
import { skipSqlite } from './d1-sqlite.js';
import { fakeLimiter, type LimiterFault, makeEnv } from './worker-env.js';

const BASE = 'http://w.test';
const IP = '203.0.113.7';
const T = START;

afterEach(() => vi.restoreAllMocks());

describe('MemoryLimiter', () => {
  it('counts per key in a fixed window', () => {
    const m = new MemoryLimiter();
    for (let i = 0; i < 30; i++) expect(m.hit('w:k', 30, T)).toBe(true);
    expect(m.hit('w:k', 30, T)).toBe(false);
    expect(m.hit('w:other', 30, T)).toBe(true);
    expect(m.hit('w:k', 30, windowOf(T) + 60_000)).toBe(true);
  });

  it('caps the key set and clears on overflow', () => {
    const m = new MemoryLimiter();
    for (let i = 0; i < 5_000; i++) m.hit(`r:${i}`, 1, T);
    expect(m.size).toBe(5_000);
    expect(m.hit('r:new', 1, T)).toBe(true);
    expect(m.size).toBe(1);
    expect(m.hit('r:0', 1, T)).toBe(true);
  });

  it('limits equal the wrangler.jsonc simple limits', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../../worker/wrangler.jsonc'), 'utf8');
    const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as {
      ratelimits: { name: string; simple: { limit: number } }[];
    };
    const by = (n: string) => cfg.ratelimits.find((r) => r.name === n)?.simple.limit;
    expect(MEMORY_LIMITS).toEqual({ r: by('READS'), w: by('WRITES'), a: by('SIGNIN') });
    expect(MEMORY_LIMITS).toEqual({ r: 60, w: 30, a: 20 });
  });
});

describe('binding outcome logs', () => {
  const req = new Request(`${BASE}/v1/index.json`, { headers: { 'cf-connecting-ip': IP } });
  const bind = (fn: () => Promise<unknown>): RateLimit => ({ limit: fn as RateLimit['limit'] });

  function spies() {
    return {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    };
  }

  it('logs a refusal with the literal words only', async () => {
    const s = spies();
    expect(
      await bindingAllowed(
        bind(async () => ({ success: false })),
        'w',
        req,
        T,
      ),
    ).toBe(false);
    expect(s.log.mock.calls).toEqual([['ratelimit', 'w', 'refused']]);
    expect(s.warn).not.toHaveBeenCalled();
  });

  it('logs a throw and allows', async () => {
    const s = spies();
    const b = bind(() => Promise.reject(new Error(`boom ${IP}`)));
    expect(await bindingAllowed(b, 'w', req, T)).toBe(true);
    expect(s.warn.mock.calls).toEqual([['ratelimit', 'w', 'threw']]);
  });

  it('logs an unexpected result and allows', async () => {
    const s = spies();
    expect(
      await bindingAllowed(
        bind(async () => ({})),
        'w',
        req,
        T,
      ),
    ).toBe(true);
    expect(
      await bindingAllowed(
        bind(async () => ({ success: undefined })),
        'w',
        req,
        T,
      ),
    ).toBe(true);
    expect(s.warn.mock.calls).toEqual([
      ['ratelimit', 'w', 'unexpected'],
      ['ratelimit', 'w', 'unexpected'],
    ]);
  });

  it('never logs an address, key or hash', async () => {
    const s = spies();
    await bindingAllowed(
      bind(async () => ({ success: false })),
      'r',
      req,
      T,
    );
    await bindingAllowed(
      bind(() => Promise.reject(new Error('x'))),
      'r',
      req,
      T,
    );
    await bindingAllowed(
      bind(async () => ({})),
      'r',
      req,
      T,
    );
    const all = JSON.stringify([...s.log.mock.calls, ...s.warn.mock.calls]);
    expect(all).not.toContain(IP);
    expect(all).not.toMatch(/[0-9a-f]{32}/);
  });

  it('a success logs nothing', async () => {
    const s = spies();
    expect(
      await bindingAllowed(
        bind(async () => ({ success: true })),
        'w',
        req,
        T,
      ),
    ).toBe(true);
    expect(s.log).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
  });
});

describe.skipIf(skipSqlite)('handler memory layer', () => {
  async function setup(withMemo: boolean) {
    const { env, clock } = await makeEnv({
      GITHUB_CLIENT_ID: 'Ov23liVCN9Nf6VlLv3St',
      ALLOW_UNVERIFIED_GITHUB_TOKENS: 'true',
      SIGNIN_LIMIT: '1000',
    });
    const h = createHandler(env as Env, {
      now: clock.now,
      fetch: () => Promise.reject(new Error('no fetch')),
      ...(withMemo ? { memo: new MemoryLimiter() } : {}),
    });
    const call = (method: string, p: string, body?: unknown) =>
      h.fetch(
        new Request(BASE + p, {
          method,
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    return { call, clock };
  }

  it('the 61st read in a window is 429 and the next window passes', async () => {
    const s = spies();
    const w = await setup(true);
    for (let i = 0; i < 60; i++) expect((await w.call('GET', '/v1/meta.json')).status).toBe(200);
    const over = await w.call('GET', '/v1/meta.json');
    expect(over.status).toBe(429);
    const t = w.clock.now();
    expect(over.headers.get('retry-after')).toBe(String(retryAfterSeconds(windowOf(t), t)));
    expect(s.log).not.toHaveBeenCalled();
    expect(s.warn).not.toHaveBeenCalled();
    w.clock.advance(60_000);
    expect((await w.call('GET', '/v1/meta.json')).status).toBe(200);
  });

  it('the 31st anonymous write is 429', async () => {
    const w = await setup(true);
    for (let i = 0; i < 30; i++) expect((await w.call('POST', '/v1/entries', {})).status).toBe(401);
    const over = await w.call('POST', '/v1/entries', {});
    expect(over.status).toBe(429);
    const t = w.clock.now();
    expect(over.headers.get('retry-after')).toBe(String(retryAfterSeconds(windowOf(t), t)));
    w.clock.advance(60_000);
    expect((await w.call('POST', '/v1/entries', {})).status).toBe(401);
  });

  it('the 21st sign-in is 429', async () => {
    const w = await setup(true);
    for (let i = 0; i < 20; i++)
      expect((await w.call('POST', '/v1/auth/github', { token: 'x' })).status).toBe(400);
    expect((await w.call('POST', '/v1/auth/github', { token: 'x' })).status).toBe(429);
  });

  it('without memo nothing changes', async () => {
    const w = await setup(false);
    for (let i = 0; i < 100; i++) expect((await w.call('GET', '/v1/meta.json')).status).toBe(200);
  });

  function spies() {
    return {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    };
  }
});

describe('RateCounter', () => {
  const W = windowOf(T);
  const post = (body: unknown) =>
    new Request('https://limiter/hit', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const ok = async (c: RateCounter, body: unknown) =>
    ((await (await c.fetch(post(body))).json()) as { ok: boolean }).ok;
  const noStorage = new Proxy(
    {},
    {
      get() {
        throw new Error('storage touched');
      },
    },
  );

  it('counts per key in a window and resets when the window changes', async () => {
    const c = new RateCounter(noStorage, {});
    for (let i = 0; i < 3; i++) expect(await ok(c, { key: 'w:k', limit: 3, win: W })).toBe(true);
    expect(await ok(c, { key: 'w:k', limit: 3, win: W })).toBe(false);
    expect(await ok(c, { key: 'w:other', limit: 3, win: W })).toBe(true);
    expect(await ok(c, { key: 'w:k', limit: 3, win: W + 60_000 })).toBe(true);
  });

  it.each([
    'not json',
    'null',
    '[]',
    {},
    { key: '', limit: 3, win: W },
    { key: 'k'.repeat(81), limit: 3, win: W },
    { key: 5, limit: 3, win: W },
    { key: 'k', limit: 0, win: W },
    { key: 'k', limit: 1.5, win: W },
    { key: 'k', limit: 1001, win: W },
    { key: 'k', limit: '3', win: W },
    { key: 'k', limit: 3, win: 'x' },
    { key: 'k', limit: 3, win: null },
  ])('answers 400 to a bad body: %j', async (body) => {
    const r = await new RateCounter({}, {}).fetch(post(body));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false });
  });

  it('refuses a new key once 10,000 are held, an existing key still counts', async () => {
    const c = new RateCounter({}, {});
    for (let i = 0; i < 10_000; i++) await ok(c, { key: `w:${i}`, limit: 1, win: W });
    expect(await ok(c, { key: 'w:new', limit: 5, win: W })).toBe(false);
    expect(await ok(c, { key: 'w:0', limit: 5, win: W })).toBe(true);
    expect(await ok(c, { key: 'w:new', limit: 5, win: W + 60_000 })).toBe(true);
  });
});

describe.skipIf(skipSqlite)('handler strict layer', () => {
  async function setup(opts: { limiter?: ReturnType<typeof fakeLimiter> | null; memo?: boolean } = {}) {
    const { env, clock } = await makeEnv({
      GITHUB_CLIENT_ID: 'Ov23liVCN9Nf6VlLv3St',
      ALLOW_UNVERIFIED_GITHUB_TOKENS: 'true',
      SIGNIN_LIMIT: '1000',
    });
    if (opts.limiter) env.LIMITER = opts.limiter;
    const h = createHandler(env as Env, {
      now: clock.now,
      fetch: () => Promise.reject(new Error('no fetch')),
      ...(opts.memo === false ? {} : { memo: new MemoryLimiter() }),
    });
    const call = (method: string, p: string, body?: unknown) =>
      h.fetch(
        new Request(BASE + p, {
          method,
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    return { call, clock };
  }

  it('the 31st anonymous write is 429 with a window-based retry-after', async () => {
    const lim = fakeLimiter();
    const w = await setup({ limiter: lim, memo: false });
    for (let i = 0; i < 30; i++) expect((await w.call('POST', '/v1/entries', {})).status).toBe(401);
    const over = await w.call('POST', '/v1/entries', {});
    expect(over.status).toBe(429);
    const t = w.clock.now();
    expect(over.headers.get('retry-after')).toBe(String(retryAfterSeconds(windowOf(t), t)));
    expect(lim.calls.every((c) => c === 'w')).toBe(true);
  });

  it('the DO refuses while a fresh memory layer allows', async () => {
    const counter = new RateCounter({}, {});
    const lim = fakeLimiter(counter);
    const a = await setup({ limiter: lim });
    for (let i = 0; i < 30; i++) expect((await a.call('POST', '/v1/entries', {})).status).toBe(401);
    const b = await setup({ limiter: lim });
    expect((await b.call('POST', '/v1/entries', {})).status).toBe(429);
  });

  it('the 21st sign-in is 429 from the DO under prefix a', async () => {
    const lim = fakeLimiter();
    const w = await setup({ limiter: lim, memo: false });
    for (let i = 0; i < 20; i++)
      expect((await w.call('POST', '/v1/auth/github', { token: 'x' })).status).toBe(400);
    expect((await w.call('POST', '/v1/auth/github', { token: 'x' })).status).toBe(429);
    expect(new Set(lim.calls)).toEqual(new Set(['a']));
  });

  it.each(['throw', '500', 'garbage'] as LimiterFault[])(
    'a %s DO logs do-failed and the other layers decide',
    async (fault) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const w = await setup({ limiter: fakeLimiter(undefined, fault) });
      for (let i = 0; i < 30; i++) expect((await w.call('POST', '/v1/entries', {})).status).toBe(401);
      expect((await w.call('POST', '/v1/entries', {})).status).toBe(429);
      expect(warn.mock.calls[0]).toEqual(['ratelimit', 'w', 'do-failed']);
      expect(warn.mock.calls.every((c) => c.join(' ') === 'ratelimit w do-failed')).toBe(true);
    },
  );

  it('reads never call the DO', async () => {
    const lim = fakeLimiter();
    const w = await setup({ limiter: lim });
    for (let i = 0; i < 5; i++) expect((await w.call('GET', '/v1/meta.json')).status).toBe(200);
    expect(lim.calls).toEqual([]);
  });

  it('no LIMITER keeps the memory behaviour', async () => {
    const w = await setup();
    for (let i = 0; i < 30; i++) expect((await w.call('POST', '/v1/entries', {})).status).toBe(401);
    expect((await w.call('POST', '/v1/entries', {})).status).toBe(429);
  });
});
