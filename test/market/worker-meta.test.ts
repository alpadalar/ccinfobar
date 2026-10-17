import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKET_LIMITS, parseMeta } from '../../src/market/protocol.js';
import { fail, MESSAGES } from '../../src/market/rules.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { errorResponse, readJsonBody } from '../../src/market/worker/http.js';
import worker from '../../src/market/worker/index.js';
import { stubEnv } from './worker-env.js';

const BASE = 'http://w.test';

function handler(vars = {}) {
  const { env, clock } = stubEnv(vars);
  return createHandler(env, { now: clock.now, fetch: () => Promise.reject(new Error('no fetch')) });
}

const get = (p: string, vars = {}) => handler(vars).fetch(new Request(BASE + p));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('worker landing page', () => {
  it('serves a static page with a strict CSP', async () => {
    const r = await get('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await r.text();
    expect(html).toContain('public');
    expect(html).toContain('href="https://github.com/alpadalar/ccinfobar/issues"');
    expect(html).toContain('docs/MARKETPLACE.md');
    expect(html).toContain('href="/v1/meta.json"');
    expect(html).not.toMatch(/<script/i);
  });

  it('escapes the market name', async () => {
    const html = await (await get('/', { MARKET_NAME: '<b>"x" & y</b>' })).text();
    expect(html).toContain('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('runs through the default export', async () => {
    const r = await worker.fetch(new Request(`${BASE}/`), stubEnv().env);
    expect(r.status).toBe(200);
  });
});

describe('worker meta', () => {
  it('advertises GitHub sign-in, no overwrite and the shared limits', async () => {
    const r = await get('/v1/meta.json');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const body = await r.json();
    expect(parseMeta(body)).not.toBeNull();
    expect(body).toEqual({
      protocol: 1,
      name: 'ccinfobar marketplace',
      capabilities: {
        write: true,
        overwrite: false,
        withdraw: true,
        submit: 'api',
        review: true,
        report: true,
      },
      auth: ['github-device'],
      github: { clientId: 'Ov23liVCN9Nf6VlLv3St' },
      limits: { ...MARKET_LIMITS },
    });
  });

  it('turns overwrite on only for the exact value true', async () => {
    expect(
      (await (await get('/v1/meta.json', { ALLOW_OVERWRITE: 'true' })).json()).capabilities.overwrite,
    ).toBe(true);
    for (const v of ['TRUE', '1', 'yes', '', undefined]) {
      const body = await (await get('/v1/meta.json', { ALLOW_OVERWRITE: v })).json();
      expect(body.capabilities.overwrite, String(v)).toBe(false);
    }
  });

  it('leaves github out without a client id', async () => {
    const body = await (await get('/v1/meta.json', { GITHUB_CLIENT_ID: '' })).json();
    expect(body).not.toHaveProperty('github');
    expect(body.auth).toEqual(['github-device']);
  });

  it('uses the market name from the env', async () => {
    const body = await (await get('/v1/meta.json', { MARKET_NAME: 'test market' })).json();
    expect(body.name).toBe('test market');
    expect((await (await get('/v1/meta.json', { MARKET_NAME: '' })).json()).name).toBe(
      'ccinfobar marketplace',
    );
  });

  it('lowers maxEntryBytes only to a valid smaller value', async () => {
    const max = async (v: string) =>
      (await (await get('/v1/meta.json', { MAX_ENTRY_BYTES: v })).json()).limits.maxEntryBytes;
    expect(await max('1000')).toBe(1000);
    for (const v of ['abc', '0', '-5', '1e3', '12.5', String(MARKET_LIMITS.maxEntryBytes + 1), '']) {
      expect(await max(v), v).toBe(MARKET_LIMITS.maxEntryBytes);
    }
  });
});

describe('worker errors', () => {
  it('answers 404 not-found for unknown routes and methods', async () => {
    const h = handler();
    for (const [method, p] of [
      ['GET', '/v1/nothing'],
      ['GET', '/v2/meta.json'],
      ['POST', '/'],
      ['PUT', '/v1/meta.json'],
      ['DELETE', '/v1/meta.json'],
    ] as const) {
      const r = await h.fetch(new Request(BASE + p, { method }));
      expect(r.status, `${method} ${p}`).toBe(404);
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await r.json()).toEqual({ error: { code: 'not-found', message: MESSAGES['not-found'] } });
    }
  });

  it('answers 500 internal for a plain error and logs a fixed code only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = {
      url: `${BASE}/v1/meta.json`,
      get method(): string {
        throw new Error('secret detail');
      },
    } as unknown as Request;
    const r = await handler().fetch(bad);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: { code: 'internal', message: MESSAGES.internal } });
    expect(log.mock.calls).toEqual([['market: internal']]);
  });

  it('keeps MarketHttpError codes, messages and retry-after', async () => {
    const e = fail(429, 'rate-limited');
    e.retryAfter = 42;
    const r = errorResponse(e);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('42');
    expect(await r.json()).toEqual({ error: { code: 'rate-limited', message: MESSAGES['rate-limited'] } });
    const v = errorResponse(fail(400, 'invalid', 'invalid id'));
    expect(v.headers.get('retry-after')).toBeNull();
    expect(await v.json()).toEqual({ error: { code: 'invalid', message: 'invalid id' } });
  });
});

describe('readJsonBody', () => {
  const CAP = MARKET_LIMITS.maxBodyBytes;
  const post = (body: BodyInit | null, headers: Record<string, string>) =>
    new Request(`${BASE}/v1/entries`, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const x = e as { status: number; code: string };
      return `${x.status} ${x.code}`;
    }
    return 'ok';
  };

  it('parses JSON and treats an empty body as {}', async () => {
    expect(await readJsonBody(post('{"a":1}', { 'content-type': 'application/json' }), CAP)).toEqual({
      a: 1,
    });
    expect(
      await readJsonBody(post('[1]', { 'content-type': 'Application/JSON; charset=utf-8' }), CAP),
    ).toEqual([1]);
    expect(await readJsonBody(post(null, { 'content-type': 'application/json' }), CAP)).toEqual({});
  });

  it('checks the content type before the size', async () => {
    expect(await code(readJsonBody(post('{}', { 'content-type': 'text/plain' }), CAP))).toBe(
      '415 unsupported-media',
    );
    expect(await code(readJsonBody(post('{}', {}), CAP))).toBe('415 unsupported-media');
    const big = post('{}', { 'content-type': 'text/plain', 'content-length': String(2 * CAP) });
    expect(await code(readJsonBody(big, CAP))).toBe('415 unsupported-media');
  });

  it('refuses a declared length over the cap without reading', async () => {
    const req = {
      headers: new Headers({ 'content-type': 'application/json', 'content-length': String(2 * CAP) }),
      get body(): never {
        throw new Error('body read');
      },
    } as unknown as Request;
    expect(await code(readJsonBody(req, CAP))).toBe('413 too-large');
  });

  it('counts streamed bytes without a content length', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++;
        if (sent > 40) c.close();
        else c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const req = post(stream, { 'content-type': 'application/json' });
    expect(req.headers.get('content-length')).toBeNull();
    expect(await code(readJsonBody(req, CAP))).toBe('413 too-large');
    expect(sent).toBeLessThan(40);
    expect(cancelled).toBe(true);
  });

  it('accepts a body of exactly the cap', async () => {
    const text = `"${'a'.repeat(CAP - 2)}"`;
    expect(
      ((await readJsonBody(post(text, { 'content-type': 'application/json' }), CAP)) as string).length,
    ).toBe(CAP - 2);
    expect(await code(readJsonBody(post(`${text} `, { 'content-type': 'application/json' }), CAP))).toBe(
      '413 too-large',
    );
  });

  it('answers 400 invalid for bad JSON', async () => {
    for (const b of ['{', 'nope', '﻿{}']) {
      expect(await code(readJsonBody(post(b, { 'content-type': 'application/json' }), CAP)), b).toBe(
        '400 invalid',
      );
    }
  });
});
