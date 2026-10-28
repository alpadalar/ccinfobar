import { isFileId } from './ids.js';
import type { RotationDay, RotationEvery, ThemeRotation } from './types.js';

export const ROTATION_DAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const satisfies readonly RotationDay[];
export const ROTATION_MAX = 32;
export const ROTATION_MINUTES_MAX = 10080;

const BY_GETDAY: readonly RotationDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES: Record<string, RotationDay> = {
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
};

const isId = (v: unknown): v is string => isFileId(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const mod = (a: number, n: number): number => ((a % n) + n) % n;

function normEvery(v: unknown): RotationEvery | undefined {
  if (v === 'hour' || v === 'day' || v === 'week') return v;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.min(ROTATION_MINUTES_MAX, Math.max(1, Math.round(v)));
  }
  return undefined;
}

export function normalizeThemeRotation(raw: unknown): ThemeRotation | undefined {
  if (!isObject(raw)) return undefined;
  const out: ThemeRotation = {};
  if (Array.isArray(raw.themes)) {
    const themes = [...new Set(raw.themes.filter(isId))].slice(0, ROTATION_MAX);
    if (themes.length) out.themes = themes;
  }
  const every = normEvery(raw.every);
  if (every !== undefined) out.every = every;
  if (raw.order === 'cycle' || raw.order === 'shuffle') out.order = raw.order;
  if (isObject(raw.weekdays)) {
    const map: Partial<Record<RotationDay, string>> = {};
    for (const d of ROTATION_DAYS) {
      const v = raw.weekdays[d];
      if (isId(v)) map[d] = v;
    }
    if (Object.keys(map).length) out.weekdays = map;
  }
  return out.themes || out.weekdays ? out : undefined;
}

// wall-clock calendar day, DST-independent
const dayNumber = (now: Date): number =>
  Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);

export function periodIndex(every: RotationEvery, now: Date): number {
  const day = dayNumber(now);
  if (every === 'hour') return day * 24 + now.getHours();
  if (every === 'day') return day;
  // 1970-01-05 was a Monday
  if (every === 'week') return Math.floor((day + 3) / 7);
  const minute = now.getHours() * 60 + now.getMinutes();
  // per-day slots restart at local midnight
  if (every <= 1440) return day * Math.ceil(1440 / every) + Math.floor(minute / every);
  return Math.floor((day * 1440 + minute) / every);
}

export const todayKey = (now: Date): RotationDay => BY_GETDAY[now.getDay()]!;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutation(n: number, round: number, key: string): number[] {
  const rand = mulberry32(fnv1a(`${round}|${key}`));
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j]!, perm[i]!];
  }
  return perm;
}

function shufflePos(n: number, key: string, idx: number): number {
  // two themes: alternate from a seeded start
  if (n === 2) return mod(idx + (fnv1a(key) & 1), 2);
  const round = Math.floor(idx / n);
  const perm = permutation(n, round, key);
  const prev = permutation(n, round - 1, key);
  if (perm[0] === prev[n - 1]) [perm[0], perm[1]] = [perm[1]!, perm[0]!];
  return perm[mod(idx, n)]!;
}

export function pickRotationTheme(
  rot: ThemeRotation,
  now: Date,
  known: (id: string) => boolean,
): string | null {
  const pinned = rot.weekdays?.[todayKey(now)];
  if (pinned && known(pinned)) return pinned;
  const pool = rot.themes ?? [];
  const n = pool.length;
  if (!n) return null;
  const idx = periodIndex(rot.every ?? 'day', now);
  const pos = n === 1 ? 0 : rot.order === 'shuffle' ? shufflePos(n, pool.join(','), idx) : mod(idx, n);
  for (let k = 0; k < n; k++) {
    const id = pool[(pos + k) % n]!;
    if (known(id)) return id;
  }
  return null;
}

const nextMidnight = (now: Date): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

export function nextRotationChange(rot: ThemeRotation, now: Date): Date {
  const every = rot.every ?? 'day';
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  let next: Date;
  if (every === 'hour') next = new Date(y, m, d, now.getHours() + 1);
  else if (every === 'day') next = nextMidnight(now);
  else if (every === 'week') next = new Date(y, m, d + 7 - mod(now.getDay() - 1, 7));
  else if (every <= 1440) {
    const minute = now.getHours() * 60 + now.getMinutes();
    const at = Math.min((Math.floor(minute / every) + 1) * every, 1440);
    next = new Date(y, m, d, 0, at);
  } else {
    const total = (periodIndex(every, now) + 1) * every;
    const day = Math.floor(total / 1440);
    const at = new Date(day * 86_400_000);
    next = new Date(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, total - day * 1440);
  }
  if (rot.weekdays && Object.keys(rot.weekdays).length) {
    const mid = nextMidnight(now);
    if (mid < next) next = mid;
  }
  return next;
}

export function rotationIds(rot: ThemeRotation): string[] {
  const ids = [...(rot.themes ?? [])];
  for (const d of ROTATION_DAYS) {
    const v = rot.weekdays?.[d];
    if (v) ids.push(v);
  }
  return [...new Set(ids)];
}

export function withoutRotation<T extends { themeRotation?: unknown }>(config: T): T {
  if (!('themeRotation' in config)) return config;
  const { themeRotation: _r, ...rest } = config;
  return rest as T;
}

export function parseEvery(s: string): RotationEvery | null {
  const v = s.trim().toLowerCase();
  if (v === 'hour' || v === 'hourly') return 'hour';
  if (v === 'day' || v === 'daily') return 'day';
  if (v === 'week' || v === 'weekly') return 'week';
  const m = /^(\d{1,5})m?$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= ROTATION_MINUTES_MAX ? n : null;
}

export type WeekdaysParse =
  | { ok: true; map: Partial<Record<RotationDay, string>> }
  | { ok: false; bad: string };

export function parseWeekdays(s: string): WeekdaysParse {
  const map: Partial<Record<RotationDay, string>> = {};
  for (const part of s.split(/[,\s]+/)) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq > 0 ? part.slice(0, eq).toLowerCase() : '';
    const id = eq > 0 ? part.slice(eq + 1) : '';
    const day = (ROTATION_DAYS as readonly string[]).includes(key) ? (key as RotationDay) : DAY_NAMES[key];
    if (!day || !isId(id)) return { ok: false, bad: part };
    map[day] = id;
  }
  return { ok: true, map };
}

export function formatWeekdays(map: Partial<Record<RotationDay, string>> | undefined): string {
  return ROTATION_DAYS.filter((d) => map?.[d])
    .map((d) => `${d}=${map![d]}`)
    .join(',');
}
