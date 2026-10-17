import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCredential, writeCredential, writePublisher } from '../../src/catalog/store.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { VERIFY_URL } from '../../src/market/github.js';
import { json } from '../fake-fetch.js';

const ENDPOINT = 'https://market.example.com';
const CLIENT = 'Ov23liVCN9Nf6VlLv3St';
const DEVICE = '3584d83530557fdd1f46af8289938c8ef79f9dc5';
const T0 = Date.UTC(2026, 9, 17, 12);
// built at runtime so no fixture looks like a real secret
const GH_TOKEN = ['gho', 'x'.repeat(16), 'Y7'].join('_');
const MARKET_TOKEN = 'a'.repeat(64);
const POLL_URL = 'https://github.com/login/oauth/access_token';

let dir: string;
let cat: string;
let handle: EditorHandle;
let port: number;
let t = T0;
const bodies: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = [
  'CCINFOBAR_CONFIG_DIR',
  'CCINFOBAR_CACHE_DIR',
  'CCINFOBAR_MARKETPLACE_URL',
  'HOME',
  'USERPROFILE',
];

interface Call {
  url: string;
  method: string;
  at: number;
}

type Step = () => Response;

const metaBody = (over: Record<string, unknown> = {}) => ({
  protocol: 1,
  name: 'test marketplace',
  capabilities: { write: true, overwrite: false, withdraw: true, submit: 'api', review: true },
  auth: ['github-device'],
  github: { clientId: CLIENT },
  limits: {},
  ...over,
});

const pending: Step = () => json({ error: 'authorization_pending' });
const granted: Step = () => json({ access_token: GH_TOKEN, token_type: 'bearer' });
const offline: Step = () => {
  throw new TypeError('fetch failed');
};

function world(
  opts: { meta?: Record<string, unknown>; polls?: Step[]; expires?: number; signIn?: Step } = {},
) {
  const calls: Call[] = [];
  const polls = [...(opts.polls ?? [pending, granted])];
  const routes: Record<string, Step> = {
    [`${ENDPOINT}/v1/meta.json`]: () => json(opts.meta ?? metaBody()),
    'https://github.com/login/device/code': () =>
      json({
        device_code: DEVICE,
        user_code: 'WDJB-MJHT',
        verification_uri: VERIFY_URL,
        expires_in: opts.expires ?? 900,
        interval: 5,
      }),
    [POLL_URL]: () => (polls.shift() ?? pending)(),
    [`${ENDPOINT}/v1/auth/github`]:
      opts.signIn ??
      (() => json({ handle: 'octo-cat', token: MARKET_TOKEN, displayName: 'Octo', admin: true })),
    [`${ENDPOINT}/v1/auth/logout`]: () => json({ ok: true }),
  };
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init.method ?? 'GET', at: t });
    const route = routes[url];
    if (!route) throw new TypeError(`no route for ${url}`);
    return route();
  };
  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    polls: () => calls.filter((c) => c.url === POLL_URL),
  };
}

async function boot(w: ReturnType<typeof world>): Promise<void> {
  handle = await startEditor({
    configPath: path.join(dir, 'c.json'),
    open: false,
    port: 0,
    claudeVersion: () => null,
    market: { fetch: w.fetch, now: () => t, defaultEndpoint: ENDPOINT },
  });
  port = Number(new URL(handle.url).port);
}

type Res = { status: number; json: () => Record<string, any>; text: string };

function request(
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = { 'x-ccinfobar-token': handle.token },
): Promise<Res> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const h = { ...headers, ...(text === undefined ? {} : { 'content-type': 'application/json' }) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        bodies.push(raw);
        resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(raw), text: raw });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

const start = () => request('POST', '/api/catalog/login', {});
const status = (flow: string) => request('GET', `/api/catalog/login/${flow}`);

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-login-routes-'));
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  process.env.HOME = path.join(dir, 'home');
  process.env.USERPROFILE = path.join(dir, 'home');
  delete process.env.CCINFOBAR_MARKETPLACE_URL;
  cat = path.join(dir, 'cfg', 'catalog');
  t = T0;
  bodies.length = 0;
});

afterEach(async () => {
  await handle?.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // no login route body ever carries the device code or a token
  for (const b of bodies) {
    expect(b).not.toContain(DEVICE);
    expect(b).not.toContain(GH_TOKEN);
    expect(b).not.toContain(MARKET_TOKEN);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('editor sign-in routes', () => {
  it('starts a flow and returns only the user code and the fixed GitHub page', async () => {
    const w = world();
    await boot(w);
    const res = await start();
    expect(res.status).toBe(200);
    const b = res.json();
    expect(Object.keys(b).sort()).toEqual(['expiresIn', 'flow', 'interval', 'userCode', 'verificationUri']);
    expect(b).toMatchObject({
      userCode: 'WDJB-MJHT',
      verificationUri: VERIFY_URL,
      expiresIn: 900,
      interval: 5,
    });
    expect(b.flow).toMatch(/^[0-9a-f]{16}$/);
    expect(w.calls.map((c) => c.url)).toEqual([
      `${ENDPOINT}/v1/meta.json`,
      'https://github.com/login/device/code',
    ]);
  });

  it('polls GitHub at most once per interval, then signs in and stores the marketplace token', async () => {
    const w = world();
    await boot(w);
    const { flow } = (await start()).json();
    for (let i = 0; i < 10; i++) expect((await status(flow)).json()).toEqual({ status: 'pending' });
    expect(w.polls()).toHaveLength(0);
    t += 5000;
    for (let i = 0; i < 10; i++) expect((await status(flow)).json()).toEqual({ status: 'pending' });
    expect(w.polls()).toHaveLength(1);
    t += 5000;
    const ok = await status(flow);
    expect(ok.json()).toEqual({ status: 'ok', handle: 'octo-cat', admin: true });
    expect(w.polls()).toHaveLength(2);
    expect(readCredential(ENDPOINT, cat)).toBe(MARKET_TOKEN);
    // the answer is kept; asking again sends nothing
    t += 5000;
    expect((await status(flow)).json()).toEqual({ status: 'ok', handle: 'octo-cat', admin: true });
    expect(w.calls).toHaveLength(5);
    const market = (await request('GET', '/api/catalog')).json().market;
    expect(market).toEqual({ endpoint: ENDPOINT, source: 'default', signedIn: true, handle: 'octo-cat' });
  });

  it('raises the interval on slow_down', async () => {
    const w = world({ polls: [() => json({ error: 'slow_down', interval: 10 }), granted] });
    await boot(w);
    const { flow } = (await start()).json();
    t += 5000;
    expect((await status(flow)).json().status).toBe('pending');
    t += 9000;
    expect((await status(flow)).json().status).toBe('pending');
    expect(w.polls()).toHaveLength(1);
    t += 1000;
    expect((await status(flow)).json().status).toBe('ok');
    expect(w.polls()).toHaveLength(2);
  });

  it('keeps one flow: a second start cancels the first', async () => {
    const w = world();
    await boot(w);
    const first = (await start()).json().flow;
    const second = (await start()).json().flow;
    expect(second).not.toBe(first);
    t += 5000;
    expect((await status(first)).json()).toEqual({ status: 'cancelled' });
    expect(w.polls()).toHaveLength(0);
    expect((await status(second)).json().status).toBe('pending');
    expect(w.polls()).toHaveLength(1);
  });

  it('DELETE cancels the flow and GitHub is not asked again', async () => {
    const w = world();
    await boot(w);
    const { flow } = (await start()).json();
    t += 5000;
    await status(flow);
    expect(w.polls()).toHaveLength(1);
    const del = await request('DELETE', `/api/catalog/login/${flow}`);
    expect(del.status).toBe(200);
    expect(del.json()).toEqual({ status: 'cancelled' });
    for (let i = 0; i < 3; i++) {
      t += 5000;
      expect((await status(flow)).json()).toEqual({ status: 'cancelled' });
    }
    expect(w.polls()).toHaveLength(1);
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('answers expired after the code expires without asking GitHub', async () => {
    const w = world({ expires: 20 });
    await boot(w);
    const { flow, expiresIn } = (await start()).json();
    expect(expiresIn).toBe(20);
    t += 21_000;
    expect((await status(flow)).json()).toEqual({ status: 'expired' });
    expect((await status(flow)).json()).toEqual({ status: 'expired' });
    expect(w.polls()).toHaveLength(0);
  });

  it('backs off on network failures and fails after three', async () => {
    const w = world({ polls: [offline, offline, offline, granted] });
    await boot(w);
    const { flow } = (await start()).json();
    // the browser asks every second
    for (let i = 0; i < 60; i++) {
      t += 1000;
      const s = (await status(flow)).json();
      if (s.status !== 'pending') {
        expect(s).toEqual({ status: 'failed', code: 'upstream', errorId: 'market.error.upstream' });
        break;
      }
    }
    const at = w.polls().map((c) => c.at - T0);
    expect(at).toEqual([5000, 15_000, 35_000]);
    t += 60_000;
    expect((await status(flow)).json().status).toBe('cancelled');
    expect(w.polls()).toHaveLength(3);
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('drops a flow the browser stopped asking about, without a request in between', async () => {
    const w = world();
    await boot(w);
    const { flow } = (await start()).json();
    const before = w.calls.length;
    // 2 x interval + 30 s
    t += 40_000;
    expect((await status(flow)).json().status).toBe('pending');
    t += 40_001;
    expect((await status(flow)).json()).toEqual({ status: 'cancelled' });
    expect(w.calls.length).toBe(before + 1);
  });

  it('reports a refused marketplace exchange as failed with its reason', async () => {
    const w = world({
      polls: [granted],
      signIn: () => json({ error: { code: 'unavailable', message: 'sign-in is not configured' } }, 503),
    });
    await boot(w);
    const { flow } = (await start()).json();
    t += 5000;
    expect((await status(flow)).json()).toMatchObject({
      status: 'failed',
      code: 'unavailable',
      errorId: 'market.error.unavailable',
    });
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('keeps the token and origin checks and sends nothing when they fail', async () => {
    const w = world();
    await boot(w);
    const none = await request('POST', '/api/catalog/login', {}, {});
    expect(none.status).toBe(401);
    expect(none.json().errorId).toBe('err.server.badToken');
    const origin = await request(
      'POST',
      '/api/catalog/login',
      {},
      { 'x-ccinfobar-token': handle.token, origin: 'https://evil.example.com' },
    );
    expect(origin.status).toBe(403);
    expect((await request('GET', '/api/catalog/login/0123456789abcdef', undefined, {})).status).toBe(401);
    expect((await request('POST', '/api/catalog/logout', {}, {})).status).toBe(401);
    expect((await request('GET', '/api/catalog/login/not-a-flow')).status).toBe(400);
    expect(w.calls).toHaveLength(0);
  });

  it('answers not-github on a token-mode marketplace before any GitHub call', async () => {
    const w = world({ meta: metaBody({ auth: ['token'], github: undefined }) });
    await boot(w);
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({
      errorId: 'err.catalog.signIn.notGithub',
      code: 'not-github',
      tokenMode: true,
    });
    expect(w.calls.map((c) => c.url)).toEqual([`${ENDPOINT}/v1/meta.json`]);
  });

  it('answers 409 noEndpoint when the marketplace is off', async () => {
    const w = world();
    process.env.CCINFOBAR_MARKETPLACE_URL = 'off';
    await boot(w);
    const res = await start();
    expect(res.status).toBe(409);
    expect(res.json().errorId).toBe('err.catalog.noEndpoint');
    expect(w.calls).toHaveLength(0);
  });

  it('logout revokes the token and forgets it', async () => {
    const w = world();
    await boot(w);
    writeCredential(ENDPOINT, MARKET_TOKEN, cat);
    writePublisher(ENDPOINT, 'octo-cat', cat);
    const res = await request('POST', '/api/catalog/logout', {});
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, signedOut: true });
    expect(res.json().catalog.market).toEqual({
      endpoint: ENDPOINT,
      source: 'default',
      signedIn: false,
      handle: null,
    });
    expect(readCredential(ENDPOINT, cat)).toBeNull();
    expect(w.calls.map((c) => [c.method, c.url])).toEqual([['POST', `${ENDPOINT}/v1/auth/logout`]]);
    const again = await request('POST', '/api/catalog/logout', {});
    expect(again.json()).toMatchObject({ ok: true, signedOut: false });
    expect(w.calls).toHaveLength(1);
  });
});
