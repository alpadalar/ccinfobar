import { toEpochMs } from '../core/time.js';
import type { RenderContext, WidgetItem } from '../core/types.js';
import { opt } from './shared.js';

export type ProjKey = 'five_hour' | 'seven_day';
export type Pace = 'window' | 'recent';

export const WINDOW_LEN: Record<ProjKey, number> = { five_hour: 18_000_000, seven_day: 604_800_000 };
export const LOOKBACK: Record<ProjKey, number> = { five_hour: 1_800_000, seven_day: 43_200_000 };

const WARM_MIN = 900_000;
const MIN_SPAN = 600_000;
const MIN_POINTS = 3;

export type Projection =
  | { state: 'warming' }
  | {
      state: 'ok';
      used: number;
      proj: number;
      eta: number;
      safe: boolean;
      idle: boolean;
      resetsAt: number;
    };

interface Point {
  t: number;
  pct: number;
}

const STEPS = 30;

// least-squares pct per ms
function slope(points: Point[]): number | null {
  let st = 0;
  let sp = 0;
  for (const p of points) {
    st += p.t;
    sp += p.pct;
  }
  const mt = st / points.length;
  const mp = sp / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.pct - mp);
    den += (p.t - mt) ** 2;
  }
  return den > 0 ? num / den : null;
}

// fills gaps linearly so a flat stretch counts for its length
function dense(points: Point[], step: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1];
    out.push(a);
    if (!b) break;
    const n = Math.floor((b.t - a.t) / step);
    for (let j = 1; j < n; j++) {
      const t = a.t + j * step;
      out.push({ t, pct: a.pct + ((b.pct - a.pct) * (t - a.t)) / (b.t - a.t) });
    }
  }
  return out;
}

export function projectWindow(
  used: number,
  resetsAt: number,
  len: number,
  now: number,
  opts: { pace: Pace; samples?: Point[]; lookback: number },
): Projection {
  const start = resetsAt - len;
  const elapsed = now - start;
  if (!(elapsed >= Math.max(WARM_MIN, 0.05 * len))) return { state: 'warming' };
  const u = Math.max(0, used);
  let rate = u / Math.min(elapsed, len);
  let idle = false;
  if (opts.pace === 'recent') {
    const from = Math.max(start, now - opts.lookback);
    const pts = (opts.samples ?? [])
      .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.pct) && s.t >= from && s.t <= now)
      .sort((a, b) => a.t - b.t);
    const span = pts.length ? pts[pts.length - 1]!.t - pts[0]!.t : 0;
    const k =
      pts.length >= MIN_POINTS && span >= MIN_SPAN
        ? slope(dense([...pts, { t: now, pct: u }], Math.max(1000, opts.lookback / STEPS)))
        : null;
    if (k !== null) {
      idle = k <= 0;
      rate = idle ? 0 : k;
    }
  }
  const left = Math.max(0, resetsAt - now);
  const proj = u + rate * left;
  const eta = u >= 100 ? 0 : rate <= 0 ? Number.POSITIVE_INFINITY : (100 - u) / rate;
  return { state: 'ok', used: u, proj, eta, safe: u < 100 && now + eta >= resetsAt, idle, resetsAt };
}

function samplesOf(ctx: RenderContext, key: ProjKey): Point[] {
  try {
    return ctx.data.limits?.()?.windows[key]?.samples ?? [];
  } catch {
    return [];
  }
}

export function projectionFor(ctx: RenderContext, key: ProjKey, pace: Pace): Projection | null {
  const w = ctx.payload.rate_limits?.[key];
  const used = w?.used_percentage;
  const resetsAt = toEpochMs(w?.resets_at);
  if (typeof used !== 'number' || !Number.isFinite(used) || resetsAt === null) return null;
  const now = ctx.now.getTime();
  const samples = pace === 'recent' ? samplesOf(ctx, key) : undefined;
  return projectWindow(used, resetsAt, WINDOW_LEN[key], now, { pace, samples, lookback: LOOKBACK[key] });
}

export type WindowChoice = ProjKey | 'first';

export const WINDOW_LABEL: Record<ProjKey, string> = { five_hour: '5h', seven_day: '7d' };

export function itemWindow(item: WidgetItem): WindowChoice {
  const w = opt<string>(item, 'window', 'first');
  if (w === '7d') return 'seven_day';
  return w === 'first' ? 'first' : 'five_hour';
}

export function itemKey(item: WidgetItem): ProjKey {
  return opt<string>(item, 'window', '5h') === '7d' ? 'seven_day' : 'five_hour';
}

export function itemPace(item: WidgetItem): Pace {
  return opt<string>(item, 'pace', 'window') === 'recent' ? 'recent' : 'window';
}

type Ok = Projection & { state: 'ok' };

// unsafe with the earliest eta, else the highest projection
export function firstWindow(ctx: RenderContext, pace: Pace): { key: ProjKey; p: Ok } | null {
  let best: { key: ProjKey; p: Ok } | null = null;
  for (const key of ['five_hour', 'seven_day'] as const) {
    const p = projectionFor(ctx, key, pace);
    if (p?.state !== 'ok') continue;
    if (
      !best ||
      (!p.safe && (best.p.safe || p.eta < best.p.eta)) ||
      (p.safe && best.p.safe && p.proj > best.p.proj)
    ) {
      best = { key, p };
    }
  }
  return best;
}

export function warnLevel(v: number): number {
  return Number.isFinite(v) ? Math.min(1000, Math.max(1, v)) : 90;
}

// D-15: stays on down to warnAt - 5 when the newest earlier sample was at risk
export function riskOn(
  ctx: RenderContext,
  key: ProjKey,
  warnAt: number,
  pace: Pace,
): { on: boolean; proj: number } | null {
  const p = projectionFor(ctx, key, pace);
  if (p?.state !== 'ok') return null;
  const warn = warnLevel(warnAt);
  if (p.proj >= warn) return { on: true, proj: p.proj };
  if (p.proj < warn - 5) return { on: false, proj: p.proj };
  const now = ctx.now.getTime();
  const len = WINDOW_LEN[key];
  const start = p.resetsAt - len;
  const samples = samplesOf(ctx, key);
  let prev: Point | null = null;
  for (const s of samples) {
    if (!Number.isFinite(s.t) || !Number.isFinite(s.pct) || s.t >= now || s.t < start) continue;
    if (!prev || s.t > prev.t) prev = s;
  }
  if (!prev) return { on: false, proj: p.proj };
  const q = projectWindow(prev.pct, p.resetsAt, len, prev.t, { pace, samples, lookback: LOOKBACK[key] });
  return { on: q.state === 'ok' && q.proj >= warn, proj: p.proj };
}

export function projectionState(ctx: RenderContext, item: WidgetItem): 'warming' | 'ok' | 'none' {
  try {
    const w = item.type === 'usage-projection' ? itemKey(item) : itemWindow(item);
    const keys: ProjKey[] = w === 'first' ? ['five_hour', 'seven_day'] : [w];
    const states = keys.map((k) => projectionFor(ctx, k, itemPace(item))?.state ?? 'none');
    if (states.includes('ok')) return 'ok';
    return states.includes('warming') ? 'warming' : 'none';
  } catch {
    return 'none';
  }
}

export function formatProjection(p: number): string {
  return p > 200 ? '>200%' : `${Math.round(p)}%`;
}

export function riskColor(p: number, warnAt: number): 'red' | 'yellow' | 'green' {
  if (p >= 100) return 'red';
  return p >= warnAt ? 'yellow' : 'green';
}
