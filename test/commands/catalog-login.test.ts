import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SignInDeps, SignInError, signInWithGitHub } from '../../src/catalog/signin.js';
import { readCredential, readPublisher, writeCredential, writePublisher } from '../../src/catalog/store.js';
import { VERIFY_URL } from '../../src/market/github.js';
import { json } from '../fake-fetch.js';

const ENDPOINT = 'https://market.example.com';
const CLIENT = 'Ov23liVCN9Nf6VlLv3St';
const DEVICE = '3584d83530557fdd1f46af8289938c8ef79f9dc5';
const T0 = Date.UTC(2026, 9, 17, 12);
// built at runtime so no fixture looks like a real secret
const GH_TOKEN = ['gho', 'x'.repeat(16), 'Y7'].join('_');
const MARKET_TOKEN = 'a'.repeat(64);

let root = '';
let cat = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-login-'));
  cat = path.join(root, 'catalog');
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Route = (call: Call) => Response | Promise<Response>;

const metaBody = (over: Record<string, unknown> = {}) => ({
  protocol: 1,
  name: 'test marketplace',
  capabilities: { write: true, overwrite: false, withdraw: true, submit: 'api', review: true },
  auth: ['github-device'],
  github: { clientId: CLIENT },
  limits: {},
  ...over,
});

const deviceStart = {
  device_code: DEVICE,
  user_code: 'WDJB-MJHT',
  verification_uri: VERIFY_URL,
  expires_in: 900,
  interval: 5,
};

const pending = () => json({ error: 'authorization_pending' });

// GitHub and marketplace answers by url; token polls take the queued answers
function world(opts: { meta?: Record<string, unknown>; polls?: (() => Response)[]; signIn?: Route } = {}) {
  const calls: Call[] = [];
  const polls = [...(opts.polls ?? [pending, () => json({ access_token: GH_TOKEN, token_type: 'bearer' })])];
  const routes: Record<string, Route> = {
    [`${ENDPOINT}/v1/meta.json`]: () => json(opts.meta ?? metaBody()),
    'https://github.com/login/device/code': () => json(deviceStart),
    'https://github.com/login/oauth/access_token': () => (polls.shift() ?? pending)(),
    [`${ENDPOINT}/v1/auth/github`]:
      opts.signIn ??
      (() => json({ handle: 'octo-cat', token: MARKET_TOKEN, displayName: 'Octo Cat', admin: false })),
    [`${ENDPOINT}/v1/auth/logout`]: () => json({ ok: true }),
  };
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v;
    const body =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : '';
    const call = { url, method: init.method ?? 'GET', headers, body };
    calls.push(call);
    const route = routes[url];
    if (!route) throw new TypeError(`no route for ${url}`);
    return route(call);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

function clock() {
  let t = T0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
}

function deps(w: ReturnType<typeof world>, over: Partial<SignInDeps> = {}) {
  const c = clock();
  const codes: Parameters<SignInDeps['onCode']>[0][] = [];
  const d: SignInDeps = {
    fetch: w.fetch,
    now: c.now,
    sleep: c.sleep,
    dir: cat,
    env: { CCINFOBAR_MARKETPLACE_URL: ENDPOINT },
    defaultEndpoint: null,
    onCode: (info) => void codes.push(info),
    ...over,
  };
  return { deps: d, codes, clock: c };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SignInError);
    return (e as SignInError).code;
  }
  throw new Error('expected a SignInError');
}

describe('signInWithGitHub', () => {
  it('signs in with the client id from meta and stores only the marketplace token (D-05, D-06)', async () => {
    const w = world();
    const h = deps(w);
    const res = await signInWithGitHub(h.deps);
    expect(res).toEqual({ endpoint: ENDPOINT, handle: 'octo-cat', admin: false });
    expect(h.codes).toEqual([
      { userCode: 'WDJB-MJHT', verificationUri: VERIFY_URL, expiresAt: T0 + 900_000 },
    ]);
    const device = w.calls.find((c) => c.url === 'https://github.com/login/device/code')!;
    expect(new URLSearchParams(device.body).get('client_id')).toBe(CLIENT);
    expect(w.calls.map((c) => c.url)).toEqual([
      `${ENDPOINT}/v1/meta.json`,
      'https://github.com/login/device/code',
      'https://github.com/login/oauth/access_token',
      'https://github.com/login/oauth/access_token',
      `${ENDPOINT}/v1/auth/github`,
    ]);
    // the GitHub token goes once, in the body, to the endpoint that named the client id
    const sent = w.calls.filter(
      (c) => c.body.includes(GH_TOKEN) || JSON.stringify(c.headers).includes(GH_TOKEN),
    );
    expect(sent.map((c) => c.url)).toEqual([`${ENDPOINT}/v1/auth/github`]);
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(readCredential(ENDPOINT, cat)).toBe(MARKET_TOKEN);
    expect(readPublisher(ENDPOINT, cat)).toBe('octo-cat');
    const written = files(root);
    expect(written.length).toBeGreaterThan(0);
    for (const f of written) expect(fs.readFileSync(f, 'utf8'), f).not.toContain(GH_TOKEN);
  });

  it('refuses a token-mode server without contacting GitHub', async () => {
    const w = world({ meta: metaBody({ auth: ['token'], github: undefined }) });
    const h = deps(w);
    let err: unknown;
    try {
      await signInWithGitHub(h.deps);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SignInError);
    expect((err as SignInError).code).toBe('not-github');
    expect((err as SignInError).tokenMode).toBe(true);
    expect(w.calls.filter((c) => c.url.startsWith('https://github.com'))).toEqual([]);
    expect(h.codes).toEqual([]);
  });

  it('needs a client id in meta even when github-device is listed', async () => {
    const w = world({ meta: metaBody({ github: undefined }) });
    const h = deps(w);
    expect(await code(signInWithGitHub(h.deps))).toBe('not-github');
    expect(w.calls.filter((c) => c.url.startsWith('https://github.com'))).toEqual([]);
  });

  it('stops with cancelled when the signal aborts while polling', async () => {
    const w = world({ polls: [pending, pending, pending] });
    const ac = new AbortController();
    const c = clock();
    const h = deps(w, {
      signal: ac.signal,
      sleep: async (ms) => {
        await c.sleep(ms);
        if (c.sleeps.length === 2) ac.abort();
      },
    });
    expect(await code(signInWithGitHub(h.deps))).toBe('cancelled');
    expect(w.calls.some((c) => c.url === `${ENDPOINT}/v1/auth/github`)).toBe(false);
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('stops with expired when the code runs out', async () => {
    const w = world({ polls: Array.from({ length: 400 }, () => pending) });
    const h = deps(w);
    expect(await code(signInWithGitHub(h.deps))).toBe('expired');
    expect(h.clock.now()).toBeGreaterThanOrEqual(T0 + 900_000);
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('maps denied, disabled and the marketplace answer', async () => {
    expect(
      await code(signInWithGitHub(deps(world({ polls: [() => json({ error: 'access_denied' })] })).deps)),
    ).toBe('denied');
    const off = world();
    const disabled = deps(off, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        String(input) === 'https://github.com/login/device/code'
          ? json({ error: 'device_flow_disabled' }, 400)
          : off.fetch(input, init)) as typeof fetch,
    });
    expect(await code(signInWithGitHub(disabled.deps))).toBe('disabled');
    const refused = world({ signIn: () => json({ error: 'unauthorized', message: 'no' }, 401) });
    expect(await code(signInWithGitHub(deps(refused).deps))).toBe('unauthorized');
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('needs an endpoint and sends nothing without one', async () => {
    const w = world();
    const h = deps(w, { env: {} });
    expect(await code(signInWithGitHub(h.deps))).toBe('no-endpoint');
    expect(w.calls).toEqual([]);
  });

  it('replaces an older credential for the same endpoint only', async () => {
    writeCredential('https://other.example.com', 'b'.repeat(64), cat);
    writePublisher('https://other.example.com', 'someone', cat);
    await signInWithGitHub(deps(world()).deps);
    expect(readCredential('https://other.example.com', cat)).toBe('b'.repeat(64));
    expect(readPublisher('https://other.example.com', cat)).toBe('someone');
    expect(readCredential(ENDPOINT, cat)).toBe(MARKET_TOKEN);
  });
});
