import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/catalog/model.js';
import { reviewPublish, runPublish } from '../../src/catalog/publish.js';
import { listEntries, saveEntry, writeCredential } from '../../src/catalog/store.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { startMarketServer } from '../../src/market/server.js';
import { json } from '../fake-fetch.js';

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const FAKE = 'https://m.example.com';
const TOKEN = 'c'.repeat(64);

let dir: string;
let cat: string;
let pub: string;
let handle: EditorHandle | null = null;
let port: number;
let t = T0;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'CCINFOBAR_CONFIG_DIR',
  'CCINFOBAR_CACHE_DIR',
  'CCINFOBAR_MARKETPLACE_URL',
  'HOME',
  'USERPROFILE',
];
const servers: { close(): Promise<void> }[] = [];

const LINKED: EntryContent = {
  layout: {
    lines: [
      [
        { id: 'm', type: 'model' },
        { id: 'l', type: 'link', options: { url: 'https://example.com/docs', text: 'docs' } },
      ],
    ],
  },
  appearance: { theme: 'nord' },
};

type Res = { status: number; json: () => Record<string, any> };

function request(method: string, p: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = { 'x-ccinfobar-token': handle!.token };
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

async function boot(market: { fetch: typeof fetch; defaultEndpoint?: string | null }): Promise<void> {
  handle = await startEditor({
    configPath: path.join(dir, 'c.json'),
    open: false,
    port: 0,
    claudeVersion: () => null,
    market: { now: () => t, ...market },
  });
  port = Number(new URL(handle.url).port);
}

// the Worker's ETag and 304 in front of the reference server; counts requests
function counted() {
  const seen: { path: string; status: number }[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await globalThis.fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const where = new URL(url).pathname;
    if ((init?.method ?? 'GET') !== 'GET' || res.status !== 200) {
      seen.push({ path: where, status: res.status });
      return res;
    }
    const body = await res.text();
    const tag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    if (new Headers(init?.headers).get('if-none-match') === tag) {
      seen.push({ path: where, status: 304 });
      return new Response(null, { status: 304, headers: { etag: tag } });
    }
    seen.push({ path: where, status: 200 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', etag: tag } });
  }) as typeof fetch;
  return { fetch: fn, seen };
}

// a reference server with alice's entries, published from her own catalog
async function market() {
  const s = await startMarketServer({ dataDir: path.join(dir, `data-${servers.length}`) });
  servers.push(s);
  process.env.CCINFOBAR_MARKETPLACE_URL = s.url;
  const send = async (
    name: string,
    content: EntryContent,
    mode: 'new' | 'update' | 'overwrite' = 'new',
    cols?: number,
  ) => {
    const hit = listEntries(pub).find((e) => e.name === name);
    saveEntry(
      {
        kind: 'bundle',
        name,
        description: `${name} layout`,
        author: 'Alice',
        content,
        share: true,
        now: new Date(T0),
        ...(cols === undefined ? {} : { cols }),
        ...(hit ? { mode, id: hit.id, rev: hit.rev } : { mode: 'new' as const }),
      },
      pub,
    );
    const deps = { dir: pub, env: { CCINFOBAR_MARKETPLACE_URL: s.url }, fetch: globalThis.fetch };
    const res = await runPublish(await reviewPublish(null, deps), deps);
    expect(res.code).toBeNull();
    expect(res.results.filter((r) => !r.ok)).toEqual([]);
  };
  return { url: s.url, send };
}

const remoteIdOf = (name: string): string => listEntries(pub).find((e) => e.name === name)!.share.remote!.id;

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-routes-'));
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  process.env.HOME = path.join(dir, 'home');
  process.env.USERPROFILE = path.join(dir, 'home');
  delete process.env.CCINFOBAR_MARKETPLACE_URL;
  cat = path.join(dir, 'cfg', 'catalog');
  pub = path.join(dir, 'publisher', 'catalog');
  t = T0;
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  for (const s of servers.splice(0)) await s.close();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('editor install routes', () => {
  it('plans an install, then saves exactly the reviewed version with its origin', async () => {
    const m = await market();
    await m.send('Linked', LINKED);
    const id = remoteIdOf('Linked');
    const c = counted();
    await boot({ fetch: c.fetch });
    const plan = await request('POST', '/api/catalog/install/plan', { id });
    expect(plan.status).toBe(200);
    const p = plan.json();
    expect(p).toMatchObject({
      id,
      version: 1,
      kind: 'bundle',
      name: 'Linked',
      author: 'Alice',
      existing: null,
    });
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.targets).toEqual([{ kind: 'link', target: 'https://example.com/docs' }]);
    expect(listEntries(cat)).toEqual([]);
    const res = await request('POST', '/api/catalog/install', {
      id,
      version: p.version,
      hash: p.hash,
      targets: p.targets,
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: 'Linked', result: 'new' });
    const listed = (await request('GET', '/api/catalog')).json().user;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      ref: res.json().entryId,
      name: 'Linked',
      origin: { id, version: 1 },
      share: { wanted: false },
    });
    // a repeat install of the same hash saves nothing new
    const again = await request('POST', '/api/catalog/install', {
      id,
      version: 1,
      hash: p.hash,
      targets: p.targets,
    });
    expect(again.json()).toMatchObject({ result: 'same', entryId: res.json().entryId });
  });

  it('answers 409 changed when the server overwrote the version after the review', async () => {
    const m = await market();
    await m.send('Linked', LINKED);
    const id = remoteIdOf('Linked');
    await boot({ fetch: counted().fetch });
    const p = (await request('POST', '/api/catalog/install/plan', { id })).json();
    const other: EntryContent = { ...LINKED, appearance: { theme: 'dracula' } };
    await m.send('Linked', other, 'overwrite');
    expect(listEntries(pub)[0]!.share.remote!.version).toBe(1);
    const res = await request('POST', '/api/catalog/install', {
      id,
      version: 1,
      hash: p.hash,
      targets: p.targets,
    });
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ code: 'changed', errorId: 'err.catalog.install.changed' });
    expect(res.json().plan.hash).not.toBe(p.hash);
    expect(listEntries(cat)).toEqual([]);
  });

  it('answers 409 changed when the client edits the targets', async () => {
    const m = await market();
    await m.send('Linked', LINKED);
    const id = remoteIdOf('Linked');
    await boot({ fetch: counted().fetch });
    const p = (await request('POST', '/api/catalog/install/plan', { id })).json();
    for (const targets of [[], [{ kind: 'link', target: 'https://example.com/other' }]]) {
      const res = await request('POST', '/api/catalog/install', { id, version: 1, hash: p.hash, targets });
      expect(res.status).toBe(409);
      expect(res.json().code).toBe('changed');
    }
    const bad = await request('POST', '/api/catalog/install', { id, version: 1, hash: p.hash });
    expect(bad.status).toBe(400);
    expect(listEntries(cat)).toEqual([]);
  });

  it('maps a missing version and a bad id to messages without saving', async () => {
    const m = await market();
    await m.send('Linked', LINKED);
    const id = remoteIdOf('Linked');
    await boot({ fetch: counted().fetch });
    const none = await request('POST', '/api/catalog/install/plan', { id, version: 4 });
    expect(none.status).toBe(404);
    expect(none.json()).toMatchObject({
      errorId: 'err.catalog.install.noVersion',
      errorParams: { id, version: 4 },
    });
    const bad = await request('POST', '/api/catalog/install/plan', { id: 'not an id' });
    expect(bad.status).toBe(400);
    expect(bad.json().errorId).toBe('catalog.remote.badId');
    const gone = await request('POST', '/api/catalog/install/plan', { id: 'alice/nothing-here' });
    expect(gone.status).toBe(404);
    expect(gone.json().errorId).toBe('err.catalog.install.not-found');
  });

  it('GET /api/catalog shows the default endpoint and sends nothing', async () => {
    const calls: string[] = [];
    await boot({
      fetch: (async (u: string) => {
        calls.push(String(u));
        return json({});
      }) as unknown as typeof fetch,
      defaultEndpoint: FAKE,
    });
    const body = (await request('GET', '/api/catalog')).json();
    expect(body.market).toEqual({ endpoint: FAKE, source: 'default', signedIn: false, handle: null });
    expect(body.endpoint).toBe(FAKE);
    expect(calls).toEqual([]);
  });

  it('serves GET /api/catalog/remote from the 24 h cache; refresh sends one conditional request', async () => {
    const m = await market();
    await m.send('Linked', LINKED);
    const c = counted();
    await boot({ fetch: c.fetch });
    const first = await request('GET', '/api/catalog/remote');
    expect(first.status).toBe(200);
    expect(first.json().entries.map((e: { name: string }) => e.name)).toEqual(['Linked']);
    expect(first.json().checkedAt).toBe(new Date(T0).toISOString());
    const sent = c.seen.length;
    expect(sent).toBeGreaterThan(0);
    t += 3_600_000;
    const second = await request('GET', '/api/catalog/remote');
    expect(second.json().entries).toEqual(first.json().entries);
    expect(c.seen.length).toBe(sent);
    const refreshed = await request('GET', '/api/catalog/remote?refresh=1');
    expect(refreshed.status).toBe(200);
    expect(c.seen.slice(sent)).toEqual([{ path: '/v1/index.json', status: 304 }]);
    expect(refreshed.json().checkedAt).toBe(new Date(t).toISOString());
    t += 10_000;
    await request('GET', '/api/catalog/remote?refresh=1');
    expect(c.seen.length).toBe(sent + 1);
  });
});

describe('editor remote previews route', () => {
  it('renders a published entry; the index comes from the cache the second time', async () => {
    const m = await market();
    await m.send('Linked', LINKED);
    const id = remoteIdOf('Linked');
    const c = counted();
    await boot({ fetch: c.fetch });
    const body = { config: { lines: [[{ id: 'a', type: 'model' }]] }, ids: [id, 'alice/nothing-here', 7] };
    const res = await request('POST', '/api/catalog/remote/previews', body);
    expect(res.status).toBe(200);
    const previews = res.json().previews;
    expect(Object.keys(previews)).toEqual([id]);
    expect(previews[id].length).toBeGreaterThan(0);
    expect(previews[id].join('')).not.toBe('');
    const sent = c.seen.length;
    const again = await request('POST', '/api/catalog/remote/previews', body);
    expect(again.json()).toEqual(res.json());
    // overwrite on: the version is asked again, the index is not
    expect(c.seen.slice(sent).map((x) => x.path)).toEqual([`/v1/entries/${id}/1.json`, '/v1/meta.json']);
  });

  it('answers 400 without an ids array and 409 with the marketplace off', async () => {
    await market();
    await boot({ fetch: counted().fetch });
    const bad = await request('POST', '/api/catalog/remote/previews', { ids: 'alice/x' });
    expect(bad.status).toBe(400);
    await handle!.close();
    delete process.env.CCINFOBAR_MARKETPLACE_URL;
    const calls: string[] = [];
    await boot({
      fetch: (async (u: string) => {
        calls.push(String(u));
        return json({});
      }) as unknown as typeof fetch,
      defaultEndpoint: null,
    });
    const off = await request('POST', '/api/catalog/remote/previews', { ids: [] });
    expect(off.status).toBe(409);
    expect(off.json().errorId).toBe('err.catalog.noEndpoint');
    expect(calls).toEqual([]);
  });
});

describe('editor remote cols', () => {
  const flex: EntryContent = {
    layout: {
      lines: [
        [
          { id: 'm', type: 'model' },
          { id: 'f', type: 'flex' },
          { id: 'c', type: 'text', options: { text: 'end' } },
        ],
      ],
    },
    appearance: { theme: 'nord' },
  };
  const width = (l: string) => [...l.replace(/\x1b\[[0-9;]*m/g, '')].length;

  it('passes cols through list, entry and install plan, and previews at it', async () => {
    const m = await market();
    await m.send('Wide', flex, 'new', 150);
    await m.send('Plain', flex);
    const wide = remoteIdOf('Wide');
    const plain = remoteIdOf('Plain');
    await boot({ fetch: globalThis.fetch });
    const list = (await request('GET', '/api/catalog/remote')).json().entries;
    expect(list.find((e: { id: string }) => e.id === wide).cols).toBe(150);
    expect(list.find((e: { id: string }) => e.id === plain)).not.toHaveProperty('cols');
    expect((await request('GET', `/api/catalog/remote/${wide}`)).json().entry.cols).toBe(150);
    expect((await request('POST', '/api/catalog/install/plan', { id: wide })).json().cols).toBe(150);
    expect((await request('POST', '/api/catalog/install/plan', { id: plain })).json().cols).toBeNull();
    const res = await request('POST', '/api/catalog/remote/previews', {
      config: { lines: [[{ id: 'a', type: 'model' }]] },
      width: 96,
      ids: [wide, plain],
    });
    const { previews } = res.json();
    expect(width(previews[wide][0])).toBeGreaterThan(120);
    expect(width(previews[wide][0])).toBeLessThanOrEqual(150);
    expect(width(previews[plain][0])).toBeLessThanOrEqual(96);
  });
});

describe('editor report route', () => {
  function reports(answer: () => Response) {
    const calls: { url: string; method: string; auth: string | null; body: string }[] = [];
    const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const auth = new Headers(init.headers).get('authorization');
      calls.push({
        url,
        method: init.method ?? 'GET',
        auth,
        body: typeof init.body === 'string' ? init.body : '',
      });
      if (url === `${FAKE}/v1/entries/alice/x/reports` && init.method === 'POST') return answer();
      throw new TypeError(`no route for ${url}`);
    };
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  it('needs sign-in and sends nothing without it', async () => {
    const w = reports(() => json({ id: 1 }, 201));
    await boot({ fetch: w.fetch, defaultEndpoint: FAKE });
    const res = await request('POST', '/api/catalog/report', { id: 'alice/x', reason: 'spam' });
    expect(res.status).toBe(401);
    expect(res.json()).toMatchObject({ errorId: 'err.catalog.signInFirst', code: 'sign-in' });
    expect(w.calls).toEqual([]);
  });

  it('checks the reason and the id before any request', async () => {
    const w = reports(() => json({ id: 1 }, 201));
    await boot({ fetch: w.fetch, defaultEndpoint: FAKE });
    writeCredential(FAKE, TOKEN, cat);
    for (const reason of ['', '   ', 'x'.repeat(201), 7]) {
      const res = await request('POST', '/api/catalog/report', { id: 'alice/x', reason });
      expect(res.status).toBe(400);
      expect(res.json()).toMatchObject({
        errorId: 'err.catalog.report.badReason',
        errorParams: { max: 200 },
      });
    }
    const bad = await request('POST', '/api/catalog/report', { id: '../x', reason: 'spam' });
    expect(bad.json().errorId).toBe('catalog.remote.badId');
    expect(w.calls).toEqual([]);
  });

  it('passes a report through when signed in and says when it was already sent', async () => {
    let answer = () => json({ id: 7 }, 201);
    const w = reports(() => answer());
    await boot({ fetch: w.fetch, defaultEndpoint: FAKE });
    writeCredential(FAKE, TOKEN, cat);
    const res = await request('POST', '/api/catalog/report', { id: 'alice/x', reason: '  spam  ' });
    expect(res.status).toBe(201);
    expect(res.json()).toEqual({ reported: true, report: 7 });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(w.calls[0]!.body)).toEqual({ reason: 'spam' });
    answer = () => json({ error: { code: 'conflict', message: 'already reported' } }, 409);
    const again = await request('POST', '/api/catalog/report', { id: 'alice/x', reason: 'spam' });
    expect(again.status).toBe(200);
    expect(again.json()).toEqual({ reported: false, already: true });
    answer = () => json({ error: { code: 'unauthorized', message: 'sign in' } }, 401);
    const refused = await request('POST', '/api/catalog/report', { id: 'alice/x', reason: 'spam' });
    expect(refused.status).toBe(401);
    expect(refused.json().errorId).toBe('err.catalog.signInFirst');
  });
});
