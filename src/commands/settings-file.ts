import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry, writeTmp } from '../data/store.js';

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
    super(`Cannot parse ${file}: ${reason}`);
    this.name = 'SettingsParseError';
  }
}

const MAX_ATTEMPTS = 3;
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

// realpath, following dangling links by hand
export function resolveReal(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e;
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
    throw new SettingsParseError(file, 'not a JSON object');
  }
  return { ...raw, data: data as Record<string, unknown>, format };
}

// tmp next to real, mode and owner kept; false when real changed meanwhile
function commit(raw: RawRead, bytes: Uint8Array, beforeRename?: () => void): boolean {
  fs.mkdirSync(path.dirname(raw.real), { recursive: true });
  const tmp = writeTmp(raw.real, bytes, { mode: raw.mode, flush: true });
  try {
    fs.chmodSync(tmp, raw.mode);
    if (posix && raw.uid !== undefined && raw.gid !== undefined) {
      try {
        fs.chownSync(tmp, raw.uid, raw.gid);
      } catch {}
    }
    beforeRename?.();
    if (currentHash(raw.real) !== raw.hash) {
      fs.unlinkSync(tmp);
      return false;
    }
    renameWithRetry(tmp, raw.real, 2000);
    return true;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
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
    if (!commit(cur, after, opts.beforeRename)) continue;
    return { ...result, changed: true, afterHash: hashBytes(after) };
  }
  throw new Error(`${file} changed while writing; try again`);
}

// byte-exact restore
export function writeSettingsBytes(file: string, bytes: Uint8Array, opts: PatchOpts = {}): WriteResult {
  const cur = readRaw(file);
  if (cur.exists && cur.bytes.equals(bytes)) return { changed: false, real: cur.real, backup: null };
  if (!commit(cur, bytes, opts.beforeRename)) throw new Error(`${file} changed while writing; try again`);
  return { changed: true, real: cur.real, backup: null };
}

// a symlinked file is emptied, not unlinked
export function deleteSettingsFile(file: string, opts: PatchOpts = {}): WriteResult {
  const cur = readRaw(file);
  if (!cur.exists) return { changed: false, real: cur.real, backup: null };
  let link = false;
  try {
    link = fs.lstatSync(file).isSymbolicLink();
  } catch {}
  if (link) {
    const empty = serialize({}, detectFormat(cur.bytes.toString('utf8')));
    return writeSettingsBytes(file, Buffer.from(empty, 'utf8'), opts);
  }
  fs.rmSync(cur.real, { force: true });
  return { changed: true, real: cur.real, backup: null };
}
