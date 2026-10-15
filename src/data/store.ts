import path from 'node:path';
import { fs, randomHex } from '../core/builtins.js';

export type WriteClass = 'cache' | 'settings';

export interface RenameDeps {
  rename?: (from: string, to: string) => void;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => void;
}

const RETRY_WIN = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const TMP_RE = /\.\d+\.[0-9a-f]{8}\.tmp$/;
const LEGACY_TMP_RE = /\.\d+\.tmp$/;

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function renameWithRetry(from: string, to: string, budgetMs: number, deps: RenameDeps = {}): void {
  const rename = deps.rename ?? fs.renameSync;
  const platform = deps.platform ?? process.platform;
  const sleep = deps.sleep ?? sleepSync;
  const start = Date.now();
  for (let wait = 10; ; wait = Math.min(100, wait + 10)) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      const retry = platform === 'win32' ? RETRY_WIN.has(code) : code === 'EBUSY';
      if (!retry || Date.now() - start + wait > budgetMs) throw e;
      sleep(wait);
    }
  }
}

// realpath, following dangling links by hand
export function resolveReal(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let cur = path.resolve(file);
  for (let i = 0; i < 40; i++) {
    let link: string;
    try {
      link = fs.readlinkSync(cur);
    } catch {
      break;
    }
    cur = path.resolve(path.dirname(cur), link);
  }
  try {
    return path.join(fs.realpathSync(path.dirname(cur)), path.basename(cur));
  } catch {
    return cur;
  }
}

function existingMode(file: string): number | undefined {
  try {
    return fs.statSync(file).mode & 0o7777;
  } catch {
    return undefined;
  }
}

export function writeAtomic(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number; class?: WriteClass } = {},
): boolean {
  const cls = opts.class ?? 'cache';
  let tmp: string | null = null;
  try {
    const target = resolveReal(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mode = opts.mode ?? existingMode(target);
    tmp = `${target}.${process.pid}.${randomHex(4)}.tmp`;
    fs.writeFileSync(
      tmp,
      data,
      mode === undefined ? { flush: cls === 'settings' } : { mode, flush: cls === 'settings' },
    );
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    renameWithRetry(tmp, target, cls === 'settings' ? 2000 : 100);
    return true;
  } catch (e) {
    if (tmp) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
    if (cls === 'settings') throw e;
    return false;
  }
}

// dot-prefixed tmp next to file; caller renames it
export function writeTmp(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number; flush?: boolean } = {},
): string {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomHex(4)}.tmp`);
  try {
    fs.writeFileSync(
      tmp,
      data,
      opts.mode === undefined ? { flush: !!opts.flush } : { mode: opts.mode, flush: !!opts.flush },
    );
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
  return tmp;
}

// one small line per call, so concurrent appends do not interleave
export function appendLine(file: string, line: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, { flag: 'a', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// crypto-free for the hook path; tiny files only
export function writeSmall(file: string, text: string): boolean {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

export function readJsonSafe<T>(file: string, guard?: (v: unknown) => v is T): T | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (guard && !guard(v)) return null;
    return v as T;
  } catch {
    return null;
  }
}

export function pruneTmp(dir: string, olderThanMs: number, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!TMP_RE.test(name) && !LEGACY_TMP_RE.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || now - st.mtimeMs <= olderThanMs) continue;
      fs.unlinkSync(p);
      removed++;
    } catch {}
  }
  return removed;
}

function tryCreate(file: string): boolean {
  fs.closeSync(fs.openSync(file, 'wx'));
  return true;
}

export function acquireLock(file: string, staleMs: number, now = Date.now()): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return tryCreate(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  try {
    if (now - fs.statSync(file).mtimeMs < staleMs) return false;
    fs.unlinkSync(file);
    return tryCreate(file);
  } catch {
    return false;
  }
}
