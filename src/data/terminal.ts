import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { cacheDir } from '../core/paths.js';
import { writeAtomic } from './store.js';

const TTL_OK = 60_000;
const TTL_FAIL = 600_000;

export interface TerminalDeps {
  run?: (cmd: string, args: string[]) => string | null;
  openTty?: () => number | null;
  platform?: NodeJS.Platform;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  stdoutColumns?: () => number | null;
}

function defaultRun(cmd: string, args: string[]): string | null {
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

export interface TtyIo {
  open(): number;
  isatty(fd: number): boolean;
  stream(fd: number): { columns: unknown; destroy(): void };
  close(fd: number): void;
}

const NODE_TTY: TtyIo = {
  open: () =>
    fs.openSync('/dev/tty', fs.constants.O_RDONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK),
  isatty: (fd) => tty.isatty(fd),
  stream: (fd) => new tty.WriteStream(fd),
  close: (fd) => fs.closeSync(fd),
};

export function ttyColumns(io: TtyIo = NODE_TTY): number | null {
  let fd: number;
  try {
    fd = io.open();
  } catch {
    return null;
  }
  let stream: { columns: unknown; destroy(): void } | null = null;
  try {
    if (!io.isatty(fd)) return null;
    stream = io.stream(fd);
    return positive(String(stream.columns));
  } catch {
    return null;
  } finally {
    try {
      stream?.destroy();
    } catch {}
    // libuv reopens the tty and owns only its dup; our fd stays ours
    try {
      io.close(fd);
    } catch {}
  }
}

function probe(deps: TerminalDeps): number | null {
  const run = deps.run ?? defaultRun;
  let pid = process.pid;
  for (let depth = 0; depth < 8; depth++) {
    const out = run('ps', ['-o', 'ppid=,tty=', '-p', String(pid)]);
    if (!out) return null;
    const [ppid, term] = out.split(/\s+/);
    if (term && term !== '?' && term !== '??') {
      const dev = `/dev/${term}`;
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

function direct(hint: number | undefined, deps: TerminalDeps): number | null {
  if (hint && hint > 0) return hint;
  const fromEnv = positive((deps.env ?? process.env).COLUMNS);
  if (fromEnv) return fromEnv;
  if (deps.stdoutColumns) return deps.stdoutColumns();
  if (process.stdout.isTTY && process.stdout.columns) return process.stdout.columns;
  return null;
}

function widthFile(sessionId: string | undefined, deps: TerminalDeps): string {
  const key = (sessionId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(cacheDir(deps.env), `width-${key || 'default'}.json`);
}

function readCached(file: string, now: number | null): number | null | undefined {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { width: unknown; at: unknown };
    if (typeof cached.at !== 'number') return undefined;
    const ok = typeof cached.width === 'number' && cached.width > 0;
    if (now !== null && now - cached.at >= (ok ? TTL_OK : TTL_FAIL)) return undefined;
    return ok ? (cached.width as number) : null;
  } catch {
    return undefined;
  }
}

// read-only: no probe, no cache write
export function cachedTerminalWidth(
  sessionId: string | undefined,
  hint?: number,
  deps: TerminalDeps = {},
): number | null {
  return direct(hint, deps) ?? readCached(widthFile(sessionId, deps), null) ?? null;
}

export function terminalWidth(
  sessionId: string | undefined,
  hint?: number,
  deps: TerminalDeps = {},
): number | null {
  const known = direct(hint, deps);
  if (known) return known;
  if ((deps.platform ?? process.platform) === 'win32') return null;
  const now = (deps.now ?? Date.now)();
  const file = widthFile(sessionId, deps);
  const cached = readCached(file, now);
  if (cached !== undefined) return cached;
  const fast = deps.openTty ? deps.openTty() : ttyColumns();
  const width = fast ?? probe(deps);
  writeAtomic(file, JSON.stringify({ width, at: now }), { mode: 0o600 });
  return width;
}
