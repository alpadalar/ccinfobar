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

// pct per ms, null below the fit minimum
function slope(points: Point[]): number | null {
  if (points.length < MIN_POINTS) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let st = 0;
  let sp = 0;
  for (const p of points) {
    lo = Math.min(lo, p.t);
    hi = Math.max(hi, p.t);
    st += p.t;
    sp += p.pct;
  }
  if (hi - lo < MIN_SPAN) return null;
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
    const pts = (opts.samples ?? []).filter(
      (s) => Number.isFinite(s.t) && Number.isFinite(s.pct) && s.t >= from && s.t <= now,
    );
    const k = slope(pts);
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

export function itemKey(item: WidgetItem): ProjKey {
  return opt<string>(item, 'window', '5h') === '7d' ? 'seven_day' : 'five_hour';
}

export function itemPace(item: WidgetItem): Pace {
  return opt<string>(item, 'pace', 'window') === 'recent' ? 'recent' : 'window';
}

export function projectionState(ctx: RenderContext, item: WidgetItem): 'warming' | 'ok' | 'none' {
  try {
    const p = projectionFor(ctx, itemKey(item), itemPace(item));
    return p ? p.state : 'none';
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
