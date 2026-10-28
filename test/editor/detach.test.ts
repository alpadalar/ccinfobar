import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '../../src/core/i18n/index.js';
import { editorStateFile, pingEditor, readEditorState, runDetach } from '../../src/editor/detach.js';
import { type EditorHandle, startEditor } from '../../src/editor/server.js';

let dir: string;
let env: NodeJS.ProcessEnv;
let stateFile: string;
let handle: EditorHandle | null;
let prevDir: string | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ping(url: string): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: u.port,
        path: '/api/ping',
        headers: { 'x-ccinfobar-token': u.searchParams.get('t') ?? '' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function closed(server: EditorHandle): Promise<boolean> {
  return pingEditor(server.url, 300).then((ok) => !ok);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-detach-unit-'));
  env = { ...process.env, CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
  stateFile = editorStateFile(env);
  prevDir = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = dir;
  handle = null;
});

afterEach(async () => {
  await handle?.close();
  if (prevDir === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(idleMs = 200) {
  return startEditor({
    configPath: path.join(dir, 'c.json'),
    open: false,
    port: 0,
    detached: { idleMs, checkMs: 50, stateFile },
  });
}

describe('detached editor server', () => {
  it('writes the state file and stops when idle', async () => {
    handle = await start();
    const state = readEditorState(env);
    expect(state).toMatchObject({ url: handle.url, pid: process.pid });
    if (process.platform !== 'win32') expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    await sleep(450);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(await closed(handle)).toBe(true);
  });

  it('a request postpones the idle shutdown', async () => {
    // wide margins: Windows runners can stall a request for a second
    handle = await start(4000);
    await sleep(2500);
    expect(await ping(handle.url)).toBe(200);
    await sleep(2500);
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(await pingEditor(handle.url)).toBe(true);
  }, 15_000);

  it('counts only token-checked requests as activity (injected clock)', async () => {
    let clock = 0;
    const startClock = () =>
      startEditor({
        configPath: path.join(dir, 'c.json'),
        open: false,
        port: 0,
        detached: { idleMs: 1000, checkMs: 10, stateFile, now: () => clock },
      });
    handle = await startClock();
    clock = 900;
    expect(await ping(handle.url)).toBe(200);
    await sleep(60);
    expect(fs.existsSync(stateFile)).toBe(true);
    clock = 1800;
    await sleep(60);
    expect(fs.existsSync(stateFile)).toBe(true);
    clock = 2000;
    await sleep(100);
    expect(await closed(handle)).toBe(true);

    clock = 0;
    handle = await startClock();
    clock = 900;
    const u = new URL(handle.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: u.port, path: '/api/ping' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(401);
    const wrong = `${handle.token.slice(0, -1)}${handle.token.endsWith('0') ? '1' : '0'}`;
    const equalLen = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: u.port, path: '/api/ping', headers: { 'x-ccinfobar-token': wrong } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(equalLen).toBe(401);
    clock = 1500;
    await sleep(100);
    expect(await closed(handle)).toBe(true);
  });

  it('keeps a state file that holds another pid', async () => {
    handle = await start(60_000);
    fs.writeFileSync(stateFile, JSON.stringify({ url: handle.url, pid: process.pid + 1, startedAt: 1 }));
    await handle.close();
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it('rejects a state file that is not a loopback url', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ url: 'http://evil.example/?t=ab', pid: 5, startedAt: 1 }));
    expect(readEditorState(env)).toBeNull();
  });
});

describe('runDetach', () => {
  it('reuses a live editor without spawning', async () => {
    handle = await start(60_000);
    const spawned: string[][] = [];
    const lines: string[] = [];
    const code = await runDetach({
      configPath: path.join(dir, 'c.json'),
      open: false,
      env,
      spawn: (a) => (spawned.push(a), 1),
      log: (s) => lines.push(s),
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([]);
    expect(lines.join('\n')).toContain(handle.url);
  });

  it('spawns when the recorded editor does not answer and waits for its state', async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const stale = 'http://127.0.0.1:1/?t=00';
    fs.writeFileSync(stateFile, JSON.stringify({ url: stale, pid: 4242, startedAt: 1 }));
    const fresh = 'http://127.0.0.1:2/?t=ff';
    const spawned: string[][] = [];
    const lines: string[] = [];
    const code = await runDetach({
      configPath: '/x/c.json',
      port: 9999,
      open: false,
      env,
      spawn: (a) => {
        spawned.push(a);
        setTimeout(
          () => fs.writeFileSync(stateFile, JSON.stringify({ url: fresh, pid: 777, startedAt: 2 })),
          150,
        );
        return 777;
      },
      log: (s) => lines.push(s),
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([
      ['edit', '--serve-detached', '--no-open', '--config', path.resolve('/x/c.json'), '--port', '9999'],
    ]);
    expect(lines.join('\n')).toContain(fresh);
  });

  it('prints the ready line in the display language', async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const fresh = 'http://127.0.0.1:3/?t=ee';
    const lines: string[] = [];
    const prev = setLanguage('tr');
    try {
      await runDetach({
        configPath: '/x/c.json',
        open: false,
        env,
        spawn: () => {
          setTimeout(
            () => fs.writeFileSync(stateFile, JSON.stringify({ url: fresh, pid: 778, startedAt: 2 })),
            50,
          );
          return 778;
        },
        log: (s) => lines.push(s),
      });
    } finally {
      setLanguage(prev);
    }
    expect(lines).toEqual([`ccinfobar editörü çalışıyor: ${fresh}`]);
  });

  it('does not reuse an editor for another config or port', async () => {
    handle = await start(60_000);
    expect(readEditorState(env)?.config).toBe(path.join(dir, 'c.json'));
    for (const o of [
      { configPath: path.join(dir, 'other.json') },
      { configPath: path.join(dir, 'c.json'), port: 1 },
    ]) {
      const spawned: string[][] = [];
      const code = await runDetach({
        ...o,
        open: false,
        env,
        spawn: (a) => {
          spawned.push(a);
          return null;
        },
        waitMs: 200,
        log: () => {},
      });
      expect(code).toBe(1);
      expect(spawned).toHaveLength(1);
    }
    expect(fs.existsSync(`${stateFile}.lock`)).toBe(false);
  });

  it('two concurrent calls spawn one editor', async () => {
    const spawned: string[][] = [];
    const spawn = (a: string[]) => {
      spawned.push(a);
      void start(60_000).then((h) => {
        handle = h;
      });
      return process.pid;
    };
    const opts = { configPath: path.join(dir, 'c.json'), open: false, env, spawn, waitMs: 3000 };
    const urls: string[] = [];
    const codes = await Promise.all([
      runDetach({ ...opts, log: (s) => urls.push(s) }),
      runDetach({ ...opts, log: (s) => urls.push(s) }),
    ]);
    expect(codes).toEqual([0, 0]);
    expect(spawned).toHaveLength(1);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
  });

  it('fails when the child never writes its state', async () => {
    const code = await runDetach({
      configPath: '/x/c.json',
      open: false,
      env,
      spawn: () => 888,
      waitMs: 300,
      log: () => {},
    });
    expect(code).toBe(1);
  });
});
