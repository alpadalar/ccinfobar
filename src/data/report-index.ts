import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, claudeDir, displayRoot, normalizeRoot } from '../core/paths.js';
import {
  type Bucket,
  type FileEntry,
  type FileKind,
  IDLE_CAP_MS,
  type IndexState,
  type LedgerDeps,
  type LedgerSession,
  MAX_REPORT_FILES,
  MAX_REPORT_LINE,
  type RecentReq,
  type ScanNote,
  type ScanResult,
  type SessionData,
} from '../core/report-types.js';
import { sanitizeText } from '../core/sanitize.js';
import { dayKey, monthKey } from '../core/time.js';
import type { Credited, SessionRow } from './ledger.js';
import { readJsonSafe, writeAtomic } from './store.js';

export interface WalkedFile {
  rel: string;
  abs: string;
  kind: FileKind;
  sid: string;
  enc: string;
}

const SID = /^[A-Za-z0-9_-]{1,128}$/;
const MAIN = /^([A-Za-z0-9_-]{1,128})\.jsonl$/;
const ORPHANED = /^([A-Za-z0-9_-]{1,128})\.orphaned-.*\.jsonl$/;
const SUPERSEDED = /^([A-Za-z0-9_-]{1,128})\.jsonl\.superseded-.+$/;
const AGENT = /^agent-.+\.jsonl$/;
const AGENT_DEPTH = 4;

const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function list(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort(byName);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function walkTranscripts(
  claudeDir: string,
  maxFiles = MAX_REPORT_FILES,
): { files: WalkedFile[]; capped: boolean } {
  const files: WalkedFile[] = [];
  let capped = false;
  const add = (f: WalkedFile): boolean => {
    if (files.length >= maxFiles) {
      capped = true;
      return false;
    }
    files.push(f);
    return true;
  };
  const agents = (dir: string, rel: string, depth: number, sid: string, enc: string): boolean => {
    for (const d of list(dir)) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      if (d.isFile() && AGENT.test(d.name)) {
        if (!add({ rel: `${rel}/${d.name}`, abs, kind: 'agent', sid, enc })) return false;
      } else if (d.isDirectory() && depth < AGENT_DEPTH) {
        if (!agents(abs, `${rel}/${d.name}`, depth + 1, sid, enc)) return false;
      }
    }
    return true;
  };
  const projects = path.join(claudeDir, 'projects');
  for (const p of list(projects)) {
    if (p.isSymbolicLink() || !p.isDirectory()) continue;
    const enc = p.name;
    const dir = path.join(projects, enc);
    const base = `projects/${enc}`;
    for (const d of list(dir)) {
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      const rel = `${base}/${d.name}`;
      if (d.isFile()) {
        const main = MAIN.exec(d.name);
        const aside = main ? null : (ORPHANED.exec(d.name) ?? SUPERSEDED.exec(d.name));
        const sid = main?.[1] ?? aside?.[1];
        if (sid && !add({ rel, abs, kind: main ? 'main' : 'aside', sid, enc })) return { files, capped };
      } else if (d.isDirectory() && SID.test(d.name)) {
        const sub = path.join(abs, 'subagents');
        if (isDir(sub) && !agents(sub, `${rel}/subagents`, 1, d.name, enc)) return { files, capped };
      }
    }
  }
  return { files, capped };
}

// biome-ignore lint/suspicious/noExplicitAny: untyped JSONL
type Json = Record<string, any>;

const CHUNK = 8 * 1024 * 1024;
const RECENT = 64;
const MAX_MODEL = 200;
// prompt size of the long-context price tier, fixed in bucket keys
export const BIG = 100_000;

const map = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// cyrb53
export function keyHash(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function bucketKey(day: string, model: string, fast: boolean, big: boolean, usd: boolean): string {
  return `${day}|${model}|${fast ? 1 : 0}|${big ? 1 : 0}|${usd ? 1 : 0}`;
}

export function emptyState(): IndexState {
  return { v: 1, files: map(), owners: new Map() };
}

function newEntry(f: WalkedFile): FileEntry {
  return {
    kind: f.kind,
    sid: f.sid,
    enc: f.enc,
    id: null,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    tail: '',
    gone: false,
    cwd: null,
    buckets: map(),
    time: map(),
    lastTs: null,
    horizon: 0,
    recent: [],
    skipped: 0,
    first: null,
    born: 0,
    lost: false,
    tz: '',
    shown: null,
  };
}

type Req = Omit<RecentReq, 'k' | 'b'>;

const zero = (): Bucket => ({ in: 0, out: 0, cr: 0, w5: 0, w1: 0, n: 0, usd: 0 });

function addTo(f: FileEntry, b: string, r: Req, sign: 1 | -1): void {
  let x = f.buckets[b];
  if (!x) {
    if (sign < 0) return;
    x = zero();
    f.buckets[b] = x;
  }
  x.in += sign * r.in;
  x.out += sign * r.out;
  x.cr += sign * r.cr;
  x.w5 += sign * r.w5;
  x.w1 += sign * r.w1;
  x.usd += sign * (r.usd ?? 0);
  x.n += sign;
  if (x.n <= 0) delete f.buckets[b];
}

interface Scan {
  st: IndexState;
  rel: string;
  f: FileEntry;
  platform: NodeJS.Platform;
}

function parse(line: string): Json | null {
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === 'object' ? (e as Json) : null;
  } catch {
    return null;
  }
}

function applyAssistant(sc: Scan, e: Json, ts: number | null): void {
  if (e.type !== 'assistant') return;
  const msg = e.message as Json | undefined;
  const u = msg?.usage as Json | undefined;
  if (!msg || !u || typeof u !== 'object' || msg.model === '<synthetic>') return;
  const { st, rel, f } = sc;
  const cc = (u.cache_creation ?? {}) as Json;
  const w1 = num(cc.ephemeral_1h_input_tokens);
  const w5x = num(cc.ephemeral_5m_input_tokens);
  const r: Req = {
    in: num(u.input_tokens),
    out: num(u.output_tokens),
    cr: num(u.cache_read_input_tokens),
    w5: w5x + Math.max(0, num(u.cache_creation_input_tokens) - w1 - w5x),
    w1,
    usd: typeof e.costUSD === 'number' && Number.isFinite(e.costUSD) && e.costUSD >= 0 ? e.costUSD : null,
  };
  const model = sanitizeText(typeof msg.model === 'string' ? msg.model : '')
    .replace(/\|/g, '_')
    .slice(0, MAX_MODEL);
  const big = r.in + r.cr + r.w5 + r.w1 > BIG;
  const b = bucketKey(dayKey(ts ?? f.lastTs ?? f.mtimeMs), model, u.speed === 'fast', big, r.usd !== null);
  const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
  const rq = typeof e.requestId === 'string' && e.requestId ? e.requestId : null;
  if (id === null && rq === null) {
    addTo(f, b, r, 1);
    return;
  }
  const k = keyHash(`${id ?? ''}:${rq ?? ''}`);
  const owner = st.owners.get(k);
  if (owner === undefined) {
    st.owners.set(k, rel);
    addTo(f, b, r, 1);
    f.recent.push({ k, b, ...r });
    if (f.recent.length > RECENT) f.recent.shift();
    return;
  }
  if (owner !== rel) {
    const o = st.files[owner];
    const main = f.kind === 'main' && o?.kind === 'main' && e.isSidechain !== true;
    if (main && rank(f, rel, o, owner) < 0) {
      // the older copy owns it, even when read later
      const old = o.recent.find((x) => x.k === k);
      if (old) {
        addTo(o, old.b, old, -1);
        o.recent = o.recent.filter((x) => x !== old);
      } else addTo(o, b, r, -1);
      st.owners.set(k, rel);
      addTo(f, b, r, 1);
      f.recent.push({ k, b, ...r });
      if (f.recent.length > RECENT) f.recent.shift();
      return;
    }
    // copies of another session's main file form this file's prefix
    if (ts !== null && ts >= f.horizon && main) {
      f.horizon = ts;
      f.time = map();
    }
    return;
  }
  const old = f.recent.find((x) => x.k === k);
  if (!old) return;
  addTo(f, old.b, old, -1);
  addTo(f, b, r, 1);
  Object.assign(old, { b, ...r });
}

function applyLine(sc: Scan, line: string): void {
  const f = sc.f;
  let e: Json | null = null;
  if (f.cwd === null) {
    e = parse(line);
    const cwd = e?.cwd;
    const pm = sc.platform === 'win32' ? path.win32 : path.posix;
    if (typeof cwd === 'string' && cwd && pm.isAbsolute(cwd)) {
      f.cwd = normalizeRoot(cwd, sc.platform);
      if (sc.platform === 'win32') {
        const shown = displayRoot(cwd, sc.platform);
        f.shown = shown !== f.cwd ? shown : null;
      }
    }
  } else if (line.includes('"usage"') && line.includes('"type":"assistant"')) {
    e = parse(line);
  }
  let ts: number | null;
  let side: boolean;
  if (e) {
    const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
    ts = Number.isNaN(t) ? null : t;
    if (f.first === null && ts !== null) f.first = ts;
    side = e.isSidechain === true;
    applyAssistant(sc, e, ts);
  } else {
    if (f.kind !== 'main') return;
    ts = lineTs(line);
    side = line.includes('"isSidechain":true');
  }
  if (f.kind === 'main' && ts !== null && !side) tick(f, ts);
}

const TS = '"timestamp":"';

function lineTs(line: string): number | null {
  const i = line.lastIndexOf(TS);
  if (i < 0) return null;
  const j = line.indexOf('"', i + TS.length);
  const t = j < 0 ? Number.NaN : Date.parse(line.slice(i + TS.length, j));
  return Number.isNaN(t) ? null : t;
}

// gap to the previous entry, capped, on the later entry's day
function tick(f: FileEntry, ts: number): void {
  if (f.lastTs !== null && ts > f.lastTs && ts > f.horizon) {
    const d = dayKey(ts);
    f.time[d] = (f.time[d] ?? 0) + Math.min(ts - f.lastTs, IDLE_CAP_MS);
  }
  if (f.lastTs === null || ts > f.lastTs) f.lastTs = ts;
}

const TAIL = 256;
const EMPTY: Buffer = Buffer.alloc(0);

const tailHash = (b: Buffer): string => keyHash(b.toString('latin1')).toString(16);

// bytes [from - n, from) after b
function before(hist: Buffer, data: Buffer, end: number): Buffer {
  if (end >= TAIL) return Buffer.from(data.subarray(end - TAIL, end));
  return Buffer.concat([hist, data.subarray(0, end)]).subarray(-TAIL);
}

// hist: the bytes right before f.offset
function readFile(sc: Scan, abs: string, size: number, maxLine: number, hist: Buffer): number {
  const f = sc.f;
  let fd: number | null = null;
  let read = 0;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size - f.offset, 1)));
    let carry = Buffer.alloc(0);
    let skipping = false;
    let pos = f.offset;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      const base = pos - carry.length;
      pos += n;
      read += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      let nl = data.indexOf(10, start);
      while (nl !== -1) {
        if (skipping || nl - start > maxLine) {
          skipping = false;
          f.skipped++;
        } else if (nl > start) applyLine(sc, data.toString('utf8', start, nl));
        start = nl + 1;
        f.offset = base + start;
        nl = data.indexOf(10, start);
      }
      if (start > 0) f.tail = tailHash(before(hist, data, start));
      // a line over the cap is dropped up to its newline
      if (skipping || data.length - start > maxLine) {
        skipping = true;
        carry = Buffer.alloc(0);
      } else carry = Buffer.from(data.subarray(start));
      hist = before(hist, data, data.length - carry.length);
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return read;
}

function readTail(abs: string, offset: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, 'r');
    const n = Math.min(TAIL, offset);
    const b = Buffer.alloc(n);
    return fs.readSync(fd, b, 0, n, offset - n) === n ? b : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

const DAY_MS = 86_400_000;
const KEEP_MONTHS = 13;

// first kept day of the 13-month window
function keepFrom(now: number): { day: string; ms: number } {
  const d = new Date(now);
  const first = new Date(d.getFullYear(), d.getMonth() - (KEEP_MONTHS - 1), 1);
  return { day: `${monthKey(first.getTime() + DAY_MS / 2)}-01`, ms: first.getTime() };
}

function resetEntry(f: FileEntry): void {
  Object.assign(f, {
    size: 0,
    offset: 0,
    tail: '',
    cwd: null,
    buckets: map(),
    time: map(),
    lastTs: null,
    horizon: 0,
    recent: [],
    skipped: 0,
    first: null,
    born: 0,
    tz: '',
    shown: null,
  });
}

// drops days before the window; true when something went
function pruneGone(f: FileEntry, day: string): boolean {
  let cut = false;
  for (const k in f.buckets) {
    if (k.slice(0, 10) < day) {
      delete f.buckets[k];
      cut = true;
    }
  }
  for (const k in f.time) {
    if (k < day) {
      delete f.time[k];
      cut = true;
    }
  }
  if (cut) f.recent = f.recent.filter((r) => r.b.slice(0, 10) >= day);
  return cut;
}

interface Todo {
  w: WalkedFile;
  f: FileEntry;
  size: number;
  hist: Buffer;
}

export interface ScanOpts {
  maxLine?: number;
  maxFiles?: number;
  onProgress?: (files: number, bytes: number) => void;
  rebuild?: boolean;
  now?: number;
  // lazy owners; null means unusable
  loadOwners?: () => Map<number, string> | null;
  // current zone; present files cut in another one are read again
  tz?: string;
  platform?: NodeJS.Platform;
}

export interface ScanOut {
  state: IndexState;
  notes: ScanNote[];
  bytesRead: number;
  files: number;
  changed: boolean;
  keysLoaded: boolean;
}

function statOf(abs: string): { id: string | null; size: number; mtime: number; born: number } | null {
  try {
    const s = fs.statSync(abs, { bigint: true });
    return {
      id: s.ino === 0n ? null : `${s.dev}:${s.ino}`,
      size: Number(s.size),
      mtime: Number(s.mtimeMs) + Number(s.mtimeNs % 1_000_000n) / 1e6,
      born: Number(s.birthtimeMs) + Number(s.birthtimeNs % 1_000_000n) / 1e6,
    };
  } catch {
    return null;
  }
}

const PEEK = 64 * 1024;

// top-level timestamp of the first complete line that has one
function peekFirst(abs: string, size: number): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(abs, 'r');
    const b = Buffer.alloc(Math.min(PEEK, size));
    const n = fs.readSync(fd, b, 0, b.length, 0);
    let start = 0;
    for (let nl = b.indexOf(10, start); nl !== -1 && nl < n; nl = b.indexOf(10, start)) {
      const e = parse(b.toString('utf8', start, nl));
      const t = typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
      if (!Number.isNaN(t)) return t;
      start = nl + 1;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

const INF = Number.POSITIVE_INFINITY;

// content order: first entry, then birth time, then path
function rank(a: FileEntry, ar: string, b: FileEntry, br: string): number {
  const first = (a.first ?? INF) - (b.first ?? INF);
  const born = (a.born > 0 ? a.born : INF) - (b.born > 0 ? b.born : INF);
  return first || born || (ar < br ? -1 : ar > br ? 1 : 0);
}

function plan(
  st: IndexState,
  files: WalkedFile[],
  capped: boolean,
  root: string,
  opts: ScanOpts,
): { todo: Todo[]; release: Set<string>; changed: boolean } {
  const todo: Todo[] = [];
  const release = new Set<string>();
  let changed = false;
  const reset = (rel: string, f: FileEntry) => {
    release.add(rel);
    resetEntry(f);
  };
  const seen = new Set<string>();
  for (const w of files) {
    seen.add(w.rel);
    const s = statOf(w.abs);
    if (!s) continue;
    let f = st.files[w.rel];
    let hist = EMPTY;
    if (!f) {
      f = newEntry(w);
      st.files[w.rel] = f;
    } else {
      const same = s.id === f.id || s.id === null || f.id === null;
      const zone = opts.tz !== undefined && f.tz !== opts.tz;
      if (opts.rebuild || zone || !same || s.size < f.offset) reset(w.rel, f);
      else if (!f.gone && s.id === f.id && s.size === f.size && s.mtime === f.mtimeMs) continue;
      else if (f.offset > 0) {
        const b = readTail(w.abs, f.offset);
        if (b && tailHash(b) === f.tail) hist = b;
        else reset(w.rel, f);
      }
    }
    changed = true;
    f.gone = false;
    f.id = s.id;
    f.mtimeMs = s.mtime;
    if (f.offset === 0) {
      f.tz = opts.tz ?? '';
      f.born = s.born;
      f.first = s.size > 0 ? peekFirst(w.abs, s.size) : null;
    }
    if (s.size > f.offset) todo.push({ w, f, size: s.size, hist });
    else f.size = s.size;
  }
  const keep = keepFrom(opts.now ?? Date.now());
  for (const [rel, f] of Object.entries(st.files)) {
    if (seen.has(rel)) continue;
    if (!f.gone) {
      // past the file cap a file may still exist
      if (capped && statOf(path.join(root, ...rel.split('/')))) continue;
      f.gone = true;
      changed = true;
    }
    if (pruneGone(f, keep.day)) changed = true;
    if (!Object.keys(f.buckets).length && !Object.keys(f.time).length) {
      delete st.files[rel];
      release.add(rel);
      changed = true;
    }
  }
  todo.sort((a, b) => rank(a.f, a.w.rel, b.f, b.w.rel));
  return { todo, release, changed };
}

export function scanTree(claudeDir: string, state: IndexState | null, opts: ScanOpts = {}): ScanOut {
  let st = state ?? emptyState();
  const maxLine = opts.maxLine ?? MAX_REPORT_LINE;
  const { files, capped } = walkTranscripts(claudeDir, opts.maxFiles);
  let p = plan(st, files, capped, claudeDir, opts);
  let keysLoaded = !opts.loadOwners;
  if (!keysLoaded && (p.todo.length || p.release.size)) {
    const owners = opts.loadOwners!();
    keysLoaded = true;
    if (owners) st.owners = owners;
    else {
      // without the key set present files are read again; gone totals are final
      const kept = emptyState();
      for (const [rel, f] of Object.entries(st.files)) {
        if (!f.gone) continue;
        kept.files[rel] = f;
        f.lost = true;
        for (const r of f.recent) kept.owners.set(r.k, rel);
      }
      st = kept;
      p = plan(st, files, capped, claudeDir, opts);
    }
  }
  if (p.release.size) {
    for (const [k, rel] of st.owners) if (p.release.has(rel)) st.owners.delete(k);
  }
  let bytesRead = 0;
  let done = 0;
  const platform = opts.platform ?? process.platform;
  for (const { w, f, size, hist } of p.todo) {
    bytesRead += readFile({ st, rel: w.rel, f, platform }, w.abs, size, maxLine, hist);
    f.size = size;
    opts.onProgress?.(++done, bytesRead);
  }
  const notes: ScanNote[] = [];
  if (capped) notes.push({ code: 'file-cap', count: files.length });
  let skipped = 0;
  let gone = 0;
  let lost = 0;
  let zoned = 0;
  for (const f of Object.values(st.files)) {
    skipped += f.skipped;
    if (f.gone) gone++;
    if (f.gone && f.lost) lost++;
    if (f.gone && opts.tz !== undefined && f.tz !== opts.tz) zoned++;
  }
  if (skipped > 0) notes.push({ code: 'line-skipped', count: skipped });
  if (gone > 0) notes.push({ code: 'deleted-transcripts', count: gone });
  if (lost > 0) notes.push({ code: 'keys-lost', count: lost });
  if (zoned > 0) notes.push({ code: 'old-zone', count: zoned });
  return { state: st, notes, bytesRead, files: files.length, changed: p.changed, keysLoaded };
}

export function sessionsOf(state: IndexState): Record<string, SessionData> {
  const out = map<SessionData>();
  const cwdFrom = map<boolean>();
  for (const f of Object.values(state.files)) {
    let s = out[f.sid];
    if (!s) {
      s = { sid: f.sid, enc: f.enc, cwd: null, buckets: map(), time: map(), files: 0, gone: true };
      out[f.sid] = s;
    }
    s.files++;
    if (!f.gone) s.gone = false;
    if (f.kind === 'main') {
      s.enc = f.enc;
      if (f.cwd !== null && !cwdFrom[f.sid]) {
        s.cwd = f.cwd;
        s.shown = f.shown;
        cwdFrom[f.sid] = true;
      }
      for (const [d, ms] of Object.entries(f.time)) s.time[d] = (s.time[d] ?? 0) + ms;
    } else if (s.cwd === null) {
      s.cwd = f.cwd;
      s.shown = f.shown;
    }
    for (const [k, b] of Object.entries(f.buckets)) {
      let x = s.buckets[k];
      if (!x) {
        x = zero();
        s.buckets[k] = x;
      }
      x.in += b.in;
      x.out += b.out;
      x.cr += b.cr;
      x.w5 += b.w5;
      x.w1 += b.w1;
      x.n += b.n;
      x.usd += b.usd;
    }
  }
  return out;
}

export interface LedgerState {
  files: Record<string, number>;
  rows: Record<string, SessionRow>;
  sessions: Record<string, LedgerSession>;
}

// loaded: state.owners holds the whole key set
export interface ReportIndex {
  claudeDir: string;
  state: IndexState;
  ledger: LedgerState;
  order: string[];
  keys: { n: number; stamp: number };
  loaded: boolean;
  // zone the ledger days were cut in
  ledgerTz: string;
  // entries read from index.json; keys of any other path are released
  known?: Set<string>;
}

const INDEX = 'index.json';
const OLD_KEYS = 'keys.bin';
const KEYS_RE = /^keys-[0-9a-f]{8}\.bin$/;
const ORPHAN_MS = 600_000;

// named by stamp, so a crash leaves the pair index.json names
const keysFile = (stamp: number) => `keys-${stamp.toString(16).padStart(8, '0')}.bin`;
const MAGIC = 'CCRK';
const HEAD = 16;
const ENTRY = 12;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const KINDS: ReadonlySet<unknown> = new Set(['main', 'agent', 'aside']);
const SEGMENTS = 16;

export function dirKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  const d = dir.normalize('NFC');
  return platform === 'win32' ? d.toLowerCase() : d;
}

export function indexDir(env: NodeJS.ProcessEnv = process.env): string {
  const h = createHash('sha256')
    .update(dirKey(path.resolve(claudeDir(env))))
    .digest('hex')
    .slice(0, 16);
  return path.join(cacheDir(env), 'report', h);
}

export function emptyLedger(): LedgerState {
  return { files: map(), rows: map(), sessions: map() };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;
const REQ = ['in', 'out', 'cr', 'w5', 'w1'] as const;

function numMap(v: unknown, key: RegExp): Record<string, number> | null {
  if (!isObj(v)) return null;
  const out = map<number>();
  for (const [k, n] of Object.entries(v)) {
    if (!key.test(k) || !fin(n)) return null;
    out[k] = n;
  }
  return out;
}

function bucketOf(v: unknown): Bucket | null {
  if (!isObj(v) || !fin(v.n) || !fin(v.usd)) return null;
  const b = zero();
  for (const k of REQ) {
    const n = v[k];
    if (!fin(n)) return null;
    b[k] = n;
  }
  b.n = v.n;
  b.usd = v.usd;
  return b;
}

function recentOf(v: unknown): RecentReq | null {
  if (!isObj(v) || !uint(v.k) || !str(v.b, 400) || !(v.usd === null || fin(v.usd))) return null;
  const r: RecentReq = { k: v.k, b: v.b, in: 0, out: 0, cr: 0, w5: 0, w1: 0, usd: v.usd };
  for (const k of REQ) {
    const n = v[k];
    if (!fin(n)) return null;
    r[k] = n;
  }
  return r;
}

function entryOf(v: unknown): FileEntry | null {
  if (!isObj(v) || !KINDS.has(v.kind) || !str(v.sid, 128) || !str(v.enc)) return null;
  if (!(v.id === null || str(v.id, 100)) || !(v.cwd === null || str(v.cwd))) return null;
  if (!uint(v.size) || !fin(v.mtimeMs) || !uint(v.offset) || !str(v.tail, 16)) return null;
  if (typeof v.gone !== 'boolean' || !(v.lastTs === null || fin(v.lastTs)) || !fin(v.horizon)) return null;
  if (!uint(v.skipped) || !isObj(v.buckets) || !Array.isArray(v.recent) || v.recent.length > RECENT)
    return null;
  if (!(v.first === undefined || v.first === null || fin(v.first))) return null;
  if (!(v.born === undefined || fin(v.born)) || !(v.lost === undefined || typeof v.lost === 'boolean'))
    return null;
  if (!(v.tz === undefined || str(v.tz, 100)) || !(v.shown === undefined || v.shown === null || str(v.shown)))
    return null;
  const buckets = map<Bucket>();
  for (const [k, b] of Object.entries(v.buckets)) {
    const x = bucketOf(b);
    if (!x || k.length > 400) return null;
    buckets[k] = x;
  }
  const time = numMap(v.time, DAY_KEY);
  if (!time) return null;
  const recent: RecentReq[] = [];
  for (const r of v.recent) {
    const x = recentOf(r);
    if (!x) return null;
    recent.push(x);
  }
  return {
    kind: v.kind as FileKind,
    sid: v.sid,
    enc: v.enc,
    id: v.id,
    size: v.size,
    mtimeMs: v.mtimeMs,
    offset: v.offset,
    tail: v.tail,
    gone: v.gone,
    cwd: v.cwd,
    buckets,
    time,
    lastTs: v.lastTs,
    horizon: v.horizon,
    recent,
    skipped: v.skipped,
    first: (v.first ?? null) as number | null,
    born: (v.born ?? 0) as number,
    lost: v.lost === true,
    tz: (v.tz ?? '') as string,
    shown: (v.shown ?? null) as string | null,
  };
}

function ledgerOf(v: unknown): LedgerState | null {
  if (!isObj(v) || !isObj(v.files) || !isObj(v.sessions)) return null;
  const lg = emptyLedger();
  for (const [k, n] of Object.entries(v.files)) {
    if (!MONTH_KEY.test(k) || !uint(n)) return null;
    lg.files[k] = n;
  }
  for (const [sid, r] of Object.entries(v.sessions)) {
    if (!SID.test(sid) || !isObj(r) || !Array.isArray(r.h) || !fin(r.seen)) return null;
    if (!r.h.length || r.h.length > SEGMENTS || !r.h.every(fin)) return null;
    lg.rows[sid] = { h: [...r.h], seen: r.seen };
    if (r.a === undefined) continue;
    const days = numMap(r.days, DAY_KEY);
    if (!str(r.a, 80) || !str(r.p) || !fin(r.first) || !fin(r.firstT) || !fin(r.total) || !days) return null;
    lg.sessions[sid] = { a: r.a, p: r.p, first: r.first, firstT: r.firstT, total: r.total, days };
  }
  return lg;
}

const NO_KEYS = { n: -1, stamp: 0 };

// null only for an unreadable or foreign index; bad parts are dropped one by one
export function loadIndex(
  dir: string,
  root?: string,
  platform: NodeJS.Platform = process.platform,
): ReportIndex | null {
  const raw = readJsonSafe<unknown>(path.join(dir, INDEX));
  if (!isObj(raw) || raw.v !== 1 || !str(raw.claudeDir) || !isObj(raw.files)) return null;
  if (root !== undefined && dirKey(raw.claudeDir, platform) !== dirKey(root, platform)) return null;
  const keys = raw.keys;
  const order = raw.order;
  const keysOk =
    isObj(keys) && uint(keys.n) && uint(keys.stamp) && Array.isArray(order) && order.every((o) => str(o));
  const state = emptyState();
  const known = new Set<string>();
  for (const [rel, v] of Object.entries(raw.files)) {
    const f = entryOf(v);
    if (!f || !rel.startsWith('projects/')) continue;
    state.files[rel] = f;
    known.add(rel);
  }
  return {
    claudeDir: raw.claudeDir,
    state,
    ledger: ledgerOf(raw.ledger) ?? emptyLedger(),
    order: keysOk ? (order as string[]) : [],
    keys: keysOk ? { n: keys.n as number, stamp: keys.stamp as number } : { ...NO_KEYS },
    loaded: false,
    ledgerTz: str(raw.ledgerTz, 100) ? raw.ledgerTz : '',
    known,
  };
}

export function loadKeys(dir: string, idx: ReportIndex): Map<number, string> | null {
  if (idx.keys.n < 0) return null;
  try {
    const b = fs.readFileSync(path.join(dir, keysFile(idx.keys.stamp)));
    if (b.length < HEAD || b.toString('latin1', 0, 4) !== MAGIC || b.readUInt32LE(4) !== 1) return null;
    const n = b.readUInt32LE(8);
    if (n !== idx.keys.n || b.readUInt32LE(12) !== idx.keys.stamp || b.length !== HEAD + n * ENTRY)
      return null;
    const owners = new Map<number, string>();
    const known = idx.known;
    for (let i = 0, o = HEAD; i < n; i++, o += ENTRY) {
      const k = b.readDoubleLE(o);
      const rel = idx.order[b.readUInt32LE(o + 8)];
      if (rel === undefined || !Number.isSafeInteger(k) || k < 0) return null;
      if (!known || known.has(rel)) owners.set(k, rel);
    }
    return owners;
  } catch {
    return null;
  }
}

function keysBuffer(idx: ReportIndex): Buffer {
  const owners = idx.state.owners;
  const order: string[] = [];
  const at = new Map<string, number>();
  const stamp = Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
  const b = Buffer.alloc(HEAD + owners.size * ENTRY);
  b.write(MAGIC, 0, 'latin1');
  b.writeUInt32LE(1, 4);
  b.writeUInt32LE(owners.size, 8);
  b.writeUInt32LE(stamp, 12);
  let o = HEAD;
  for (const [k, rel] of owners) {
    let i = at.get(rel);
    if (i === undefined) {
      i = order.length;
      order.push(rel);
      at.set(rel, i);
    }
    b.writeDoubleLE(k, o);
    b.writeUInt32LE(i, o + 8);
    o += ENTRY;
  }
  idx.order = order;
  idx.keys = { n: owners.size, stamp };
  return b;
}

// old key files; a fresh one may belong to a concurrent run
function dropKeys(dir: string, keep: string, prev: string): void {
  const now = Date.now();
  for (const { name } of list(dir)) {
    if (name === keep || !(name === OLD_KEYS || KEYS_RE.test(name))) continue;
    const file = path.join(dir, name);
    try {
      if (name !== prev && name !== OLD_KEYS && now - fs.statSync(file).mtimeMs < ORPHAN_MS) continue;
      fs.unlinkSync(file);
    } catch {}
  }
}

// the key file first; index.json names its stamp, older key files go after
export function saveIndex(dir: string, idx: ReportIndex, now = Date.now()): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const prev = idx.keys.n < 0 ? '' : keysFile(idx.keys.stamp);
    if (idx.loaded) {
      const buf = keysBuffer(idx);
      if (!writeAtomic(path.join(dir, keysFile(idx.keys.stamp)), buf, { mode: 0o600 })) return false;
    }
    const sessions = map<Obj>();
    for (const [sid, row] of Object.entries(idx.ledger.rows)) {
      sessions[sid] = { h: row.h, seen: row.seen, ...idx.ledger.sessions[sid] };
    }
    const out = {
      v: 1,
      claudeDir: idx.claudeDir,
      at: now,
      keys: idx.keys,
      order: idx.order,
      files: idx.state.files,
      ledger: { files: idx.ledger.files, sessions },
      ledgerTz: idx.ledgerTz,
    };
    const ok = writeAtomic(path.join(dir, INDEX), JSON.stringify(out), { mode: 0o600 });
    if (ok && idx.loaded) dropKeys(dir, keysFile(idx.keys.stamp), prev);
    return ok;
  } catch {
    return false;
  }
}

const LEDGER_CHUNK = 1024 * 1024;
const LEDGER_LINE = 64 * 1024;

// complete lines from the stored offset, as ledger.ts advance
function foldMonth(
  lg: LedgerState,
  file: string,
  key: string,
  on: (c: Credited) => void,
  stepText: LedgerDeps['stepText'],
) {
  let fd: number | null = null;
  let bytes = 0;
  try {
    const size = fs.statSync(file).size;
    const from = lg.files[key] ?? 0;
    if (from > size) return { bytes, shrank: true };
    if (from === size) return { bytes, shrank: false };
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(Math.min(LEDGER_CHUNK, size - from));
    let carry = EMPTY;
    let pos = from;
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      bytes += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const last = data.lastIndexOf(10);
      if (last >= 0) stepText(lg.rows, data.toString('utf8', 0, last + 1), on);
      carry = Buffer.from(data.subarray(last + 1));
      // skip a junk run with no newline
      if (carry.length > LEDGER_LINE) carry = EMPTY;
      lg.files[key] = pos - carry.length;
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return { bytes, shrank: false };
}

function pruneLedgerState(lg: LedgerState, now: number): boolean {
  const keep = keepFrom(now);
  let cut = false;
  for (const [sid, s] of Object.entries(lg.sessions)) {
    for (const d in s.days) {
      if (d < keep.day) {
        delete s.days[d];
        cut = true;
      }
    }
    if (s.firstT < keep.ms && !Object.keys(s.days).length) {
      delete lg.sessions[sid];
      cut = true;
    }
  }
  for (const [sid, r] of Object.entries(lg.rows)) {
    if (r.seen < keep.ms && !lg.sessions[sid]) {
      delete lg.rows[sid];
      cut = true;
    }
  }
  return cut;
}

// month files oldest first, so a session crossing months keeps its highs
export function foldLedger(
  env: NodeJS.ProcessEnv,
  start: LedgerState,
  deps: LedgerDeps,
  now = Date.now(),
): { ledger: LedgerState; changed: boolean; bytes: number } {
  const dir = deps.ledgerDir(env);
  const accounts = deps.accountKeysForDir(env);
  const months = deps.monthFiles(dir);
  let lg = start;
  let changed = false;
  let bytes = 0;
  const on = (c: Credited) => {
    if (!accounts.has(c.a)) return;
    let s = lg.sessions[c.s];
    if (!s) {
      s = { a: c.a, p: c.p, first: c.c, firstT: c.t, total: 0, days: map() };
      lg.sessions[c.s] = s;
    }
    if (!(c.delta > 0)) return;
    s.total += c.delta;
    const d = dayKey(c.t);
    s.days[d] = (s.days[d] ?? 0) + c.delta;
  };
  for (let pass = 0; pass < 2; pass++) {
    let shrank = false;
    for (const key of months) {
      const r = foldMonth(lg, path.join(dir, `${key}.jsonl`), key, on, deps.stepText);
      bytes += r.bytes;
      if (r.bytes > 0) changed = true;
      if (r.shrank) {
        shrank = true;
        break;
      }
    }
    if (!shrank) break;
    // a rewritten month on old highs would double count
    lg = emptyLedger();
    changed = true;
  }
  const present = new Set(months);
  for (const k in lg.files) {
    if (!present.has(k)) {
      delete lg.files[k];
      changed = true;
    }
  }
  if (pruneLedgerState(lg, now)) changed = true;
  return { ledger: lg, changed, bytes };
}

export interface ReportOpts {
  rebuild?: boolean;
  now?: number;
  onProgress?: (files: number, bytes: number) => void;
  maxFiles?: number;
  maxLine?: number;
}

export function timeZone(): string {
  try {
    return new Intl.DateTimeFormat('en-US').resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

// never writes the ledger or its summary
export function readReportData(env: NodeJS.ProcessEnv, deps: LedgerDeps, opts: ReportOpts = {}): ScanResult {
  const root = path.resolve(claudeDir(env));
  const now = opts.now ?? Date.now();
  const dir = indexDir(env);
  const tz = timeZone();
  const idx: ReportIndex = loadIndex(dir, root) ?? {
    claudeDir: root,
    state: emptyState(),
    ledger: emptyLedger(),
    order: [],
    keys: { n: 0, stamp: 0 },
    loaded: true,
    ledgerTz: tz,
  };
  const scan = scanTree(root, idx.state, {
    maxLine: opts.maxLine,
    maxFiles: opts.maxFiles,
    onProgress: opts.onProgress,
    rebuild: opts.rebuild,
    now,
    loadOwners: idx.loaded ? undefined : () => loadKeys(dir, idx),
    tz,
  });
  idx.state = scan.state;
  idx.loaded ||= scan.keysLoaded;
  const rezone = idx.ledgerTz !== tz;
  const lg = foldLedger(env, opts.rebuild || rezone ? emptyLedger() : idx.ledger, deps, now);
  idx.ledger = lg.ledger;
  idx.ledgerTz = tz;
  if (scan.changed || lg.changed || rezone || opts.rebuild) saveIndex(dir, idx, now);
  let ledgerSince: number | null = null;
  for (const s of Object.values(lg.ledger.sessions)) {
    if (ledgerSince === null || s.firstT < ledgerSince) ledgerSince = s.firstT;
  }
  const notes = [...scan.notes];
  const gone = notes.find((n) => n.code === 'deleted-transcripts');
  if (opts.rebuild && gone) notes.push({ code: 'rebuild-kept', count: gone.count });
  return {
    claudeDir: root,
    sessions: sessionsOf(scan.state),
    ledger: lg.ledger.sessions,
    ledgerSince,
    notes,
    files: scan.files,
    bytesRead: scan.bytesRead + lg.bytes,
  };
}
