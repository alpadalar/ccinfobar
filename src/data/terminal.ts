import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../core/paths.js';
import { writeAtomic } from './store.js';

const TTL_MS = 10_000;

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 300,
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function positive(v: string | null | undefined): number | null {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function probe(): number | null {
  if (process.platform === 'win32') return null;
  let pid = process.pid;
  for (let depth = 0; depth < 8; depth++) {
    const out = run('ps', ['-o', 'ppid=,tty=', '-p', String(pid)]);
    if (!out) return null;
    const [ppid, tty] = out.split(/\s+/);
    if (tty && tty !== '?' && tty !== '??') {
      const dev = `/dev/${tty}`;
      for (const flag of ['-F', '-f']) {
        const size = run('stty', [flag, dev, 'size']);
        const cols = positive(size?.split(/\s+/)[1]);
        if (cols) return cols;
      }
    }
    const next = positive(ppid);
    if (!next || next === pid) return null;
    pid = next;
  }
  return null;
}

function direct(hint?: number): number | null {
  if (hint && hint > 0) return hint;
  const fromEnv = positive(process.env.COLUMNS);
  if (fromEnv) return fromEnv;
  if (process.stdout.isTTY && process.stdout.columns) return process.stdout.columns;
  return null;
}

function widthFile(sessionId: string | undefined): string {
  const key = (sessionId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(cacheDir(), `width-${key || 'default'}.json`);
}

function readCached(file: string, maxAge: number): number | null | undefined {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { width: unknown; at: unknown };
    if (typeof cached.at !== 'number' || Date.now() - cached.at >= maxAge) return undefined;
    return typeof cached.width === 'number' && cached.width > 0 ? cached.width : null;
  } catch {
    return undefined;
  }
}

// read-only: no probe, no cache write
export function cachedTerminalWidth(sessionId: string | undefined, hint?: number): number | null {
  return direct(hint) ?? readCached(widthFile(sessionId), Number.POSITIVE_INFINITY) ?? null;
}

export function terminalWidth(sessionId: string | undefined, hint?: number): number | null {
  const known = direct(hint);
  if (known) return known;
  const file = widthFile(sessionId);
  const cached = readCached(file, TTL_MS);
  if (cached !== undefined) return cached;
  const width = probe();
  writeAtomic(file, JSON.stringify({ width, at: Date.now() }));
  return width;
}
