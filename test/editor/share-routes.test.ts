import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeShare } from '../../src/catalog/share-code.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

let dir: string;
let file: string;
let handle: EditorHandle;
let port: number;
const saved: Record<string, string | undefined> = {};
const ENV = ['CCINFOBAR_CONFIG_DIR', 'CCINFOBAR_CACHE_DIR'];

type Res = { status: number; json: () => Record<string, any> };

function post(p: string, body: unknown, token = true): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-ccinfobar-token'] = handle.token;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const risky = (): Config => ({
  ...defaultConfig(),
  lines: [
    [
      { id: 'm', type: 'model' },
      { id: 'k', type: 'command', options: { command: 'echo hi' } },
      { id: 'h', type: 'http', options: { url: 'https://example.com/api' } },
      { id: 'l', type: 'link', options: { url: 'https://example.com/', text: 'x' } },
    ],
  ],
});

const codeOf = (config: Config) => {
  const r = encodeShare(config, { includeCommands: true });
  if (!r.ok) throw new Error(r.errorId);
  return r.code;
};

const snapshot = () => {
  const themes = path.join(dir, 'themes');
  return {
    config: fs.readFileSync(file, 'utf8'),
    themes: fs.existsSync(themes) ? fs.readdirSync(themes).sort() : [],
  };
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-share-routes-'));
  file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ lines: [[{ id: 'x', type: 'cwd' }]] }));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CCINFOBAR_CONFIG_DIR = dir;
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  handle = await startEditor({ configPath: file, open: false, terminal: null, claudeVersion: () => null });
  port = Number(new URL(handle.url).port);
});

afterEach(async () => {
  await handle.close();
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/share', () => {
  it('removes commands, HTTP calls and links by default', async () => {
    const r = await post('/api/share', { config: risky(), cols: 120 });
    expect(r.status).toBe(200);
    const j = r.json();
    expect(j.code).toMatch(/^ccib1:/);
    expect(j).toMatchObject({ chars: j.code.length, max: 32768, included: false });
    expect(j.dropped.map((x: { kind: string }) => x.kind)).toEqual(['command', 'http', 'link']);
    expect(j.targets).toEqual(j.dropped);
    const open = (await post('/api/share/open', { code: j.code })).json();
    expect(open.cols).toBe(120);
    expect(open.targets).toEqual([]);
  });

  it('keeps them when asked', async () => {
    const j = (await post('/api/share', { config: risky(), includeCommands: true })).json();
    expect(j.included).toBe(true);
    expect(j.dropped).toEqual([]);
    expect(j.targets).toHaveLength(3);
  });

  it('refuses a config too big for a code', async () => {
    const lines = Array.from({ length: 40 }, (_, l) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `t${l}-${i}`,
        type: 'text',
        options: { text: crypto.randomBytes(60).toString('hex') },
      })),
    );
    const r = await post('/api/share', { config: { lines } });
    expect(r.status).toBe(400);
    expect(r.json().errorId).toBe('err.share.tooBig');
  });

  it('needs the token like every route', async () => {
    expect((await post('/api/share', { config: risky() }, false)).status).toBe(401);
    expect((await post('/api/share/open', { code: 'x' }, false)).status).toBe(401);
    expect((await post('/api/share/install-theme', { code: 'x' }, false)).status).toBe(401);
  });
});

describe('POST /api/share/open', () => {
  it('decodes a code and writes nothing', async () => {
    const code = codeOf({ ...risky(), theme: 'mine-x', separator: '|' } as Config);
    const before = snapshot();
    const r = await post('/api/share/open', { code: `  "${code}"\n` });
    expect(r.status).toBe(200);
    const j = r.json();
    expect(j.code).toBe(code);
    expect(j.cols).toBeNull();
    expect(j.content.layout.lines[0]).toHaveLength(4);
    expect(j.content.theme).toBeTruthy();
    expect(j.targets.map((x: { kind: string; line: number; index: number }) => [x.kind, x.index])).toEqual([
      ['command', 1],
      ['http', 2],
      ['link', 3],
    ]);
    expect(snapshot()).toEqual(before);
  });

  it('answers garbage with an error id', async () => {
    for (const [code, id] of [
      ['hello', 'err.share.notCode'],
      ['ccib2:abc', 'err.share.version'],
      ['ccib1:AAAA', 'err.share.corrupt'],
      [42, 'err.share.notCode'],
    ] as const) {
      const r = await post('/api/share/open', { code });
      expect(r.status, String(code)).toBe(400);
      expect(r.json().errorId).toBe(id);
    }
    expect((await post('/api/share/install-theme', { code: 'hello' })).status).toBe(400);
  });
});

describe('POST /api/share/install-theme', () => {
  it('installs the embedded theme from the code', async () => {
    const code = codeOf({ ...defaultConfig(), theme: 'nord', separator: '|' });
    const j = (await post('/api/share/install-theme', { code })).json();
    expect(j.ok).toBe(true);
    expect(j.theme).toMatchObject({ id: 'nord-2', written: true, renamed: true });
    expect(fs.existsSync(path.join(dir, 'themes', 'nord-2.json'))).toBe(true);
    expect(j.themes.some((t: { id: string }) => t.id === 'nord-2')).toBe(true);
  });

  it('installs nothing for a built-in theme', async () => {
    const code = codeOf({ ...defaultConfig(), theme: 'nord' });
    const j = (await post('/api/share/install-theme', { code })).json();
    expect(j.theme).toBeNull();
  });
});
