import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { claudeSettingsPath, configDir } from '../core/paths.js';
import { renameWithRetry, resolveReal, writeAtomic, writeTmp } from '../data/store.js';

export { resolveReal };

export interface SettingsFormat {
  bom: boolean;
  eol: '\n' | '\r\n';
  indent: string;
  finalNewline: boolean;
}

export interface SettingsRead {
  file: string;
  real: string;
  exists: boolean;
  bytes: Buffer;
  data: Record<string, unknown>;
  format: SettingsFormat;
  hash: string | null;
  mode: number;
  uid?: number;
  gid?: number;
}

export interface PatchOpts {
  env?: NodeJS.ProcessEnv;
  backup?: boolean;
  original?: boolean;
  beforeRename?: () => void;
}

export interface PatchResult {
  changed: boolean;
  existed: boolean;
  real: string;
  beforeBytes: Buffer;
  beforeHash: string | null;
  afterHash: string | null;
  backup: string | null;
  attempts: number;
}

export interface WriteResult {
  changed: boolean;
  real: string;
  backup: string | null;
}

export class SettingsParseError extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(t('install.settings.cannotParse', { file, reason }));
    this.name = 'SettingsParseError';
  }
}

const MAX_ATTEMPTS = 3;
const KEEP = 10;
const NEW_MODE = 0o600;
const posix = process.platform !== 'win32';

export function hashBytes(buf: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

export function detectFormat(text: string): SettingsFormat {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const indent = /^[{[][^\n]*\r?\n([ \t]+)\S/.exec(body)?.[1] ?? '  ';
  return { bom, eol, indent, finalNewline: body === '' || /\n$/.test(body) };
}

export function serialize(obj: unknown, f: SettingsFormat): string {
  let s = JSON.stringify(obj, null, f.indent);
  if (f.eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  return `${f.bom ? '﻿' : ''}${s}${f.finalNewline ? f.eol : ''}`;
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

interface RawRead {
  file: string;
  real: string;
  exists: boolean;
  bytes: Buffer;
  hash: string | null;
  mode: number;
  uid?: number;
  gid?: number;
}

function readRaw(file: string): RawRead {
  const real = resolveReal(file);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(real);
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e;
    return { file, real, exists: false, bytes: Buffer.alloc(0), hash: null, mode: NEW_MODE };
  }
  const st = fs.statSync(real);
  return {
    file,
    real,
    exists: true,
    bytes,
    hash: hashBytes(bytes),
    mode: st.mode & 0o7777,
    uid: st.uid,
    gid: st.gid,
  };
}

function currentHash(real: string): string | null {
  try {
    return hashBytes(fs.readFileSync(real));
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
}

export function readSettings(file: string): SettingsRead {
  const raw = readRaw(file);
  if (!raw.exists) {
    return { ...raw, data: {}, format: { bom: false, eol: '\n', indent: '  ', finalNewline: true } };
  }
  const text = raw.bytes.toString('utf8');
  const format = detectFormat(text);
  let data: unknown;
  try {
    data = JSON.parse(format.bom ? text.slice(1) : text);
  } catch (e) {
    throw new SettingsParseError(file, (e as Error).message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SettingsParseError(file, t('install.settings.notObject'));
  }
  return { ...raw, data: data as Record<string, unknown>, format };
}

export function backupsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'backups');
}

export function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

const samePath = (a: string, b: string) => (posix ? a === b : a.toLowerCase() === b.toLowerCase());

export function backupPrefix(real: string, env: NodeJS.ProcessEnv = process.env): string {
  let user: string | null = null;
  try {
    user = resolveReal(claudeSettingsPath(env));
  } catch {}
  if (user && samePath(user, real)) return 'settings';
  return `project-${createHash('sha256').update(real).digest('hex').slice(0, 8)}`;
}

const STAMPED = /^(.+)-(\d{8}T\d{6}Z)(?:-(\d+))?\.json$/;

// backups a manifest entry restores from
function pinnedBackups(env: NodeJS.ProcessEnv): string[] {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(configDir(env), 'manifest.json'), 'utf8')) as {
      entries?: { restore?: { backup?: unknown } | null }[];
    };
    return (Array.isArray(m.entries) ? m.entries : [])
      .map((e) => e?.restore?.backup)
      .filter((b): b is string => typeof b === 'string')
      .map((b) => path.resolve(configDir(env), b));
  } catch {
    return [];
  }
}

function rotate(dir: string, prefix: string, env: NodeJS.ProcessEnv): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const mine = names
    .map((name) => ({ name, m: STAMPED.exec(name) }))
    .filter((x) => x.m?.[1] === prefix)
    .map(({ name, m }) => ({ name, at: m?.[2] ?? '', n: Number(m?.[3] ?? 1) }))
    .sort((a, b) => (a.at === b.at ? a.n - b.n : a.at < b.at ? -1 : 1));
  const pinned = pinnedBackups(env);
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) {
    const file = path.join(dir, old.name);
    if (pinned.some((p) => samePath(p, file))) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

function writeBackup(
  real: string,
  bytes: Uint8Array,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): string {
  const env = opts.env ?? process.env;
  const dir = backupsDir(env);
  const prefix = backupPrefix(real, env);
  const name = `${prefix}-${stamp(opts.now ?? new Date())}`;
  let target = path.join(dir, `${name}.json`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${name}-${n}.json`);
  writeAtomic(target, bytes, { mode: 0o600, class: 'settings' });
  return target;
}

export function rotateBackups(real: string, env: NodeJS.ProcessEnv = process.env): void {
  rotate(backupsDir(env), backupPrefix(real, env), env);
}

export function backupSettings(
  real: string,
  bytes: Uint8Array,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): string {
  const target = writeBackup(real, bytes, opts);
  rotateBackups(real, opts.env);
  return target;
}

// pre-ccinfobar copy, never rotated
export function ensureOriginal(
  real: string,
  bytes: Uint8Array,
  opts: { env?: NodeJS.ProcessEnv; legacyFile?: string } = {},
): string | null {
  const env = opts.env ?? process.env;
  const target = path.join(backupsDir(env), `${backupPrefix(real, env)}-original.json`);
  if (fs.existsSync(target)) return null;
  let src: Uint8Array = bytes;
  if (opts.legacyFile) {
    try {
      src = fs.readFileSync(opts.legacyFile);
    } catch {}
  }
  writeAtomic(target, src, { mode: 0o600, class: 'settings' });
  return target;
}

function takeBackup(raw: RawRead, opts: PatchOpts): string | null {
  if (!raw.exists || opts.backup === false) return null;
  if (opts.original !== false)
    ensureOriginal(raw.real, raw.bytes, { env: opts.env, legacyFile: legacyFile(raw) });
  return writeBackup(raw.real, raw.bytes, { env: opts.env });
}

function legacyFile(raw: RawRead): string | undefined {
  for (const f of [`${raw.file}.ccinfobar-backup`, `${raw.real}.ccinfobar-backup`]) {
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

// tmp next to real, mode and owner kept; false when real changed meanwhile
function commit(raw: RawRead, bytes: Uint8Array, opts: PatchOpts): string | null | false {
  fs.mkdirSync(path.dirname(raw.real), { recursive: true });
  const tmp = writeTmp(raw.real, bytes, { mode: raw.mode, flush: true });
  let backup: string | null = null;
  let renamed = false;
  try {
    fs.chmodSync(tmp, raw.mode);
    if (posix && raw.uid !== undefined && raw.gid !== undefined) {
      try {
        fs.chownSync(tmp, raw.uid, raw.gid);
      } catch {}
    }
    backup = takeBackup(raw, opts);
    opts.beforeRename?.();
    // hash check right before the rename; backup already taken from the bytes we read
    if (currentHash(raw.real) !== raw.hash) {
      fs.unlinkSync(tmp);
      if (backup) fs.rmSync(backup, { force: true });
      return false;
    }
    renameWithRetry(tmp, raw.real, 2000);
    renamed = true;
    if (backup) rotateBackups(raw.real, opts.env ?? process.env);
    return backup;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    if (backup && !renamed) {
      try {
        fs.rmSync(backup, { force: true });
      } catch {}
    }
    throw e;
  }
}

export function patchSettings(
  file: string,
  mutate: (data: Record<string, unknown>) => unknown,
  opts: PatchOpts = {},
): PatchResult {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const cur = readSettings(file);
    const draft = structuredClone(cur.data);
    const out = mutate(draft);
    const next =
      out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : draft;
    const after = Buffer.from(serialize(next, cur.format), 'utf8');
    const result: PatchResult = {
      changed: false,
      existed: cur.exists,
      real: cur.real,
      beforeBytes: cur.bytes,
      beforeHash: cur.hash,
      afterHash: cur.hash,
      backup: null,
      attempts: attempt,
    };
    const empty = !cur.exists && Object.keys(next).length === 0;
    if (empty || (cur.exists && after.equals(cur.bytes))) return result;
    const backup = commit(cur, after, opts);
    if (backup === false) continue;
    return { ...result, changed: true, afterHash: hashBytes(after), backup };
  }
  throw new Error(t('install.settings.changed', { file }));
}

// byte-exact restore
export function writeSettingsBytes(file: string, bytes: Uint8Array, opts: PatchOpts = {}): WriteResult {
  const cur = readRaw(file);
  if (cur.exists && cur.bytes.equals(bytes)) return { changed: false, real: cur.real, backup: null };
  const backup = commit(cur, bytes, opts);
  if (backup === false) throw new Error(t('install.settings.changed', { file }));
  return { changed: true, real: cur.real, backup };
}

// a symlinked file is emptied, not unlinked; null if it changed since ifHash
export function deleteSettingsFile(
  file: string,
  opts: PatchOpts & { ifHash?: string | null } = {},
): WriteResult | null {
  const cur = readRaw(file);
  if (!cur.exists) return { changed: false, real: cur.real, backup: null };
  const expected = opts.ifHash === undefined ? cur.hash : opts.ifHash;
  if (cur.hash !== expected) return null;
  let link = false;
  try {
    link = fs.lstatSync(file).isSymbolicLink();
  } catch {}
  if (link) {
    const empty = Buffer.from(serialize({}, detectFormat(cur.bytes.toString('utf8'))), 'utf8');
    const backup = commit(cur, empty, opts);
    return backup === false ? null : { changed: true, real: cur.real, backup };
  }
  const backup = takeBackup(cur, opts);
  opts.beforeRename?.();
  if (currentHash(cur.real) !== expected) {
    if (backup) fs.rmSync(backup, { force: true });
    return null;
  }
  fs.rmSync(cur.real, { force: true });
  if (backup) rotateBackups(cur.real, opts.env ?? process.env);
  return { changed: true, real: cur.real, backup };
}

// undo a write unless someone changed the file since
export function rollbackPatch(file: string, res: PatchResult, env?: NodeJS.ProcessEnv): void {
  try {
    const opts = { env, backup: false, ifHash: res.afterHash };
    if (!res.existed) deleteSettingsFile(file, opts);
    else if (readSettings(file).hash === res.afterHash) writeSettingsBytes(file, res.beforeBytes, opts);
  } catch {}
}
