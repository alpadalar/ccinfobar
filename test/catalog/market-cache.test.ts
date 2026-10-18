import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planInstall } from '../../src/catalog/install.js';
import {
  cachedEntry,
  cachedIndex,
  cachedVersion,
  INDEX_TTL_MS,
  MIN_REFRESH_MS,
} from '../../src/catalog/market-cache.js';
import type { EntryContent } from '../../src/catalog/model.js';
import { contentHash, createMarketClient } from '../../src/market/client.js';

let root = '';
let cacheDir = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-mcache-'));
  cacheDir = path.join(root, 'cache');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const EP = 'https://market.example.com';
const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const HOUR = 3_600_000;

const content = (type: string): EntryContent => ({ layout: { lines: [[{ id: 'w', type }]] } });

function summary(n: number, hash: string) {
  return {
    id: `alp/e${n}`,
    kind: 'preset',
    name: `E${n}`,
    description: '',
    author: 'Alp',
    publisher: 'alp',
    version: 1,
    updatedAt: new Date(T0).toISOString(),
    hash,
  };
}

interface Call {
  path: string;
  inm: string | null;
}

// pages, entries and versions with ETags; a 304 when the tag matches
function fakeMarket() {
  const c1 = content('model');
  const s = {
    gen: 1,
    down: false,
    overwrite: false,
    pages: [[summary(1, contentHash(c1))], [summary(2, contentHash(c1))]],
    versions: new Map<string, { content: EntryContent; hash: string }[]>([
      ['alp/e1', [{ content: c1, hash: contentHash(c1) }]],
    ]),
  };
  const calls: Call[] = [];
  const res = (body: unknown, etag?: string) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
    });
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const inm = new Headers(init.headers).get('if-none-match');
    calls.push({ path: url.pathname, inm });
    if (s.down) throw new TypeError('fetch failed');
    const p = url.pathname;
    if (p === '/v1/meta.json')
      return res({
        protocol: 1,
        name: 'Test',
        capabilities: { write: true, overwrite: s.overwrite, withdraw: true, submit: 'api' },
        auth: ['token'],
        limits: {},
      });
    const page = p === '/v1/index.json' ? 1 : Number(/^\/v1\/index-(\d+)\.json$/.exec(p)?.[1] ?? 0);
    if (page) {
      const tag = `"g${s.gen}"`;
      if (inm === tag) return new Response(null, { status: 304, headers: { etag: tag } });
      const next = page < s.pages.length ? { next: `index-${page + 1}.json` } : {};
      return res({ entries: s.pages[page - 1] ?? [], generatedAt: `gen-${s.gen}`, ...next }, tag);
    }
    const em = /^\/v1\/entries\/([a-z0-9-]+\/[a-z0-9-]+)\.json$/.exec(p);
    const list = em ? s.versions.get(em[1]!) : undefined;
    if (em && list) {
      const last = list.at(-1)!;
      const tag = `"${last.hash.slice(0, 16)}-${list.length}"`;
      if (inm === tag) return new Response(null, { status: 304, headers: { etag: tag } });
      return res(
        {
          ...summary(1, last.hash),
          id: em[1],
          publisher: em[1]!.split('/')[0],
          version: list.length,
          versions: list.map((v, i) => ({
            version: i + 1,
            at: new Date(T0).toISOString(),
            note: '',
            hash: v.hash,
          })),
        },
        tag,
      );
    }
    const vm = /^\/v1\/entries\/([a-z0-9-]+\/[a-z0-9-]+)\/(\d+)\.json$/.exec(p);
    const v = vm ? s.versions.get(vm[1]!)?.[Number(vm[2]) - 1] : undefined;
    if (v) return res({ version: Number(vm![2]), content: v.content, hash: v.hash });
    return new Response(JSON.stringify({ error: { code: 'not-found', message: 'no' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createMarketClient({ endpoint: EP, fetch: fn as unknown as typeof fetch });
  return { s, calls, client, fetch: fn as unknown as typeof fetch };
}

const clock = (t: number) => () => new Date(t);
const marketDir = () =>
  path.join(cacheDir, 'market', createHash('sha256').update(EP).digest('hex').slice(0, 16));
const indexFile = () => path.join(marketDir(), 'index.json');
const idKey = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);

describe('cachedIndex', () => {
  it('never saves a partial walk, so the next load asks again (WR-08)', async () => {
    const m = fakeMarket();
    const partial = {
      ...m.client,
      indexIfChanged: async () => ({
        changed: true as const,
        etag: '"g9"',
        index: { entries: [], generatedAt: 'x', gen: 9, partial: true as const },
      }),
    };
    const r = await cachedIndex(EP, { client: partial, now: clock(T0), cacheDir });
    expect(r).toMatchObject({ fromCache: false, partial: true });
    expect(r.index).not.toHaveProperty('partial');
    expect(fs.existsSync(indexFile())).toBe(false);
    const again = await cachedIndex(EP, { client: m.client, now: clock(T0 + 1000), cacheDir });
    expect(again.fromCache).toBe(false);
    expect(again.partial).toBeUndefined();
    expect(fs.existsSync(indexFile())).toBe(true);
  });

  it('walks once, then serves the cache for 24 hours with no request', async () => {
    const m = fakeMarket();
    const first = await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
    expect(first.fromCache).toBe(false);
    expect(first.checkedAt).toBe(new Date(T0).toISOString());
    expect(first.index.entries.map((e) => e.id)).toEqual(['alp/e1', 'alp/e2']);
    expect(m.calls.map((c) => c.path)).toEqual(['/v1/index.json', '/v1/index-2.json']);
    const file = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    expect(file).toMatchObject({ schema: 1, endpoint: EP, etag: '"g1"', generatedAt: 'gen-1' });
    const later = await cachedIndex(EP, { client: m.client, now: clock(T0 + 23 * HOUR), cacheDir });
    expect(later).toEqual({ index: first.index, fromCache: true, checkedAt: first.checkedAt });
    expect(m.calls).toHaveLength(2);
  });

  it('a refresh sends one conditional request; 304 only moves checkedAt', async () => {
    const m = fakeMarket();
    await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
    m.calls.length = 0;
    const t = T0 + HOUR;
    const r = await cachedIndex(EP, { client: m.client, now: clock(t), cacheDir, refresh: true });
    expect(m.calls).toEqual([{ path: '/v1/index.json', inm: '"g1"' }]);
    expect(r).toMatchObject({ fromCache: true, checkedAt: new Date(t).toISOString() });
    expect(r.index.entries.map((e) => e.id)).toEqual(['alp/e1', 'alp/e2']);
    expect(JSON.parse(fs.readFileSync(indexFile(), 'utf8')).checkedAt).toBe(new Date(t).toISOString());
    // a second refresh inside the minimum interval sends nothing
    const again = await cachedIndex(EP, {
      client: m.client,
      now: clock(t + 10_000),
      cacheDir,
      refresh: true,
    });
    expect(again.checkedAt).toBe(new Date(t).toISOString());
    expect(m.calls).toHaveLength(1);
    expect(MIN_REFRESH_MS).toBe(30_000);
  });

  it('a changed index fetches the pages and replaces the cache', async () => {
    const m = fakeMarket();
    await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
    m.calls.length = 0;
    m.s.gen = 2;
    m.s.pages[1]!.push(summary(3, m.s.pages[0]![0]!.hash));
    const r = await cachedIndex(EP, { client: m.client, now: clock(T0 + HOUR), cacheDir, refresh: true });
    expect(m.calls).toEqual([
      { path: '/v1/index.json', inm: '"g1"' },
      { path: '/v1/index-2.json', inm: null },
    ]);
    expect(r.fromCache).toBe(false);
    expect(r.index.entries.map((e) => e.id)).toEqual(['alp/e1', 'alp/e2', 'alp/e3']);
    expect(JSON.parse(fs.readFileSync(indexFile(), 'utf8'))).toMatchObject({
      etag: '"g2"',
      generatedAt: 'gen-2',
    });
  });

  it('after 24 hours a plain read behaves like a refresh', async () => {
    const m = fakeMarket();
    await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
    m.calls.length = 0;
    const r = await cachedIndex(EP, { client: m.client, now: clock(T0 + INDEX_TTL_MS + HOUR), cacheDir });
    expect(m.calls).toEqual([{ path: '/v1/index.json', inm: '"g1"' }]);
    expect(r.fromCache).toBe(true);
    // a clock that went back is not trusted either
    m.calls.length = 0;
    await cachedIndex(EP, { client: m.client, now: clock(T0 - HOUR), cacheDir });
    expect(m.calls).toHaveLength(1);
  });

  it('concurrent calls share one walk', async () => {
    const m = fakeMarket();
    const deps = { client: m.client, now: clock(T0), cacheDir };
    const [a, b] = await Promise.all([cachedIndex(EP, deps), cachedIndex(EP, deps)]);
    expect(a).toBe(b);
    expect(m.calls.map((c) => c.path)).toEqual(['/v1/index.json', '/v1/index-2.json']);
  });

  it('a refresh during a plain load still sends its conditional request (IN-05)', async () => {
    const m = fakeMarket();
    await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
    m.calls.length = 0;
    const later = { client: m.client, now: clock(T0 + 60_000), cacheDir };
    const [plain, fresh] = await Promise.all([
      cachedIndex(EP, later),
      cachedIndex(EP, { ...later, refresh: true }),
    ]);
    expect(plain.fromCache).toBe(true);
    expect(fresh.checkedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(m.calls).toEqual([{ path: '/v1/index.json', inm: '"g1"' }]);
  });

  it('ignores corrupt or foreign cache files and rewrites them', async () => {
    const m = fakeMarket();
    fs.mkdirSync(marketDir(), { recursive: true });
    for (const bad of [
      '{nope',
      JSON.stringify({
        schema: 1,
        endpoint: 'https://other.example.com',
        etag: null,
        checkedAt: new Date(T0).toISOString(),
        generatedAt: '',
        entries: [],
      }),
      JSON.stringify({
        schema: 2,
        endpoint: EP,
        etag: null,
        checkedAt: new Date(T0).toISOString(),
        generatedAt: '',
        entries: [],
      }),
      JSON.stringify({
        schema: 1,
        endpoint: EP,
        etag: 'bad tag',
        checkedAt: new Date(T0).toISOString(),
        generatedAt: '',
        entries: [],
      }),
      JSON.stringify({
        schema: 1,
        endpoint: EP,
        etag: null,
        checkedAt: 'soon',
        generatedAt: '',
        entries: [],
      }),
    ]) {
      fs.writeFileSync(indexFile(), bad);
      m.calls.length = 0;
      const r = await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
      expect(r.fromCache).toBe(false);
      expect(m.calls[0]).toEqual({ path: '/v1/index.json', inm: null });
      expect(JSON.parse(fs.readFileSync(indexFile(), 'utf8'))).toMatchObject({ endpoint: EP, etag: '"g1"' });
    }
    // cached entries are parsed again: a forged one is dropped
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    raw.entries.push({ id: '../../x', kind: 'preset', name: 'X' });
    fs.writeFileSync(indexFile(), JSON.stringify(raw));
    const r = await cachedIndex(EP, { client: m.client, now: clock(T0 + HOUR), cacheDir });
    expect(r.index.entries.map((e) => e.id)).toEqual(['alp/e1', 'alp/e2']);
  });

  it('a failed refresh returns the cache as stale; without a cache it throws', async () => {
    const m = fakeMarket();
    m.s.down = true;
    await expect(cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir })).rejects.toMatchObject({
      name: 'MarketError',
      code: 'network',
    });
    m.s.down = false;
    const first = await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
    m.s.down = true;
    const r = await cachedIndex(EP, { client: m.client, now: clock(T0 + HOUR), cacheDir, refresh: true });
    expect(r).toEqual({ index: first.index, fromCache: true, checkedAt: first.checkedAt, stale: true });
  });

  it('never writes outside the cache dir through a planted link', async () => {
    const m = fakeMarket();
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, 'keep');
    fs.mkdirSync(marketDir(), { recursive: true });
    try {
      fs.symlinkSync(outside, indexFile());
    } catch {
      return; // no symlinks without rights on Windows
    }
    await cachedIndex(EP, { client: m.client, now: clock(T0), cacheDir });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });
});

describe('cachedEntry and cachedVersion', () => {
  it('revalidates a cached entry with one conditional request', async () => {
    const m = fakeMarket();
    const first = await cachedEntry(EP, 'alp/e1', { client: m.client, now: clock(T0), cacheDir });
    expect(first.fromCache).toBe(false);
    expect(m.calls).toEqual([{ path: '/v1/entries/alp/e1.json', inm: null }]);
    m.calls.length = 0;
    const again = await cachedEntry(EP, 'alp/e1', { client: m.client, now: clock(T0 + HOUR), cacheDir });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.inm).toMatch(/^"[0-9a-f]{16}-1"$/);
    expect(again).toEqual({
      entry: first.entry,
      fromCache: true,
      checkedAt: new Date(T0 + HOUR).toISOString(),
    });
    // a new version answers 200
    const c2 = content('cwd');
    m.s.versions.get('alp/e1')!.push({ content: c2, hash: contentHash(c2) });
    const fresh = await cachedEntry(EP, 'alp/e1', { client: m.client, now: clock(T0 + 2 * HOUR), cacheDir });
    expect(fresh.fromCache).toBe(false);
    expect(fresh.entry.version).toBe(2);
  });

  it('keeps immutable versions forever and re-hashes them on read', async () => {
    const m = fakeMarket();
    const h = m.s.versions.get('alp/e1')![0]!.hash;
    const deps = { client: m.client, cacheDir, kind: 'preset' as const, immutable: true };
    const v = await cachedVersion(EP, 'alp/e1', 1, h, deps);
    expect(v).toEqual({ version: 1, content: content('model'), hash: h });
    expect(m.calls).toHaveLength(1);
    expect(await cachedVersion(EP, 'alp/e1', 1, h, deps)).toEqual(v);
    expect(m.calls).toHaveLength(1);
    // an edited cache file is ignored and fetched again
    const file = path.join(marketDir(), 'versions', idKey('alp/e1'), '1.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.version.content.layout.lines[0][0].type = 'cwd';
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(await cachedVersion(EP, 'alp/e1', 1, h, deps)).toEqual(v);
    expect(m.calls).toHaveLength(2);
    // another expected hash never matches the cached file
    await expect(cachedVersion(EP, 'alp/e1', 1, 'f'.repeat(64), deps)).rejects.toMatchObject({
      code: 'bad-hash',
    });
  });

  it('names cache files by a hash of the id, so Windows device names never become paths (WR-09)', async () => {
    const m = fakeMarket();
    const c1 = m.s.versions.get('alp/e1')!;
    for (const id of ['con/nul', 'com1/lpt9', 'aux/prn']) m.s.versions.set(id, c1);
    for (const id of ['con/nul', 'com1/lpt9', 'aux/prn']) {
      const e = await cachedEntry(EP, id, { client: m.client, cacheDir });
      await cachedVersion(EP, id, 1, e.entry.hash, {
        client: m.client,
        cacheDir,
        kind: 'preset',
        immutable: true,
      });
    }
    const names: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        names.push(d.name);
        if (d.isDirectory()) walk(path.join(dir, d.name));
      }
    };
    walk(marketDir());
    expect(names.filter((n) => /^(?:con|nul|aux|prn|com\d|lpt\d)(?:\.|$)/i.test(n))).toEqual([]);
    expect(fs.existsSync(path.join(marketDir(), 'entries', `${idKey('con/nul')}.json`))).toBe(true);
    expect(fs.existsSync(path.join(marketDir(), 'versions', idKey('com1/lpt9'), '1.json'))).toBe(true);
  });

  it('caches nothing while the server allows overwrites', async () => {
    const m = fakeMarket();
    const h = m.s.versions.get('alp/e1')![0]!.hash;
    const deps = { client: m.client, cacheDir, kind: 'preset' as const, immutable: false };
    await cachedVersion(EP, 'alp/e1', 1, h, deps);
    await cachedVersion(EP, 'alp/e1', 1, h, deps);
    expect(m.calls).toHaveLength(2);
    expect(fs.existsSync(path.join(marketDir(), 'versions'))).toBe(false);
  });
});

describe('planInstall with the caches', () => {
  it('a second plan sends one entry request (304) and no version or meta request', async () => {
    const m = fakeMarket();
    const deps = {
      dir: path.join(root, 'catalog'),
      cacheDir,
      env: { CCINFOBAR_MARKETPLACE_URL: EP },
      fetch: m.fetch,
    };
    const a = await planInstall('alp/e1', deps);
    expect(m.calls.map((c) => c.path)).toEqual([
      '/v1/entries/alp/e1.json',
      '/v1/entries/alp/e1/1.json',
      '/v1/meta.json',
    ]);
    m.calls.length = 0;
    const b = await planInstall('alp/e1', deps);
    expect(b).toEqual(a);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ path: '/v1/entries/alp/e1.json' });
    expect(m.calls[0]!.inm).not.toBeNull();
  });

  it('with overwrite on, the version is fetched every time', async () => {
    const m = fakeMarket();
    m.s.overwrite = true;
    const deps = {
      dir: path.join(root, 'catalog'),
      cacheDir,
      env: { CCINFOBAR_MARKETPLACE_URL: EP },
      fetch: m.fetch,
    };
    await planInstall('alp/e1', deps);
    m.calls.length = 0;
    await planInstall('alp/e1', deps);
    expect(m.calls.map((c) => c.path)).toEqual([
      '/v1/entries/alp/e1.json',
      '/v1/entries/alp/e1/1.json',
      '/v1/meta.json',
    ]);
  });
});
