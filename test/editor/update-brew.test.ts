import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallKind } from '../../src/commands/update.js';
import { t } from '../../src/core/i18n/index.js';
import { VERSION } from '../../src/core/version.js';
import { readUpdateState } from '../../src/data/update-state.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { withLang } from '../helpers.js';

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

const latest = async () => '99.0.0';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-upbrew-'));
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

  it('names the missing release checksum when the install fails closed', async () => {
    await start('npm-global', latest);
    install.mockRejectedValueOnce(new Error('digest-unavailable'));
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(500);
    expect(res.json().errorId).toBe('err.server.digestUnavailable');
    expect(res.json().error).toBe(t('err.server.digestUnavailable'));
    expect(withLang('tr', () => t('err.server.digestUnavailable'))).toContain('sağlama toplamı');
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

describe('editor update api verification', () => {
  const stateOf = () => readUpdateState();

  it('answers 500 updateRejected and records the state when the check fails', async () => {
    await start('npm-global', latest, { verify: async (v) => (v === '99.0.0' ? 'render-failed:1' : null) });
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(500);
    expect(res.json().errorId).toBe('err.server.updateRejected.ok');
    expect(res.json().errorParams).toEqual({
      version: '99.0.0',
      reason: 'render-failed:1',
      current: VERSION,
    });
    expect(res.json().error).toBe(`99.0.0 failed its check (render-failed:1); back on ${VERSION}`);
    expect(install.mock.calls.map((c) => (c as unknown as string[])[0])).toEqual([
      '99.0.0',
      expect.any(String),
    ]);
    expect(stateOf()).toMatchObject({ rejected: '99.0.0', rollback: 'ok', reason: 'render-failed:1' });
    const trText = withLang('tr', () => t('err.server.updateRejected.ok', res.json().errorParams));
    expect(trText).toBe(`99.0.0 denetimi geçemedi (render-failed:1); ${VERSION} sürümüne dönüldü`);
    expect(trText.replace('render-failed:1', '')).not.toMatch(/\b(ok|failed|unverified)\b/);
  });

  it('names a failed rollback with the manual command', async () => {
    install.mockImplementation(async (...args: unknown[]) => {
      if (args[0] !== '99.0.0') throw new Error('EACCES');
    });
    await start('npm-global', latest, { verify: async (v) => (v === '99.0.0' ? 'render-failed:1' : null) });
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(500);
    expect(res.json().errorId).toBe('err.server.updateRejected.failed');
    expect(res.json().error).toContain(`npm install -g ccinfobar@${VERSION}`);
    expect(stateOf()).toMatchObject({ rejected: '99.0.0', rollback: 'failed' });
  });

  it('installs when the check passes', async () => {
    await start('npm-global', latest, { verify: async () => null });
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ installed: '99.0.0' });
    expect(res.json()).not.toHaveProperty('inconclusive');
    expect(stateOf()).toMatchObject({ installed: '99.0.0' });
  });

  it('keeps the install and says the check was inconclusive', async () => {
    await start('npm-global', latest, { verify: async () => 'entry-missing' });
    const res = await request('POST', '/api/update', '{"install":true}');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ installed: '99.0.0', inconclusive: 'entry-missing' });
  });
});
