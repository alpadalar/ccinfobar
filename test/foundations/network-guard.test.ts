import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeFetch, json } from '../fake-fetch.js';

const GUARD = /ccinfobar test guard/;

function taken(): string[] {
  const v = globalThis.__ccibNetViolations ?? [];
  const urls = v.map((x) => x.url);
  v.length = 0;
  return urls;
}

describe('network guard', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    taken();
  });

  it('blocks a fetch to a public host and records it', async () => {
    await expect(fetch('https://example.com/x')).rejects.toThrow(GUARD);
    expect(taken()).toEqual(['https://example.com/x']);
  });

  it('blocks URL and Request inputs', async () => {
    await expect(fetch(new URL('https://api.github.com/user'))).rejects.toThrow(/api\.github\.com/);
    await expect(fetch(new Request('https://github.com/login/device/code'))).rejects.toThrow(GUARD);
    expect(taken()).toEqual(['https://api.github.com/user', 'https://github.com/login/device/code']);
  });

  it('records a blocked fetch even when the error is swallowed', async () => {
    await fetch('http://ccinfobar-market.example.workers.dev/v1/meta.json').catch(() => null);
    expect(taken()).toHaveLength(1);
  });

  it('allows a loopback server', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.json()).toEqual({ ok: true });
    expect(taken()).toEqual([]);
  });

  it('never blocks localhost', async () => {
    // localhost may resolve to ::1 first
    const err = await fetch(`http://localhost:${port}/`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(String(err)).not.toMatch(GUARD);
    expect(taken()).toEqual([]);
  });

  it('allows data: URLs', async () => {
    expect(await (await fetch('data:application/json,{"a":1}')).json()).toEqual({ a: 1 });
    expect(taken()).toEqual([]);
  });

  it('blocks http and https requests to public hosts', () => {
    expect(() => https.request('https://example.com')).toThrow(GUARD);
    expect(() => https.get(new URL('https://api.github.com/user'))).toThrow(GUARD);
    expect(() => http.request({ host: 'example.org', path: '/' })).toThrow(/example\.org/);
    expect(() => http.get({ hostname: 'example.net' })).toThrow(GUARD);
    expect(taken()).toHaveLength(4);
  });

  it('allows an http request to loopback', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ hostname: '127.0.0.1', port, path: '/' }, (res) => {
          let s = '';
          res.on('data', (c: Buffer) => {
            s += c.toString();
          });
          res.on('end', () => resolve(s));
        })
        .on('error', reject);
    });
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(taken()).toEqual([]);
  });

  it('leaves an injected fake fetch alone', async () => {
    const { fetch: f, calls } = fakeFetch([json({ login: 'x' })]);
    expect(await (await f('https://api.github.com/user')).json()).toEqual({ login: 'x' });
    expect(calls).toHaveLength(1);
    expect(taken()).toEqual([]);
  });
});
