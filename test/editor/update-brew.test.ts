import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallKind } from '../../src/commands/update.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

const install = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/commands/update.js', async (orig) => ({
  ...(await orig<typeof import('../../src/commands/update.js')>()),
  installVersionAsync: install,
}));

let dir: string;
let handle: EditorHandle | undefined;
let port: number;
let prev: Record<string, string | undefined>;

function request(
  method: string,
  p: string,
  body?: string,
): Promise<{ status: number; json: () => Record<string, any> }> {
  const headers: Record<string, string> = { 'x-ccinfobar-token': handle!.token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(kind: InstallKind, fetchLatest: (ms: number) => Promise<string>): Promise<void> {
  handle = await startEditor({
    configPath: path.join(dir, 'config', 'c.json'),
    open: false,
    port: 0,
    claudeVersion: () => null,
    installKind: () => kind,
    fetchLatest,
  });
  port = Number(new URL(handle.url).port);
}

const latest = async () => '99.0.0';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-upbrew-'));
  prev = { config: process.env.CCINFOBAR_CONFIG_DIR, cache: process.env.CCINFOBAR_CACHE_DIR };
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  fs.mkdirSync(process.env.CCINFOBAR_CONFIG_DIR, { recursive: true });
  install.mockClear();
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const [k, key] of [
    ['config', 'CCINFOBAR_CONFIG_DIR'],
    ['cache', 'CCINFOBAR_CACHE_DIR'],
  ] as const) {
    if (prev[k] === undefined) delete process.env[key];
    else process.env[key] = prev[k];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('editor update api on a Homebrew copy', () => {
  it('refuses install with the brew hint and never runs npm', async () => {
    await start('brew', latest);
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(409);
    expect(res.json().error).toContain('brew upgrade ccinfobar');
    expect(res.json().error).toBe('Installed with Homebrew: run `brew upgrade ccinfobar`');
    expect(res.json().errorId).toBe('update.brewRefused');
    expect(res.json().errorParams).toEqual({ command: 'brew upgrade ccinfobar' });
    expect(install).not.toHaveBeenCalled();
  });

  it('checks without installing', async () => {
    await start('brew', latest);
    const res = await request('POST', '/api/update', '{}');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ newer: true, kind: 'brew', latest: '99.0.0' });
    expect(res.json()).not.toHaveProperty('installed');
    expect(install).not.toHaveBeenCalled();
  });

  it('reports kind brew in /api/system', async () => {
    await start('brew', latest);
    const res = await request('GET', '/api/system');
    expect(res.status).toBe(200);
    expect(res.json().kind).toBe('brew');
  });

  it('keeps the generic refusal for a source checkout', async () => {
    await start('source', latest);
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(409);
    expect(res.json().error).toContain('cannot update itself');
    expect(res.json().errorId).toBe('err.server.cannotUpdate');
    expect(install).not.toHaveBeenCalled();
  });

  it('answers 502 when the latest version cannot be fetched', async () => {
    await start('brew', async () => {
      throw new Error('offline');
    });
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(502);
    expect(install).not.toHaveBeenCalled();
  });
});
