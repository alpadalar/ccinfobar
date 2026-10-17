import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { MARKET_LIMITS, parseIndex } from '../../src/market/protocol.js';
import { fixedWindow, startMarketServer } from '../../src/market/server.js';

// protocol cases live in conformance.ts; these need the data dir, restarts or raw sockets

let dir: string;
let server: { url: string; close(): Promise<void> };
let port: number;
let clock: number;

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
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
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers, json: () => JSON.parse(body) });
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
  async function restart(o: Partial<Parameters<typeof startMarketServer>[0]> = {}): Promise<void> {
    await server.close();
    server = await startMarketServer({ dataDir: dir, now: () => clock, ...o });
    port = Number(new URL(server.url).port);
  }

  async function withTwo(token: string): Promise<void> {
    await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    const r = await request('POST', '/v1/entries/alp/mine/versions', {
      token,
      headers: { 'if-match': '"1"' },
      body: { content: preset([[{ type: 'cwd' }]]), note: 'two' },
    });
    expect(r.status).toBe(201);
  }

  it('new versions and overwrites never rewrite earlier version files', async () => {
    const alp = await register('alp');
    await request('POST', '/v1/entries', { token: alp, body: publishBody('mine') });
    const v1Bytes = fs.readFileSync(file('v1', 'entries', 'alp', 'mine', '1.json'));
    await request('POST', '/v1/entries/alp/mine/versions', {
      token: alp,
      headers: { 'if-match': '"1"' },
      body: { content: preset([[{ type: 'cwd' }]]), note: 'two' },
    });
    const r = await request('PUT', '/v1/entries/alp/mine/versions/2', {
      token: alp,
      body: { content: preset([[{ type: 'model' }, { type: 'git-branch' }]]), note: 'fixed' },
    });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(file('v1', 'entries', 'alp', 'mine', '1.json')).equals(v1Bytes)).toBe(true);

    await restart({ allowOverwrite: false });
    const v2Bytes = fs.readFileSync(file('v1', 'entries', 'alp', 'mine', '2.json'));
    const off = await request('PUT', '/v1/entries/alp/mine/versions/2', {
      token: alp,
      body: { content: preset([[{ type: 'cwd' }]]), note: '' },
    });
    expect(off.status).toBe(403);
    expect(fs.readFileSync(file('v1', 'entries', 'alp', 'mine', '2.json')).equals(v2Bytes)).toBe(true);
  });

  it('withdraw deletes version files, keeps no personal data on disk and survives a restart', async () => {
    const alp = await register('alp');
    await withTwo(alp);
    expect((await request('DELETE', '/v1/entries/alp/mine', { token: alp })).status).toBe(200);
    const raw = fs.readFileSync(file('v1', 'entries', 'alp', 'mine.json'), 'utf8');
    const indexRaw = fs.readFileSync(file('v1', 'index.json'), 'utf8');
    for (const text of [raw, indexRaw]) expect(text).not.toMatch(/Name mine|"desc"|"Alp"|"first"|"two"/);
    expect(fs.existsSync(file('v1', 'entries', 'alp', 'mine', '1.json'))).toBe(false);
    expect(fs.existsSync(file('v1', 'entries', 'alp', 'mine', '2.json'))).toBe(false);

    expect((await request('DELETE', '/v1/entries/alp/mine', { token: alp })).status).toBe(200);
    await restart();
    const idx = parseIndex((await request('GET', '/v1/index.json')).json())!;
    expect(idx.entries).toEqual([]);
    expect((await request('GET', '/v1/entries/alp/mine.json')).json().withdrawn).toBe(true);
    expect((await request('GET', '/v1/entries/alp/mine/1.json')).status).toBe(410);
    expect((await request('POST', '/v1/entries', { token: alp, body: publishBody('mine') })).status).toBe(
      409,
    );
  });

  it('blanks an older tombstone that still has personal data at start (WR-08)', async () => {
    const alp = await register('alp');
    await withTwo(alp);
    expect((await request('DELETE', '/v1/entries/alp/mine', { token: alp })).status).toBe(200);
    const f = file('v1', 'entries', 'alp', 'mine.json');
    const old = { ...JSON.parse(fs.readFileSync(f, 'utf8')), name: 'Mine', author: 'Alperen' };
    old.versions[0].note = 'secret note';
    fs.writeFileSync(f, JSON.stringify(old));
    await restart();
    const now = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(now).toMatchObject({ name: '', author: '', withdrawn: true });
    expect(now.versions[0].note).toBe('');
    expect(fs.readFileSync(file('v1', 'index.json'), 'utf8')).not.toMatch(/Alperen|Mine/);
  });

  it('413 over 1 MiB closes the connection', async () => {
    const token = await register('alp');
    const head = '{"pad":"';
    const big = `${head}${'x'.repeat(MARKET_LIMITS.maxBodyBytes + 1 - head.length - 2)}"}`;
    expect(Buffer.byteLength(big)).toBe(MARKET_LIMITS.maxBodyBytes + 1);
    const r = await request('POST', '/v1/entries', { token, body: big });
    expect(r.status).toBe(413);
    expect(r.headers.connection).toBe('close');
    expect(r.json().error.code).toBe('too-large');
    const charset = await request('POST', '/v1/entries', {
      token,
      body: publishBody('mine'),
      headers: { 'content-type': 'Application/JSON; charset=utf-8' },
    });
    expect(charset.status).toBe(201);
    expect(fs.existsSync(file('v1', 'entries', 'alp', 'mine', '1.json'))).toBe(true);
  });

  it('refused writes leave no files behind', async () => {
    await restart({ caps: { publishers: 2, entries: 3, entriesPerPublisher: 2 } });
    const a = await register('alp');
    const b = await register('bob');
    expect((await request('POST', '/v1/publishers', { body: { handle: 'cem' } })).status).toBe(413);
    expect(fs.existsSync(file('private', 'publishers', 'cem.json'))).toBe(false);
    const bad = preset([[{ type: 'command', options: { command: 'echo hi' } }]]);
    expect((await request('POST', '/v1/entries', { token: a, body: publishBody('bad', bad) })).status).toBe(
      400,
    );
    expect(fs.existsSync(file('v1', 'entries', 'alp', 'bad.json'))).toBe(false);
    expect(fs.existsSync(file('v1', 'entries', 'alp', 'bad'))).toBe(false);
    for (const s of ['one', 'two']) await request('POST', '/v1/entries', { token: a, body: publishBody(s) });
    await request('POST', '/v1/entries', { token: b, body: publishBody('one') });
    expect((await request('POST', '/v1/entries', { token: b, body: publishBody('two') })).status).toBe(413);
    expect(fs.existsSync(file('v1', 'entries', 'bob', 'two.json'))).toBe(false);

    await restart({ rateLimit: { perMinute: 3 } });
    for (const h of ['c', 'd', 'e']) await request('POST', '/v1/publishers', { body: { handle: h } });
    expect((await request('POST', '/v1/publishers', { body: { handle: 'f' } })).status).toBe(429);
    expect(fs.existsSync(file('private', 'publishers', 'f.json'))).toBe(false);
  });

  it('caps ignore tombstones and keep their slugs after a restart (IN-09)', async () => {
    const caps = { publishers: 2, entries: 3, entriesPerPublisher: 2 };
    await restart({ caps });
    const a = await register('alp');
    const b = await register('bob');
    for (const s of ['one', 'two']) await request('POST', '/v1/entries', { token: a, body: publishBody(s) });
    await request('POST', '/v1/entries', { token: b, body: publishBody('one') });
    expect((await request('DELETE', '/v1/entries/alp/one', { token: a })).status).toBe(200);
    await restart({ caps });
    expect((await request('POST', '/v1/entries', { token: a, body: publishBody('one') })).status).toBe(409);
    expect((await request('POST', '/v1/entries', { token: a, body: publishBody('four') })).status).toBe(201);
    const again = await request('POST', '/v1/entries', { token: b, body: publishBody('two') });
    expect(again.json().error.message).toBe('too many entries');
    expect((await request('POST', '/v1/publishers', { body: { handle: 'cem' } })).status).toBe(413);
  });

  it('tombstone caps hold after a restart', async () => {
    const caps = { entriesPerPublisher: 2, tombstonesPerPublisher: 3, tombstones: 5 };
    await restart({ caps, rateLimit: { perMinute: 1000 } });
    const a = await register('alp');
    const b = await register('bob');
    const loop = async (token: string, who: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const r = await request('POST', '/v1/entries', { token, body: publishBody(`x${i}`) });
        if (r.status !== 201) return r;
        expect((await request('DELETE', `/v1/entries/${who}/x${i}`, { token })).status).toBe(200);
      }
      return null;
    };
    expect((await loop(a, 'alp', 10))!.status).toBe(413);
    const tombs = () => fs.readdirSync(file('v1', 'entries', 'alp')).filter((f) => f.endsWith('.json'));
    expect(tombs()).toHaveLength(3);
    await restart({ caps, rateLimit: { perMinute: 1000 } });
    expect((await request('POST', '/v1/entries', { token: a, body: publishBody('y') })).status).toBe(413);
    const g = (await loop(b, 'bob', 10))!;
    expect(g.json().error.message).toBe('too many withdrawn entries');
    expect(fs.readdirSync(file('v1', 'entries', 'bob')).filter((f) => f.endsWith('.json'))).toHaveLength(2);
  });

  it('a write updates the index without reading other entry files', async () => {
    const token = await register('alp');
    for (const s of ['aa', 'bb', 'cc']) await request('POST', '/v1/entries', { token, body: publishBody(s) });
    const others = [file('v1', 'entries', 'alp', 'bb.json'), file('v1', 'entries', 'alp', 'cc.json')];
    const spy = vi.spyOn(fs, 'readFileSync');
    try {
      const writes: [string, string, Parameters<typeof request>[2]][] = [
        [
          'POST',
          '/v1/entries/alp/aa/versions',
          { token, headers: { 'if-match': '"1"' }, body: { content: preset(), note: '' } },
        ],
        [
          'PUT',
          '/v1/entries/alp/aa/versions/2',
          { token, body: { content: preset([[{ type: 'cwd' }]]), note: '' } },
        ],
        ['POST', '/v1/entries', { token, body: publishBody('dd') }],
        ['DELETE', '/v1/entries/alp/aa', { token }],
      ];
      for (const [m, p, o] of writes) {
        spy.mockClear();
        const r = await request(m, p, o);
        expect(r.status, `${m} ${p}`).toBeLessThan(300);
        const read = spy.mock.calls.map((c) => path.resolve(String(c[0])));
        for (const f of others) expect(read, `${m} ${p}`).not.toContain(path.resolve(f));
        if (p.includes('/aa')) expect(read).toContain(path.resolve(file('v1', 'entries', 'alp', 'aa.json')));
      }
    } finally {
      spy.mockRestore();
    }
    const index = parseIndex((await request('GET', '/v1/index.json')).json())!;
    // the withdrawn alp/aa stays out of the index
    expect(index.entries.map((e) => [e.id, e.version, e.withdrawn ?? false])).toEqual([
      ['alp/bb', 1, false],
      ['alp/cc', 1, false],
      ['alp/dd', 1, false],
    ]);
    const before = fs.readFileSync(file('v1', 'index.json'), 'utf8');
    await restart();
    expect(JSON.parse(fs.readFileSync(file('v1', 'index.json'), 'utf8')).entries).toEqual(
      JSON.parse(before).entries,
    );
  });

  it('keeps the index order after a restart', async () => {
    const x = await register('a-b');
    const y = await register('a');
    await request('POST', '/v1/entries', { token: x, body: publishBody('z') });
    await request('POST', '/v1/entries', { token: y, body: publishBody('z') });
    await request('POST', '/v1/entries', { token: y, body: publishBody('y') });
    await restart();
    expect((await request('GET', '/v1/index.json')).json().entries.map((e: any) => e.id)).toEqual([
      'a/y',
      'a/z',
      'a-b/z',
    ]);
  });

  it('malformed requests and handler failures never stop the server', async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write('NOT HTTP\r\n\r\n'));
      let out = '';
      sock.on('data', (d) => {
        out += d.toString('latin1');
      });
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
    });
    expect(raw.startsWith('HTTP/1.1 400')).toBe(true);
    // an unexpected fs failure becomes a fixed 500
    const token = await register('alp');
    fs.mkdirSync(file('private', 'owners'), { recursive: true });
    fs.writeFileSync(file('private', 'owners', 'alp'), 'not a dir');
    const r = await request('POST', '/v1/entries', { token, body: publishBody('mine') });
    expect(r.status).toBe(500);
    expect(r.json()).toEqual({ error: { code: 'internal', message: 'internal error' } });
    expect((await request('GET', '/v1/meta.json')).status).toBe(200);
  });

  it('fixed windows bound the key table and evict old windows', () => {
    let t = Date.UTC(2026, 9, 16, 12, 0, 0);
    const hit = fixedWindow(5, () => t, 2);
    expect([hit('a'), hit('b')]).toEqual([null, null]);
    expect(hit('c')).toBe(60);
    expect(hit('a')).toBeNull();
    t += 60_000;
    expect(hit('c')).toBeNull();
    expect(hit('d')).toBeNull();
    expect(hit('a')).toBe(60);
  });

  it('fixed windows count each key on its own', () => {
    let t = Date.UTC(2026, 9, 16, 12, 0, 10);
    const hit = fixedWindow(2, () => t);
    expect([hit('token:a'), hit('token:a'), hit('token:a')]).toEqual([null, null, 50]);
    expect(hit('token:b')).toBeNull();
    expect(hit('ip:1')).toBeNull();
    t += 49_500;
    expect(hit('token:a')).toBe(1);
    t += 500;
    expect(hit('token:a')).toBeNull();
  });

  it('listens on 127.0.0.1 with an ephemeral port and closes twice', async () => {
    const u = new URL(server.url);
    expect(u.hostname).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);
    await server.close();
    await server.close();
    await expect(request('GET', '/v1/meta.json')).rejects.toThrow();
  });

  it('names itself in meta.json and advertises token auth', async () => {
    expect((await request('GET', '/v1/meta.json')).json()).toMatchObject({
      name: 'ccinfobar reference marketplace',
      auth: ['token'],
    });
    await restart({ allowOverwrite: false, name: 'Mine' });
    const meta = (await request('GET', '/v1/meta.json')).json();
    expect(meta.name).toBe('Mine');
    expect(meta.capabilities.overwrite).toBe(false);
  });

  it('register publisher stores only the sha256 of its token', async () => {
    const r = await request('POST', '/v1/publishers', { body: { handle: 'alp', displayName: 'Alp' } });
    expect(r.status).toBe(201);
    const { token } = r.json();
    await request('POST', '/v1/publishers', { body: { handle: 'alp', displayName: 'Other' } });
    const rec = fs.readFileSync(file('private', 'publishers', 'alp.json'), 'utf8');
    expect(rec).not.toContain(token);
    const parsed = JSON.parse(rec);
    expect(parsed).toMatchObject({ handle: 'alp', displayName: 'Alp', tokenSha256: sha256(token) });
    expect(typeof parsed.createdAt).toBe('string');
    for (const f of walk(dir)) expect(fs.readFileSync(f, 'utf8')).not.toContain(token);
  });

  // raw paths: fetch would collapse the dot segments before they reach the server
  it('path segments with traversal never reach files outside v1', async () => {
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

  it('has no root page', async () => {
    const r = await request('GET', '/');
    expect(r.status).toBe(404);
    expect(r.json().error.code).toBe('not-found');
  });
});

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
