import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { cacheDir } from '../core/paths.js';
import { acquireLock, readJsonSafe } from '../data/store.js';
import { safeCwd, spawnSelfDetached } from '../data/update-state.js';

export interface EditorState {
  url: string;
  pid: number;
  startedAt: number;
  config?: string;
}

export interface DetachOptions {
  configPath: string;
  port?: number | undefined;
  open: boolean;
  env?: NodeJS.ProcessEnv;
  spawn?: (args: string[]) => number | null;
  waitMs?: number;
  log?: (s: string) => void;
}

const URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/\?t=[0-9a-f]+$/;

export function editorStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'editor.json');
}

function isState(v: unknown): v is EditorState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.url === 'string' &&
    URL_RE.test(s.url) &&
    Number.isInteger(s.pid) &&
    (s.pid as number) > 0 &&
    typeof s.startedAt === 'number' &&
    (s.config === undefined || typeof s.config === 'string')
  );
}

export function readEditorState(env: NodeJS.ProcessEnv = process.env): EditorState | null {
  return readJsonSafe(editorStateFile(env), isState);
}

export function pingEditor(url: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve(false);
    }
    const token = u.searchParams.get('t') ?? '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port: u.port,
        path: '/api/ping',
        method: 'GET',
        headers: { 'x-ccinfobar-token': token },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function openUrl(url: string): Promise<void> {
  const { openBrowser } = await import('./server.js');
  openBrowser(url);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// same config, and the same port when one was asked for
async function reusable(env: NodeJS.ProcessEnv, config: string, port?: number): Promise<string | null> {
  const live = readEditorState(env);
  if (!live || live.config !== config) return null;
  if (port && new URL(live.url).port !== String(port)) return null;
  return (await pingEditor(live.url)) ? live.url : null;
}

export async function runDetach(opts: DetachOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((s: string) => console.log(s));
  const ready = async (url: string) => {
    log(t('edit.running', { url }));
    if (opts.open) await openUrl(url);
    return 0;
  };
  const config = path.resolve(opts.configPath);
  const waitMs = opts.waitMs ?? 5000;
  const end = Date.now() + waitMs;

  const live = await reusable(env, config, opts.port);
  if (live) return ready(live);

  // one spawn at a time; a waiter reuses the winner's editor
  const lock = `${editorStateFile(env)}.lock`;
  while (!acquireLock(lock, waitMs + 1000)) {
    if (Date.now() >= end) {
      console.error(t('edit.detachFailed'));
      return 1;
    }
    await sleep(100);
    const url = await reusable(env, config, opts.port);
    if (url) return ready(url);
  }
  try {
    const again = await reusable(env, config, opts.port);
    if (again) return ready(again);
    const args = ['edit', '--serve-detached', '--no-open', '--config', config];
    if (opts.port) args.push('--port', String(opts.port));
    // home cwd: the server runs claude --version
    const pid = (opts.spawn ?? ((a: string[]) => spawnSelfDetached(a, env, safeCwd())))(args);
    if (pid !== null) {
      for (;;) {
        const state = readEditorState(env);
        if (state?.pid === pid) return ready(state.url);
        if (Date.now() >= end) break;
        await sleep(100);
      }
    }
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
  console.error(t('edit.detachFailed'));
  return 1;
}
