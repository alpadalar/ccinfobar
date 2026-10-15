import fs from 'node:fs';
import path from 'node:path';
import {
  type Bucket,
  type FileEntry,
  type FileKind,
  IDLE_CAP_MS,
  type IndexState,
  MAX_REPORT_FILES,
  MAX_REPORT_LINE,
  type RecentReq,
  type ScanNote,
  type SessionData,
} from '../core/report-types.js';
import { sanitizeText } from '../core/sanitize.js';
import { dayKey } from '../core/time.js';
import { normalizeRoot } from './ledger.js';

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
const BIG = 100_000;

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
  if (msg.id === undefined && e.requestId === undefined) {
    addTo(f, b, r, 1);
    return;
  }
  const k = keyHash(`${msg.id ?? ''}:${e.requestId ?? ''}`);
  const owner = st.owners.get(k);
  if (owner === undefined) {
    st.owners.set(k, rel);
    addTo(f, b, r, 1);
    f.recent.push({ k, b, ...r });
    if (f.recent.length > RECENT) f.recent.shift();
    return;
  }
  if (owner !== rel) {
    // copies of another session's main file form this file's prefix
    if (ts !== null && ts >= f.horizon && e.isSidechain !== true && st.files[owner]?.kind === 'main') {
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
    if (typeof cwd === 'string' && cwd && path.isAbsolute(cwd)) f.cwd = normalizeRoot(cwd);
  } else if (line.includes('"usage"') && line.includes('"type":"assistant"')) {
    e = parse(line);
  }
  let ts: number | null;
  let side: boolean;
  if (e) {
    const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
    ts = Number.isNaN(t) ? null : t;
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

function readFile(sc: Scan, abs: string, size: number, maxLine: number): number {
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
      // a line over the cap is dropped up to its newline
      if (skipping || data.length - start > maxLine) {
        skipping = true;
        carry = Buffer.alloc(0);
      } else carry = Buffer.from(data.subarray(start));
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

export function scanTree(
  claudeDir: string,
  state: IndexState | null,
  opts: { maxLine?: number; maxFiles?: number; onProgress?: (files: number, bytes: number) => void } = {},
): { state: IndexState; notes: ScanNote[]; bytesRead: number } {
  const st = state ?? emptyState();
  const maxLine = opts.maxLine ?? MAX_REPORT_LINE;
  const { files, capped } = walkTranscripts(claudeDir, opts.maxFiles);
  const todo: { w: WalkedFile; f: FileEntry; size: number }[] = [];
  for (const w of files) {
    let s: fs.Stats;
    try {
      s = fs.statSync(w.abs);
    } catch {
      continue;
    }
    let f = st.files[w.rel];
    if (!f) {
      f = newEntry(w);
      st.files[w.rel] = f;
    }
    f.gone = false;
    f.mtimeMs = s.mtimeMs;
    if (s.size > f.offset) todo.push({ w, f, size: s.size });
    else f.size = s.size;
  }
  todo.sort((a, b) => a.f.mtimeMs - b.f.mtimeMs || (a.w.rel < b.w.rel ? -1 : a.w.rel > b.w.rel ? 1 : 0));
  let bytesRead = 0;
  let done = 0;
  for (const { w, f, size } of todo) {
    bytesRead += readFile({ st, rel: w.rel, f }, w.abs, size, maxLine);
    f.size = size;
    opts.onProgress?.(++done, bytesRead);
  }
  const notes: ScanNote[] = [];
  if (capped) notes.push({ code: 'file-cap', count: files.length });
  let skipped = 0;
  for (const f of Object.values(st.files)) skipped += f.skipped;
  if (skipped > 0) notes.push({ code: 'line-skipped', count: skipped });
  return { state: st, notes, bytesRead };
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
        cwdFrom[f.sid] = true;
      }
      for (const [d, ms] of Object.entries(f.time)) s.time[d] = (s.time[d] ?? 0) + ms;
    } else if (s.cwd === null) s.cwd = f.cwd;
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
