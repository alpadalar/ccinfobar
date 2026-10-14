import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

const FOREIGN = { type: 'command', command: 'npx ccstatusline', padding: 0 };

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
const PLACEHOLDER = 'ccinfobar (installed on first Install)';

async function start(statusLine?: unknown): Promise<void> {
  if (statusLine !== undefined)
    fs.writeFileSync(settings, `${JSON.stringify({ model: 'opus', statusLine }, null, 2)}\n`);
  fs.writeFileSync(configFile, JSON.stringify(defaultConfig()));
  handle = await startEditor({ configPath: configFile, open: false, port: 0, setup: fakeSetup });
  port = Number(new URL(handle.url).port);
}

function manifest(): { entries: { kind: string }[] } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

beforeEach(() => {
  setups = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-plan-'));
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

describe('editor install plan', () => {
  it('returns the plan for a foreign statusLine without writing', async () => {
    await start(FOREIGN);
    const before = fs.readFileSync(settings);
    const res = await request('POST', '/api/install/plan', { command: 'ccinfobar' });
    expect(res.status).toBe(200);
    const plan = res.json().plan;
    expect(plan).toMatchObject({
      owner: 'foreign',
      needsConfirm: true,
      current: { command: 'npx ccstatusline' },
      proposed: { command: 'ccinfobar', type: 'command', padding: 0 },
    });
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  it('refuses to replace a foreign statusLine without confirm', async () => {
    await start(FOREIGN);
    const before = fs.readFileSync(settings);
    const res = await request('POST', '/api/install', { command: 'ccinfobar' });
    expect(res.status).toBe(409);
    const body = res.json();
    expect(body.error).toBe('Confirm replacing the current statusLine first.');
    expect(body.plan.current.command).toBe('npx ccstatusline');
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('replaces with confirm and records the manifest', async () => {
    await start(FOREIGN);
    const res = await request('POST', '/api/install', {
      command: 'ccinfobar',
      confirm: true,
      current: FOREIGN,
    });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.backup).toBe('string');
    expect(body.backupsDir).toBe(path.join(dir, 'backups'));
    expect(body.claude.installed).toBe(true);
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(data.statusLine.command).toBe('ccinfobar');
    expect(data.model).toBe('opus');
    expect(manifest().entries.filter((e) => e.kind === 'statusLine')).toHaveLength(1);
    expect((await request('GET', '/api/state')).json().claude.installed).toBe(true);
  });

  it('refuses a confirm made against a different statusLine', async () => {
    await start(FOREIGN);
    const before = fs.readFileSync(settings);
    const res = await request('POST', '/api/install', {
      command: 'ccinfobar',
      confirm: true,
      current: { type: 'command', command: 'something else' },
    });
    expect(res.status).toBe(409);
    expect(res.json().plan.current.command).toBe('npx ccstatusline');
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('refuses a confirm that does not send the statusLine it was shown', async () => {
    await start(FOREIGN);
    const before = fs.readFileSync(settings);
    const res = await request('POST', '/api/install', { command: 'ccinfobar', confirm: true });
    expect(res.status).toBe(400);
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('plans the placeholder command without installing anything', async () => {
    await start(FOREIGN);
    globalThis.__ccibRenderGuard = true;
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request('POST', '/api/install/plan', { command: PLACEHOLDER });
    } finally {
      globalThis.__ccibRenderGuard = false;
    }
    expect(res.status).toBe(200);
    expect(res.json().plan.proposed.command).toBe(PLACEHOLDER);
    expect(setups).toEqual([]);
  });

  it('does not install ccinfobar before a foreign statusLine is confirmed', async () => {
    await start(FOREIGN);
    const res = await request('POST', '/api/install', { command: PLACEHOLDER });
    expect(res.status).toBe(409);
    expect(setups).toEqual([]);
  });

  it('installs ccinfobar after confirm and writes the resolved command', async () => {
    await start(FOREIGN);
    const res = await request('POST', '/api/install', {
      command: PLACEHOLDER,
      confirm: true,
      current: FOREIGN,
    });
    expect(res.status).toBe(200);
    expect(setups).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command).toBe('/opt/ccib/bin/ccinfobar');
  });

  it('installs without confirm when nothing is set', async () => {
    await start();
    const res = await request('POST', '/api/install', { command: 'ccinfobar' });
    expect(res.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command).toBe('ccinfobar');
    expect(manifest().entries).toHaveLength(1);
  });

  it('does not report a foreign wrapper as installed', async () => {
    await start({ type: 'command', command: 'bash -c "ccinfobar | x"' });
    expect((await request('GET', '/api/state')).json().claude.installed).toBe(false);
  });
});
