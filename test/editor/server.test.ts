import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

let dir: string;
let file: string;
let handle: EditorHandle;
let port: number;

function request(
  method: string,
  p: string,
  opts: { body?: string; headers?: Record<string, string>; token?: boolean } = {},
): Promise<{ status: number; body: string; json: () => Record<string, any> }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token !== false) headers['x-ccinfobar-token'] = handle.token;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) });
      });
    });
    req.on('error', (e) => {
      if (opts.body && opts.body.length > 1024 * 1024) resolve({ status: 413, body: '', json: () => ({}) });
      else reject(e);
    });
    req.end(opts.body);
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-editor-'));
  file = path.join(dir, 'c.json');
  handle = await startEditor({ configPath: file, open: false, port: 0 });
  port = Number(new URL(handle.url).port);
});

afterEach(async () => {
  await handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('editor server', () => {
  it('binds to loopback with a 32-hex token', () => {
    expect(handle.token).toMatch(/^[0-9a-f]{32}$/);
    expect(handle.url).toBe(`http://127.0.0.1:${port}/?t=${handle.token}`);
  });

  it('serves html at /', async () => {
    const res = await request('GET', '/', { token: false });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<');
  });

  it('requires the token for the api', async () => {
    expect((await request('GET', '/api/state', { token: false })).status).toBe(401);
    expect(
      (await request('GET', '/api/state', { token: false, headers: { 'x-ccinfobar-token': 'nope' } })).status,
    ).toBe(401);
  });

  it('rejects foreign Host headers', async () => {
    const res = await request('GET', '/api/state', { headers: { host: 'evil.example:80' } });
    expect(res.status).toBe(403);
    const ok = await request('GET', '/api/state', { headers: { host: `localhost:${port}` } });
    expect(ok.status).toBe(200);
  });

  it('rejects mismatching Origin on mutating requests', async () => {
    const body = JSON.stringify({ config: defaultConfig() });
    const bad = await request('PUT', '/api/config', { body, headers: { origin: 'http://evil.example' } });
    expect(bad.status).toBe(403);
    expect(fs.existsSync(file)).toBe(false);
    const good = await request('PUT', '/api/config', {
      body,
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(good.status).toBe(200);
  });

  it('returns the state shape', async () => {
    const res = await request('GET', '/api/state');
    expect(res.status).toBe(200);
    const s = res.json();
    expect(typeof s.version).toBe('string');
    expect(s.configPath).toBe(file);
    expect(Array.isArray(s.config.lines)).toBe(true);
    expect(s.savedConfig).toEqual(s.config);
    expect(s.widgets.length).toBeGreaterThan(0);
    expect(s.widgets[0]).toHaveProperty('type');
    expect(s.widgets[0]).not.toHaveProperty('render');
    expect(Array.isArray(s.widgets[0].options)).toBe(true);
    expect(s.categories.length).toBeGreaterThan(0);
    expect(s.presets[0]).toHaveProperty('config');
    expect(Object.keys(s.themes).length).toBeGreaterThan(0);
    expect(s.claude).toHaveProperty('installed');
    expect(typeof s.claude.defaultCommand).toBe('string');
    expect(typeof s.hasLastPayload).toBe('boolean');
  });

  it('renders previews', async () => {
    const res = await request('POST', '/api/preview', {
      body: JSON.stringify({ config: defaultConfig(), source: 'sample', width: 140 }),
    });
    expect(res.status).toBe(200);
    const { lines } = res.json();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('\x1b[');
  });

  it('survives garbage preview input', async () => {
    const res = await request('POST', '/api/preview', { body: JSON.stringify({ config: 42 }) });
    expect(res.status).toBe(200);
  });

  it('writes the config file', async () => {
    const config = { ...defaultConfig(), separator: ' :: ' };
    const res = await request('PUT', '/api/config', { body: JSON.stringify({ config }) });
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).separator).toBe(' :: ');
    const state = (await request('GET', '/api/state')).json();
    expect(state.config.separator).toBe(' :: ');
  });

  it('rejects invalid json and oversized bodies', async () => {
    expect((await request('PUT', '/api/config', { body: '{nope' })).status).toBe(400);
    const big = JSON.stringify({ config: defaultConfig(), pad: 'x'.repeat(1024 * 1024 + 10) });
    expect((await request('PUT', '/api/config', { body: big })).status).toBe(413);
  });

  it('404s unknown routes', async () => {
    expect((await request('GET', '/api/nope')).status).toBe(404);
    expect((await request('GET', '/other', { token: false })).status).toBe(404);
  });

  it('shuts down on request', async () => {
    const res = await request('POST', '/api/shutdown', { body: '{}' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    await expect(request('GET', '/api/state')).rejects.toThrow();
  });
});
