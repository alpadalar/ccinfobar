import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ruleNeeds } from '../core/conditions.js';
import { cacheDir, claudeDir } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import { toEpochMs } from '../core/time.js';
import type { Config, ModelWindow, RateWindow, StatusPayload } from '../core/types.js';
import { getWidget } from '../widgets/index.js';
import { detectProvider, PROVIDER_KINDS, type ProviderKind } from './provider.js';
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
  model?: string;
}

export interface StoredWindow {
  pct: number;
  resetsAt: number;
  at: number | null;
  src: ObsSrc;
  samples: Sample[];
  model?: string;
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
  model?: string;
}

export interface LimitsView {
  windows: Record<string, ResolvedWindow>;
  expired: string[];
}

export interface UsageLike {
  fetchedAt: number;
  rate_limits?: RateLimits;
  legacy?: boolean;
}

const TOL = 10 * 60_000;
const API_MAX_AGE = 30 * 60_000;
const MAX_PCT = 1000;
export const LIMIT_KEYS = ['five_hour', 'seven_day'] as const;
type Key = (typeof LIMIT_KEYS)[number];
const LEN: Record<Key, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };
const GAP: Record<Key, number> = { five_hour: 60_000, seven_day: 1_200_000 };
const MAX_SAMPLES = 32;
const MODEL = 'model:';
const MAX_MODELS = 16;
const MAX_NAME = 64;
const BAD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const isKey = (k: string): k is Key => (LIMIT_KEYS as readonly string[]).includes(k);
const isModelKey = (k: string) => k.startsWith(MODEL);
const lenOf = (k: string) => (isKey(k) ? LEN[k] : LEN.seven_day);
const gapOf = (k: string) => (isKey(k) ? GAP[k] : GAP.seven_day);

export function modelKey(name: unknown): { key: string; model: string } | null {
  if (typeof name !== 'string') return null;
  const model = sanitizeText(name).trim().slice(0, MAX_NAME);
  const low = model.toLowerCase();
  if (!model || BAD_NAMES.has(low)) return null;
  return { key: MODEL + low, model };
}

export function accountKeyFor(kind: ProviderKind, env: NodeJS.ProcessEnv = process.env): string {
  let dir = path.resolve(claudeDir(env)).normalize('NFC');
  if (process.platform === 'win32') dir = dir.toLowerCase();
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '';
  return createHash('sha256').update(`${kind}\u0000${dir}\u0000${secure}`).digest('hex').slice(0, 16);
}

export function accountKey(env: NodeJS.ProcessEnv = process.env): string {
  return accountKeyFor(detectProvider(env).kind, env);
}

// every provider Claude Code may have used with this config dir
export function accountKeysForDir(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(PROVIDER_KINDS.map((k) => accountKeyFor(k, env)));
}

export function limitsFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'limits', `${accountKey(env)}.json`);
}

export function limitsOn(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!detectProvider(env).planLimits) return false;
  const widgets = config.lines.some((items) => items.some((i) => getWidget(i.type)?.category === 'limits'));
  return widgets || ruleNeeds(config, 'limits');
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pctOk = (v: unknown): v is number => num(v) && v >= 0 && v <= MAX_PCT;

function parseWindow(v: unknown, key: string): StoredWindow | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  if (!pctOk(w.pct) || !num(w.resetsAt)) return null;
  if (w.at !== null && !num(w.at)) return null;
  if (w.src !== 'payload' && w.src !== 'usage-api') return null;
  const samples: Sample[] = [];
  if (Array.isArray(w.samples)) {
    for (const s of w.samples.slice(-MAX_SAMPLES)) {
      const p = s as Record<string, unknown> | null;
      if (p && num(p.t) && pctOk(p.pct)) samples.push({ t: p.t, pct: p.pct });
    }
  }
  const out: StoredWindow = {
    pct: w.pct,
    resetsAt: w.resetsAt,
    at: w.at as number | null,
    src: w.src,
    samples,
  };
  if (!isModelKey(key)) return out;
  const m = modelKey(w.model);
  return m && m.key === key ? { ...out, model: m.model } : null;
}

export function parseLimitsStore(text: string | null): LimitsStore | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { v?: unknown; windows?: unknown } | null;
    if (!v || typeof v !== 'object' || v.v !== 1) return null;
    const src = v.windows && typeof v.windows === 'object' ? (v.windows as Record<string, unknown>) : {};
    const windows: Record<string, StoredWindow> = Object.create(null);
    let models = 0;
    for (const k of Object.keys(src)) {
      if (!isKey(k) && (!isModelKey(k) || models >= MAX_MODELS)) continue;
      const w = parseWindow(src[k], k);
      if (!w) continue;
      windows[k] = w;
      if (isModelKey(k)) models++;
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

export function readLimitsStoreText(env: NodeJS.ProcessEnv = process.env): string | null {
  return readText(limitsFile(env));
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

// later window, then newest capture, then payload, then higher pct; unknown capture last.
// Payload (0.1%) beats an API integer within 1 point.
export function pick<T extends LimitObs>(list: T[], len: number, now: number): T | null {
  const ok = list.filter((o) => plausible(o, len, now));
  if (!ok.length) return null;
  const latest = Math.max(...ok.map((o) => o.resetsAt as number));
  const cur = ok.filter((o) => latest - (o.resetsAt as number) <= TOL);
  const known = cur.filter((o) => o.at !== null);
  const pool = known.length ? known : cur;
  return pool.reduce((a, b) => {
    if (a.src !== b.src && Math.abs(a.pct - b.pct) < 1) return a.src === 'payload' ? a : b;
    if ((b.at ?? 0) !== (a.at ?? 0)) return (b.at ?? 0) > (a.at ?? 0) ? b : a;
    if (a.src !== b.src) return a.src === 'payload' ? a : b.src === 'payload' ? b : a;
    return b.pct > a.pct ? b : a;
  });
}

function obsOf(w: RateWindow | null | undefined, at: number | null, src: ObsSrc): LimitObs | null {
  if (!w || !num(w.used_percentage)) return null;
  return { pct: w.used_percentage, resetsAt: toEpochMs(w.resets_at), at, src };
}

type Seen = { key: string; obs: LimitObs; raw: RateWindow };

// 5h, 7d and per-model weekly windows; legacy sonnet/opus fold into model keys
function observations(r: RateLimits | undefined, at: number | null, src: ObsSrc): Seen[] {
  const out: Seen[] = [];
  if (!r) return out;
  for (const key of LIMIT_KEYS) {
    const obs = obsOf(r[key], at, src);
    if (obs) out.push({ key, obs, raw: r[key] as RateWindow });
  }
  const models: [unknown, ModelWindow | RateWindow | undefined][] = [];
  for (const m of Array.isArray(r.seven_day_models) ? r.seven_day_models : []) models.push([m?.model, m]);
  models.push(['Sonnet', r.seven_day_sonnet], ['Opus', r.seven_day_opus]);
  for (const [name, w] of models) {
    const m = modelKey(name);
    const obs = m && obsOf(w, at, src);
    if (!m || !obs || !w || out.some((o) => o.key === m.key)) continue;
    out.push({
      key: m.key,
      obs: { ...obs, model: m.model },
      raw: 'model' in w ? w : { model: m.model, ...w },
    });
  }
  return out;
}

// thinned ring: a flat point once per gap; the newest point moves forward within its gap
export function addSample(ring: Sample[], p: Sample, gap: number): Sample[] {
  const last = ring[ring.length - 1];
  if (!last) return [p];
  if (p.t < last.t) return ring;
  const near = p.t - last.t < gap;
  if (near && p.pct === last.pct) return ring;
  const prev = ring[ring.length - 2];
  const live = p.t === last.t || (near && !!prev && last.t - prev.t < gap);
  return (live ? [...ring.slice(0, -1), p] : [...ring, p]).slice(-MAX_SAMPLES);
}

export function mergeObservation(
  store: LimitsStore | null,
  key: string,
  obs: LimitObs,
  now: number,
): LimitsStore {
  const windows: Record<string, StoredWindow> = Object.create(null);
  let models = 0;
  for (const [k, w] of Object.entries(store?.windows ?? {})) {
    if (!isKey(k) && !isModelKey(k)) continue;
    if (!plausible(w, lenOf(k), now)) continue;
    windows[k] = w;
    if (isModelKey(k)) models++;
  }
  const model = isModelKey(key) ? (obs.model ?? windows[key]?.model) : undefined;
  const room = !isModelKey(key) || (!!model && (key in windows || models < MAX_MODELS));
  if ((isKey(key) || isModelKey(key)) && room) {
    const prev = windows[key];
    const win = pick<LimitObs>(prev ? [prev, obs] : [obs], lenOf(key), now);
    if (win && win !== prev) {
      const resetsAt = win.resetsAt as number;
      const same = prev && Math.abs(prev.resetsAt - resetsAt) <= TOL;
      const point = { t: win.at ?? now, pct: win.pct };
      // API integers would zig-zag against payload tenths
      const feed = win.src === 'payload';
      const kept = same ? prev.samples : [];
      const samples = feed ? (same ? addSample(kept, point, gapOf(key)) : [point]) : kept;
      const next: StoredWindow = { pct: win.pct, resetsAt, at: win.at, src: win.src, samples };
      windows[key] = model ? { ...next, model } : next;
    }
  }
  return { v: 1, windows };
}

type Cand = LimitObs & { from: 'payload' | 'store' | 'api'; raw?: RateWindow; samples?: Sample[] };

// own payload, then an API "no active window", only when nothing plausible exists
function winner(list: Cand[], len: number, now: number): Cand | null {
  return (
    pick(list, len, now) ??
    list.find((c) => c.from === 'payload' && (c.resetsAt === null || c.resetsAt > now)) ??
    list.find((c) => c.from === 'api' && c.resetsAt === null) ??
    null
  );
}

const SOURCE = { payload: 'payload', store: 'limits-cache', api: 'usage-api' } as const;

function viewOf(win: Cand, s: StoredWindow | undefined): ResolvedWindow {
  const same = s && win.resetsAt !== null && Math.abs(s.resetsAt - win.resetsAt) <= TOL;
  const out: ResolvedWindow = {
    pct: win.pct,
    resetsAt: win.resetsAt,
    at: win.at,
    source: SOURCE[win.from],
    samples: same ? s.samples : [],
  };
  return win.model ? { ...out, model: win.model } : out;
}

const expiredIn = (list: Cand[], now: number) => list.some((c) => c.resetsAt !== null && c.resetsAt <= now);

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
  const view: LimitsView = { windows: Object.create(null), expired: [] };
  const stored = store?.windows ?? {};
  const groups = new Map<string, Cand[]>();
  const add = (key: string, c: Cand) => {
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  };
  const ownObs = observations(own, captureAt, 'payload');
  // a legacy capture never beats a known one
  const apiObs = api ? observations(api.rate_limits, api.legacy ? null : api.fetchedAt, 'usage-api') : [];
  for (const o of ownObs) add(o.key, { ...o.obs, from: 'payload', raw: o.raw });
  for (const [key, w] of Object.entries(stored)) add(key, { ...w, from: 'store' });
  for (const o of apiObs) add(o.key, { ...o.obs, from: 'api', raw: o.raw });
  for (const key of LIMIT_KEYS) {
    const list = groups.get(key) ?? [];
    const win = winner(list, LEN[key], now);
    if (!win) {
      delete out[key];
      if (expiredIn(list, now)) view.expired.push(key);
      continue;
    }
    out[key] = win.raw ?? {
      used_percentage: win.pct,
      resets_at: Math.floor((win.resetsAt as number) / 1000),
    };
    view.windows[key] = viewOf(win, stored[key]);
  }
  // payload order, then API order, then the rest of the store
  const order = [...new Set([...ownObs, ...apiObs].map((o) => o.key).concat(Object.keys(stored)))];
  const models: ModelWindow[] = [];
  for (const key of order.filter(isModelKey)) {
    const list = groups.get(key) ?? [];
    const win = winner(list, LEN.seven_day, now);
    if (!win?.model) {
      if (expiredIn(list, now)) view.expired.push(key);
      continue;
    }
    const resets_at = win.resetsAt === null ? null : Math.floor(win.resetsAt / 1000);
    models.push(
      (win.raw as ModelWindow | undefined) ?? { model: win.model, used_percentage: win.pct, resets_at },
    );
    view.windows[key] = viewOf(win, stored[key]);
  }
  delete out.seven_day_sonnet;
  delete out.seven_day_opus;
  if (models.length) out.seven_day_models = models;
  else delete out.seven_day_models;
  if (!own && !Object.keys(out).length) return { payload, view };
  return { payload: { ...payload, rate_limits: out }, view };
}

const hasWindows = (payload: StatusPayload) =>
  LIMIT_KEYS.some((k) => num(payload.rate_limits?.[k]?.used_percentage));

export function captureTime(payload: StatusPayload, transcript?: () => TranscriptInfo | null): number | null {
  if (!hasWindows(payload)) return null;
  try {
    const at = transcript?.()?.lastAssistantAt;
    if (num(at)) return at;
  } catch {}
  if (!payload.transcript_path) return null;
  try {
    return fs.statSync(payload.transcript_path).mtimeMs;
  } catch {
    return null;
  }
}

// no lock: a writer that got in first is re-read and merged into
function writeStore(
  env: NodeJS.ProcessEnv,
  seen: Seen[],
  now: number,
  clear: boolean,
  first?: string | null,
): void {
  const file = limitsFile(env);
  let text = first !== undefined ? first : readText(file);
  for (let i = 0; i < 3; i++) {
    let store: LimitsStore | null = clear ? { v: 1, windows: Object.create(null) } : parseLimitsStore(text);
    for (const o of seen) store = mergeObservation(store, o.key, o.obs, now);
    if (!store || (text === null && !Object.keys(store.windows).length)) return;
    const next = JSON.stringify(store);
    if (next === text) return;
    const again = clear ? text : readText(file);
    if (again === text) {
      writeAtomic(file, next, { mode: 0o600 });
      return;
    }
    text = again;
  }
}

export function recordLimits(
  env: NodeJS.ProcessEnv,
  payload: StatusPayload,
  captureAt: number | null,
  now: number,
  text?: string | null,
): void {
  try {
    if (!hasWindows(payload) || !detectProvider(env).planLimits) return;
    writeStore(env, observations(payload.rate_limits, captureAt, 'payload'), now, false, text);
  } catch {}
}

// worker result; an account switch starts the file over
export function recordUsageApi(
  env: NodeJS.ProcessEnv,
  cache: UsageLike,
  accountChanged: boolean,
  now: number,
): void {
  try {
    if (!detectProvider(env).planLimits || !num(cache.fetchedAt)) return;
    const seen = observations(cache.rate_limits, cache.fetchedAt, 'usage-api').filter(
      (o) => o.obs.resetsAt !== null,
    );
    if (seen.length || accountChanged) writeStore(env, seen, now, accountChanged);
  } catch {}
}
