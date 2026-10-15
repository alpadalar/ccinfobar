import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');

let dir: string;
let pid: number | null = null;

function envFor(d: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CCINFOBAR_CONFIG_DIR: path.join(d, 'config'),
    CCINFOBAR_CACHE_DIR: path.join(d, 'cache'),
    CLAUDE_CONFIG_DIR: path.join(d, 'claude'),
    HOME: path.join(d, 'home'),
    USERPROFILE: path.join(d, 'home'),
    CCINFOBAR_NO_JOBS: '1',
  };
}

function detach() {
  const started = Date.now();
  const res = spawnSync(process.execPath, [bin, 'edit', '--detach', '--no-open'], {
    encoding: 'utf8',
    env: envFor(dir),
    timeout: 6000,
  });
  return { ...res, ms: Date.now() - started };
}

function request(
  url: string,
  method: string,
  p: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const headers: Record<string, string> = token ? { 'x-ccinfobar-token': token } : {};
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function alive(p: number): boolean {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

afterEach(async () => {
  if (pid !== null && alive(pid)) {
    try {
      process.kill(pid);
    } catch {}
    await waitFor(() => !alive(pid as number), 2000);
  }
  pid = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync(bin))('edit --detach', () => {
  it('prints the url, exits, reuses the live editor and stops on shutdown', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-detach-'));
    const first = detach();
    expect(first.error).toBeUndefined();
    expect(first.status).toBe(0);
    expect(first.ms).toBeLessThan(6000);
    const url = first.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/)?.[0];
    expect(url).toBeDefined();

    const stateFile = path.join(dir, 'cache', 'editor.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    pid = state.pid;
    expect(state.url).toBe(url);
    expect(typeof state.pid).toBe('number');
    expect(typeof state.startedAt).toBe('number');
    if (process.platform !== 'win32') expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);

    const token = new URL(url as string).searchParams.get('t') as string;
    const ping = await request(url as string, 'GET', '/api/ping', token);
    expect(ping.status).toBe(200);
    expect(JSON.parse(ping.body)).toEqual({ ok: true });
    expect((await request(url as string, 'GET', '/api/ping')).status).toBe(401);

    const second = detach();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(url);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid).toBe(pid);

    expect((await request(url as string, 'POST', '/api/shutdown', token)).status).toBe(200);
    expect(await waitFor(() => !fs.existsSync(stateFile), 2000)).toBe(true);
  }, 20_000);
});
