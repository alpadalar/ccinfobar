import path from 'node:path';
import { detectProvider } from '../data/provider.js';
import { findUp, insideRepo } from '../data/repos.js';
import { contextPercent, windowSize } from '../widgets/context.js';
import { riskOn } from '../widgets/projection.js';
import { itemVisible, type MetricValue, type Visibility } from './conditions.js';
import type { DataSources, RenderContext, WidgetItem } from './types.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const WINDOWS: ReadonlyMap<string, 'five_hour' | 'seven_day'> = new Map([
  ['usage.5h', 'five_hour'],
  ['usage.7d', 'seven_day'],
]);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (v: number | null): number | null => (v === null ? null : Math.round(v));
const cents = (v: unknown): number | null => (num(v) ? Math.round(v * 100) / 100 : null);

function usage(ctx: RenderContext, key: 'five_hour' | 'seven_day'): number | null {
  const p = ctx.payload.rate_limits?.[key]?.used_percentage;
  if (num(p)) return Math.round(p);
  const w = ctx.data.limits?.()?.windows[key]?.pct;
  return num(w) ? Math.round(w) : null;
}

function running(ctx: RenderContext): number {
  return ctx.data.agents().filter((a) => a.running).length;
}

function tokensTotal(ctx: RenderContext): number | null {
  const cw = ctx.payload.context_window;
  if (num(cw?.total_input_tokens) || num(cw?.total_output_tokens)) {
    return (cw?.total_input_tokens ?? 0) + (cw?.total_output_tokens ?? 0);
  }
  const t = ctx.data.transcript();
  return t ? t.inputTokens + t.outputTokens : null;
}

// the limit-risk widget defaults: warnAt 90, window pace, either window
function limitRisk(ctx: RenderContext): boolean | null {
  let known = false;
  for (const key of ['five_hour', 'seven_day'] as const) {
    const r = riskOn(ctx, key, 90, 'window');
    if (r?.on) return true;
    if (r) known = true;
  }
  return known ? false : null;
}

type Getter = (ctx: RenderContext, get: (name: string) => MetricValue) => MetricValue;

const GETTERS: ReadonlyMap<string, Getter> = new Map<string, Getter>([
  ['context.pct', (ctx) => pct(contextPercent(ctx, 'raw'))],
  ['context.usable', (ctx) => pct(contextPercent(ctx, 'usable'))],
  ['usage.5h', (ctx) => usage(ctx, 'five_hour')],
  ['usage.7d', (ctx) => usage(ctx, 'seven_day')],
  ['cost.session', (ctx) => cents(ctx.payload.cost?.total_cost_usd)],
  ['cost.today', (ctx) => cents(ctx.data.ledger?.()?.today)],
  ['tokens.total', tokensTotal],
  ['agents.running', running],
  [
    'agents',
    (_, get) => {
      const n = get('agents.running');
      return typeof n === 'number' ? n > 0 : null;
    },
  ],
  ['time.hour', (ctx) => ctx.now.getHours()],
  ['time.weekday', (ctx) => DAYS[ctx.now.getDay()] ?? null],
  ['provider', (ctx) => detectProvider(ctx.env).kind],
  ['git', (ctx) => insideRepo(ctx.cwd, path, { env: ctx.env }) !== null],
  ['gsd', (ctx) => findUp(ctx.cwd, '.planning', 'dir') !== null],
  ['limit-risk', limitRisk],
  [
    'permission.waiting',
    (ctx) => {
      if (!ctx.data.hooks) return null;
      const h = ctx.data.hooks();
      return h ? h.pendingPermission !== null : null;
    },
  ],
]);

const memo = new WeakMap<DataSources, Map<string, MetricValue>>();

export function hasItemRules(item: WidgetItem): boolean {
  return item.showWhen !== undefined || item.hideWhen !== undefined;
}

export function metricGetter(ctx: RenderContext): (name: string) => MetricValue {
  let values = memo.get(ctx.data);
  if (!values) {
    values = new Map();
    memo.set(ctx.data, values);
  }
  const cache = values;
  const get = (name: string): MetricValue => {
    if (cache.has(name)) return cache.get(name)!;
    let v: MetricValue = null;
    try {
      v = GETTERS.get(name)?.(ctx, get) ?? null;
    } catch {}
    if (typeof v === 'number' && !Number.isFinite(v)) v = null;
    cache.set(name, v);
    return v;
  };
  return get;
}

// before now, oldest first
function series<T extends { t: number }>(
  list: readonly T[],
  now: number,
  value: (s: T) => number | null,
): number[] {
  const out: [number, number][] = [];
  for (const s of list) {
    if (!num(s.t) || s.t >= now) continue;
    const v = value(s);
    if (num(v)) out.push([s.t, Math.round(v)]);
  }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

export function metricPrev(ctx: RenderContext): (name: string) => number[] | null {
  return (name) => {
    try {
      const now = ctx.now.getTime();
      const key = WINDOWS.get(name);
      if (key) {
        const list = series(ctx.data.limits?.()?.windows[key]?.samples ?? [], now, (x) => x.pct);
        return list.length ? list : null;
      }
      if (name === 'context.pct' && ctx.data.history) {
        const size = windowSize(ctx);
        if (!size) return null;
        const list = series(ctx.data.history(), now, (x) =>
          num(x.ctx) ? Math.max(0, Math.min(100, (x.ctx / size) * 100)) : null,
        );
        return list.length ? list : null;
      }
    } catch {}
    return null;
  };
}

export function ruleDecision(ctx: RenderContext, item: WidgetItem): Visibility {
  return itemVisible(item, metricGetter(ctx), metricPrev(ctx));
}
