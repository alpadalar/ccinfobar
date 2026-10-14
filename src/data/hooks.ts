import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import { readJsonSafe, writeAtomic } from './store.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PermissionRequest',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface HookLine {
  v: 1;
  t: number;
  e: HookEvent;
  p?: string;
  sa?: boolean;
  a?: string;
  at?: string;
  tp?: string;
  n?: string;
  tn?: string;
  s?: string;
}

type StrKey = 'p' | 'a' | 'at' | 'tp' | 'n' | 'tn' | 's';

// stored key, stdin key, cap
const FIELDS: Record<HookEvent, Array<[StrKey, string, number]>> = {
  SessionStart: [['s', 'source', 256]],
  UserPromptSubmit: [['p', 'prompt_id', 256]],
  Stop: [['p', 'prompt_id', 256]],
  SubagentStart: [
    ['a', 'agent_id', 256],
    ['at', 'agent_type', 256],
  ],
  SubagentStop: [
    ['a', 'agent_id', 256],
    ['at', 'agent_type', 256],
    ['tp', 'agent_transcript_path', 1024],
  ],
  Notification: [['n', 'notification_type', 256]],
  PermissionRequest: [['tn', 'tool_name', 256]],
};

const EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS);

export function isHookEvent(x: unknown): x is HookEvent {
  return typeof x === 'string' && EVENT_SET.has(x);
}

export function hookLine(event: HookEvent, input: Record<string, unknown>, now: number): HookLine {
  const line: HookLine = { v: 1, t: now, e: event };
  for (const [key, src, cap] of FIELDS[event]) {
    const v = input[src];
    if (typeof v === 'string') line[key] = sanitizeText(v).slice(0, cap);
  }
  if (event === 'Stop' && typeof input.stop_hook_active === 'boolean') line.sa = input.stop_hook_active;
  return line;
}

export function hooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'hooks');
}

export function hookLogPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  return path.join(hooksDir(env), `${sessionId}.jsonl`);
}

export interface HookAgent {
  type: string | null;
  start: number | null;
  end: number | null;
  transcript: string | null;
}

export interface HookTurn {
  promptId: string | null;
  start: number | null;
  end: number | null;
  durationMs: number | null;
}

export interface HookState {
  lastEventAt: number | null;
  lastSource: string | null;
  turn: HookTurn | null;
  pendingPermission: { since: number; tool: string | null } | null;
  agents: Record<string, HookAgent>;
}

export const DUP_WINDOW_MS = 2000;
const FOLD_VERSION = 1;
const MAX_TURNS = 50;
const MAX_AGENTS = 100;
const MAX_SEEN = 512;
const MAX_LINE = 64 * 1024;
const CHUNK = 1024 * 1024;
const BAD_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const CAPS: Record<StrKey, number> = { p: 256, a: 256, at: 256, tp: 1024, n: 256, tn: 256, s: 256 };

interface Span {
  start: number | null;
  end: number | null;
}

type Agent = HookAgent;

interface Fold {
  turns: Map<string, Span>;
  loose: Span[];
  agents: Map<string, Agent>;
  seen: Map<string, number>;
  pending: { since: number; tool: string | null } | null;
  clearAt: number | null;
  lastEventAt: number | null;
  lastSource: string | null;
  sourceAt: number | null;
}

function emptyFold(): Fold {
  return {
    turns: new Map(),
    loose: [],
    agents: new Map(),
    seen: new Map(),
    pending: null,
    clearAt: null,
    lastEventAt: null,
    lastSource: null,
    sourceAt: null,
  };
}

const lo = (a: number | null, b: number) => (a === null || b < a ? b : a);
const hi = (a: number | null, b: number) => (a === null || b > a ? b : a);
const rank = (x: Span) => x.start ?? x.end ?? Number.NEGATIVE_INFINITY;

function trim<T extends Span>(m: Map<string, T>, cap: number) {
  while (m.size > cap) {
    let oldKey: string | null = null;
    let old = Number.POSITIVE_INFINITY;
    for (const [k, v] of m) {
      const r = rank(v);
      if (r < old) {
        old = r;
        oldKey = k;
      }
    }
    if (oldKey === null) return;
    m.delete(oldKey);
  }
}

function dedupe(f: Fold, key: string, t: number): boolean {
  for (const [k, at] of f.seen) if (at < t - DUP_WINDOW_MS) f.seen.delete(k);
  const prev = f.seen.get(key);
  if (prev !== undefined && Math.abs(t - prev) <= DUP_WINDOW_MS) return true;
  f.seen.delete(key);
  f.seen.set(key, t);
  if (f.seen.size > MAX_SEEN) {
    const first = f.seen.keys().next();
    if (!first.done) f.seen.delete(first.value);
  }
  return false;
}

function clearPending(f: Fold, t: number) {
  f.clearAt = hi(f.clearAt, t);
  if (f.pending && t >= f.pending.since) f.pending = null;
}

function setPending(f: Fold, t: number, tool: string | null) {
  if (f.clearAt !== null && t <= f.clearAt) return;
  if (f.pending) {
    f.pending.since = Math.min(f.pending.since, t);
    if (tool) f.pending.tool = tool;
  } else f.pending = { since: t, tool };
}

function agent(f: Fold, id: string): Agent {
  let a = f.agents.get(id);
  if (!a) {
    a = { type: null, start: null, end: null, transcript: null };
    f.agents.set(id, a);
  }
  return a;
}

function turn(f: Fold, p: string): Span {
  let x = f.turns.get(p);
  if (!x) {
    x = { start: null, end: null };
    f.turns.set(p, x);
  }
  return x;
}

function looseStart(f: Fold, t: number) {
  let hit: Span | null = null;
  for (const x of f.loose)
    if (x.start === null && x.end !== null && x.end >= t && (!hit || x.end < (hit.end ?? 0))) hit = x;
  if (hit) hit.start = t;
  else f.loose.push({ start: t, end: null });
  if (f.loose.length > MAX_TURNS)
    f.loose.sort((a, b) => rank(a) - rank(b)).splice(0, f.loose.length - MAX_TURNS);
}

function looseStop(f: Fold, t: number) {
  let hit: Span | null = null;
  for (const x of f.loose)
    if (x.start !== null && x.start <= t && (!hit || x.start > (hit.start ?? 0))) hit = x;
  if (hit) hit.end = hi(hit.end, t);
  else {
    f.loose.push({ start: null, end: t });
    if (f.loose.length > MAX_TURNS)
      f.loose.sort((a, b) => rank(a) - rank(b)).splice(0, f.loose.length - MAX_TURNS);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: parsed JSONL
function step(f: Fold, x: any) {
  if (x.v !== 1 || !isHookEvent(x.e) || typeof x.t !== 'number' || !Number.isFinite(x.t)) return;
  const e: HookEvent = x.e;
  const t: number = x.t;
  const v: Partial<Record<StrKey, string>> = {};
  for (const k of Object.keys(CAPS) as StrKey[]) {
    const raw = x[k];
    if (raw === undefined) continue;
    if (typeof raw !== 'string') return;
    v[k] = sanitizeText(raw).slice(0, CAPS[k]);
  }
  if ((v.p !== undefined && BAD_IDS.has(v.p)) || (v.a !== undefined && BAD_IDS.has(v.a))) return;
  if (dedupe(f, `${e}|${v.p ?? ''}|${v.a ?? ''}|${v.tn ?? ''}|${v.n ?? ''}`, t)) return;
  f.lastEventAt = hi(f.lastEventAt, t);
  switch (e) {
    case 'SessionStart':
      if (f.sourceAt === null || t >= f.sourceAt) {
        f.sourceAt = t;
        f.lastSource = v.s ?? null;
      }
      clearPending(f, t);
      break;
    case 'UserPromptSubmit':
      if (v.p) {
        const u = turn(f, v.p);
        u.start = lo(u.start, t);
        trim(f.turns, MAX_TURNS);
      } else looseStart(f, t);
      clearPending(f, t);
      break;
    case 'Stop':
      if (v.p) {
        const u = turn(f, v.p);
        u.end = hi(u.end, t);
        trim(f.turns, MAX_TURNS);
      } else looseStop(f, t);
      clearPending(f, t);
      break;
    case 'SubagentStart':
    case 'SubagentStop': {
      if (!v.a) return;
      const a = agent(f, v.a);
      if (v.at) a.type = v.at;
      if (e === 'SubagentStart') a.start = lo(a.start, t);
      else {
        a.end = hi(a.end, t);
        if (v.tp) a.transcript = v.tp;
      }
      trim(f.agents, MAX_AGENTS);
      break;
    }
    case 'Notification':
      if (v.n === 'permission_prompt') setPending(f, t, null);
      break;
    case 'PermissionRequest':
      setPending(f, t, v.tn ?? null);
      break;
  }
}

function applyText(f: Fold, text: string) {
  if (!text || text.length > MAX_LINE) return;
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return;
  }
  if (x && typeof x === 'object' && !Array.isArray(x)) step(f, x);
}

function toState(f: Fold): HookState {
  let best: { p: string | null; s: Span } | null = null;
  for (const [p, s] of f.turns) if (!best || rank(s) >= rank(best.s)) best = { p, s };
  for (const s of f.loose) if (!best || rank(s) >= rank(best.s)) best = { p: null, s };
  const agents: Record<string, HookAgent> = Object.create(null);
  for (const [id, a] of f.agents)
    agents[id] = { type: a.type, start: a.start, end: a.end, transcript: a.transcript };
  const s = best?.s;
  return {
    lastEventAt: f.lastEventAt,
    lastSource: f.lastSource,
    turn:
      best && s
        ? {
            promptId: best.p,
            start: s.start,
            end: s.end,
            durationMs: s.start !== null && s.end !== null && s.end >= s.start ? s.end - s.start : null,
          }
        : null,
    pendingPermission: f.pending ? { since: f.pending.since, tool: f.pending.tool } : null,
    agents,
  };
}

export function foldHookLog(lines: Iterable<string>): HookState {
  const f = emptyFold();
  for (const line of lines) if (typeof line === 'string') applyText(f, line);
  return toState(f);
}

// serialized fold
type Num = number | null;
type Str = string | null;
interface Saved {
  turns: [string, Num, Num][];
  loose: [Num, Num][];
  agents: [string, Str, Num, Num, Str][];
  seen: [string, number][];
  pending: { since: number; tool: Str } | null;
  clearAt: Num;
  lastEventAt: Num;
  lastSource: Str;
  sourceAt: Num;
}

function save(f: Fold): Saved {
  return {
    turns: [...f.turns].map(([p, s]) => [p, s.start, s.end]),
    loose: f.loose.map((s) => [s.start, s.end]),
    agents: [...f.agents].map(([id, a]) => [id, a.type, a.start, a.end, a.transcript]),
    seen: [...f.seen],
    pending: f.pending,
    clearAt: f.clearAt,
    lastEventAt: f.lastEventAt,
    lastSource: f.lastSource,
    sourceAt: f.sourceAt,
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): Num => (isNum(v) ? v : null);
const str = (v: unknown): Str => (typeof v === 'string' ? v : null);
const rows = (v: unknown): unknown[][] =>
  Array.isArray(v) ? v.filter((r): r is unknown[] => Array.isArray(r)) : [];
const id = (v: unknown): v is string => typeof v === 'string' && v !== '' && !BAD_IDS.has(v);

// biome-ignore lint/suspicious/noExplicitAny: cache file
function load(s: any): Fold {
  const f = emptyFold();
  if (!s || typeof s !== 'object') return f;
  for (const [p, a, b] of rows(s.turns)) if (id(p)) f.turns.set(p, { start: num(a), end: num(b) });
  for (const [a, b] of rows(s.loose)) f.loose.push({ start: num(a), end: num(b) });
  for (const [k, ty, a, b, tp] of rows(s.agents))
    if (id(k)) f.agents.set(k, { type: str(ty), start: num(a), end: num(b), transcript: str(tp) });
  for (const [k, t] of rows(s.seen)) if (typeof k === 'string' && isNum(t)) f.seen.set(k, t);
  trim(f.turns, MAX_TURNS);
  trim(f.agents, MAX_AGENTS);
  f.loose.splice(0, Math.max(0, f.loose.length - MAX_TURNS));
  const pd = s.pending;
  if (pd && typeof pd === 'object' && isNum(pd.since)) f.pending = { since: pd.since, tool: str(pd.tool) };
  f.clearAt = num(s.clearAt);
  f.lastEventAt = num(s.lastEventAt);
  f.lastSource = str(s.lastSource);
  f.sourceAt = num(s.sourceAt);
  return f;
}

interface FoldCache {
  v: number;
  offset: number;
  ino?: number;
  state: unknown;
}

const isCache = (v: unknown): v is FoldCache =>
  !!v &&
  typeof v === 'object' &&
  (v as FoldCache).v === FOLD_VERSION &&
  Number.isSafeInteger((v as FoldCache).offset) &&
  (v as FoldCache).offset >= 0;

function advance(f: Fold, fd: number, from: number, size: number): number {
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size - from, 1)));
  let carry = Buffer.alloc(0);
  let pos = from;
  let offset = from;
  while (pos < size) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    if (n <= 0) break;
    pos += n;
    const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    let start = 0;
    let nl = data.indexOf(10, start);
    while (nl !== -1) {
      if (nl > start) applyText(f, data.toString('utf8', start, nl));
      start = nl + 1;
      nl = data.indexOf(10, start);
    }
    carry = Buffer.from(data.subarray(start));
    offset = pos - carry.length;
  }
  return offset;
}

export function readHookState(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { persist?: boolean } = {},
): HookState | null {
  const file = hookLogPath(sessionId, env);
  if (!file) return null;
  let fd: number | null = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const size = st.size;
    const cacheFile = path.join(hooksDir(env), `${sessionId}.fold.json`);
    const cached = readJsonSafe(cacheFile, isCache);
    const fresh = !cached || cached.offset > size || (cached.ino !== undefined && cached.ino !== st.ino);
    const f = fresh ? emptyFold() : load(cached.state);
    let offset = fresh ? 0 : cached.offset;
    if (offset < size) {
      fd = fs.openSync(file, 'r');
      const before = offset;
      offset = advance(f, fd, offset, size);
      if ((offset !== before || fresh) && opts.persist !== false)
        writeAtomic(cacheFile, JSON.stringify({ v: FOLD_VERSION, offset, ino: st.ino, state: save(f) }), {
          mode: 0o600,
          class: 'cache',
        });
    }
    return toState(f);
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
