import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { createMarketClient } from '../../src/market/client.js';
import { canonicalJson, parseIndex, parseMeta, parseRemoteEntry } from '../../src/market/protocol.js';
import { startMarketServer } from '../../src/market/server.js';

let dir: string;
let server: { url: string; close(): Promise<void> };
let port: number;
let clock: number;

interface Res {
  status: number;
  body: string;
  json: () => any;
}

function request(
  method: string,
  p: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let text: string | undefined;
  if (opts.body !== undefined) {
    text = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end(text);
  });
}

const preset = (lines: unknown[][] = [[{ type: 'model' }]]) =>
  ({ layout: { lines } }) as unknown as EntryContent;

function publishBody(slug: string, content: unknown = preset(), kind = 'preset') {
  return { kind, slug, name: `Name ${slug}`, description: 'desc', author: 'Alp', content, note: 'first' };
}

async function register(handle: string): Promise<string> {
  const r = await request('POST', '/v1/publishers', { body: { handle, displayName: handle.toUpperCase() } });
  expect(r.status).toBe(201);
  return r.json().token;
}

const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const file = (...parts: string[]) => path.join(dir, ...parts);

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-market-'));
  clock = Date.UTC(2026, 9, 16, 12, 0, 0);
  server = await startMarketServer({ dataDir: dir, now: () => clock });
  port = Number(new URL(server.url).port);
});

afterEach(async () => {
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('reference market server', () => {
  it.todo('overwrite is refused when allowOverwrite is false');
  it.todo('withdraw tombstones the entry and versions answer 410');
  it.todo('413 over 1 MiB, 415 without JSON, 429 past the rate limit');

  it('listens on 127.0.0.1 with an ephemeral port and closes twice', async () => {
    const u = new URL(server.url);
    expect(u.hostname).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);
    await server.close();
    await server.close();
    await expect(request('GET', '/v1/meta.json')).rejects.toThrow();
  });

  it('serves meta.json with protocol 1 and write capabilities', async () => {
    const r = await request('GET', '/v1/meta.json');
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({
      protocol: 1,
      name: 'ccinfobar reference marketplace',
      capabilities: { write: true, overwrite: true, withdraw: true, submit: 'api' },
      auth: ['token'],
    });
    expect(parseMeta(r.json())?.capabilities.write).toBe(true);
    const empty = await request('GET', '/v1/index.json');
    expect(empty.status).toBe(200);
    expect(empty.json().entries).toEqual([]);
  });

  it('reflects allowOverwrite and name in meta.json', async () => {
    await server.close();
    server = await startMarketServer({ dataDir: dir, allowOverwrite: false, name: 'Mine' });
    port = Number(new URL(server.url).port);
    const meta = (await request('GET', '/v1/meta.json')).json();
    expect(meta.name).toBe('Mine');
    expect(meta.capabilities.overwrite).toBe(false);
  });

  it('register publisher returns a token once and stores only its sha256', async () => {
    const r = await request('POST', '/v1/publishers', { body: { handle: 'alp', displayName: 'Alp' } });
    expect(r.status).toBe(201);
    const { handle, token } = r.json();
    expect(handle).toBe('alp');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const again = await request('POST', '/v1/publishers', { body: { handle: 'alp', displayName: 'Other' } });
    expect(again.status).toBe(409);
    expect(again.json()).toEqual({ error: { code: 'conflict', message: expect.any(String) } });
    expect(again.body).not.toContain(token);
    const rec = fs.readFileSync(file('private', 'publishers', 'alp.json'), 'utf8');
    expect(rec).not.toContain(token);
    const parsed = JSON.parse(rec);
    expect(parsed).toMatchObject({ handle: 'alp', displayName: 'Alp', tokenSha256: sha256(token) });
    expect(typeof parsed.createdAt).toBe('string');
    for (const f of walk(dir)) expect(fs.readFileSync(f, 'utf8')).not.toContain(token);
  });

  it('rejects bad handles and bodies', async () => {
    for (const body of [
      { handle: 'ALP', displayName: 'x' },
      { handle: '../x', displayName: 'x' },
      { handle: '-a', displayName: 'x' },
      { handle: 'a'.repeat(40), displayName: 'x' },
      { handle: 'ok', displayName: 5 },
      { displayName: 'x' },
      [],
    ]) {
      const r = await request('POST', '/v1/publishers', { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json().error.code).toBe('invalid');
    }
    const bad = await request('POST', '/v1/publishers', { body: '{not json' });
    expect(bad.status).toBe(400);
    expect(bad.json().error.code).toBe('invalid');
  });

  it('publish creates v1 and the index lists it', async () => {
    const token = await register('alp');
    const content = preset();
    const r = await request('POST', '/v1/entries', { token, body: publishBody('mine', content) });
    expect(r.status).toBe(201);
    const hash = sha(content);
    expect(r.json()).toEqual({ id: 'alp/mine', version: 1, hash });

    const index = (await request('GET', '/v1/index.json')).json();
    expect(parseIndex(index)?.entries).toEqual([
      {
        id: 'alp/mine',
        kind: 'preset',
        name: 'Name mine',
        description: 'desc',
        author: 'Alp',
        publisher: 'alp',
        version: 1,
        updatedAt: '2026-10-16T12:00:00.000Z',
        hash,
      },
    ]);
    const entry = parseRemoteEntry((await request('GET', '/v1/entries/alp/mine.json')).json());
    expect(entry?.versions).toEqual([{ version: 1, at: '2026-10-16T12:00:00.000Z', note: 'first', hash }]);
    const v1 = (await request('GET', '/v1/entries/alp/mine/1.json')).json();
    expect(v1).toEqual({ version: 1, content, hash });
    expect(sha(v1.content)).toBe(v1.hash);

    const dup = await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    expect(dup.status).toBe(409);
    expect(dup.json().error.code).toBe('conflict');
  });

  it('a new version needs If-Match and answers 412 when stale', async () => {
    const token = await register('alp');
    await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    const v1Bytes = fs.readFileSync(file('v1', 'entries', 'alp', 'mine', '1.json'));
    const next = preset([[{ type: 'model' }, { type: 'cwd' }]]);
    const p = '/v1/entries/alp/mine/versions';

    const missing = await request('POST', p, { token, body: { content: next, note: 'n' } });
    expect(missing.status).toBe(412);
    expect(missing.json().error.code).toBe('stale');

    clock += 60_000;
    const ok = await request('POST', p, {
      token,
      headers: { 'if-match': '"1"' },
      body: { content: next, note: 'second', name: 'Renamed' },
    });
    expect(ok.status).toBe(201);
    expect(ok.json()).toEqual({ id: 'alp/mine', version: 2, hash: sha(next) });

    const stale = await request('POST', p, {
      token,
      headers: { 'if-match': '"1"' },
      body: { content: next, note: 'again' },
    });
    expect(stale.status).toBe(412);
    expect(stale.json().error.code).toBe('stale');

    const entry = parseRemoteEntry((await request('GET', '/v1/entries/alp/mine.json')).json())!;
    expect(entry.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(entry).toMatchObject({ version: 2, name: 'Renamed', updatedAt: '2026-10-16T12:01:00.000Z' });
    expect(entry.versions[1]).toEqual({
      version: 2,
      at: '2026-10-16T12:01:00.000Z',
      note: 'second',
      hash: sha(next),
    });
    expect(fs.readFileSync(file('v1', 'entries', 'alp', 'mine', '1.json')).equals(v1Bytes)).toBe(true);
    expect((await request('GET', '/v1/entries/alp/mine/2.json')).json().content).toEqual(next);
    expect((await request('GET', '/v1/entries/alp/mine/3.json')).status).toBe(404);
    const index = parseIndex((await request('GET', '/v1/index.json')).json())!;
    expect(index.entries[0]).toMatchObject({ id: 'alp/mine', version: 2, hash: sha(next) });
  });

  it('only the owner token may write its entries', async () => {
    const alp = await register('alp');
    const bob = await register('bob');
    await request('POST', '/v1/entries', { token: alp, body: publishBody('mine') });
    const p = '/v1/entries/alp/mine/versions';
    const body = { content: preset(), note: '' };
    const headers = { 'if-match': '"1"' };

    const other = await request('POST', p, { token: bob, headers, body });
    expect(other.status).toBe(403);
    expect(other.json().error.code).toBe('forbidden');
    const none = await request('POST', p, { headers, body });
    expect(none.status).toBe(401);
    expect(none.json().error.code).toBe('unauthorized');
    const unknown = await request('POST', p, { token: 'f'.repeat(64), headers, body });
    expect(unknown.status).toBe(401);
    const junk = await request('POST', p, { token: '../alp', headers, body });
    expect(junk.status).toBe(401);
    const noPublish = await request('POST', '/v1/entries', { body: publishBody('x') });
    expect(noPublish.status).toBe(401);
    const missing = await request('POST', '/v1/entries/alp/nope/versions', { token: alp, headers, body });
    expect(missing.status).toBe(404);

    // bob publishes under his own handle only
    const own = await request('POST', '/v1/entries', { token: bob, body: publishBody('mine') });
    expect(own.json().id).toBe('bob/mine');
    const entry = parseRemoteEntry((await request('GET', '/v1/entries/alp/mine.json')).json())!;
    expect(entry.versions).toHaveLength(1);
  });

  it('command/http/env content and personal keys are rejected as data-only', async () => {
    const token = await register('alp');
    const cases: [unknown, string][] = [
      [preset([[{ type: 'command', options: { command: 'echo hi' } }]]), 'command-widget'],
      [preset([[{ type: 'http', options: { url: 'https://example.com' } }]]), 'http-widget'],
      [preset([[{ type: 'env', options: { name: 'HOME' } }]]), 'env-widget'],
      [preset([[{ type: 'link', options: { url: 'file:///etc/passwd' } }]]), 'unsafe-link'],
      [{ layout: { lines: [[{ type: 'model' }]], budget: { daily: 5 } } }, 'personal-key:budget'],
      [{ layout: { lines: 'x' } }, 'bad-lines'],
      [{ appearance: { style: 'plain' } }, 'unknown-key:appearance'],
    ];
    for (const [content, code] of cases) {
      const r = await request('POST', '/v1/entries', { token, body: publishBody('bad', content) });
      expect(r.status, code).toBe(400);
      expect(r.json()).toEqual({ error: { code: 'invalid', message: code } });
    }
    await request('POST', '/v1/entries', { token, body: publishBody('good') });
    const v = await request('POST', '/v1/entries/alp/good/versions', {
      token,
      headers: { 'if-match': '"1"' },
      body: { content: preset([[{ type: 'command', options: { command: 'x' } }]]), note: '' },
    });
    expect(v.status).toBe(400);
    expect(v.json().error.message).toBe('command-widget');
    const theme = await request('POST', '/v1/entries', {
      token,
      body: publishBody('th', { appearance: { style: 'powerline' } }, 'theme'),
    });
    expect(theme.status).toBe(201);
    expect(fs.existsSync(file('v1', 'entries', 'alp', 'bad.json'))).toBe(false);
    expect(fs.existsSync(file('v1', 'entries', 'alp', 'bad'))).toBe(false);
  });

  it('path segments with traversal are rejected', async () => {
    const token = await register('alp');
    await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    fs.writeFileSync(path.join(dir, 'x.json'), '{"secret":1}');
    for (const p of [
      '/v1/entries/..%2F..%2Fx.json',
      '/v1/entries/..%2F..%2Fx/1.json',
      '/v1/entries/ALP/mine.json',
      '/v1/entries/alp/MINE.json',
      '/v1/entries/%2E%2E/x.json',
      '/v1/entries/..%5C..%5Cx.json',
      '/v1/entries/alp/..%2F..%2F..%2Fx.json',
      '/v1/entries/alp/mine/0.json',
      '/v1/entries/alp/mine/01.json',
      '/v1/entries/alp/mine/1e3.json',
      '/v1/entries/alp/mine/..%2F..%2F..%2F..%2Fx.json',
      '/v1/entries/alp/%E0%A4%A.json',
      '/v1/../x.json',
      '/x.json',
    ]) {
      const r = await request('GET', p);
      expect([400, 404], p).toContain(r.status);
      expect(r.body, p).not.toContain('secret');
      expect(['invalid', 'not-found']).toContain(r.json().error.code);
    }
    const w = await request('POST', '/v1/entries/..%2F..%2Fprivate/x/versions', {
      token,
      headers: { 'if-match': '"1"' },
      body: { content: preset(), note: '' },
    });
    expect([400, 404]).toContain(w.status);
  });

  it('never serves private files', async () => {
    const token = await register('alp');
    await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    for (const p of [
      '/private/publishers/alp.json',
      '/v1/private/publishers/alp.json',
      '/v1/../private/publishers/alp.json',
      '/v1/entries/../../private/publishers/alp.json',
      '/v1/entries/%2E%2E/%2E%2E/private/publishers/alp.json',
      '/v1/entries/..%2F..%2Fprivate%2Fpublishers/alp.json',
      '/private/owners/alp/mine.json',
      '/v1/publishers/alp.json',
      '/v1/publishers',
    ]) {
      const r = await request('GET', p);
      expect([400, 404], p).toContain(r.status);
      expect(r.body).not.toContain('tokenSha256');
    }
  });

  it('the data dir layout equals the static protocol paths', async () => {
    const token = await register('alp');
    await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    await request('POST', '/v1/entries/alp/mine/versions', {
      token,
      headers: { 'if-match': '"1"' },
      body: { content: preset([[{ type: 'cwd' }]]), note: '' },
    });
    const files = walk(path.join(dir, 'v1'))
      .map((f) => `/${path.relative(dir, f).split(path.sep).join('/')}`)
      .sort();
    expect(files).toEqual([
      '/v1/entries/alp/mine.json',
      '/v1/entries/alp/mine/1.json',
      '/v1/entries/alp/mine/2.json',
      '/v1/index.json',
      '/v1/meta.json',
    ]);
    for (const p of files) {
      const r = await request('GET', p);
      expect(r.status, p).toBe(200);
      expect(r.body, p).toBe(fs.readFileSync(path.join(dir, ...p.split('/').filter(Boolean)), 'utf8'));
    }
    const priv = walk(path.join(dir, 'private')).map((f) => path.relative(dir, f).split(path.sep).join('/'));
    expect(priv).toContain('private/publishers/alp.json');
    expect(priv).toContain('private/owners/alp/mine.json');
    expect(walk(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps history across a restart and rebuilds the index from disk', async () => {
    const token = await register('alp');
    await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    await server.close();
    fs.rmSync(path.join(dir, 'v1', 'index.json'));
    server = await startMarketServer({ dataDir: dir, now: () => clock });
    port = Number(new URL(server.url).port);
    expect((await request('GET', '/v1/index.json')).json().entries.map((e: any) => e.id)).toEqual([
      'alp/mine',
    ]);
    const v = await request('POST', '/v1/entries/alp/mine/versions', {
      token,
      headers: { 'if-match': '"1"' },
      body: { content: preset(), note: '' },
    });
    expect(v.json().version).toBe(2);
  });

  it('answers 404 for unknown routes and methods', async () => {
    for (const [m, p] of [
      ['GET', '/'],
      ['GET', '/v1/entries'],
      ['DELETE', '/v1/index.json'],
      ['PUT', '/v1/meta.json'],
      ['POST', '/v1/index.json'],
      ['GET', '/v2/meta.json'],
    ] as const) {
      const r = await request(m, p, m === 'GET' ? {} : { body: {} });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.json().error.code).toBe('not-found');
    }
  });

  it('works end to end with the market client', async () => {
    const anon = createMarketClient({ endpoint: server.url, fetch: globalThis.fetch });
    expect((await anon.meta()).capabilities.write).toBe(true);
    const { token } = await anon.register('alp', 'Alp');
    const client = createMarketClient({ endpoint: server.url, fetch: globalThis.fetch, token });
    const content = preset([[{ type: 'model' }, { type: 'link', options: { url: 'https://example.com' } }]]);
    const pub = await client.publish({
      kind: 'preset',
      slug: 'mine',
      name: 'Mine',
      description: '',
      author: 'Alp',
      content,
      note: '',
    });
    expect(pub).toEqual({ id: 'alp/mine', version: 1, hash: sha(content) });
    const v2 = await client.addVersion('alp/mine', 1, { content: preset(), note: 'two' });
    expect(v2.version).toBe(2);
    await expect(client.addVersion('alp/mine', 1, { content: preset(), note: '' })).rejects.toMatchObject({
      code: 'stale',
    });
    const entry = await anon.entry('alp/mine');
    expect(entry.versions.map((v) => v.version)).toEqual([1, 2]);
    const got = await anon.version('alp/mine', 1, 'preset');
    expect(got.hash).toBe(pub.hash);
    expect(got.targets.length).toBe(1);
    expect((await anon.index()).entries.map((e) => e.id)).toEqual(['alp/mine']);
  });
});

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
