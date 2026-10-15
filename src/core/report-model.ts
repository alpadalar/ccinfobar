import type { Period, RangeInput } from './report-types.js';
import { addDays, dayKey, mondayOf, parseDay, weekKey } from './time.js';

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
