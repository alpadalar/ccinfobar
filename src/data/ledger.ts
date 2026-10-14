import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../core/paths.js';
import type { Config, StatusPayload } from '../core/types.js';
import { accountKey } from './limits.js';
import { appendLine, readJsonSafe, writeAtomic } from './store.js';

export interface LedgerLine {
  v: 1;
  t: number;
  a: string;
  s: string;
  p: string;
  // Phase 9 rebuild input
  tp: string;
  c: number;
}

export interface SessionRow {
  h: number[];
  seen: number;
}

type DayRows = Record<string, number>;

export interface Summary {
  v: 1;
  files: Record<string, number>;
  sessions: Record<string, SessionRow>;
  days: Record<string, DayRows>;
  projects: Record<string, Record<string, DayRows>>;
  since: Record<string, number>;
  at: number;
  built: boolean;
}

export interface LedgerRead {
  summary: Summary;
  moved: boolean;
  more: boolean;
}

export interface LedgerView {
  today: number;
  week: number;
  month: number;
  project: { today: number; week: number; month: number; all: number };
  since: number | null;
  at: number | null;
  partial: boolean;
}

const ZERO = 0.005;
const SEGMENTS = 4;
const MAX_COST = 1e6;
const MAX_PROJECT = 1024;
const CHUNK = 1024 * 1024;
export const BYTE_BUDGET = 16 * 1024 * 1024;
export const RENDER_BUDGET = 256 * 1024;
const MAX_LINE = 64 * 1024;
const KEEP_MONTHS = 13;
const KEEP_DAYS = 400;
const KEEP_SESSION_DAYS = 30;
const DAY_MS = 86_400_000;
export const LEDGER_FILE = /^\d{4}-\d{2}\.jsonl$/;
const ID = /^[\w-]{1,80}$/;
const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const LEDGER_TYPES: ReadonlySet<string> = new Set(['cost-today', 'cost-week', 'cost-project']);

const map = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const costOk = (v: unknown): v is number => num(v) && v >= 0 && v <= MAX_COST;
const idOk = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && !BAD_KEYS.has(v);
const projectOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_PROJECT && !BAD_KEYS.has(v);

// segmented high-water fold (D-43); most recently updated first
export function credit(highs: number[] | undefined, c: number): { highs: number[]; delta: number } {
  if (!highs) return { highs: [c], delta: 0 };
  let best = -1;
  for (let i = 0; i < highs.length; i++)
    if (highs[i]! <= c && (best < 0 || highs[i]! > highs[best]!)) best = i;
  if (best >= 0) {
    const delta = c - highs[best]!;
    return { highs: [c, ...highs.filter((_, i) => i !== best)], delta };
  }
  const delta = c <= ZERO ? c : 0;
  return { highs: [c, ...highs].slice(0, SEGMENTS), delta };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function projectRoot(payload: StatusPayload, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const raw =
    payload.workspace?.project_dir || payload.workspace?.current_dir || payload.cwd || process.cwd();
  let root = p.resolve(raw);
  while (root.length > 1 && /[\\/]$/.test(root) && p.dirname(root) !== root) root = root.slice(0, -1);
  return (platform === 'win32' ? root.toLowerCase() : root).slice(0, MAX_PROJECT);
}

export function emptySummary(): Summary {
  return {
    v: 1,
    files: map(),
    sessions: map(),
    days: map(),
    projects: map(),
    since: map(),
    at: 0,
    built: false,
  };
}

function child<T>(m: Record<string, Record<string, T>>, key: string): Record<string, T> {
  let v = m[key];
  if (!v) {
    v = map<T>();
    m[key] = v;
  }
  return v;
}

function add(rows: DayRows, day: string, delta: number): void {
  rows[day] = (rows[day] ?? 0) + delta;
}

function foldLine(s: Summary, text: string): void {
  let e: Partial<LedgerLine>;
  try {
    e = JSON.parse(text) as Partial<LedgerLine>;
  } catch {
    return;
  }
  if (!e || typeof e !== 'object' || e.v !== 1) return;
  if (!num(e.t) || e.t <= 0 || !costOk(e.c) || !idOk(e.s) || !idOk(e.a) || !projectOk(e.p)) return;
  const row = s.sessions[e.s];
  const { highs, delta } = credit(row?.h, e.c);
  s.sessions[e.s] = { h: highs, seen: Math.max(row?.seen ?? 0, e.t) };
  s.since[e.a] = Math.min(s.since[e.a] ?? e.t, e.t);
  if (!(delta > 0)) return;
  const day = dayKey(e.t);
  add(child(s.days, e.a), day, delta);
  add(child(child(s.projects, e.a), e.p), day, delta);
}

// complete lines only; a torn tail waits for its newline
export function foldText(summary: Summary, text: string): void {
  const end = text.lastIndexOf('\n');
  let start = 0;
  while (start <= end) {
    const nl = text.indexOf('\n', start);
    if (nl > start) foldLine(summary, text.slice(start, nl));
    start = nl + 1;
  }
}

function dayRows(v: unknown): DayRows {
  const out = map<number>();
  if (!v || typeof v !== 'object') return out;
  for (const [k, n] of Object.entries(v)) if (DAY.test(k) && costOk(n)) out[k] = n;
  return out;
}

function parseSummary(raw: unknown): Summary {
  const s = emptySummary();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return s;
  const obj = (v: unknown) => (v && typeof v === 'object' ? Object.entries(v) : []);
  for (const [k, n] of obj(r.files))
    if (MONTH.test(k) && Number.isSafeInteger(n) && (n as number) >= 0) s.files[k] = n as number;
  for (const [k, v] of obj(r.sessions)) {
    const row = v as Partial<SessionRow> | null;
    if (!idOk(k) || !row || !Array.isArray(row.h) || !num(row.seen)) continue;
    const h = row.h.filter(costOk).slice(0, SEGMENTS);
    if (h.length) s.sessions[k] = { h, seen: row.seen };
  }
  for (const [a, v] of obj(r.days)) if (idOk(a)) s.days[a] = dayRows(v);
  for (const [a, v] of obj(r.projects)) {
    if (!idOk(a)) continue;
    const projects = map<DayRows>();
    for (const [p, rows] of obj(v)) if (projectOk(p)) projects[p] = dayRows(rows);
    s.projects[a] = projects;
  }
  for (const [a, t] of obj(r.since)) if (idOk(a) && num(t)) s.since[a] = t;
  if (num(r.at)) s.at = r.at;
  if (r.built === true) s.built = true;
  return s;
}

const ledgerDir = (env: NodeJS.ProcessEnv) => path.join(cacheDir(env), 'ledger');
const summaryFile = (env: NodeJS.ProcessEnv) => path.join(ledgerDir(env), 'summary.json');

function prevMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() - 1, 1, 12).getTime();
}

// warm: from the newest folded month (at least last month) to this one
function warmKeys(s: Summary, now: number): string[] {
  const cur = monthKey(now);
  const prev = monthKey(prevMonth(now));
  let last = '';
  for (const k in s.files) if (k <= cur && k > last) last = k;
  const from = last && last < prev ? last : prev;
  const d = new Date(now);
  const out: string[] = [];
  for (let i = 0; i < KEEP_MONTHS; i++) {
    const k = monthKey(new Date(d.getFullYear(), d.getMonth() - i, 1, 12).getTime());
    if (k < from) break;
    out.unshift(k);
  }
  return out;
}

interface Step {
  moved: boolean;
  shrank: boolean;
  cut: boolean;
  used: number;
}

// reads at most budget bytes from the stored offset
function advance(s: Summary, file: string, key: string, budget: number): Step {
  const step: Step = { moved: false, shrank: false, cut: false, used: 0 };
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const from = s.files[key] ?? 0;
    if (from > size) {
      step.shrank = true;
      return step;
    }
    if (from === size) return step;
    const end = Math.min(size, from + Math.max(0, budget));
    step.cut = end < size;
    if (end === from) return step;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, end - from));
    let carry = Buffer.alloc(0);
    let pos = from;
    let offset = from;
    while (pos < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n <= 0) break;
      pos += n;
      step.used += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const last = data.lastIndexOf(10);
      if (last >= 0) foldText(s, data.toString('utf8', 0, last + 1));
      carry = Buffer.from(data.subarray(last + 1));
      // skip a junk run with no newline
      if (carry.length > MAX_LINE) carry = Buffer.alloc(0);
      offset = pos - carry.length;
    }
    s.files[key] = offset;
    step.moved = offset !== from;
    return step;
  } catch {
    return step;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

// month keys, oldest first
function monthFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => LEDGER_FILE.test(f))
      .map((f) => f.slice(0, 7))
      .sort();
  } catch {
    return [];
  }
}

function foldFiles(env: NodeJS.ProcessEnv, start: Summary, now: number, total: number): LedgerRead {
  const dir = ledgerDir(env);
  let summary = start;
  let moved = false;
  let more = false;
  for (let pass = 0; pass < 2; pass++) {
    const cold = !summary.built;
    // cold: every month file, oldest first, so a session crossing months keeps its highs
    const keys = cold ? monthFiles(dir) : warmKeys(summary, now);
    let budget = total;
    let shrank = false;
    more = false;
    for (const key of keys) {
      const r = advance(summary, path.join(dir, `${key}.jsonl`), key, budget);
      budget -= r.used;
      if (r.moved) moved = true;
      if (r.cut) more = true;
      if (r.shrank) {
        shrank = true;
        break;
      }
    }
    if (!shrank) {
      if (cold && !more) {
        summary.built = true;
        moved = true;
      }
      break;
    }
    // rebuild: re-reading a rewritten file on old highs would double count
    summary = emptySummary();
    moved = true;
  }
  if (moved) summary.at = now;
  return { summary, moved, more };
}

export function readLedger(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  opts: { persist?: boolean; budget?: number } = {},
): LedgerRead {
  try {
    const read = foldFiles(
      env,
      parseSummary(readJsonSafe(summaryFile(env))),
      now,
      opts.budget ?? BYTE_BUDGET,
    );
    if (read.moved && opts.persist === true)
      writeAtomic(summaryFile(env), JSON.stringify(read.summary), { mode: 0o600 });
    return read;
  } catch {
    return { summary: emptySummary(), moved: false, more: false };
  }
}

function dropOld(rows: DayRows, first: string): void {
  for (const day in rows) if (day < first) delete rows[day];
}

// D-21; month files by name only
export function pruneLedger(env: NodeJS.ProcessEnv, summary: Summary, now = Date.now()): void {
  try {
    const d = new Date(now);
    const oldest = monthKey(new Date(d.getFullYear(), d.getMonth() - (KEEP_MONTHS - 1), 1, 12).getTime());
    const dir = ledgerDir(env);
    for (const key of monthFiles(dir)) {
      if (key >= oldest) continue;
      try {
        const file = path.join(dir, `${key}.jsonl`);
        if (!fs.lstatSync(file).isFile()) continue;
        fs.unlinkSync(file);
        delete summary.files[key];
      } catch {}
    }
  } catch {}
  const first = dayKey(now - KEEP_DAYS * DAY_MS);
  for (const a in summary.days) dropOld(summary.days[a]!, first);
  for (const a in summary.projects) {
    const projects = summary.projects[a]!;
    for (const p in projects) {
      dropOld(projects[p]!, first);
      if (Object.keys(projects[p]!).length === 0) delete projects[p];
    }
  }
  const seen = now - KEEP_SESSION_DAYS * DAY_MS;
  for (const id in summary.sessions) if (summary.sessions[id]!.seen < seen) delete summary.sessions[id];
}

function sums(rows: DayRows | undefined, today: string, monday: string, sunday: string, month: string) {
  const out = { today: 0, week: 0, month: 0, all: 0 };
  if (!rows) return out;
  for (const day in rows) {
    const v = rows[day]!;
    out.all += v;
    if (day === today) out.today += v;
    if (day >= monday && day <= sunday) out.week += v;
    if (day.startsWith(month)) out.month += v;
  }
  return out;
}

export function ledgerView(
  summary: Summary,
  account: string,
  project: string,
  now: number,
  pending?: { session: string | undefined; c: unknown },
): LedgerView | null {
  let extra = 0;
  if (pending && idOk(pending.session) && costOk(pending.c)) {
    extra = credit(summary.sessions[pending.session]?.h, pending.c).delta;
  }
  const since = summary.since[account];
  if (since === undefined && !(extra > 0)) return null;
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7;
  const monday = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow, 12).getTime());
  const sunday = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow + 6, 12).getTime());
  const today = dayKey(now);
  const month = `${monthKey(now)}-`;
  const all = sums(summary.days[account], today, monday, sunday, month);
  const proj = sums(summary.projects[account]?.[project], today, monday, sunday, month);
  if (extra > 0) {
    all.today += extra;
    all.week += extra;
    all.month += extra;
    proj.today += extra;
    proj.week += extra;
    proj.month += extra;
    proj.all += extra;
  }
  return {
    today: all.today,
    week: all.week,
    month: all.month,
    project: proj,
    since: since ?? null,
    at: summary.at > 0 ? summary.at : null,
    partial: !summary.built,
  };
}

export function ledgerOn(config: Config): boolean {
  return config.lines.some((items) =>
    items.some((i) => LEDGER_TYPES.has(i.type) || (i.type === 'budget' && i.options?.period !== 'session')),
  );
}

function transcriptHash(file: string | undefined): string {
  if (!file) return '';
  return createHash('sha256').update(path.basename(file)).digest('hex').slice(0, 12);
}

// post-stdout; appends only a changed total
export function recordLedger(
  env: NodeJS.ProcessEnv,
  payload: StatusPayload,
  first: LedgerRead,
  now = Date.now(),
): void {
  let pruned = false;
  let read = first;
  try {
    if (read.more) {
      const next = foldFiles(env, read.summary, now, BYTE_BUDGET);
      read = { ...next, moved: read.moved || next.moved };
    }
    const c = payload.cost?.total_cost_usd;
    const s = payload.session_id;
    if (costOk(c) && idOk(s)) {
      const row = read.summary.sessions[s];
      if (!row?.h.includes(c)) {
        const line: LedgerLine = {
          v: 1,
          t: now,
          a: accountKey(env),
          s,
          p: projectRoot(payload),
          tp: transcriptHash(payload.transcript_path),
          c,
        };
        const file = path.join(ledgerDir(env), `${monthKey(now)}.jsonl`);
        const fresh = !fs.existsSync(file);
        if (appendLine(file, JSON.stringify(line)) && fresh) {
          pruneLedger(env, read.summary, now);
          pruned = true;
        }
      }
    }
    if (read.moved || pruned) writeAtomic(summaryFile(env), JSON.stringify(read.summary), { mode: 0o600 });
  } catch {}
}
