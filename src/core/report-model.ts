import { PRICES_UPDATED, priceFor, requestCost } from './prices.js';
import {
  type CostSource,
  LEDGER_ZERO_USD,
  type Period,
  type ProjectFilter,
  type RangeInput,
  type Report,
  type ReportNote,
  type ReportRow,
  type ScanResult,
  type Tokens,
} from './report-types.js';
import { addDays, dayKey, mondayOf, parseDay, weekKey } from './time.js';
import type { Config } from './types.js';

export type Range = { period: Period; since: string | null; until: string | null };
export type RangeError = { error: 'period' | 'since' | 'until' | 'order'; value: string };

const PERIODS: readonly Period[] = ['day', 'week', 'month'];
const DEFAULT_SPAN: Record<Period, string> = { day: '7d', week: '4w', month: '3m' };
const REL = /^(\d{1,4})([dwm])$/;

function monthStart(ms: number, back: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() - back, 1, 12).getTime();
}

// last n units including the current one
function sinceOf(n: number, unit: string, ref: number): number {
  if (unit === 'd') return addDays(ref, -(n - 1));
  if (unit === 'w') return addDays(mondayOf(ref), -7 * (n - 1));
  return monthStart(ref, n - 1);
}

// n units before ref, month ends clamped
function untilOf(n: number, unit: string, ref: number): number {
  if (unit === 'd') return addDays(ref, -n);
  if (unit === 'w') return addDays(ref, -7 * n);
  const d = new Date(ref);
  const first = new Date(d.getFullYear(), d.getMonth() - n, 1, 12);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last), 12).getTime();
}

function dayArg(v: string, ref: number, since: boolean): number | null {
  const m = REL.exec(v);
  if (m) {
    const n = Number(m[1]);
    if (since && n < 1) return null;
    return since ? sinceOf(n, m[2]!, ref) : untilOf(n, m[2]!, ref);
  }
  return parseDay(v);
}

export function parseRange(input: RangeInput, now: number): Range | RangeError {
  const p = input.period;
  if (p !== undefined && p !== false && (typeof p !== 'string' || !PERIODS.includes(p as Period)))
    return { error: 'period', value: typeof p === 'string' ? p : '' };
  const period: Period = typeof p === 'string' ? (p as Period) : 'day';
  const today = addDays(now, 0);
  let until: number | null = null;
  const u = input.until;
  if (u !== undefined && u !== false) {
    until = typeof u === 'string' ? dayArg(u, today, false) : null;
    if (until === null) return { error: 'until', value: typeof u === 'string' ? u : '' };
  }
  let since: number | null = null;
  const s = input.since;
  if (s !== undefined && s !== false) {
    since = typeof s === 'string' ? dayArg(s, today, true) : null;
    if (since === null) return { error: 'since', value: typeof s === 'string' ? s : '' };
  } else if (!input.all) {
    const m = REL.exec(DEFAULT_SPAN[period])!;
    since = sinceOf(Number(m[1]), m[2]!, until ?? today);
  }
  if (until === null && !input.all) until = today;
  const sk = since === null ? null : dayKey(since);
  const uk = until === null ? null : dayKey(until);
  if (sk !== null && uk !== null && sk > uk) return { error: 'order', value: typeof s === 'string' ? s : sk };
  return { period, since: sk, until: uk };
}

export function periodOf(day: string, period: Period): string {
  if (period === 'day') return day;
  if (period === 'month') return day.slice(0, 7);
  const ms = parseDay(day);
  return ms === null ? day : weekKey(ms);
}

// lossy: every non-alphanumeric character became '-'
export function decodeProjectDir(enc: string): string {
  const drive = /^([A-Za-z])--(.*)$/.exec(enc);
  if (drive) return `${drive[1]}:/${drive[2]!.replace(/-/g, '/')}`;
  return enc.startsWith('-') ? enc.replace(/-/g, '/') : enc;
}

export interface ReportOptions {
  period: Period;
  since: string | null;
  until: string | null;
  filter: ProjectFilter | null;
  config: Pick<Config, 'profiles'>;
}

type Src = 'ledger' | 'transcript';

interface Day {
  in: number;
  out: number;
  cr: number;
  cw: number;
  n: number;
  ms: number;
  usd: number;
  hasUsd: boolean;
  other: Record<string, number>;
  transcript: boolean;
  unpriced: Record<string, number>;
  vendors: Set<string>;
}

interface Acc {
  period: string;
  project: string;
  approx: boolean;
  sids: Set<string>;
  t: Tokens;
  transcript: boolean;
  ms: number;
  usd: number;
  hasUsd: boolean;
  other: Record<string, number>;
  src: Set<Src>;
  partial: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

// ascii only, so İ and ı never fold
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

function within(p: string, root: string): boolean {
  if (p === root) return true;
  if (!root || !p.startsWith(root)) return false;
  return /[\\/]$/.test(root) || p[root.length] === '/' || p[root.length] === '\\';
}

function currentProject(cwd: string, projects: Iterable<string>): string {
  let best: string | null = null;
  for (const p of projects) if (within(cwd, p) && (best === null || p.length > best.length)) best = p;
  return best ?? cwd;
}

function newDay(): Day {
  return {
    in: 0,
    out: 0,
    cr: 0,
    cw: 0,
    n: 0,
    ms: 0,
    usd: 0,
    hasUsd: false,
    other: {},
    transcript: false,
    unpriced: {},
    vendors: new Set(),
  };
}

function newAcc(period: string, project: string, approx: boolean): Acc {
  return {
    period,
    project,
    approx,
    sids: new Set(),
    t: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    transcript: false,
    ms: 0,
    usd: 0,
    hasUsd: false,
    other: {},
    src: new Set(),
    partial: false,
  };
}

function merge(into: Acc, a: Acc): void {
  for (const s of a.sids) into.sids.add(s);
  into.t.input += a.t.input;
  into.t.output += a.t.output;
  into.t.cacheRead += a.t.cacheRead;
  into.t.cacheWrite += a.t.cacheWrite;
  into.t.total += a.t.total;
  into.transcript ||= a.transcript;
  into.ms += a.ms;
  into.usd += a.usd;
  into.hasUsd ||= a.hasUsd;
  for (const [c, v] of Object.entries(a.other)) into.other[c] = (into.other[c] ?? 0) + v;
  for (const s of a.src) into.src.add(s);
  into.partial ||= a.partial;
}

function toRow(a: Acc): ReportRow {
  const row: ReportRow = {
    period: a.period,
    project: a.project,
    approx: a.approx,
    sessions: a.sids.size,
    tokens: a.transcript ? { ...a.t } : null,
    costUsd: a.hasUsd ? a.usd : null,
    costSource: (a.src.size > 1 ? 'mixed' : ([...a.src][0] ?? null)) as CostSource,
    partial: a.partial,
    activeMs: a.transcript ? a.ms : null,
  };
  if (Object.keys(a.other).length > 0) row.costOther = { ...a.other };
  return row;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareRows(a: ReportRow, b: ReportRow): number {
  if (a.period !== b.period) return byText(a.period, b.period);
  if (a.costUsd !== b.costUsd) {
    if (a.costUsd === null) return 1;
    if (b.costUsd === null) return -1;
    return b.costUsd - a.costUsd;
  }
  const ta = a.tokens?.total ?? -1;
  const tb = b.tokens?.total ?? -1;
  if (ta !== tb) return tb - ta;
  return byText(a.project, b.project) || Number(a.approx) - Number(b.approx);
}

export function buildReport(data: ScanResult, opts: ReportOptions): Report {
  const { since, until } = opts;
  const inRange = (d: string) =>
    DAY_RE.test(d) &&
    parseDay(d) !== null &&
    (since === null || d >= since) &&
    (until === null || d <= until);
  const prices = new Map<string, ReturnType<typeof priceFor>>();
  const price = (model: string) => {
    if (!prices.has(model)) prices.set(model, priceFor(model, opts.config));
    return prices.get(model)!;
  };
  const periods = new Map<string, string>();
  const periodKey = (d: string) => {
    let p = periods.get(d);
    if (p === undefined) {
      p = periodOf(d, opts.period);
      periods.set(d, p);
    }
    return p;
  };

  const cells = new Map<string, Acc>();
  const unpriced = new Map<string, number>();
  const vendors = new Set<string>();
  let approxCount = 0;
  let ledgerOnly = 0;

  const sids = new Set([...Object.keys(data.sessions), ...Object.keys(data.ledger)]);
  const owner = new Map<string, { project: string; approx: boolean }>();
  for (const sid of sids) {
    const s = Object.hasOwn(data.sessions, sid) ? data.sessions[sid] : undefined;
    const l = Object.hasOwn(data.ledger, sid) ? data.ledger[sid] : undefined;
    if (l && typeof l.p === 'string' && l.p) owner.set(sid, { project: l.p, approx: false });
    else if (s?.cwd) owner.set(sid, { project: s.cwd, approx: false });
    else if (s) owner.set(sid, { project: decodeProjectDir(s.enc), approx: true });
  }
  const f = opts.filter;
  let here: string | null = null;
  if (f?.kind === 'cwd') {
    const known = new Set<string>();
    for (const o of owner.values()) if (!o.approx) known.add(o.project);
    here = currentProject(f.cwd, known);
  }
  const matches = (project: string) =>
    !f || (f.kind === 'substring' ? fold(project).includes(fold(f.text)) : project === here);

  for (const [sid, { project, approx }] of owner) {
    const s = Object.hasOwn(data.sessions, sid) ? data.sessions[sid] : undefined;
    const l = Object.hasOwn(data.ledger, sid) ? data.ledger[sid] : undefined;
    if (!matches(project)) continue;

    const days = new Map<string, Day>();
    const day = (d: string) => {
      let x = days.get(d);
      if (!x) {
        x = newDay();
        days.set(d, x);
      }
      return x;
    };
    // estimate split by request day, kept apart until the source is chosen
    const est = new Map<string, { usd: number; hasUsd: boolean; other: Record<string, number> }>();
    let priced = true;
    let requests = 0;
    for (const [key, b] of Object.entries(s?.buckets ?? {})) {
      const parts = key.split('|');
      if (parts.length !== 5) continue;
      const [d, model, fast, big, usdFlag] = parts as [string, string, string, string, string];
      const u = { in: pos(b.in), out: pos(b.out), cr: pos(b.cr), w5: pos(b.w5), w1: pos(b.w1) };
      const n = pos(b.n);
      requests += n;
      let usd: number | null = null;
      let other: [string, number] | null = null;
      let vendor: string | null = null;
      if (usdFlag === '1') usd = pos(b.usd);
      else {
        const r = price(model);
        const c = r ? requestCost(r.price, { ...u, fast: fast === '1', big: big === '1' }) : null;
        if (r && c !== null && Number.isFinite(c)) {
          if (r.currency === 'USD') usd = c;
          else other = [r.currency, c];
          if (r.source === 'profile' && r.vendor) vendor = r.vendor;
        } else priced = false;
      }
      if (!inRange(d)) continue;
      const x = day(d);
      x.in += u.in;
      x.out += u.out;
      x.cr += u.cr;
      x.cw += u.w5 + u.w1;
      x.n += n;
      x.transcript = true;
      if (usd === null && other === null) x.unpriced[model] = (x.unpriced[model] ?? 0) + n;
      if (vendor) x.vendors.add(vendor);
      let e = est.get(d);
      if (!e) {
        e = { usd: 0, hasUsd: false, other: {} };
        est.set(d, e);
      }
      if (usd !== null) {
        e.usd += usd;
        e.hasUsd = true;
      }
      if (other) e.other[other[0]] = (e.other[other[0]] ?? 0) + other[1];
    }
    for (const [d, ms] of Object.entries(s?.time ?? {})) {
      if (!inRange(d)) continue;
      const x = day(d);
      x.ms += pos(ms);
      x.transcript = true;
    }

    let src: Src | null = null;
    let partial = false;
    if (l && l.first <= LEDGER_ZERO_USD) src = 'ledger';
    else if (s && requests > 0 && priced) src = 'transcript';
    else if (l) {
      src = 'ledger';
      partial = true;
    } else partial = !priced;

    if (src === 'ledger') {
      for (const [d, v] of Object.entries(l!.days)) {
        const c = pos(v);
        if (c === 0 || !inRange(d)) continue;
        const x = day(d);
        x.usd += c;
        x.hasUsd = true;
      }
    } else if (src === 'transcript') {
      for (const [d, e] of est) {
        const x = day(d);
        x.usd += e.usd;
        x.hasUsd ||= e.hasUsd;
        for (const [c, v] of Object.entries(e.other)) x.other[c] = (x.other[c] ?? 0) + v;
      }
    }
    const fullCost = src === 'ledger' && !partial;

    let counted = false;
    let onlyLedger = true;
    for (const [d, x] of days) {
      const hasOther = Object.keys(x.other).length > 0;
      if (!(x.n > 0 || x.ms > 0 || x.usd > 0 || hasOther)) continue;
      counted = true;
      if (x.transcript) onlyLedger = false;
      const period = periodKey(d);
      const ck = `${period}\u0000${approx ? 1 : 0}\u0000${project}`;
      let a = cells.get(ck);
      if (!a) {
        a = newAcc(period, project, approx);
        cells.set(ck, a);
      }
      a.sids.add(sid);
      a.t.input += x.in;
      a.t.output += x.out;
      a.t.cacheRead += x.cr;
      a.t.cacheWrite += x.cw;
      a.t.total += x.in + x.out + x.cr + x.cw;
      a.transcript ||= x.transcript;
      a.ms += x.ms;
      if (x.hasUsd) {
        a.usd += x.usd;
        a.hasUsd = true;
      }
      for (const [c, v] of Object.entries(x.other)) a.other[c] = (a.other[c] ?? 0) + v;
      if (src && (x.hasUsd || hasOther)) a.src.add(src);
      if (partial) a.partial = true;
      if (!fullCost)
        for (const [m, n] of Object.entries(x.unpriced)) unpriced.set(m, (unpriced.get(m) ?? 0) + n);
      if (src === 'transcript') for (const v of x.vendors) vendors.add(v);
    }
    if (counted && approx) approxCount++;
    if (counted && onlyLedger) ledgerOnly++;
  }

  const rows = [...cells.values()].map(toRow).sort(compareRows);
  const byPeriod = new Map<string, Acc[]>();
  for (const a of cells.values()) {
    const list = byPeriod.get(a.period) ?? [];
    list.push(a);
    byPeriod.set(a.period, list);
  }
  const subtotals: ReportRow[] = [];
  const total = newAcc('', '', false);
  for (const [period, list] of [...byPeriod].sort((a, b) => byText(a[0], b[0]))) {
    const sub = newAcc(period, '', false);
    for (const a of list) {
      merge(sub, a);
      merge(total, a);
    }
    if (list.length > 1) subtotals.push(toRow(sub));
  }

  const models = [...unpriced.keys()].sort(byText);
  const requests = models.reduce((n, m) => n + unpriced.get(m)!, 0);
  const ledgerSince = data.ledgerSince === null ? null : dayKey(data.ledgerSince);
  const notes: ReportNote[] = [{ code: 'estimate' }];
  if (ledgerSince) notes.push({ code: 'ledger-since', params: { date: ledgerSince } });
  if (requests > 0) notes.push({ code: 'unpriced', params: { models: models.join(', '), requests } });
  for (const c of Object.keys(total.other).sort(byText))
    notes.push({ code: 'non-usd', params: { currency: c, amount: total.other[c]! } });
  for (const v of [...vendors].sort(byText)) notes.push({ code: 'profile-price', params: { vendor: v } });
  if (rows.some((r) => r.partial)) notes.push({ code: 'partial' });
  if (approxCount > 0) notes.push({ code: 'approx-project', params: { count: approxCount } });
  if (ledgerOnly > 0) notes.push({ code: 'ledger-only', params: { count: ledgerOnly } });
  for (const n of data.notes) notes.push({ code: n.code, params: { count: n.count } });

  return {
    period: opts.period,
    since,
    until,
    rows,
    subtotals,
    total: rows.length > 0 ? toRow(total) : null,
    unpriced: { models, requests },
    ledgerSince,
    pricesUpdated: PRICES_UPDATED,
    notes,
  };
}
