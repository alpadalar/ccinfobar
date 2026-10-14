import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, claudeDir } from '../core/paths.js';
import { toEpochMs } from '../core/time.js';
import type { Config, RateWindow, StatusPayload } from '../core/types.js';
import { getWidget } from '../widgets/index.js';
import { detectProvider } from './provider.js';
import { writeAtomic } from './store.js';
import type { TranscriptInfo } from './transcript.js';

type RateLimits = NonNullable<StatusPayload['rate_limits']>;
type ObsSrc = 'payload' | 'usage-api';
export type LimitSource = 'payload' | 'limits-cache' | 'usage-api';

export interface Sample {
  t: number;
  pct: number;
}

export interface LimitObs {
  pct: number;
  resetsAt: number | null;
  at: number | null;
  src: ObsSrc;
}

export interface StoredWindow {
  pct: number;
  resetsAt: number;
  at: number | null;
  src: ObsSrc;
  samples: Sample[];
}

export interface LimitsStore {
  v: 1;
  windows: Record<string, StoredWindow>;
}

export interface ResolvedWindow {
  pct: number;
  resetsAt: number | null;
  at: number | null;
  source: LimitSource;
  samples: Sample[];
}

export interface LimitsView {
  windows: Record<string, ResolvedWindow>;
  expired: string[];
  storeAt: number | null;
}

export interface UsageLike {
  fetchedAt: number;
  rate_limits?: RateLimits;
}

const TOL = 10 * 60_000;
const API_MAX_AGE = 30 * 60_000;
const MAX_PCT = 1000;
export const LIMIT_KEYS = ['five_hour', 'seven_day'] as const;
type Key = (typeof LIMIT_KEYS)[number];
const LEN: Record<Key, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };

export function accountKey(env: NodeJS.ProcessEnv = process.env): string {
  let dir = path.resolve(claudeDir(env)).normalize('NFC');
  if (process.platform === 'win32') dir = dir.toLowerCase();
  const kind = detectProvider(env).kind;
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '';
  return createHash('sha256').update(`${kind}\u0000${dir}\u0000${secure}`).digest('hex').slice(0, 16);
}

export function limitsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'limits', `${accountKey(env)}.json`);
}

export function limitsOn(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!detectProvider(env).planLimits) return false;
  return config.lines.some((items) => items.some((i) => getWidget(i.type)?.category === 'limits'));
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pctOk = (v: unknown): v is number => num(v) && v >= 0 && v <= MAX_PCT;

function parseWindow(v: unknown): StoredWindow | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  if (!pctOk(w.pct) || !num(w.resetsAt)) return null;
  if (w.at !== null && !num(w.at)) return null;
  if (w.src !== 'payload' && w.src !== 'usage-api') return null;
  const samples: Sample[] = [];
  if (Array.isArray(w.samples)) {
    for (const s of w.samples.slice(-32)) {
      const p = s as Record<string, unknown> | null;
      if (p && num(p.t) && pctOk(p.pct)) samples.push({ t: p.t, pct: p.pct });
    }
  }
  return { pct: w.pct, resetsAt: w.resetsAt, at: w.at as number | null, src: w.src, samples };
}

export function parseLimitsStore(text: string | null): LimitsStore | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { v?: unknown; windows?: unknown } | null;
    if (!v || typeof v !== 'object' || v.v !== 1) return null;
    const src = v.windows && typeof v.windows === 'object' ? (v.windows as Record<string, unknown>) : {};
    const windows: Record<string, StoredWindow> = Object.create(null);
    for (const k of LIMIT_KEYS) {
      if (!Object.hasOwn(src, k)) continue;
      const w = parseWindow(src[k]);
      if (w) windows[k] = w;
    }
    return { v: 1, windows };
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readLimitsStore(env: NodeJS.ProcessEnv = process.env): LimitsStore | null {
  try {
    return parseLimitsStore(readText(limitsFile(env)));
  } catch {
    return null;
  }
}

export function plausible(o: LimitObs, len: number, now: number): boolean {
  return pctOk(o.pct) && o.resetsAt !== null && o.resetsAt > now && o.resetsAt <= now + len + TOL;
}

// later window, then newest capture, then payload, then higher pct; unknown capture last
export function pick<T extends LimitObs>(list: T[], len: number, now: number): T | null {
  const ok = list.filter((o) => plausible(o, len, now));
  if (!ok.length) return null;
  const latest = Math.max(...ok.map((o) => o.resetsAt as number));
  const cur = ok.filter((o) => latest - (o.resetsAt as number) <= TOL);
  const known = cur.filter((o) => o.at !== null);
  const pool = known.length ? known : cur;
  return pool.reduce((a, b) => {
    if ((b.at ?? 0) !== (a.at ?? 0)) return (b.at ?? 0) > (a.at ?? 0) ? b : a;
    if (a.src !== b.src) return a.src === 'payload' ? a : b.src === 'payload' ? b : a;
    return b.pct > a.pct ? b : a;
  });
}

function obsOf(w: RateWindow | null | undefined, at: number | null, src: ObsSrc): LimitObs | null {
  if (!w || !num(w.used_percentage)) return null;
  return { pct: w.used_percentage, resetsAt: toEpochMs(w.resets_at), at, src };
}

const isKey = (k: string): k is Key => (LIMIT_KEYS as readonly string[]).includes(k);

export function mergeObservation(
  store: LimitsStore | null,
  key: string,
  obs: LimitObs,
  now: number,
): LimitsStore {
  const windows: Record<string, StoredWindow> = Object.create(null);
  for (const k of LIMIT_KEYS) {
    const w = store?.windows[k];
    if (w && plausible(w, LEN[k], now)) windows[k] = w;
  }
  if (isKey(key)) {
    const prev = windows[key];
    const win = pick<LimitObs>(prev ? [prev, obs] : [obs], LEN[key], now);
    if (win && win !== prev) {
      windows[key] = {
        pct: win.pct,
        resetsAt: win.resetsAt as number,
        at: win.at,
        src: win.src,
        samples: [],
      };
    }
  }
  return { v: 1, windows };
}

type Cand = LimitObs & { from: 'payload' | 'store' | 'api'; raw?: RateWindow; samples?: Sample[] };

export function resolveLimits(
  payload: StatusPayload,
  store: LimitsStore | null,
  usageCache: UsageLike | null,
  now: number,
  captureAt: number | null,
): { payload: StatusPayload; view: LimitsView } {
  const own = payload.rate_limits;
  const api = usageCache?.rate_limits && now - usageCache.fetchedAt <= API_MAX_AGE ? usageCache : null;
  const out: RateLimits = { ...api?.rate_limits, ...own };
  const view: LimitsView = { windows: Object.create(null), expired: [], storeAt: null };
  for (const w of Object.values(store?.windows ?? {})) {
    if (w.at !== null && (view.storeAt === null || w.at > view.storeAt)) view.storeAt = w.at;
  }
  for (const key of LIMIT_KEYS) {
    const list: Cand[] = [];
    const p = obsOf(own?.[key], captureAt, 'payload');
    if (p) list.push({ ...p, from: 'payload', raw: own?.[key] });
    const s = store?.windows[key];
    if (s) list.push({ ...s, from: 'store' });
    const a = api ? obsOf(api.rate_limits?.[key], api.fetchedAt, 'usage-api') : null;
    if (a) list.push({ ...a, from: 'api', raw: api?.rate_limits?.[key] });
    let win = pick(list, LEN[key], now);
    // own payload, then an API "no active window", only when nothing plausible exists
    if (!win) {
      win =
        list.find((c) => c.from === 'payload' && (c.resetsAt === null || c.resetsAt > now)) ??
        list.find((c) => c.from === 'api' && c.resetsAt === null) ??
        null;
    }
    if (!win) {
      delete out[key];
      if (list.some((c) => c.resetsAt !== null && c.resetsAt <= now)) view.expired.push(key);
      continue;
    }
    out[key] = win.raw ?? {
      used_percentage: win.pct,
      resets_at: Math.floor((win.resetsAt as number) / 1000),
    };
    view.windows[key] = {
      pct: win.pct,
      resetsAt: win.resetsAt,
      at: win.at,
      source: win.from === 'store' ? 'limits-cache' : win.from === 'api' ? 'usage-api' : 'payload',
      samples: s && win.resetsAt !== null && Math.abs(s.resetsAt - win.resetsAt) <= TOL ? s.samples : [],
    };
  }
  if (!own && !Object.keys(out).length) return { payload, view };
  return { payload: { ...payload, rate_limits: out }, view };
}

const hasWindows = (payload: StatusPayload) =>
  LIMIT_KEYS.some((k) => num(payload.rate_limits?.[k]?.used_percentage));

export function captureTime(
  payload: StatusPayload,
  _transcript?: () => TranscriptInfo | null,
): number | null {
  if (!hasWindows(payload) || !payload.transcript_path) return null;
  try {
    return fs.statSync(payload.transcript_path).mtimeMs;
  } catch {
    return null;
  }
}

export function recordLimits(
  env: NodeJS.ProcessEnv,
  payload: StatusPayload,
  captureAt: number | null,
  now: number,
): void {
  try {
    if (!hasWindows(payload)) return;
    const file = limitsFile(env);
    const text = readText(file);
    let store = parseLimitsStore(text);
    for (const key of LIMIT_KEYS) {
      const obs = obsOf(payload.rate_limits?.[key], captureAt, 'payload');
      if (obs) store = mergeObservation(store, key, obs, now);
    }
    if (!store || (text === null && !Object.keys(store.windows).length)) return;
    const next = JSON.stringify(store);
    if (next !== text) writeAtomic(file, next, { mode: 0o600 });
  } catch {}
}
