import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SignInDeps, SignInError, signInWithGitHub } from '../../src/catalog/signin.js';
import { readCredential, readPublisher, writeCredential, writePublisher } from '../../src/catalog/store.js';
import { parseArgs } from '../../src/cli/args.js';
import { type CatalogDeps, runCatalog } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
import { VERIFY_URL } from '../../src/market/github.js';
import { startMarketServer } from '../../src/market/server.js';
import { json } from '../fake-fetch.js';
import { withLangAsync } from '../helpers.js';

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
    const refused = world({ signIn: () => json({ error: { code: 'unauthorized', message: 'no' } }, 401) });
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

interface RunOpts {
  tty?: boolean;
  answers?: boolean[];
  fetch?: typeof fetch;
  env?: Record<string, string>;
  deps?: Partial<CatalogDeps>;
}

async function run(argv: string[], opts: RunOpts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const opened: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const io: PromptIo = {
    tty: opts.tty ?? false,
    columns: 100,
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? false;
    },
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  };
  process.exitCode = undefined;
  await runCatalog(parseArgs(['catalog', ...argv]), path.join(root, 'config.json'), {
    io,
    dir: cat,
    env: opts.env ?? { CCINFOBAR_MARKETPLACE_URL: ENDPOINT },
    gsd: false,
    now: () => new Date(T0),
    defaultEndpoint: null,
    open: (url) => void opened.push(url),
    sleep: async () => {},
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...opts.deps,
  });
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, asked, opened, code, text: [...out, ...err].join('\n') };
}

const githubCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith('https://github.com'));

describe('catalog login', () => {
  it('prints the code, opens nothing with --no-open and signs in (D-07)', async () => {
    const w = world();
    const r = await run(['login', '--no-open'], { fetch: w.fetch, tty: true, answers: [true] });
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toBe(`To sign in, open ${VERIFY_URL} and enter the code WDJB-MJHT`);
    expect(r.out).toContain('The code expires in 15 minutes.');
    expect(r.asked).toEqual([]);
    expect(r.opened).toEqual([]);
    expect(r.out.at(-1)).toBe('Signed in as @octo-cat');
    expect(githubCalls(w.calls)).toHaveLength(3);
    expect(readCredential(ENDPOINT, cat)).toBe(MARKET_TOKEN);
    expect(r.text).not.toContain(MARKET_TOKEN);
    expect(r.text).not.toContain(GH_TOKEN);
  });

  it('asks on a terminal and opens only the GitHub page', async () => {
    const yes = await run(['login'], { fetch: world().fetch, tty: true, answers: [true] });
    expect(yes.asked).toEqual([`Open ${VERIFY_URL} in your browser?`]);
    expect(yes.opened).toEqual(['https://github.com/login/device']);
    const no = await run(['login'], { fetch: world().fetch, tty: true, answers: [false] });
    expect(no.asked).toHaveLength(1);
    expect(no.opened).toEqual([]);
    const pipe = await run(['login'], { fetch: world().fetch });
    expect(pipe.asked).toEqual([]);
    expect(pipe.opened).toEqual([]);
    const forced = await run(['login', '--open'], { fetch: world().fetch });
    expect(forced.opened).toEqual([VERIFY_URL]);
  });

  it('prints English JSON and keeps the code on stderr', async () => {
    const r = await withLangAsync('tr', () => run(['login', '--json'], { fetch: world().fetch }));
    expect(r.code).toBeUndefined();
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0]!)).toEqual({
      schema: 1,
      endpoint: ENDPOINT,
      handle: 'octo-cat',
      admin: false,
    });
    expect(r.err.join('\n')).toContain('WDJB-MJHT');
    expect(r.opened).toEqual([]);
  });

  it('says when the account is an admin', async () => {
    const w = world({
      signIn: () => json({ handle: 'octo-cat', token: MARKET_TOKEN, displayName: '', admin: true }),
    });
    const r = await run(['login'], { fetch: w.fetch });
    expect(r.out.slice(-2)).toEqual(['Signed in as @octo-cat', 'You are an admin on this marketplace.']);
  });

  it('fails with a clear message in English and Turkish (R-11)', async () => {
    const denied = () => world({ polls: [() => json({ error: 'access_denied' })] });
    const en = await run(['login'], { fetch: denied().fetch });
    expect(en.code).toBe(1);
    expect(en.err).toEqual(['Sign-in was denied on GitHub.']);
    const tr = await withLangAsync('tr', () => run(['login'], { fetch: denied().fetch }));
    expect(tr.code).toBe(1);
    expect(tr.err).toEqual(["Giriş GitHub'da reddedildi."]);
    expect(tr.out[0]).toContain('WDJB-MJHT');
    const refused = world({ signIn: () => json({ error: { code: 'upstream', message: 'x' } }, 502) });
    const up = await run(['login'], { fetch: refused.fetch });
    expect(up.err).toEqual([
      'Could not sign in: The sign-in service (GitHub) is not available; try again later',
    ]);
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('stops on Ctrl+C and removes its handler', async () => {
    const before = process.listeners('SIGINT');
    const w = world({ polls: Array.from({ length: 10 }, () => pending) });
    let sleeps = 0;
    const r = await run(['login'], {
      fetch: w.fetch,
      deps: {
        sleep: async () => {
          if (++sleeps === 2)
            for (const l of process.listeners('SIGINT')) if (!before.includes(l)) l('SIGINT');
        },
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['Sign-in cancelled.']);
    expect(process.listeners('SIGINT')).toEqual(before);
    expect(w.calls.some((c) => c.url === `${ENDPOINT}/v1/auth/github`)).toBe(false);
  });

  it('stops when the code expires', async () => {
    let t = T0;
    const w = world({ polls: Array.from({ length: 400 }, () => pending) });
    const r = await run(['login'], {
      fetch: w.fetch,
      deps: {
        now: () => new Date(t),
        sleep: async (ms) => {
          t += ms;
        },
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['The sign-in code expired. Run ccinfobar catalog login again.']);
  });

  it('refuses --dry-run and extra arguments without sending anything', async () => {
    const w = world();
    for (const argv of [
      ['login', '--dry-run'],
      ['logout', '--dry-run'],
      ['login', 'extra'],
    ]) {
      const r = await run(argv, { fetch: w.fetch });
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err[0]).toMatch(/^Usage: ccinfobar catalog list/);
    }
    expect(w.calls).toEqual([]);
  });

  it('needs an endpoint', async () => {
    const w = world();
    const r = await run(['login'], { fetch: w.fetch, env: {} });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['No marketplace endpoint set; entries stay waiting to publish']);
    expect(w.calls).toEqual([]);
  });

  it('explains token mode on the reference server and sends nothing to GitHub', async () => {
    const s = await startMarketServer({ dataDir: path.join(root, 'data') });
    try {
      const urls: string[] = [];
      const counted = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return globalThis.fetch(input, init);
      }) as typeof fetch;
      const r = await run(['login'], { fetch: counted, env: { CCINFOBAR_MARKETPLACE_URL: s.url } });
      expect(r.code).toBeUndefined();
      expect(r.out).toEqual([
        'This marketplace does not use GitHub sign-in. Publishing registers you: run ccinfobar catalog publish. Nothing was sent to GitHub.',
      ]);
      expect(urls).toEqual([`${s.url}/v1/meta.json`]);
      const j = await run(['login', '--json'], { fetch: counted, env: { CCINFOBAR_MARKETPLACE_URL: s.url } });
      expect(JSON.parse(j.out[0]!)).toMatchObject({ endpoint: s.url, handle: null, tokenMode: true });
    } finally {
      await s.close();
    }
  });
});

describe('catalog logout', () => {
  it('revokes the token on the server and forgets it locally', async () => {
    writeCredential(ENDPOINT, MARKET_TOKEN, cat);
    writePublisher(ENDPOINT, 'octo-cat', cat);
    writeCredential('https://other.example.com', 'b'.repeat(64), cat);
    const w = world();
    const r = await run(['logout'], { fetch: w.fetch });
    expect(r.code).toBeUndefined();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ url: `${ENDPOINT}/v1/auth/logout`, method: 'POST' });
    expect(w.calls[0]!.headers.authorization).toBe(`Bearer ${MARKET_TOKEN}`);
    expect(r.out).toEqual([
      `Signed out of ${ENDPOINT}. The marketplace token was removed from this computer.`,
    ]);
    const creds = JSON.parse(fs.readFileSync(path.join(cat, 'credentials.json'), 'utf8'));
    expect(Object.keys(creds)).toEqual(['https://other.example.com']);
    expect(readPublisher(ENDPOINT, cat)).toBeNull();
  });

  it('clears locally when the server cannot be reached', async () => {
    writeCredential(ENDPOINT, MARKET_TOKEN, cat);
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await run(['logout', '--json'], { fetch: failing });
    expect(r.code).toBeUndefined();
    expect(JSON.parse(r.out[0]!)).toEqual({ schema: 1, endpoint: ENDPOINT, signedOut: true });
    expect(readCredential(ENDPOINT, cat)).toBeNull();
  });

  it('says so when not signed in and sends nothing', async () => {
    const w = world();
    const r = await run(['logout'], { fetch: w.fetch });
    expect(r.code).toBeUndefined();
    expect(r.out).toEqual([`You are not signed in to ${ENDPOINT}.`]);
    expect(w.calls).toEqual([]);
    const tr = await withLangAsync('tr', () => run(['logout'], { fetch: w.fetch }));
    expect(tr.out).toEqual([`${ENDPOINT} üzerinde giriş yapmamışsınız.`]);
  });
});
