import type { OptionSpec, RenderContext, WidgetDef, WidgetItem, WidgetResult } from '../core/types.js';
import { type HistorySample, loadHistory, recordHistory } from '../data/history.js';
import { contextTokens, windowSize } from './context.js';
import { fillOption, formatCurrency, formatTokens, opt, sparkline, thresholdColor } from './shared.js';

const memo = new WeakMap<RenderContext, HistorySample[]>();

function snapshot(ctx: RenderContext): HistorySample {
  const p = ctx.payload;
  const cw = p.context_window;
  const s: HistorySample = { t: ctx.now.getTime() };
  if (typeof cw?.total_input_tokens === 'number' || typeof cw?.total_output_tokens === 'number') {
    s.tok = (cw.total_input_tokens ?? 0) + (cw.total_output_tokens ?? 0);
  }
  const used = contextTokens(ctx);
  if (used !== null) s.ctx = used;
  if (typeof p.cost?.total_cost_usd === 'number') s.cost = p.cost.total_cost_usd;
  const h5 = p.rate_limits?.five_hour?.used_percentage;
  const d7 = p.rate_limits?.seven_day?.used_percentage;
  if (typeof h5 === 'number') s.h5 = h5;
  if (typeof d7 === 'number') s.d7 = d7;
  const spd = ctx.data.transcript()?.outputSpeed;
  if (typeof spd === 'number' && spd > 0) s.spd = Math.round(spd);
  return s;
}

// history is only kept when a chart is shown
export function series(ctx: RenderContext): HistorySample[] {
  const hit = memo.get(ctx);
  if (hit) return hit;
  let out: HistorySample[];
  if (ctx.data.history) out = ctx.data.history();
  else if (ctx.preview) out = loadHistory(ctx.payload.session_id, ctx.env);
  else out = recordHistory(ctx.payload.session_id, snapshot(ctx), ctx.env);
  memo.set(ctx, out);
  return out;
}

function rates(samples: HistorySample[], key: 'tok' | 'cost', per: number): number[] {
  const out: number[] = [];
  let prev: HistorySample | undefined;
  for (const s of samples) {
    if (typeof s[key] !== 'number') continue;
    if (prev && s.t > prev.t) out.push(Math.max(0, ((s[key]! - prev[key]!) / (s.t - prev.t)) * per));
    prev = s;
  }
  return out;
}

const points: OptionSpec = {
  key: 'points',
  label: 'Points',
  kind: 'number',
  default: 16,
  help: 'How many samples the graph shows; one sample every few seconds',
};
const showValue: OptionSpec = { key: 'showValue', label: 'Show value', kind: 'boolean', default: true };

// zoom in on small moves, keep at least 10 points of range
function pctScale(values: number[], width: number): { min: number; max: number } {
  const recent = values.slice(-width);
  const lo = Math.min(...recent);
  const hi = Math.max(...recent);
  const min = Math.max(0, Math.floor(lo - 1));
  return { min, max: Math.min(100, Math.max(hi, min + 10)) };
}

const width = (item: WidgetItem, extra = 0) =>
  Math.max(4, Math.min(60, opt(item, 'points', 16))) + (opt(item, 'fill', false) ? extra : 0);

function chart(
  ctx: RenderContext,
  item: WidgetItem,
  values: number[],
  value: string | null,
  scale: { min?: number; max?: number } = {},
  color?: string,
): WidgetResult {
  if (values.length < 2 || value === null) return null;
  const graph = sparkline(values, width(item, ctx.extra), { ...scale, ascii: ctx.config.charset === 'text' });
  const text = opt(item, 'showValue', true) ? `${graph} ${value}` : graph;
  return color ? { text, color } : text;
}

export const widgets: WidgetDef[] = [
  {
    type: 'token-rate-graph',
    name: 'Token rate graph',
    category: 'charts',
    description: 'Tokens per minute over the last few minutes, as a moving sparkline',
    label: 'Tok/m ',
    icon: { nerd: '󰄧', emoji: '📈' },
    color: 'cyan',
    sample: '▁▂▅▇▆▃▂▄ 12k',
    options: [points, showValue, fillOption],
    render(ctx, item) {
      const r = rates(series(ctx), 'tok', 60_000);
      return chart(ctx, item, r, r.length ? formatTokens(r[r.length - 1]!) : null);
    },
  },
  {
    type: 'output-speed-graph',
    name: 'Output speed graph',
    category: 'charts',
    description: 'Output tokens per second while Claude writes, as a moving sparkline',
    label: 'Speed ',
    icon: { nerd: '󰓅', emoji: '🚀' },
    color: 'cyan',
    sample: '▃▅▇▆▄▅▆▇ 72 t/s',
    options: [points, showValue, fillOption],
    render(ctx, item) {
      const v = series(ctx)
        .map((s) => s.spd)
        .filter((x): x is number => typeof x === 'number');
      return chart(ctx, item, v, v.length ? `${v[v.length - 1]} t/s` : null);
    },
  },
  {
    type: 'context-graph',
    name: 'Context graph',
    category: 'charts',
    description: 'How full the context window has been over time',
    label: 'Ctx ',
    icon: { nerd: '󰄧', emoji: '📈' },
    color: 'green',
    sample: '▁▁▂▃▃▄▅▅ 34%',
    options: [points, showValue, fillOption],
    render(ctx, item) {
      const size = windowSize(ctx);
      if (!size) return null;
      const pct = series(ctx)
        .filter((s) => typeof s.ctx === 'number')
        .map((s) => (s.ctx! / size) * 100);
      const last = pct[pct.length - 1];
      return chart(
        ctx,
        item,
        pct,
        last === undefined ? null : `${Math.round(last)}%`,
        pct.length ? pctScale(pct, width(item)) : {},
        last === undefined ? undefined : thresholdColor(last),
      );
    },
  },
  {
    type: 'usage-graph',
    name: 'Usage graph',
    category: 'charts',
    description: 'Your 5-hour or weekly usage over time',
    label: '5h ',
    icon: { nerd: '󰄧', emoji: '📈' },
    color: 'yellow',
    sample: '▃▃▄▄▅▅▆▆ 42%',
    options: [
      {
        key: 'window',
        label: 'Window',
        kind: 'select',
        default: '5h',
        choices: [
          { value: '5h', label: '5 hours' },
          { value: '7d', label: '7 days' },
        ],
      },
      points,
      showValue,
      fillOption,
    ],
    render(ctx, item) {
      const key = opt<string>(item, 'window', '5h') === '7d' ? 'd7' : 'h5';
      const pct = series(ctx)
        .map((s) => s[key])
        .filter((v): v is number => typeof v === 'number');
      const last = pct[pct.length - 1];
      return chart(
        ctx,
        item,
        pct,
        last === undefined ? null : `${Math.round(last)}%`,
        pct.length ? pctScale(pct, width(item)) : {},
        last === undefined ? undefined : thresholdColor(last),
      );
    },
  },
  {
    type: 'cost-graph',
    name: 'Spend rate graph',
    category: 'charts',
    description: 'Dollars per hour over the last few minutes',
    label: '$/h ',
    icon: { nerd: '󰄧', emoji: '📈' },
    color: 'yellow',
    sample: '▂▂▃▆▇▅▃▂ $2.47',
    options: [points, showValue, fillOption],
    render(ctx, item) {
      const r = rates(series(ctx), 'cost', 3_600_000);
      return chart(ctx, item, r, r.length ? formatCurrency(r[r.length - 1]!, 2) : null);
    },
  },
];
