import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import type { HttpValue } from '../../../src/core/job-values.js';
import type { Config, WidgetItem } from '../../../src/core/types.js';
import { httpGroups, httpJob } from '../../../src/data/jobs/http.js';
import { JOBS, jobFor, scheduleJobs } from '../../../src/data/jobs/index.js';
import { hash16, httpKey } from '../../../src/data/jobs/keys.js';
import {
  blockedByTraffic,
  type ExecFileLike,
  executeJob,
  type JobCtx,
  type JobEnvelope,
  readEnvelope,
} from '../../../src/data/jobs/runner.js';
import { fakeFetch, json } from '../../fake-fetch.js';

const NOW = 1_800_000_000_000;
const TOKEN = 'tok-SECRET-abc';
const QUERY = 'q-SECRET-xyz';
const BODY = 'body-SECRET-123';
const AUTH = 'Authorization=Bearer $RELAY_TOKEN';

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

const hits: Hit[] = [];
let base = '';
let server: http.Server;

const routes: Record<string, (res: http.ServerResponse) => void> = {
  '/data': (res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        data: { balance: 12.5, name: '\u001b[31mx', obj: {}, list: [1], flag: true, none: null },
        long: 'y'.repeat(300),
        secret: BODY,
      }),
    );
  },
  '/raw': (res) => res.end('{"big":1e400,"ok":1}'),
  '/away': (res) => {
    res.statusCode = 302;
    res.setHeader('location', 'https://evil.example/steal');
    res.end();
  },
  '/huge': (res) => res.end(`{"a":"${'z'.repeat(300 * 1024)}"}`),
  '/busy': (res) => {
    res.statusCode = 429;
    res.setHeader('retry-after', '120');
    res.end('slow down');
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    const route = routes[new URL(req.url ?? '/', 'http://x').pathname];
    if (route) route(res);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sandbox = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-http-'));
  return {
    HOME: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'cfg'),
    CCINFOBAR_NO_UPDATE: '1',
    ...extra,
  };
};

let n = 0;
const item = (options: WidgetItem['options']): WidgetItem => ({ id: `h${n++}`, type: 'http', options });
const withItems = (...items: WidgetItem[]): Config => ({ ...defaultConfig(), lines: [items] });

const keyOf = (config: Config): string => {
  const [key] = [...httpGroups(config).keys()];
  return key!;
};

async function run(
  config: Config,
  env: NodeJS.ProcessEnv,
  f: typeof fetch = globalThis.fetch,
  execFile?: ExecFileLike,
) {
  const key = keyOf(config);
  const ctx: JobCtx<HttpValue> = {
    env,
    config,
    cwd: '/',
    prev: readEnvelope<HttpValue>(key, env),
    fetch: f,
    now: NOW,
    ...(execFile ? { execFile } : {}),
  };
  return executeJob(httpJob, { key }, ctx);
}

function readAll(dir: string): string {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    out += `${name}\n`;
    out += st.isDirectory() ? readAll(p) : fs.readFileSync(p, 'utf8');
  }
  return out;
}

const since = (from: number) => hits.slice(from);

describe('httpKey', () => {
  it('hashes with sha256 and keeps 16 hex characters', () => {
    expect(hash16('abc')).toBe('ba7816bf8f01cfea');
    expect(httpKey('https://a.example/x', '')).toMatch(/^http-[0-9a-f]{16}$/);
  });

  it('normalizes the header spec', () => {
    const url = 'https://a.example/x';
    expect(httpKey(url, AUTH)).toBe(httpKey(url, ' Authorization = Bearer ${RELAY_TOKEN} '));
    expect(httpKey(url, AUTH)).not.toBe(httpKey(url, 'Authorization=Token $RELAY_TOKEN'));
    expect(httpKey(url, AUTH)).not.toBe(httpKey('https://a.example/y', AUTH));
  });

  it('never depends on env values', () => {
    const config = withItems(item({ url: 'https://a.example/x?key=${API_KEY}', headers: AUTH }));
    const keys = (env: NodeJS.ProcessEnv) => httpJob.keys({ config, payload: {}, env, cwd: '/', now: NOW });
    const a = keys(sandbox({ RELAY_TOKEN: 'one', API_KEY: 'k1' }));
    const b = keys(sandbox({ RELAY_TOKEN: 'two', API_KEY: 'k2' }));
    expect(a).toEqual(b);
    expect(a[0]?.key).toBe(httpKey('https://a.example/x?key=${API_KEY}', AUTH));
  });
});

describe('httpGroups', () => {
  it('merges items on one url and headers spec', () => {
    const url = 'https://a.example/x';
    const groups = httpGroups(
      withItems(
        item({ url, headers: AUTH, path: '$.a', interval: 60 }),
        item({ url, headers: AUTH, path: '$.b', interval: 300 }),
        item({ url, headers: AUTH, path: '$.a' }),
      ),
    );
    expect(groups.size).toBe(1);
    const [g] = [...groups.values()];
    expect(g).toEqual({
      key: httpKey(url, AUTH),
      url,
      headers: AUTH,
      paths: ['$.a', '$.b'],
      intervalS: 60,
      timeoutMs: 5000,
    });
  });

  it('splits on a different header spec', () => {
    const url = 'https://a.example/x';
    const groups = httpGroups(withItems(item({ url, headers: AUTH }), item({ url, headers: 'X-Key=$K' })));
    expect(groups.size).toBe(2);
  });

  it('defaults and clamps interval, timeout and path', () => {
    const url = 'https://a.example/x';
    const one = (options: WidgetItem['options']) =>
      [...httpGroups(withItems(item({ url, ...options }))).values()][0];
    expect(one({})).toMatchObject({ intervalS: 300, timeoutMs: 5000, paths: ['$'] });
    expect(one({ interval: 5 })?.intervalS).toBe(30);
    expect(one({ interval: '90' })?.intervalS).toBe(90);
    expect(one({ timeout: 10 })?.timeoutMs).toBe(1000);
    expect(one({ timeout: 60_000 })?.timeoutMs).toBe(15_000);
    expect(one({ path: '' })?.paths).toEqual(['$']);
  });

  it('skips items without a url and other widget types', () => {
    const config: Config = {
      ...defaultConfig(),
      lines: [
        [item({}), item({ url: '' }), { id: 'm', type: 'model', options: { url: 'https://x.example' } }],
      ],
    };
    expect(httpGroups(config).size).toBe(0);
    expect(httpJob.keys({ config, payload: {}, env: sandbox(), cwd: '/', now: NOW })).toEqual([]);
  });
});

describe('httpJob registration', () => {
  it('is registered as explicit network', () => {
    expect(JOBS).toContain(httpJob);
    const key = httpKey('https://a.example/x', '');
    expect(jobFor(key)).toBe(httpJob);
    expect(jobFor('http-xyz')).not.toBe(httpJob);
    expect(httpJob).toMatchObject({ id: 'http', network: 'explicit', lockMs: 60_000, timeoutMs: 16_000 });
    expect(blockedByTraffic(httpJob.network, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })).toBe(false);
  });

  it('asks for one request per group with the interval as ttl', () => {
    const config = withItems(
      item({ url: 'https://a.example/x', interval: 45 }),
      item({ url: 'https://a.example/x', path: '$.b' }),
      item({ url: 'https://b.example/y' }),
    );
    const reqs = httpJob.keys({ config, payload: {}, env: sandbox(), cwd: '/', now: NOW });
    expect(reqs).toEqual([
      { key: httpKey('https://a.example/x', ''), ttlMs: 45_000, paths: ['$', '$.b'] },
      { key: httpKey('https://b.example/y', ''), ttlMs: 300_000, paths: ['$'] },
    ]);
  });

  it('accepts only configured keys', () => {
    const config = withItems(item({ url: 'https://a.example/x' }));
    const input = { config, env: sandbox(), cwd: '/' };
    expect(httpJob.accepts({ key: httpKey('https://a.example/x', '') }, input)).toBe(true);
    expect(httpJob.accepts({ key: httpKey('https://a.example/z', '') }, input)).toBe(false);
  });

  it('is due by the requested ttl', () => {
    const e = (fetchedAt: number): JobEnvelope<HttpValue> => ({
      v: 1,
      key: 'http-0000000000000000',
      fetchedAt,
      ok: true,
      value: { paths: {} },
    });
    const req = { key: 'http-0000000000000000', ttlMs: 60_000 };
    expect(httpJob.due(null, NOW, req)).toBe(true);
    expect(httpJob.due(e(NOW - 50_000), NOW, req)).toBe(false);
    expect(httpJob.due(e(NOW - 60_000), NOW, req)).toBe(true);
    expect(httpJob.due(e(NOW - 200_000), NOW, { key: req.key })).toBe(false);
  });

  it('is due at once when a configured path is not in the envelope', () => {
    const e = (ok: boolean): JobEnvelope<HttpValue> => ({
      v: 1,
      key: 'http-0000000000000000',
      fetchedAt: NOW - 10_000,
      ok,
      value: ok ? { paths: { '$.a': { ok: true, v: 1 } } } : null,
      ...(ok ? {} : { blockedUntil: NOW + 50_000 }),
    });
    const req = (paths: string[]) => ({ key: 'http-0000000000000000', ttlMs: 300_000, paths });
    expect(httpJob.due(e(true), NOW, req(['$.a']))).toBe(false);
    expect(httpJob.due(e(true), NOW, req(['$.a', '$.b']))).toBe(true);
    expect(httpJob.due(e(false), NOW, req(['$.a', '$.b']))).toBe(false);
  });

  it('schedules once for two items on one url, even with nonessential traffic off', () => {
    const url = 'https://a.example/x?key=${API_KEY}';
    const config = withItems(
      item({ url, headers: AUTH, path: '$.a' }),
      item({ url, headers: AUTH, path: '$.b' }),
    );
    const env = sandbox({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      RELAY_TOKEN: TOKEN,
      API_KEY: QUERY,
    });
    const spawned: string[][] = [];
    const keys = scheduleJobs(config, {}, env, '/', null, {
      now: NOW,
      jobs: [httpJob as never],
      spawn: (args) => {
        spawned.push(args);
        return true;
      },
    });
    expect(keys).toEqual([httpKey(url, AUTH)]);
    expect(spawned).toHaveLength(1);
    const argv = spawned[0]!.join(' ');
    expect(argv).not.toContain('example');
    expect(argv).not.toContain('SECRET');
    expect(argv).not.toContain('RELAY_TOKEN');
  });
});

describe('httpJob.run', () => {
  it('extracts scalars per path', async () => {
    const env = sandbox();
    const config = withItems(
      ...['$.data.balance', '$.data.name', '$.data.obj', '$.missing', '$..x', '$.data.list[*]'].map((p) =>
        item({ url: `${base}/data`, path: p }),
      ),
      item({ url: `${base}/data`, path: '$.data.list' }),
      item({ url: `${base}/data`, path: '$.data.flag' }),
      item({ url: `${base}/data`, path: '$.data.none' }),
      item({ url: `${base}/data`, path: '$.long' }),
    );
    const from = hits.length;
    const out = await run(config, env);
    expect(since(from)).toHaveLength(1);
    expect(out.ok).toBe(true);
    const paths = out.value!.paths;
    expect(paths['$.data.balance']).toEqual({ ok: true, v: 12.5 });
    expect(paths['$.data.name']).toEqual({ ok: true, v: 'x' });
    expect(paths['$.data.obj']).toEqual({ ok: false, code: 'not-scalar' });
    expect(paths['$.data.list']).toEqual({ ok: false, code: 'not-scalar' });
    expect(paths['$.missing']).toEqual({ ok: false, code: 'path-miss' });
    expect(paths['$..x']).toEqual({ ok: false, code: 'bad-path' });
    expect(paths['$.data.list[*]']).toEqual({ ok: false, code: 'bad-path' });
    expect(paths['$.data.flag']).toEqual({ ok: true, v: true });
    expect(paths['$.data.none']).toEqual({ ok: true, v: null });
    expect(paths['$.long']).toEqual({ ok: true, v: 'y'.repeat(256) });
    expect(readEnvelope(out.key, env)).toEqual(out);
  });

  it('treats a non-finite number as not-scalar', async () => {
    const config = withItems(
      item({ url: `${base}/raw`, path: '$.big' }),
      item({ url: `${base}/raw`, path: '$.ok' }),
    );
    const out = await run(config, sandbox());
    expect(out.value!.paths['$.big']).toEqual({ ok: false, code: 'not-scalar' });
    expect(out.value!.paths['$.ok']).toEqual({ ok: true, v: 1 });
  });

  it('sends a GET with accept and user-agent and the header to loopback', async () => {
    const env = sandbox({ RELAY_TOKEN: TOKEN });
    const from = hits.length;
    const out = await run(withItems(item({ url: `${base}/data`, headers: AUTH })), env);
    expect(out.ok).toBe(true);
    const [hit] = since(from);
    expect(hit?.method).toBe('GET');
    expect(hit?.headers.accept).toBe('application/json');
    expect(hit?.headers['user-agent']).toBe('ccinfobar');
    expect(hit?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends headers over https', async () => {
    const env = sandbox({ RELAY_TOKEN: TOKEN });
    const { fetch: f, calls } = fakeFetch([json({ a: 1 })]);
    const out = await run(
      withItems(item({ url: 'https://api.example.com/v1', headers: AUTH, path: '$.a' })),
      env,
      f,
    );
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses env values over plain http to a non-loopback host', async () => {
    const env = sandbox({ RELAY_TOKEN: TOKEN, API_KEY: QUERY });
    const { fetch: f, calls } = fakeFetch([json({ a: 1 }), json({ a: 1 })]);
    const cases: Record<string, string>[] = [
      { url: 'http://api.example.com/v1', headers: AUTH },
      { url: 'http://api.example.com/q?key=${API_KEY}' },
    ];
    for (const opts of cases) {
      const out = await run(withItems(item({ ...opts, path: '$.a' })), env, f);
      expect(out).toMatchObject({ ok: false, error: 'insecure-url' });
      expect(JSON.stringify(out)).not.toContain('SECRET');
    }
    expect(calls).toHaveLength(0);
    const config = withItems(item({ url: 'http://api.example.com/q?key=${API_KEY}' }));
    expect(httpJob.keys({ config, payload: {}, env, cwd: '/', now: NOW } as any)).toEqual([]);
    await run(withItems(item({ url: 'http://localhost:8080/v1', headers: AUTH, path: '$.a' })), env, f);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const plain = await run(withItems(item({ url: 'http://api.example.com/v1', path: '$.a' })), env, f);
    expect(plain.ok).toBe(true);
    expect(calls[1]?.headers.authorization).toBeUndefined();
  });

  it('refuses denied env names before reading them', async () => {
    const env = sandbox({ ANTHROPIC_API_KEY: TOKEN, AWS_SECRET_ACCESS_KEY: TOKEN });
    const { fetch: f, calls } = fakeFetch([json({ a: 1 })]);
    for (const opts of [
      { url: 'https://attacker.example/', headers: 'X=$ANTHROPIC_API_KEY' },
      { url: 'https://attacker.example/?k=${AWS_SECRET_ACCESS_KEY}' },
    ] as Record<string, string>[]) {
      const out = await run(withItems(item({ ...opts, path: '$.a' })), env, f);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/^env (ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY) denied$/);
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      const config = withItems(item(opts));
      expect(httpJob.keys({ config, payload: {}, env, cwd: '/', now: NOW } as any)).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it('sends GitHub tokens only to GitHub or a host gh is logged in to', async () => {
    const env = sandbox({ GH_TOKEN: TOKEN });
    const execs: string[][] = [];
    const exec =
      (hosts: string[]): ExecFileLike =>
      async (_file, args) => {
        execs.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ hosts: Object.fromEntries(hosts.map((h) => [h, []])) }),
          stderr: '',
        };
      };
    const { fetch: f, calls } = fakeFetch([json({ a: 1 }), json({ a: 1 })]);
    const gh = 'Authorization=Bearer $GH_TOKEN';
    const ok = await run(
      withItems(item({ url: 'https://api.github.com/x', headers: gh, path: '$.a' })),
      env,
      f,
    );
    expect(ok.ok).toBe(true);
    expect(execs).toHaveLength(0);
    const other = withItems(item({ url: 'https://ghe.corp.example/api/v3/x', headers: gh, path: '$.a' }));
    const denied = await run(other, env, f, exec(['github.com']));
    expect(denied).toMatchObject({ ok: false, error: 'env GH_TOKEN denied', blockedUntil: NOW + 3_600_000 });
    expect(calls).toHaveLength(1);
    const listed = await run(other, sandbox({ GH_TOKEN: TOKEN }), f, exec(['ghe.corp.example']));
    expect(listed.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('fetches nothing when a header variable is unset', async () => {
    const from = hits.length;
    const out = await run(withItems(item({ url: `${base}/data`, headers: AUTH })), sandbox());
    expect(since(from)).toHaveLength(0);
    expect(out).toMatchObject({ ok: false, error: 'env RELAY_TOKEN not set' });
    expect(out.blockedUntil).toBe(NOW + 60_000);
  });

  it('reports a scrubbed variable as not set', async () => {
    const env = sandbox({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' });
    const { fetch: f, calls } = fakeFetch([]);
    const out = await run(withItems(item({ url: 'https://api.example.com/v1', headers: AUTH })), env, f);
    expect(calls).toHaveLength(0);
    expect(out.error).toBe('env RELAY_TOKEN not set');
  });

  it('fetches nothing when a query variable is unset', async () => {
    const { fetch: f, calls } = fakeFetch([]);
    const out = await run(
      withItems(item({ url: 'https://api.example.com/v1?key=${API_KEY}' })),
      sandbox(),
      f,
    );
    expect(calls).toHaveLength(0);
    expect(out.error).toBe('env API_KEY not set');
  });

  it('rejects a bad template or header spec without fetching', async () => {
    const { fetch: f, calls } = fakeFetch([]);
    const bad = await run(withItems(item({ url: 'https://${HOST}/v1' })), sandbox({ HOST: 'x' }), f);
    expect(bad.error).toBe('bad-url');
    const literal = await run(
      withItems(item({ url: 'https://a.example/v1', headers: 'X-Key=abc' })),
      sandbox(),
      f,
    );
    expect(literal.error).toBe('bad-headers');
    expect(calls).toHaveLength(0);
  });

  it('fails a key that is no longer configured', async () => {
    const env = sandbox();
    const out = await executeJob(
      httpJob,
      { key: httpKey('https://gone.example', '') },
      {
        env,
        config: withItems(item({ url: 'https://a.example/x' })),
        cwd: '/',
        prev: null,
        fetch: fakeFetch([]).fetch,
        now: NOW,
      },
    );
    expect(out.error).toBe('not-configured');
  });

  it('keeps every secret out of the cache dir (D-28)', async () => {
    const env = sandbox({ RELAY_TOKEN: TOKEN, API_KEY: `${QUERY}&a=b` });
    const url = `${base}/data?key=\${API_KEY}`;
    const from = hits.length;
    const out = await run(withItems(item({ url, headers: AUTH, path: '$.data.balance' })), env);
    expect(out.ok).toBe(true);
    const [hit] = since(from);
    expect(hit?.url).toBe(`/data?key=${encodeURIComponent(`${QUERY}&a=b`)}`);
    expect(hit?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const all = readAll(env.CCINFOBAR_CACHE_DIR!);
    expect(all).toContain(out.key);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(QUERY);
    expect(all).not.toContain(BODY);
    expect(all).not.toContain('127.0.0.1');
  });

  it('refuses a cross-origin redirect', async () => {
    const env = sandbox({ RELAY_TOKEN: TOKEN });
    const from = hits.length;
    const out = await run(withItems(item({ url: `${base}/away`, headers: AUTH })), env);
    expect(since(from)).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, error: 'cross-origin-redirect' });
  });

  it('caps the body at 256 KB', async () => {
    const out = await run(withItems(item({ url: `${base}/huge` })), sandbox());
    expect(out).toMatchObject({ ok: false, error: 'too-large' });
  });

  it('honours Retry-After on 429', async () => {
    const out = await run(withItems(item({ url: `${base}/busy` })), sandbox());
    expect(out).toMatchObject({ ok: false, error: 'http-429', blockedUntil: NOW + 120_000 });
  });

  it('stores a fixed code for a network error, never its message', async () => {
    const env = sandbox({ API_KEY: QUERY });
    const msg = `fetch failed for https://api.example.com/v1?key=${QUERY}`;
    const { fetch: f } = fakeFetch([new TypeError(msg)]);
    const out = await run(withItems(item({ url: 'https://api.example.com/v1?key=${API_KEY}' })), env, f);
    expect(out.error).toBe('network');
    expect(readAll(env.CCINFOBAR_CACHE_DIR!)).not.toContain(QUERY);
  });

  it('keeps the last good value after a failure', async () => {
    const env = sandbox();
    const config = withItems(item({ url: 'https://api.example.com/v1', path: '$.a' }));
    const { fetch: f } = fakeFetch([json({ a: 7 }), new TypeError('boom')]);
    await run(config, env, f);
    const out = await run(config, env, f);
    expect(out.ok).toBe(false);
    expect(out.lastGood?.paths['$.a']).toEqual({ ok: true, v: 7 });
  });
});
