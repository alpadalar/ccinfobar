import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { cacheDir } from '../core/paths.js';
import { readJsonSafe } from '../data/store.js';
import { spawnSelfDetached } from '../data/update-state.js';

export interface EditorState {
  url: string;
  pid: number;
  startedAt: number;
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
    typeof s.startedAt === 'number'
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

export async function runDetach(opts: DetachOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((s: string) => console.log(s));
  const ready = async (url: string) => {
    log(`ccinfobar editor running at ${url}`);
    if (opts.open) await openUrl(url);
    return 0;
  };

  const live = readEditorState(env);
  if (live && (await pingEditor(live.url))) return ready(live.url);

  const args = ['edit', '--serve-detached', '--no-open', '--config', path.resolve(opts.configPath)];
  if (opts.port) args.push('--port', String(opts.port));
  // home cwd: the server runs claude --version
  const pid = (opts.spawn ?? ((a: string[]) => spawnSelfDetached(a, env, os.homedir())))(args);
  if (pid !== null) {
    const end = Date.now() + (opts.waitMs ?? 5000);
    for (;;) {
      const state = readEditorState(env);
      if (state?.pid === pid) return ready(state.url);
      if (Date.now() >= end) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.error(t('edit.detachFailed'));
  return 1;
}
