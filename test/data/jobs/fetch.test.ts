import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLoopback } from '../../../src/core/http-spec.js';
import { errorCode, fetchJson, JobFetchError, requestJson } from '../../../src/data/jobs/fetch.js';
import { fakeFetch, json, redirect, streamed } from '../../fake-fetch.js';

const NOW = 1_800_000_000_000;
const URL_A = new URL('https://status.example.com/api/v2/summary.json');

const get = (f: typeof fetch, url = URL_A, extra: Partial<Parameters<typeof fetchJson>[1]> = {}) =>
  fetchJson(url, { fetch: f, timeoutMs: 5000, now: NOW, ...extra });

async function failure(p: Promise<unknown>): Promise<JobFetchError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(JobFetchError);
    return err as JobFetchError;
  }
  throw new Error('expected a rejection');
}

describe('fakeFetch', () => {
  it('records requests and serves scripted responses in order', async () => {
    const s = streamed(['{"a":', '1,"b":', '[2]}']);
    const { fetch: f, calls } = fakeFetch([json({ x: 1 }), new Response(s.body)]);
    expect(await (await f('https://a.test/1', { method: 'GET', headers: { 'x-y': 'z' } })).json()).toEqual({
      x: 1,
    });
    expect(await (await f(new URL('https://a.test/2'))).json()).toEqual({ a: 1, b: [2] });
    expect(calls.map((c) => c.url)).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(calls[0]?.headers['x-y']).toBe('z');
    expect(s.pulls()).toBeGreaterThan(3);
  });
});

describe('fetchJson', () => {
  it('sends one GET with the fixed headers and parses a streamed body', async () => {
    const s = streamed(['{"status":', '{"indicator":"none"}', '}']);
    const { fetch: f, calls } = fakeFetch([new Response(s.body, { status: 200 })]);
    expect(await get(f)).toEqual({ status: { indicator: 'none' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: URL_A.href, method: 'GET', redirect: 'manual' });
    expect(calls[0]?.headers).toMatchObject({ accept: 'application/json', 'user-agent': 'ccinfobar' });
  });

  it('never sends a second accept or user-agent', async () => {
    const { fetch: f, calls } = fakeFetch([json({})]);
    await get(f, URL_A, { headers: { Accept: 'text/html', 'User-Agent': 'x', Authorization: 'Bearer t' } });
    expect(calls[0]?.headers).toEqual({
      accept: 'application/json',
      'user-agent': 'ccinfobar',
      authorization: 'Bearer t',
    });
  });

  it('adds caller headers', async () => {
    const { fetch: f, calls } = fakeFetch([json({})]);
    await get(f, URL_A, { headers: { authorization: 'Bearer t' } });
    expect(calls[0]?.headers).toMatchObject({ authorization: 'Bearer t', 'user-agent': 'ccinfobar' });
  });

  it('follows a same-origin relative redirect', async () => {
    const { fetch: f, calls } = fakeFetch([redirect('/v3/summary.json'), json({ ok: 1 })]);
    expect(await get(f)).toEqual({ ok: 1 });
    expect(calls.map((c) => c.url)).toEqual([URL_A.href, 'https://status.example.com/v3/summary.json']);
    expect(calls.every((c) => c.headers['user-agent'] === 'ccinfobar' && c.method === 'GET')).toBe(true);
  });

  it('follows an http to https upgrade of the same host', async () => {
    const start = new URL('http://status.example.com/a.json');
    const { fetch: f, calls } = fakeFetch([redirect('https://status.example.com/a.json', 301), json([1])]);
    expect(await get(f, start)).toEqual([1]);
    expect(calls[1]?.url).toBe('https://status.example.com/a.json');
  });

  it.each([
    ['another host', 'https://evil.example.net/x.json', URL_A],
    ['an https downgrade', 'http://status.example.com/x.json', URL_A],
    ['an upgrade to another host', 'https://evil.example.net/x', new URL('http://status.example.com/a')],
    ['another port', 'https://status.example.com:8443/x', URL_A],
  ])('refuses a redirect to %s', async (_n, loc, start) => {
    const { fetch: f, calls } = fakeFetch([redirect(loc), json({ leaked: true })]);
    expect((await failure(get(f, start))).code).toBe('cross-origin-redirect');
    expect(calls).toHaveLength(1);
  });

  it('stops after 3 redirects', async () => {
    const { fetch: f, calls } = fakeFetch([redirect('/1'), redirect('/2'), redirect('/3'), redirect('/4')]);
    expect((await failure(get(f))).code).toBe('too-many-redirects');
    expect(calls).toHaveLength(4);
  });

  it('follows exactly 3 redirects', async () => {
    const { fetch: f } = fakeFetch([redirect('/1'), redirect('/2'), redirect('/3'), json({ n: 3 })]);
    expect(await get(f)).toEqual({ n: 3 });
  });

  it('fails a redirect without a location', async () => {
    const { fetch: f } = fakeFetch([new Response(null, { status: 302 })]);
    expect((await failure(get(f))).code).toBe('bad-redirect');
  });

  it('refuses a declared content-length over the cap without reading', async () => {
    const s = streamed(['{}']);
    const res = new Response(s.body, { status: 200, headers: { 'content-length': '300000' } });
    const { fetch: f } = fakeFetch([res]);
    expect((await failure(get(f))).code).toBe('too-large');
    expect(s.cancelled()).toBe(true);
  });

  it('cancels a streamed body past 256 KB', async () => {
    const chunk = new Uint8Array(30_000).fill(32);
    const s = streamed(Array.from({ length: 10 }, () => chunk));
    const { fetch: f } = fakeFetch([new Response(s.body, { status: 200 })]);
    expect((await failure(get(f))).code).toBe('too-large');
    expect(s.cancelled()).toBe(true);
    expect(s.pulls()).toBeLessThan(11);
  });

  it('accepts a body exactly at a custom cap', async () => {
    const { fetch: f } = fakeFetch([new Response('[1,2]')]);
    expect(await get(f, URL_A, { capBytes: 5 })).toEqual([1, 2]);
    const { fetch: g } = fakeFetch([new Response('[1,22]')]);
    expect((await failure(get(g, URL_A, { capBytes: 5 }))).code).toBe('too-large');
  });

  it('maps non-2xx to http-<status> and honours Retry-After on 429 and 503', async () => {
    const e404 = await failure(get(fakeFetch([json({ m: 'no' }, 404)]).fetch));
    expect([e404.code, e404.retryAfterMs]).toEqual(['http-404', null]);
    const e429 = await failure(get(fakeFetch([json({}, 429, { 'retry-after': '120' })]).fetch));
    expect([e429.code, e429.retryAfterMs]).toEqual(['http-429', 120_000]);
    const date = new Date(NOW + 90_000).toUTCString();
    const e503 = await failure(get(fakeFetch([json({}, 503, { 'retry-after': date })]).fetch));
    expect([e503.code, e503.retryAfterMs]).toEqual(['http-503', 90_000]);
    const e500 = await failure(get(fakeFetch([json({}, 500, { 'retry-after': '120' })]).fetch));
    expect([e500.code, e500.retryAfterMs]).toEqual(['http-500', null]);
  });

  it('ignores a leading byte order mark', async () => {
    const bom = String.fromCharCode(0xfeff);
    expect(await get(fakeFetch([new Response(`${bom}{"a":1}`)]).fetch)).toEqual({ a: 1 });
  });

  it('maps invalid JSON to bad-json', async () => {
    const e = await failure(get(fakeFetch([new Response('{nope')]).fetch));
    expect(e.code).toBe('bad-json');
    expect(e.message).toBe('bad-json');
  });

  it('passes fetch errors through for errorCode', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    await expect(get(fakeFetch([dns]).fetch)).rejects.toSatisfy((e: unknown) => errorCode(e) === 'dns');
  });
});

describe('requestJson', () => {
  const send = (f: typeof fetch, extra: Partial<Parameters<typeof requestJson>[1]> = {}, url = URL_A) =>
    requestJson(url, { fetch: f, timeoutMs: 5000, now: NOW, ...extra });

  it('sends a JSON body with the fixed headers', async () => {
    const { fetch: f, calls } = fakeFetch([json({ id: 'x' }, 201)]);
    const res = await send(f, { method: 'POST', body: { a: 1 }, headers: { Authorization: 'Bearer t' } });
    expect([res.status, res.body]).toEqual([201, { id: 'x' }]);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', redirect: 'manual', body: '{"a":1}' });
    expect(calls[0]?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'ccinfobar',
      authorization: 'Bearer t',
    });
  });

  it('sends no body or content-type without one', async () => {
    const { fetch: f, calls } = fakeFetch([new Response(null, { status: 204 })]);
    expect(await send(f, { method: 'DELETE' })).toMatchObject({ status: 204, body: null });
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers['content-type']).toBeUndefined();
  });

  it('reads a zero-byte 200 as null', async () => {
    expect((await send(fakeFetch([new Response('')]).fetch, { method: 'PUT', body: [] })).body).toBeNull();
  });

  it.each([
    ['POST', 307],
    ['PUT', 308],
    ['DELETE', 302],
  ] as const)('never follows a redirect on %s', async (method, status) => {
    const { fetch: f, calls } = fakeFetch([redirect('/v2/same', status), json({ leaked: true })]);
    const e = await failure(send(f, { method, body: { token: 'x' } }));
    expect(e.code).toBe('redirect');
    expect(errorCode(e)).toBe('redirect');
    expect(calls).toHaveLength(1);
  });

  it('follows same-origin redirects on GET only', async () => {
    const { fetch: f, calls } = fakeFetch([redirect('/1'), redirect('/2'), json({ n: 2 })]);
    expect(await send(f)).toMatchObject({ status: 200, body: { n: 2 } });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    const { fetch: g } = fakeFetch([redirect('https://evil.example.net/x'), json({})]);
    expect((await failure(send(g))).code).toBe('cross-origin-redirect');
  });

  it('keeps a protocol error code and drops the server message', async () => {
    const body = { error: { code: 'conflict', message: '<script>alert(1)</script>' } };
    const e = await failure(
      send(fakeFetch([json(body, 409)]).fetch, { method: 'PUT', body: {}, errorBody: true }),
    );
    expect([e.code, e.status, e.remoteCode, e.retryAfterMs]).toEqual(['http-409', 409, 'conflict', null]);
    expect(e.message).toBe('http-409');
    expect(`${String(e)} ${JSON.stringify(e)} ${e.stack}`).not.toContain('script');
  });

  it('reads no error body unless asked', async () => {
    const s = streamed(['{"error":', '{"code":', '"conflict"', '}', '}']);
    const e = await failure(
      send(fakeFetch([new Response(s.body, { status: 409 })]).fetch, { method: 'POST' }),
    );
    expect([e.status, e.remoteCode]).toEqual([409, null]);
    expect(s.cancelled()).toBe(true);
  });

  it.each([
    ['a bad code', JSON.stringify({ error: { code: 'Bad Code!' } })],
    ['a long code', JSON.stringify({ error: { code: 'a'.repeat(33) } })],
    ['a number', JSON.stringify({ error: { code: 7 } })],
    ['no error object', JSON.stringify({ code: 'conflict' })],
    ['invalid JSON', '{"error":'],
    ['a body over 8 KiB', JSON.stringify({ error: { code: 'conflict' }, pad: 'x'.repeat(9 * 1024) })],
  ])('drops %s', async (_n, text) => {
    const res = new Response(text, { status: 400 });
    const e = await failure(send(fakeFetch([res]).fetch, { method: 'POST', errorBody: true }));
    expect([e.code, e.status, e.remoteCode]).toEqual(['http-400', 400, null]);
  });

  it('cancels a streamed error body past 8 KiB', async () => {
    const s = streamed([
      '{"error":{"code":"conflict"},"pad":"',
      ...Array.from({ length: 10 }, () => 'x'.repeat(4096)),
    ]);
    const e = await failure(
      send(fakeFetch([new Response(s.body, { status: 422 })]).fetch, { errorBody: true }),
    );
    expect(e.remoteCode).toBeNull();
    expect(s.cancelled()).toBe(true);
  });

  it('carries Retry-After on 429', async () => {
    const res = json({ error: { code: 'rate-limited' } }, 429, { 'retry-after': '30' });
    const e = await failure(send(fakeFetch([res]).fetch, { method: 'POST', errorBody: true }));
    expect([e.code, e.status, e.remoteCode, e.retryAfterMs]).toEqual([
      'http-429',
      429,
      'rate-limited',
      30_000,
    ]);
  });

  it('fails a 300 KiB response as too-large', async () => {
    const big = new Response(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }), { status: 200 });
    expect((await failure(send(fakeFetch([big]).fetch, { method: 'POST', body: {} }))).code).toBe(
      'too-large',
    );
  });

  it('keeps fetchJson strict about empty bodies', async () => {
    expect((await failure(get(fakeFetch([new Response('')]).fetch))).code).toBe('bad-json');
    expect((await failure(get(fakeFetch([new Response(null, { status: 204 })]).fetch))).code).toBe(
      'bad-json',
    );
  });

  it('sends If-None-Match and returns a 304 without following it', async () => {
    const { fetch: f, calls } = fakeFetch([
      new Response(null, { status: 304, headers: { etag: '"g3"', location: '/elsewhere' } }),
      json({ leaked: true }),
    ]);
    const res = await send(f, { ifNoneMatch: '"g3"', headers: { 'If-None-Match': '"old"' } });
    expect([res.status, res.body, res.headers.get('etag')]).toEqual([304, null, '"g3"']);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['if-none-match']).toBe('"g3"');
  });

  it('treats a 304 as a redirect without ifNoneMatch', async () => {
    const { fetch: f, calls } = fakeFetch([new Response(null, { status: 304 })]);
    expect((await failure(send(f))).code).toBe('bad-redirect');
    expect(calls[0]?.headers['if-none-match']).toBeUndefined();
    const { fetch: g } = fakeFetch([
      new Response(null, { status: 304, headers: { location: '/b' } }),
      json(1),
    ]);
    expect((await send(g)).body).toBe(1);
  });

  it('sends a form body', async () => {
    const { fetch: f, calls } = fakeFetch([json({ device_code: 'd' })]);
    const res = await send(f, { method: 'POST', form: { client_id: 'abc', scope: '' } });
    expect(res.body).toEqual({ device_code: 'd' });
    expect(calls[0]?.body).toBe('client_id=abc&scope=');
    expect(calls[0]?.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'ccinfobar',
    });
  });

  it('refuses form and body together', async () => {
    const { fetch: f, calls } = fakeFetch([json({})]);
    expect((await failure(send(f, { method: 'POST', form: { a: 'b' }, body: { a: 1 } }))).code).toBe(
      'invalid',
    );
    expect(calls).toHaveLength(0);
  });

  it('returns a JSON error body with anyStatus', async () => {
    const res = await send(fakeFetch([json({ error: 'authorization_pending' }, 400)]).fetch, {
      method: 'POST',
      form: {},
      anyStatus: true,
    });
    expect([res.status, res.body]).toEqual([400, { error: 'authorization_pending' }]);
  });

  it.each([
    ['empty', ''],
    ['not JSON', '<html>'],
    ['over 8 KiB', JSON.stringify({ error: 'x', pad: 'x'.repeat(9 * 1024) })],
  ])('reads an %s error body as null with anyStatus', async (_n, text) => {
    const res = await send(fakeFetch([new Response(text, { status: 422 })]).fetch, { anyStatus: true });
    expect([res.status, res.body]).toEqual([422, null]);
  });

  it('cancels a streamed error body past 8 KiB with anyStatus', async () => {
    const s = streamed(['{"pad":"', ...Array.from({ length: 10 }, () => 'x'.repeat(4096))]);
    const res = await send(fakeFetch([new Response(s.body, { status: 500 })]).fetch, { anyStatus: true });
    expect([res.status, res.body]).toEqual([500, null]);
    expect(s.cancelled()).toBe(true);
  });

  it('keeps redirect rules with anyStatus', async () => {
    const { fetch: f, calls } = fakeFetch([redirect('/same', 307), json({})]);
    expect((await failure(send(f, { method: 'POST', form: {}, anyStatus: true }))).code).toBe('redirect');
    expect(calls).toHaveLength(1);
    const { fetch: g } = fakeFetch([redirect('https://evil.example.net/x'), json({})]);
    expect((await failure(send(g, { anyStatus: true }))).code).toBe('cross-origin-redirect');
  });

  it('gives other errors no status or remote code', () => {
    const e = new JobFetchError('too-large');
    expect([e.status, e.remoteCode, e.retryAfterMs]).toEqual([null, null, null]);
  });
});

describe('errorCode', () => {
  const withCause = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });

  it.each([
    [new JobFetchError('too-large'), 'too-large'],
    [timeout, 'timeout'],
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'timeout'],
    [withCause('ENOTFOUND'), 'dns'],
    [withCause('EAI_AGAIN'), 'dns'],
    [withCause('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls'],
    [withCause('CERT_HAS_EXPIRED'), 'tls'],
    [withCause('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls'],
    [withCause('ECONNREFUSED'), 'network'],
    [new SyntaxError('Unexpected token'), 'bad-json'],
    ['a string', 'network'],
    [null, 'network'],
    [undefined, 'network'],
  ])('maps %s', (err, code) => {
    expect(errorCode(err)).toBe(code);
  });

  it('never echoes the error message', () => {
    const err = new TypeError('Failed to parse URL from https://api.example.com/x?key=SECRET');
    const code = errorCode(err);
    expect(code).toBe('network');
    expect(code).not.toContain('SECRET');
  });

  it('survives hostile error objects', () => {
    const evil = {
      get name(): string {
        throw new Error('boom');
      },
    };
    expect(errorCode(evil)).toBe('network');
  });
});

describe('isLoopback', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['[::1]', true],
    ['127.0.0.2', false],
    ['localhost.evil.com', false],
    ['example.com', false],
  ])('%s → %s', (host, want) => {
    expect(isLoopback(host)).toBe(want);
  });
});

describe('fetchJson against a local server', () => {
  let server: http.Server;
  let base = '';
  const seen: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['user-agent']}`);
      if (req.url === '/hop') {
        res.writeHead(302, { location: '/data' }).end();
      } else if (req.url === '/away') {
        res.writeHead(302, { location: 'http://127.0.0.2:1/data' }).end();
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"a":');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('follows a same-origin redirect with real fetch', async () => {
    expect(await fetchJson(new URL(`${base}/hop`), { fetch, timeoutMs: 3000 })).toEqual({ ok: true });
    expect(seen.slice(-2)).toEqual(['GET /hop ccinfobar', 'GET /data ccinfobar']);
  });

  it('refuses a cross-origin redirect with real fetch', async () => {
    const n = seen.length;
    expect((await failure(fetchJson(new URL(`${base}/away`), { fetch, timeoutMs: 3000 }))).code).toBe(
      'cross-origin-redirect',
    );
    expect(seen.length).toBe(n + 1);
  });

  it('never re-sends a POST on a redirect with real fetch', async () => {
    const n = seen.length;
    const p = requestJson(new URL(`${base}/hop`), { fetch, timeoutMs: 3000, method: 'POST', body: { a: 1 } });
    expect((await failure(p)).code).toBe('redirect');
    expect(seen.slice(n)).toEqual(['POST /hop ccinfobar']);
  });

  it('times out a body that never ends', async () => {
    let err: unknown;
    try {
      await fetchJson(new URL(`${base}/slow`), { fetch, timeoutMs: 200 });
    } catch (e) {
      err = e;
    }
    expect(errorCode(err)).toBe('timeout');
  });
});
