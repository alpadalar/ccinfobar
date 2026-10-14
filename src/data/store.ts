import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mode = opts.mode ?? existingMode(file);
    tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(
      tmp,
      data,
      mode === undefined ? { flush: cls === 'settings' } : { mode, flush: cls === 'settings' },
    );
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    renameWithRetry(tmp, file, cls === 'settings' ? 2000 : 100);
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
    if (now - fs.statSync(file).mtimeMs <= staleMs) return false;
    fs.unlinkSync(file);
    return tryCreate(file);
  } catch {
    return false;
  }
}
