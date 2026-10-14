import { describe, expect, it } from 'vitest';
import type { RateWindow, StatusPayload, WidgetItem } from '../../src/core/types.js';
import type { LimitsView } from '../../src/data/limits.js';
import { getWidget } from '../../src/widgets/index.js';
import {
  formatProjection,
  LOOKBACK,
  projectionFor,
  projectionState,
  projectWindow,
  riskColor,
  WINDOW_LEN,
} from '../../src/widgets/projection.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const now = NOW.getTime();
const MIN = 60_000;
const H = 3_600_000;
const FIVE = WINDOW_LEN.five_hour;
const WEEK = WINDOW_LEN.seven_day;
const win = { pace: 'window' as const, lookback: LOOKBACK.five_hour };

const ok = (p: ReturnType<typeof projectWindow>) => {
  if (p.state !== 'ok') throw new Error('warming');
  return p;
};

const pay = (five?: RateWindow, seven?: RateWindow): StatusPayload => ({
  rate_limits: { ...(five ? { five_hour: five } : {}), ...(seven ? { seven_day: seven } : {}) },
});
const at = (msFromNow: number) => (now + msFromNow) / 1000;

const view = (key: string, w: RateWindow, samples: { t: number; pct: number }[]): LimitsView => ({
  windows: {
    [key]: {
      pct: w.used_percentage ?? 0,
      resetsAt: (w.resets_at as number) * 1000,
      at: now - 5_000,
      source: 'limits-cache',
      samples,
    },
  },
  expired: [],
  storeAt: now - 60_000,
});

const item = (options: Record<string, string> = {}): WidgetItem => ({
  id: 'p',
  type: 'usage-projection',
  options,
});

describe('projectWindow', () => {
  it('projects 92% with 25 minutes left past 100%', () => {
    const p = ok(projectWindow(92, now + 25 * MIN, FIVE, now, win));
    expect(p.proj).toBeCloseTo(100.36, 2);
    expect(p.proj).toBeGreaterThanOrEqual(100);
    expect(p.safe).toBe(false);
    expect(p.eta / MIN).toBeCloseTo(23.9, 1);
    expect(p.idle).toBe(false);
  });

  it('projects 42% with 2h14m left to about 76%, safe', () => {
    const p = ok(projectWindow(42, now + 2 * H + 14 * MIN, FIVE, now, win));
    expect(p.proj).toBeCloseTo(75.9, 1);
    expect(p.safe).toBe(true);
  });

  it('warms up for max(15 min, 5% of the window)', () => {
    expect(projectWindow(10, now + FIVE - 10 * MIN, FIVE, now, win).state).toBe('warming');
    expect(projectWindow(10, now + FIVE - 16 * MIN, FIVE, now, win).state).toBe('ok');
    const week = { pace: 'window' as const, lookback: LOOKBACK.seven_day };
    expect(projectWindow(10, now + WEEK - 8 * H, WEEK, now, week).state).toBe('warming');
    expect(projectWindow(10, now + WEEK - 9 * H, WEEK, now, week).state).toBe('ok');
    expect(projectWindow(10, now + WEEK + H, WEEK, now, week).state).toBe('warming');
  });

  it('uses the recent slope with enough samples', () => {
    const samples = [0, 1, 2, 3].map((i) => ({ t: now - (15 - 5 * i) * MIN, pct: 47 + i }));
    const p = ok(projectWindow(50, now + 2 * H, FIVE, now, { ...win, pace: 'recent', samples }));
    expect(p.proj).toBeCloseTo(74, 6);
    expect(p.eta / MIN).toBeCloseTo(250, 6);
    expect(p.safe).toBe(true);
  });

  it('falls back to the window rate with too few or too close samples', () => {
    const base = ok(projectWindow(50, now + 2 * H, FIVE, now, win)).proj;
    expect(base).toBeCloseTo(83.33, 2);
    const two = [
      { t: now - 10 * MIN, pct: 49 },
      { t: now, pct: 50 },
    ];
    const close = [0, 1, 2].map((i) => ({ t: now - (6 - 3 * i) * MIN, pct: 48 + i }));
    const old = [0, 1, 2, 3].map((i) => ({ t: now - (90 - 5 * i) * MIN, pct: 40 + i }));
    for (const samples of [two, close, old, []]) {
      const p = ok(projectWindow(50, now + 2 * H, FIVE, now, { ...win, pace: 'recent', samples }));
      expect(p.proj).toBeCloseTo(base, 6);
    }
  });

  it('projects the current value when idle', () => {
    const samples = [0, 1, 2, 3].map((i) => ({ t: now - (20 - 5 * i) * MIN, pct: 50 }));
    const p = ok(projectWindow(50, now + 2 * H, FIVE, now, { ...win, pace: 'recent', samples }));
    expect(p).toMatchObject({ proj: 50, eta: Number.POSITIVE_INFINITY, safe: true, idle: true });
  });

  it('handles zero, full and rolled windows', () => {
    expect(ok(projectWindow(0, now + 2 * H, FIVE, now, win))).toMatchObject({
      proj: 0,
      eta: Number.POSITIVE_INFINITY,
      safe: true,
    });
    expect(ok(projectWindow(100, now + 2 * H, FIVE, now, win))).toMatchObject({ eta: 0, safe: false });
    const past = ok(projectWindow(70, now - MIN, FIVE, now, win));
    expect(past.proj).toBe(70);
    expect(Number.isFinite(past.proj)).toBe(true);
  });
});

describe('formatting', () => {
  it('caps and rounds for display only', () => {
    expect(formatProjection(250)).toBe('>200%');
    expect(formatProjection(Number.POSITIVE_INFINITY)).toBe('>200%');
    expect(formatProjection(200)).toBe('200%');
    expect(formatProjection(99.6)).toBe('100%');
    expect(formatProjection(75.9)).toBe('76%');
  });

  it('colors unrounded projections', () => {
    expect(riskColor(100.36, 90)).toBe('red');
    expect(riskColor(99.6, 90)).toBe('yellow');
    expect(riskColor(90, 90)).toBe('yellow');
    expect(riskColor(89.9, 90)).toBe('green');
  });
});

describe('usage-projection', () => {
  it('renders the sample windows', () => {
    expect(renderWidget('usage-projection', ctxWith())).toBe('5h →76%');
    const week = renderWidget('usage-projection', ctxWith(), { options: { window: '7d' } });
    expect(week).toMatch(/^7d →\d+%$/);
    expect(Number(week!.slice(4, -1))).toBeLessThan(90);
  });

  it('colors by risk without rounding first', () => {
    const def = getWidget('usage-projection')!;
    const near = ctxWith({ payload: pay({ used_percentage: 92, resets_at: at(25 * MIN) }) });
    expect(def.render(near, item())).toEqual({ text: '5h →100%', color: 'red' });
    const edge = ctxWith({ payload: pay({ used_percentage: 83, resets_at: at(50 * MIN) }) });
    expect(def.render(edge, item())).toEqual({ text: '5h →100%', color: 'yellow' });
    const calm = ctxWith({ payload: pay({ used_percentage: 42, resets_at: at(2 * H + 14 * MIN) }) });
    expect(def.render(calm, item())).toEqual({ text: '5h →76%', color: 'green' });
    const hot = ctxWith({ payload: pay({ used_percentage: 90, resets_at: at(4 * H) }) });
    expect(def.render(hot, item())).toEqual({ text: '5h →>200%', color: 'red' });
  });

  it('renders the same from another session’s capture', () => {
    const w = { used_percentage: 42, resets_at: at(2 * H + 14 * MIN) };
    const c = ctxWith({ payload: pay(w), limits: () => view('five_hour', w, []) });
    expect(renderWidget('usage-projection', c)).toBe('5h →76%');
    expect(renderWidget('usage-projection', c, { options: { pace: 'recent' } })).toBe('5h →76%');
  });

  it('follows the recent trend from shared samples', () => {
    const w = { used_percentage: 50, resets_at: at(2 * H) };
    const samples = [0, 1, 2, 3].map((i) => ({ t: now - (15 - 5 * i) * MIN, pct: 47 + i }));
    const c = ctxWith({ payload: pay(w), limits: () => view('five_hour', w, samples) });
    expect(renderWidget('usage-projection', c)).toBe('5h →83%');
    expect(renderWidget('usage-projection', c, { options: { pace: 'recent' } })).toBe('5h →74%');
    const flat = samples.map((s) => ({ ...s, pct: 50 }));
    const idle = ctxWith({ payload: pay(w), limits: () => view('five_hour', w, flat) });
    expect(renderWidget('usage-projection', idle, { options: { pace: 'recent' } })).toBe('5h →50%');
  });

  it('survives a broken or missing limits view', () => {
    const w = { used_percentage: 50, resets_at: at(2 * H) };
    const broken = ctxWith({
      payload: pay(w),
      limits: () => {
        throw new Error('x');
      },
    });
    expect(renderWidget('usage-projection', broken, { options: { pace: 'recent' } })).toBe('5h →83%');
  });

  it('is empty while warming, without limits or without the window', () => {
    const warm = ctxWith({ payload: pay({ used_percentage: 3, resets_at: at(FIVE - 10 * MIN) }) });
    expect(renderWidget('usage-projection', warm)).toBeNull();
    expect(projectionState(warm, item())).toBe('warming');
    expect(projectionState(ctxWith(), item())).toBe('ok');
    const apiKey = ctxWith({ env: { ANTHROPIC_API_KEY: 'x' }, payload: {} });
    expect(renderWidget('usage-projection', apiKey)).toBeNull();
    expect(projectionState(apiKey, item())).toBe('none');
    const onlyWeek = ctxWith({
      payload: pay(undefined, { used_percentage: 20, resets_at: at(2 * 86_400_000) }),
    });
    expect(renderWidget('usage-projection', onlyWeek)).toBeNull();
    expect(renderWidget('usage-projection', onlyWeek, { options: { window: '7d' } })).toBe('7d →28%');
    expect(projectionFor(onlyWeek, 'five_hour', 'window')).toBeNull();
  });

  it('is opt-in and documented', () => {
    const def = getWidget('usage-projection')!;
    expect(def.category).toBe('limits');
    expect(def.sample).toBe('5h →76%');
    expect(def.options?.map((o) => o.key)).toEqual(['window', 'pace']);
  });
});
