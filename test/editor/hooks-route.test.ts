import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

const CMD = '/opt/ccib/bin/ccinfobar';
const SIX = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'Notification'];
const FOREIGN = { type: 'command', command: 'npx ccstatusline', padding: 0 };

let dir: string;
let claude: string;
let settings: string;
let configFile: string;
let handle: EditorHandle | undefined;
let port: number;
let prevConfig: string | undefined;
let prevClaude: string | undefined;
let versionCalls = 0;

type Res = { status: number; json: () => Record<string, any> };

function request(
  method: string,
  p: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'x-ccinfobar-token': handle?.token ?? '', ...extra };
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

async function start(version: string | null, statusLine?: unknown): Promise<void> {
  if (statusLine !== undefined)
    fs.writeFileSync(settings, `${JSON.stringify({ model: 'opus', statusLine }, null, 2)}\n`);
  fs.writeFileSync(configFile, JSON.stringify(defaultConfig()));
  handle = await startEditor({
    configPath: configFile,
    open: false,
    port: 0,
    setup: async () => ({ command: CMD, onPath: false }),
    claudeVersion: () => {
      versionCalls++;
      return version;
    },
  });
  port = Number(new URL(handle.url).port);
}

async function startInstalled(version: string | null = '2.1.299'): Promise<void> {
  await start(version);
  const res = await request('POST', '/api/install', { command: CMD });
  expect(res.status).toBe(200);
}

const readSettings = () => JSON.parse(fs.readFileSync(settings, 'utf8')) as Record<string, any>;
const hookEntries = () =>
  (
    JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      entries: { kind: string; event?: string }[];
    }
  ).entries.filter((e) => e.kind === 'hook');

beforeEach(() => {
  versionCalls = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hooks-route-'));
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

describe('editor hooks route', () => {
  it('reports hooks in /api/state and /api/system', async () => {
    await startInstalled();
    const want = {
      installed: [],
      available: true,
      claudeCode: '2.1.299',
      events: SIX,
      optional: ['PermissionRequest'],
    };
    expect((await request('GET', '/api/state')).json().hooks).toEqual(want);
    expect((await request('GET', '/api/system')).json().hooks).toEqual(want);
  });

  it('turns hooks on with the CLI install path', async () => {
    await startInstalled();
    const res = await request('POST', '/api/hooks', { enabled: true });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.backup === 'string' || body.backup === null).toBe(true);
    expect(body.hooks.installed).toEqual(SIX);
    const data = readSettings();
    expect(Object.keys(data.hooks)).toEqual(SIX);
    expect(data.hooks.Stop[0].hooks[0].command).toBe(`${CMD} hook Stop`);
    expect(hookEntries()).toHaveLength(6);
    expect((await request('GET', '/api/state')).json().hooks.installed).toEqual(SIX);
  });

  it('adds PermissionRequest only when asked and removes it again', async () => {
    await startInstalled();
    const on = await request('POST', '/api/hooks', { enabled: true, permission: true });
    expect(on.status).toBe(200);
    expect(on.json().hooks.installed).toEqual([...SIX, 'PermissionRequest']);
    expect(readSettings().hooks.PermissionRequest).toHaveLength(1);
    const off = await request('POST', '/api/hooks', { enabled: true, permission: false });
    expect(off.status).toBe(200);
    expect(off.json().hooks.installed).toEqual(SIX);
    expect(readSettings().hooks.PermissionRequest).toBeUndefined();
    expect(hookEntries()).toHaveLength(6);
  });

  it('turns hooks off and keeps the statusLine', async () => {
    await startInstalled();
    await request('POST', '/api/hooks', { enabled: true });
    const res = await request('POST', '/api/hooks', { enabled: false });
    expect(res.status).toBe(200);
    expect(res.json().hooks.installed).toEqual([]);
    const data = readSettings();
    expect(data.hooks).toBeUndefined();
    expect(data.statusLine.command).toBe(CMD);
    expect(hookEntries()).toHaveLength(0);
  });

  it('refuses hooks when ccinfobar is not the active status line', async () => {
    await start('2.1.299', FOREIGN);
    const info = (await request('GET', '/api/state')).json().hooks;
    expect(info.available).toBe(false);
    expect(info.reason).toMatch(/status line/);
    const before = fs.readFileSync(settings);
    const res = await request('POST', '/api/hooks', { enabled: true });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('refuses hooks when the Claude Code version is unknown', async () => {
    await startInstalled(null);
    const info = (await request('GET', '/api/state')).json().hooks;
    expect(info.available).toBe(false);
    expect(info.reason).toContain('2.1.101');
    const before = fs.readFileSync(settings);
    const res = await request('POST', '/api/hooks', { enabled: true });
    expect(res.status).toBe(409);
    expect(res.json().error).toContain('2.1.101');
    expect(res.json().hooks.available).toBe(false);
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('refuses hooks on an old Claude Code', async () => {
    await startInstalled('2.0.5');
    const info = (await request('GET', '/api/state')).json().hooks;
    expect(info.available).toBe(false);
    expect(info.reason).toContain('2.0.5');
    expect((await request('POST', '/api/hooks', { enabled: true })).status).toBe(409);
  });

  it('rejects a bad body', async () => {
    await startInstalled();
    expect((await request('POST', '/api/hooks', { enabled: 'yes' })).status).toBe(400);
    expect((await request('POST', '/api/hooks', { enabled: true, permission: 1 })).status).toBe(400);
    expect((await request('POST', '/api/hooks', {})).status).toBe(400);
    expect(readSettings().hooks).toBeUndefined();
  });

  it('needs the token and a local origin', async () => {
    await startInstalled();
    const saved = handle?.token;
    const headers = { 'x-ccinfobar-token': 'nope' };
    expect((await request('POST', '/api/hooks', { enabled: true }, headers)).status).toBe(401);
    const evil = { origin: 'http://evil.example' };
    expect((await request('POST', '/api/hooks', { enabled: true }, evil)).status).toBe(403);
    expect(handle?.token).toBe(saved);
    expect(readSettings().hooks).toBeUndefined();
  });

  it('a slow version check does not block other requests', async () => {
    fs.writeFileSync(configFile, JSON.stringify(defaultConfig()));
    let done = false;
    handle = await startEditor({
      configPath: configFile,
      open: false,
      port: 0,
      setup: async () => ({ command: CMD, onPath: false }),
      claudeVersion: () =>
        new Promise((r) =>
          setTimeout(() => {
            done = true;
            r('2.1.299');
          }, 400),
        ),
    });
    port = Number(new URL(handle.url).port);
    expect((await request('GET', '/api/ping')).status).toBe(200);
    expect(done).toBe(false);
  });

  it('detects the Claude Code version once per editor', async () => {
    await startInstalled();
    for (let i = 0; i < 3; i++) await request('GET', '/api/state');
    await request('GET', '/api/system');
    await request('POST', '/api/hooks', { enabled: true });
    expect(versionCalls).toBe(1);
  });
});
