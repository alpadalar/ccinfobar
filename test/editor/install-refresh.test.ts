import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';
import { withLang } from '../helpers.js';

let dir: string;
let claude: string;
let settings: string;
let configFile: string;
let handle: EditorHandle | undefined;
let port: number;
let prevConfig: string | undefined;
let prevClaude: string | undefined;

function request(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: () => Record<string, any> }> {
  const headers: Record<string, string> = { 'x-ccinfobar-token': handle?.token ?? '' };
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
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let setups: string[] = [];
const fakeSetup = async (version: string) => {
  setups.push(version);
  return { command: '/opt/ccib/bin/ccinfobar', onPath: false };
};

async function start(statusLine?: unknown): Promise<void> {
  if (statusLine !== undefined)
    fs.writeFileSync(settings, `${JSON.stringify({ model: 'opus', statusLine }, null, 2)}\n`);
  fs.writeFileSync(configFile, JSON.stringify(defaultConfig()));
  handle = await startEditor({ configPath: configFile, open: false, port: 0, setup: fakeSetup });
  port = Number(new URL(handle.url).port);
}

beforeEach(() => {
  setups = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-refresh-'));
  claude = path.join(dir, 'claude');
  fs.mkdirSync(claude);
  settings = path.join(claude, 'settings.json');
  configFile = path.join(dir, 'config.json');
  prevConfig = process.env.CCINFOBAR_CONFIG_DIR;
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = dir;
  process.env.CLAUDE_CONFIG_DIR = claude;
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  if (prevConfig === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevConfig;
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('editor install refresh interval', () => {
  const bad: unknown[] = [0.001, 0, -5, 1.5, 1e12, '30', 'abc'];

  it.each(bad)('plan refuses %j with 400', async (value) => {
    await start();
    const res = await request('POST', '/api/install/plan', { command: 'ccinfobar', refreshInterval: value });
    expect(res.status).toBe(400);
    expect(res.json().errorId).toBe('install.badRefresh');
    expect(res.json().error).toBe(
      'The refresh interval must be a whole number of seconds from 1 to 86400, or left out.',
    );
  });

  it('has the Turkish text for the same id', () => {
    expect(withLang('tr', () => t('install.badRefresh', { min: 1, max: 86400 }))).toBe(
      'Yenileme aralığı 1 ile 86400 arasında tam sayı saniye olmalı ya da hiç gönderilmemeli.',
    );
  });

  it('accepts a whole number in range', async () => {
    await start();
    for (const n of [1, 30, 86400]) {
      const res = await request('POST', '/api/install/plan', { command: 'ccinfobar', refreshInterval: n });
      expect(res.status).toBe(200);
      expect(res.json().plan.proposed.refreshInterval).toBe(n);
    }
  });

  it('treats an absent or null value as no refresh', async () => {
    await start();
    for (const body of [{ command: 'ccinfobar' }, { command: 'ccinfobar', refreshInterval: null }]) {
      const res = await request('POST', '/api/install/plan', body);
      expect(res.status).toBe(200);
      expect(res.json().plan.proposed).not.toHaveProperty('refreshInterval');
    }
  });

  it('install with a bad value writes nothing', async () => {
    await start({ type: 'command', command: 'ccinfobar', padding: 0 });
    const before = fs.readFileSync(settings);
    const res = await request('POST', '/api/install', { command: 'ccinfobar', refreshInterval: 1.5 });
    expect(res.status).toBe(400);
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });
});
