import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryAfterSeconds, windowOf } from '../../src/market/rules.js';
import type { Env, RateLimit } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import {
  MEMORY_LIMITS,
  MemoryLimiter,
  OVERFLOW_FACTOR,
  RateCounter,
  SHARDS,
  shardOf,
} from '../../src/market/worker/limiter.js';
import { bindingAllowed, countAddr } from '../../src/market/worker/rate.js';
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

  it('a full map counts new keys in a generous shared overflow bucket, tracked keys keep their own count', async () => {
    const c = new RateCounter({}, {});
    for (let i = 0; i < 10_000; i++) await ok(c, { key: `w:${i}`, limit: 1, win: W });
    const res = async (key: string, limit = 5, win = W) =>
      (await (await c.fetch(post({ key, limit, win }))).json()) as {
        ok: boolean;
        overflow?: boolean;
        first?: boolean;
      };
    expect(await res('w:new0')).toEqual({ ok: true, overflow: true, first: true });
    for (let i = 1; i < 5 * OVERFLOW_FACTOR; i++)
      expect(await res(`w:new${i}`)).toEqual({ ok: true, overflow: true });
    expect(await res('w:past')).toEqual({ ok: false, overflow: true });
    expect(await res('w:new0')).toEqual({ ok: false, overflow: true });
    expect((await res('w:1', 5)).ok).toBe(true);
    expect((await res('w:1', 5)).overflow).toBeUndefined();
    expect(await res('w:fresh', 5, W + 60_000)).toEqual({ ok: true });
  });
});

describe('shards and address keys', () => {
  it('picks a deterministic shard in range and spreads keys', () => {
    expect(shardOf('w:abc')).toBe(shardOf('w:abc'));
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const n = shardOf(`w:${i}`);
      expect(Number.isInteger(n) && n >= 0 && n < SHARDS).toBe(true);
      seen.add(n);
    }
    expect(seen.size).toBe(SHARDS);
  });

  it('counts an IPv6 address by its /64 and leaves IPv4 alone', () => {
    expect(countAddr('203.0.113.7')).toBe('203.0.113.7');
    expect(countAddr('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002');
    expect(countAddr('2001:DB8:1:2::1')).toBe('2001:0db8:0001:0002');
    expect(countAddr('2001:db8:1:2:ffff::')).toBe('2001:0db8:0001:0002');
    expect(countAddr('2001:db8:1:3::1')).not.toBe(countAddr('2001:db8:1:2::1'));
    expect(countAddr('::1')).toBe('0000:0000:0000:0000');
    expect(countAddr('fe80::1%eth0')).toBe('fe80:0000:0000:0000');
    expect(countAddr('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(countAddr('not an ip:')).toBe('not an ip:');
    expect(countAddr('local')).toBe('local');
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
    const call = (method: string, p: string, body?: unknown, ip = IP) =>
      h.fetch(
        new Request(BASE + p, {
          method,
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
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
    expect(lim.calls.every((c) => /^w:\d+$/.test(c))).toBe(true);
    expect(new Set(lim.calls).size).toBe(1);
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
    expect(lim.calls.every((c) => /^a:\d+$/.test(c))).toBe(true);
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

  it('a full DO shard lets new addresses through up to the overflow limit and logs once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const counter = new RateCounter({}, {});
    const W = windowOf(T);
    for (let i = 0; i < 10_000; i++)
      await counter.fetch(
        new Request('https://limiter/hit', {
          method: 'POST',
          body: JSON.stringify({ key: `w:${i}`, limit: 1, win: W }),
        }),
      );
    const w = await setup({ limiter: fakeLimiter(counter), memo: false });
    const ipN = (i: number) => `10.${i >> 8}.${i & 255}.1`;
    for (let i = 0; i < 30 * OVERFLOW_FACTOR; i++)
      expect((await w.call('POST', '/v1/entries', {}, ipN(i))).status).toBe(401);
    expect((await w.call('POST', '/v1/entries', {}, '198.51.100.9')).status).toBe(429);
    const lines = log.mock.calls.map((c) => c.join(' '));
    expect(lines.filter((l) => l === 'ratelimit w overflow')).toHaveLength(1);
    expect(lines.join('\n')).not.toMatch(/10\.0\.|198\.51|[0-9a-f]{32}/);
  });

  it('addresses in one IPv6 /64 share a count', async () => {
    const w = await setup({ limiter: fakeLimiter(), memo: false });
    for (let i = 0; i < 30; i++)
      expect((await w.call('POST', '/v1/entries', {}, `2001:db8:1:2::${i + 1}`)).status).toBe(401);
    expect((await w.call('POST', '/v1/entries', {}, '2001:db8:1:2:f::9')).status).toBe(429);
    expect((await w.call('POST', '/v1/entries', {}, '2001:db8:1:3::1')).status).toBe(401);
  });
});

describe('windows only move forward', () => {
  const W1 = windowOf(3 * 60_000 + 2);
  const W0 = windowOf(3 * 60_000 - 1);
  const post = (body: unknown) =>
    new Request('https://limiter/hit', { method: 'POST', body: JSON.stringify(body) });
  type Out = { ok: boolean; overflow?: boolean; first?: boolean };
  const hit = async (c: RateCounter, body: unknown) => (await (await c.fetch(post(body))).json()) as Out;

  it('memory: a stale hit is allowed, uncounted and clears nothing', () => {
    const m = new MemoryLimiter();
    const t1 = 3 * 60_000 + 2;
    const t0 = 3 * 60_000 - 1;
    expect(W0).toBeLessThan(W1);
    expect(m.hit('k', 2, t1)).toBe(true);
    expect(m.hit('k', 2, t1)).toBe(true);
    expect(m.hit('k', 2, t0)).toBe(true);
    expect(m.size).toBe(1);
    expect(m.hit('k', 2, t1)).toBe(false);
  });

  it('memory: a first-ever hit with an old time counts normally', () => {
    const m = new MemoryLimiter();
    expect(m.hit('k', 1, 60_000)).toBe(true);
    expect(m.hit('k', 1, 60_000)).toBe(false);
  });

  it('DO: a stale window is allowed, uncounted, and the newer counts survive', async () => {
    const c = new RateCounter({}, {});
    expect((await hit(c, { key: 'k', limit: 2, win: W1 })).ok).toBe(true);
    expect((await hit(c, { key: 'k', limit: 2, win: W1 })).ok).toBe(true);
    const r = await c.fetch(post({ key: 'k', limit: 2, win: W0 }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect((await hit(c, { key: 'k', limit: 2, win: W1 })).ok).toBe(false);
  });

  it('DO: a stale request on a full shard does not bump the overflow count', async () => {
    const c = new RateCounter({}, {});
    for (let i = 0; i < 10_000; i++) await hit(c, { key: `w:${i}`, limit: 1, win: W1 });
    expect(await hit(c, { key: 'w:stale', limit: 5, win: W0 })).toEqual({ ok: true });
    expect(await hit(c, { key: 'w:new', limit: 5, win: W1 })).toEqual({
      ok: true,
      overflow: true,
      first: true,
    });
  });
});
