import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';
import { beforeEach } from 'vitest';
import { resetLanguageCache } from '../src/cli/lang.js';
import { setLanguage } from '../src/core/i18n/index.js';

declare global {
  var __ccibRenderGuard: boolean | undefined;
}

type Fn = (...args: unknown[]) => unknown;

const MARK = Symbol.for('ccib.guard');
const realpath = fs.realpathSync.native;
const rmSync = fs.rmSync;

function makeRoot(): string {
  const prev = process.env.CCIB_TEST_ROOT;
  if (prev && fs.existsSync(prev)) return prev;
  const parent = process.env.CCIB_TEST_PARENT;
  const base = parent && fs.existsSync(parent) ? parent : os.tmpdir();
  const dir = realpath(fs.mkdtempSync(path.join(base, 'ccib-test-')));
  process.env.CCIB_TEST_ROOT = dir;
  if (base !== parent) {
    process.once('exit', () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    });
  }
  return dir;
}

const root = makeRoot();

function setDir(key: string, sub: string): void {
  const dir = path.join(root, sub);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}

setDir('HOME', 'home');
setDir('USERPROFILE', 'home');
setDir('APPDATA', 'appdata');
setDir('LOCALAPPDATA', 'localappdata');
setDir('XDG_CONFIG_HOME', 'xdg-config');
setDir('XDG_CACHE_HOME', 'xdg-cache');
setDir('CCINFOBAR_CONFIG_DIR', 'config');
setDir('CCINFOBAR_CACHE_DIR', 'cache');
setDir('CLAUDE_CONFIG_DIR', 'claude');
process.env.CCINFOBAR_NO_UPDATE = '1';
process.env.CCINFOBAR_NO_USAGE_API = '1';
delete process.env.CCINFOBAR_CONFIG;
process.env.LANG = 'C';
process.env.LC_ALL = 'C';
delete process.env.LC_MESSAGES;
delete process.env.CCINFOBAR_LANG;

beforeEach(() => {
  resetLanguageCache();
  setLanguage('en');
});

const win = process.platform === 'win32';
const norm = (p: string) => (win ? p.toLowerCase() : p);

function rootsOf(dir: string): string[] {
  const out = [dir];
  try {
    out.push(realpath(dir));
  } catch {}
  if (process.platform === 'darwin') {
    for (const r of [...out]) out.push(r.startsWith('/private/') ? r.slice(8) : `/private${r}`);
  }
  return [...new Set(out.map(norm))];
}

// file snapshots of test/i18n/snapshots.test.ts
const snapshots = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n', '__snapshots__');
const allowed = [...rootsOf(root), ...rootsOf(os.tmpdir()), ...rootsOf(snapshots)];

function toPath(p: unknown): string | null {
  if (typeof p === 'string') return p;
  if (Buffer.isBuffer(p)) return p.toString();
  if (p instanceof URL) return fileURLToPath(p);
  return null;
}

// realpath of the nearest existing parent plus the rest
function canonical(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = path.dirname(abs);
  for (;;) {
    try {
      return path.join(realpath(cur), ...rest.reverse(), path.basename(abs));
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.push(path.basename(cur));
    cur = parent;
  }
}

function inside(target: string): boolean {
  const t = norm(target);
  return allowed.some((r) => t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
}

function checkWrite(raw: unknown): void {
  const p = toPath(raw);
  if (p === null) return;
  if (globalThis.__ccibRenderGuard && path.basename(p) === 'config.json') {
    throw new Error(`ccinfobar test guard: config save during render: ${p}`);
  }
  const targets = [canonical(p)];
  try {
    if (fs.lstatSync(p).isSymbolicLink()) targets.push(realpath(p));
  } catch {}
  for (const t of targets) {
    if (!inside(t)) throw new Error(`ccinfobar test guard: write outside temp dirs: ${t}`);
  }
}

function wrap(obj: object, name: string, before: (args: unknown[]) => void): void {
  const target = obj as Record<string | symbol, unknown>;
  const orig = target[name] as (Fn & Record<symbol, unknown>) | undefined;
  if (typeof orig !== 'function') return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    before(args);
    return Reflect.apply(orig, this, args);
  } as Fn & Record<symbol, unknown>;
  const custom = orig[util.promisify.custom] as Fn | undefined;
  if (typeof custom === 'function') {
    wrapped[util.promisify.custom] = (...args: unknown[]) => {
      before(args);
      return custom(...args);
    };
  }
  target[name] = wrapped;
}

const writeFlags = (() => {
  const c = fs.constants;
  return c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_TRUNC;
})();

function guardFs(): void {
  const f = fs as unknown as Record<symbol, unknown>;
  if (f[MARK]) return;
  f[MARK] = true;
  for (const name of [
    'writeFileSync',
    'appendFileSync',
    'rmSync',
    'unlinkSync',
    'mkdirSync',
    'mkdtempSync',
  ]) {
    wrap(fs, name, (a) => checkWrite(a[0]));
  }
  wrap(fs, 'renameSync', (a) => checkWrite(a[1]));
  wrap(fs, 'copyFileSync', (a) => checkWrite(a[1]));
  wrap(fs, 'symlinkSync', (a) => checkWrite(a[1]));
  wrap(fs, 'openSync', (a) => {
    const flags = a[1] ?? 'r';
    const writes = typeof flags === 'number' ? (flags & writeFlags) !== 0 : /[wa+]/.test(String(flags));
    if (writes) checkWrite(a[0]);
  });
  for (const name of ['writeFile', 'appendFile', 'rm', 'unlink', 'mkdir']) {
    wrap(fs.promises, name, (a) => checkWrite(a[0]));
  }
  wrap(fs.promises, 'rename', (a) => checkWrite(a[1]));
  wrap(fs.promises, 'copyFile', (a) => checkWrite(a[1]));
}

function guardSpawn(): void {
  const c = cp as unknown as Record<symbol, unknown>;
  if (c[MARK]) return;
  c[MARK] = true;
  for (const name of ['execFileSync', 'execSync', 'spawn', 'spawnSync', 'execFile', 'exec', 'fork']) {
    wrap(cp, name, (a) => {
      if (globalThis.__ccibRenderGuard) {
        throw new Error(`ccinfobar test guard: spawn during render: ${String(a[0])}`);
      }
    });
  }
}

function guardFetch(): void {
  const orig = globalThis.fetch as typeof fetch & Record<symbol, unknown>;
  if (typeof orig !== 'function' || orig[MARK]) return;
  const wrapped = ((...args: Parameters<typeof fetch>) => {
    if (globalThis.__ccibRenderGuard) {
      throw new Error(`ccinfobar test guard: fetch during render: ${String(args[0])}`);
    }
    return orig(...args);
  }) as typeof fetch & Record<symbol, unknown>;
  wrapped[MARK] = true;
  globalThis.fetch = wrapped;
}

guardFs();
guardSpawn();
guardFetch();
module.syncBuiltinESMExports();
