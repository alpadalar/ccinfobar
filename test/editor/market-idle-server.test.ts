import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { VERIFY_URL } from '../../src/market/github.js';
import { json } from '../fake-fetch.js';

// R-11: an open editor left alone sends nothing to the marketplace or GitHub
const ENDPOINT = 'https://m.example.com';
const DAY = 86_400_000;
const src = path.resolve(__dirname, '..', '..', 'src');

let dir: string;
let handle: EditorHandle | null = null;
let port: number;
let calls: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = [
  'CCINFOBAR_CONFIG_DIR',
  'CCINFOBAR_CACHE_DIR',
  'CCINFOBAR_MARKETPLACE_URL',
  'HOME',
  'USERPROFILE',
];

const counting = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  calls.push(url);
  if (url === `${ENDPOINT}/v1/meta.json`)
    return json({
      protocol: 1,
      name: 'idle marketplace',
      capabilities: { write: true, overwrite: false, withdraw: true, submit: 'api', review: true },
      auth: ['github-device'],
      github: { clientId: 'Ov23liVCN9Nf6VlLv3St' },
      limits: {},
    });
  if (url === 'https://github.com/login/device/code')
    return json({
      device_code: '3584d83530557fdd1f46af8289938c8ef79f9dc5',
      user_code: 'WDJB-MJHT',
      verification_uri: VERIFY_URL,
      expires_in: 900,
      interval: 5,
    });
  return json({ error: 'authorization_pending' });
}) as unknown as typeof fetch;

function request(method: string, p: string, body?: unknown): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { 'x-ccinfobar-token': handle!.token };
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function boot(): Promise<void> {
  handle = await startEditor({
    configPath: path.join(dir, 'c.json'),
    open: false,
    port: 0,
    claudeVersion: () => null,
    installKind: () => 'local',
    fetchLatest: async () => {
      calls.push('npm');
      return '0.0.0';
    },
    market: { fetch: counting, defaultEndpoint: ENDPOINT },
  });
  port = Number(new URL(handle.url).port);
}

// what the page asks for when it opens and when the Catalog page shows
async function pageLoad(): Promise<void> {
  expect((await request('GET', '/')).status).toBe(200);
  expect((await request('GET', '/api/state')).status).toBe(200);
  expect((await request('GET', '/api/system')).status).toBe(200);
  const cat = await request('GET', '/api/catalog?lang=en');
  expect(cat.status).toBe(200);
  expect(JSON.parse(cat.text).market).toMatchObject({ endpoint: ENDPOINT, source: 'default' });
  const previews = await request('POST', '/api/catalog/previews', {
    config: { lines: [[{ id: 'm', type: 'model' }]] },
    width: 100,
    lang: 'en',
  });
  expect(previews.status).toBe(200);
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-market-idle-'));
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  process.env.HOME = path.join(dir, 'home');
  process.env.USERPROFILE = path.join(dir, 'home');
  delete process.env.CCINFOBAR_MARKETPLACE_URL;
  calls = [];
  // timers the server schedules from here on are fake
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await handle?.close();
  handle = null;
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('editor server idle (R-11)', () => {
  it('makes zero marketplace or GitHub requests while idle for 24 h', async () => {
    const global = vi.spyOn(globalThis, 'fetch');
    await boot();
    await pageLoad();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toEqual([]);
    // the page is opened again a day later: still local only
    await pageLoad();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(calls).toEqual([]);
    expect(global).not.toHaveBeenCalled();
  });

  it('does not poll a sign-in flow on its own', async () => {
    await boot();
    const res = await request('POST', '/api/catalog/login', {});
    expect(res.status).toBe(200);
    const flow = JSON.parse(res.text).flow as string;
    const started = calls.length;
    expect(calls).toEqual([`${ENDPOINT}/v1/meta.json`, 'https://github.com/login/device/code']);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls).toHaveLength(started);
    // nobody asked for a day: the flow was dropped, GitHub is not asked
    expect(JSON.parse((await request('GET', `/api/catalog/login/${flow}`)).text)).toEqual({
      status: 'cancelled',
    });
    expect(calls).toHaveLength(started);
  });

  it('schedules no marketplace work with intervals', () => {
    const flows = fs.readFileSync(path.join(src, 'catalog', 'login-flows.ts'), 'utf8');
    expect(flows).not.toMatch(/\bset(?:Interval|Timeout)\(/);
    const server = fs.readFileSync(path.join(src, 'editor', 'server.ts'), 'utf8');
    const intervals = [...server.matchAll(/\bsetInterval\(/g)].map((m) => m.index);
    // the only one is the detached editor's idle shutdown check
    expect(intervals).toHaveLength(1);
    const detached = server.indexOf('function startDetached(');
    expect(detached).toBeGreaterThan(-1);
    expect(intervals[0]).toBeGreaterThan(detached);
    expect(server.slice(detached, intervals[0])).not.toMatch(/\bmarket|fetch\(/i);
  });
});
