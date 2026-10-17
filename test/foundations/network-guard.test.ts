import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { runCatalog } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
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

// D-08: a shipped default is contacted only on explicit marketplace actions
describe('catalog commands without a marketplace action', () => {
  let root = '';
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    root = '';
  });

  it('send no request with a default endpoint set', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-net-catalog-'));
    let calls = 0;
    const counted = (async () => {
      calls++;
      return new Response('{}');
    }) as unknown as typeof fetch;
    const global = vi.spyOn(globalThis, 'fetch').mockImplementation(counted);
    const out: string[] = [];
    const io: PromptIo = {
      tty: false,
      columns: 100,
      ask: async () => false,
      log: (l) => void out.push(l),
      error: (l) => void out.push(l),
    };
    for (const argv of [
      ['endpoint'],
      ['endpoint', '--json'],
      ['list'],
      ['list', '--json'],
      ['show', 'bundle/nord-minimal'],
      ['author'],
    ]) {
      process.exitCode = undefined;
      await runCatalog(parseArgs(['catalog', ...argv]), path.join(root, 'config.json'), {
        io,
        dir: path.join(root, 'catalog'),
        env: {},
        gsd: true,
        fetch: counted,
        defaultEndpoint: 'https://m.example.com',
      });
      expect(process.exitCode, argv.join(' ')).toBeUndefined();
    }
    expect(out[0]).toBe('Marketplace endpoint: https://m.example.com (default)');
    expect(calls).toBe(0);
    expect(global).not.toHaveBeenCalled();
    expect(taken()).toEqual([]);
  });
});

// the in-process guard cannot see child processes: a spawned catalog command must pin the endpoint
const testDir = path.resolve(import.meta.dirname, '..');
const CHILD = /from ['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\)/;
const CATALOG_ARG = [/(?:\[|,)\s*(['"`])catalog\1\s*(?:,|\])/, /\b(?:ccinfobar|\.js)\s+catalog\b/];
const LOCAL_IMPORT = /from\s+['"](\.{1,2}\/[^'"]+)\.js['"]/g;

const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walkTs(d: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__snapshots__' && e.name !== 'fixtures') out.push(...walkTs(p));
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const spawnsCatalog = (text: string) => CATALOG_ARG.some((re) => re.test(stripComments(text)));
const pinsEndpoint = (text: string) => text.includes('CCINFOBAR_MARKETPLACE_URL');

// a file starts children itself or through a local helper
function starters(files: string[]): string[] {
  const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
  const direct = new Set(files.filter((f) => CHILD.test(text.get(f)!)));
  return files.filter((f) => {
    if (direct.has(f)) return true;
    for (const m of text.get(f)!.matchAll(LOCAL_IMPORT)) {
      if (direct.has(path.resolve(path.dirname(f), `${m[1]}.ts`))) return true;
    }
    return false;
  });
}

describe('spawned catalog commands pin the marketplace (R-06)', () => {
  it('detects a spawned catalog command', () => {
    const bad = "spawnSync(process.execPath, [bin, 'catalog', 'list'], { env: { HOME: home } });";
    expect(spawnsCatalog(bad)).toBe(true);
    expect(spawnsCatalog('execSync(`node dist/ccinfobar.js catalog publish`)')).toBe(true);
    expect(spawnsCatalog("describe('catalog store', () => {});")).toBe(false);
    expect(spawnsCatalog("// spawn(bin, ['catalog'])")).toBe(false);
    expect(pinsEndpoint(`${bad} CCINFOBAR_MARKETPLACE_URL: 'off'`)).toBe(true);
  });

  it('every test that spawns a catalog command sets CCINFOBAR_MARKETPLACE_URL', () => {
    const files = starters(walkTs(testDir));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return spawnsCatalog(text) && !pinsEndpoint(text);
    });
    expect(offenders.map((f) => path.relative(testDir, f))).toEqual([]);
  });
});
