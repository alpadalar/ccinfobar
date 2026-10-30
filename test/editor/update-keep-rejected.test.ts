import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallKind } from '../../src/commands/update.js';
import { readUpdateState, writeUpdateState } from '../../src/data/update-state.js';
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

async function start(
  kind: InstallKind,
  fetchLatest: (ms: number) => Promise<string>,
  update?: { verify?: (v: string) => Promise<string | null> },
): Promise<void> {
  handle = await startEditor({
    configPath: path.join(dir, 'config', 'c.json'),
    open: false,
    port: 0,
    claudeVersion: () => null,
    installKind: () => kind,
    fetchLatest,
    update: { install, ...update },
  });
  port = Number(new URL(handle.url).port);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-keeprej-'));
  prev = { config: process.env.CCINFOBAR_CONFIG_DIR, cache: process.env.CCINFOBAR_CACHE_DIR };
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  fs.mkdirSync(process.env.CCINFOBAR_CONFIG_DIR, { recursive: true });
  install.mockReset();
  install.mockResolvedValue(undefined);
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

describe('editor update check keeps a rejection', () => {
  it('leaves the rejected version on record and installs nothing', async () => {
    await start('npm-global', async () => '99.0.0');
    writeUpdateState({
      checkedAt: 1,
      latest: '99.0.0',
      rejected: '99.0.0',
      rollback: 'ok',
      reason: 'render-failed:1',
    });
    const res = await request('POST', '/api/update', '{}');
    expect(res.status).toBe(200);
    expect(readUpdateState()).toMatchObject({
      latest: '99.0.0',
      rejected: '99.0.0',
      rollback: 'ok',
      reason: 'render-failed:1',
    });
    expect(install).not.toHaveBeenCalled();
  });
});
