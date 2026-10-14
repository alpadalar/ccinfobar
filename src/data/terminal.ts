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

export function terminalWidth(sessionId: string | undefined, hint?: number): number | null {
  if (hint && hint > 0) return hint;
  const fromEnv = positive(process.env.COLUMNS);
  if (fromEnv) return fromEnv;
  if (process.stdout.isTTY && process.stdout.columns) return process.stdout.columns;
  const key = (sessionId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(cacheDir(), `width-${key || 'default'}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { width: number | null; at: number };
    if (Date.now() - cached.at < TTL_MS) return cached.width;
  } catch {}
  const width = probe();
  writeAtomic(file, JSON.stringify({ width, at: Date.now() }));
  return width;
}
