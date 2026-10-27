import { formatWeekday } from '../core/i18n/format.js';
import { languageLocale, t } from '../core/i18n/index.js';
import type {
  ModelWindow,
  OptionSpec,
  RateWindow,
  RenderContext,
  WidgetDef,
  WidgetItem,
  WidgetResult,
} from '../core/types.js';
import {
  firstWindow,
  formatProjection,
  itemKey,
  itemPace,
  itemWindow,
  type Projection,
  projectionFor,
  projectionState,
  riskColor,
  riskOn,
  WINDOW_LABEL,
  warnLevel,
} from './projection.js';
import {
  barFor,
  barOptions,
  formatCurrency,
  formatDuration,
  limitsLoading,
  opt,
  thresholdColor,
  thresholdOption,
  toEpochMs,
} from './shared.js';

type Key = 'five_hour' | 'seven_day' | 'seven_day_sonnet' | 'seven_day_opus';

const displayOption: OptionSpec = {
  key: 'display',
  label: 'Display',
  kind: 'select',
  default: 'percent',
  choices: [
    { value: 'percent', label: 'Percent' },
    { value: 'bar', label: 'Bar' },
  ],
};

const paceOption: OptionSpec = {
  key: 'showPace',
  label: 'Show even pace',
  kind: 'boolean',
  default: false,
  help: 'Adds where an even burn would be by now: 60%/40%, and a ◆/◇ marker in bars',
};

const clockOption: OptionSpec = {
  key: 'showClockTime',
  label: 'Show clock time',
  kind: 'boolean',
  default: false,
};

const projectionWindowOption: OptionSpec = {
  key: 'window',
  label: 'Window',
  kind: 'select',
  default: '5h',
  choices: [
    { value: '5h', label: '5 hours' },
    { value: '7d', label: '7 days' },
  ],
};

export const projectionPaceOption: OptionSpec = {
  key: 'pace',
  label: 'Pace',
  kind: 'select',
  default: 'window',
  choices: [
    { value: 'window', label: 'Window average' },
    { value: 'recent', label: 'Recent trend' },
  ],
  help: 'Window: average since the window started. Recent: trend of the last 30 minutes (5h) or 12 hours (7d)',
};

const limitWindowOption: OptionSpec = {
  key: 'window',
  label: 'Window',
  kind: 'select',
  default: 'first',
  choices: [
    { value: 'first', label: 'Whichever runs out first' },
    { value: '5h', label: '5 hours' },
    { value: '7d', label: '7 days' },
  ],
};

// window prefix only for "first"
function pickWindow(
  ctx: RenderContext,
  item: WidgetItem,
): { prefix: string; p: Projection & { state: 'ok' } } | 'warming' | null {
  const pace = itemPace(item);
  const w = itemWindow(item);
  if (w === 'first') {
    const f = firstWindow(ctx, pace);
    if (f) return { prefix: `${WINDOW_LABEL[f.key]} `, p: f.p };
    return projectionState(ctx, item) === 'warming' ? 'warming' : null;
  }
  const p = projectionFor(ctx, w, pace);
  if (!p) return null;
  return p.state === 'warming' ? 'warming' : { prefix: '', p };
}

function riskChip(ctx: RenderContext, item: WidgetItem): WidgetResult {
  const warnAt = warnLevel(opt(item, 'warnAt', 90));
  const pace = itemPace(item);
  const w = itemWindow(item);
  const keys = w === 'first' ? (['five_hour', 'seven_day'] as const) : [w];
  let best: { key: (typeof keys)[number]; proj: number } | null = null;
  let known = false;
  for (const key of keys) {
    const r = riskOn(ctx, key, warnAt, pace);
    if (r) known = true;
    if (r?.on && (!best || r.proj > best.proj)) best = { key, proj: r.proj };
  }
  if (!best) return known || projectionState(ctx, item) === 'warming' ? null : limitsLoading(ctx, item);
  const prefix = w === 'first' ? `${WINDOW_LABEL[best.key]} ` : '';
  return { text: `${prefix}${formatProjection(best.proj)}`, color: best.proj >= 100 ? 'red' : 'yellow' };
}

function etaText(ms: number): string {
  return formatDuration(ms < 60_000 ? ms : Math.round(ms / 60_000) * 60_000);
}

function win(ctx: RenderContext, key: Key): RateWindow | null {
  return ctx.payload.rate_limits?.[key] ?? null;
}

const WINDOW_OF: Record<Key, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 86_400_000,
  seven_day_sonnet: 7 * 86_400_000,
  seven_day_opus: 7 * 86_400_000,
};

export function evenPace(ctx: RenderContext, key: Key): number | null {
  return paceOf(ctx, win(ctx, key), WINDOW_OF[key]);
}

export function modelWindows(ctx: RenderContext): ModelWindow[] {
  const r = ctx.payload.rate_limits;
  const out = [...(r?.seven_day_models ?? [])];
  const legacy = [
    ['Sonnet', r?.seven_day_sonnet],
    ['Opus', r?.seven_day_opus],
  ] as const;
  for (const [model, w] of legacy) {
    if (w && !out.some((m) => m.model.toLowerCase() === model.toLowerCase())) out.push({ model, ...w });
  }
  return out;
}

// empty name: first model with a limit
export function modelWindow(ctx: RenderContext, name: string): ModelWindow | null {
  const list = modelWindows(ctx);
  const want = name.trim().toLowerCase();
  return (want ? list.find((m) => m.model.toLowerCase().includes(want)) : list[0]) ?? null;
}

function paceOf(ctx: RenderContext, w: RateWindow | null, len: number): number | null {
  const at = toEpochMs(w?.resets_at);
  if (at === null) return null;
  const left = Math.max(0, Math.min(len, at - ctx.now.getTime()));
  return Math.round((1 - left / len) * 100);
}

function usage(ctx: RenderContext, item: WidgetItem, key: Key): WidgetResult {
  return usageOf(ctx, item, win(ctx, key), WINDOW_OF[key]);
}

function usageOf(ctx: RenderContext, item: WidgetItem, w: RateWindow | null, len: number): WidgetResult {
  const pct = w?.used_percentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return limitsLoading(ctx, item);
  const clamped = Math.max(0, Math.min(100, pct));
  const pace = opt(item, 'showPace', false) ? paceOf(ctx, w, len) : null;
  let text = pace === null ? `${Math.round(pct)}%` : `${Math.round(pct)}%/${pace}%`;
  if (opt<string>(item, 'display', 'percent') === 'bar') {
    const b = barFor(ctx, item, clamped, pace);
    text = opt(item, 'showPercent', true) ? `${b} ${text}` : b;
  }
  return opt(item, 'thresholdColors', true) ? { text, color: thresholdColor(clamped) } : text;
}

function reset(ctx: RenderContext, item: WidgetItem, key: Key): WidgetResult {
  return resetOf(ctx, item, win(ctx, key));
}

function resetOf(ctx: RenderContext, item: WidgetItem, w: RateWindow | null): WidgetResult {
  const at = toEpochMs(w?.resets_at);
  if (at === null) return limitsLoading(ctx, item);
  const left = at - ctx.now.getTime();
  if (left <= 0) return null;
  if (opt(item, 'showClockTime', false)) {
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return left > 86_400_000
      ? t('widget.limit.atDay', { day: formatWeekday(d, languageLocale()), time: hm })
      : t('widget.limit.at', { time: hm });
  }
  return formatDuration(left);
}

function usageWidget(
  type: string,
  name: string,
  label: string,
  key: Key,
  sample: string,
  description: string,
): WidgetDef {
  return {
    type,
    name,
    category: 'limits',
    description,
    label,
    icon: { nerd: '󰾆', emoji: '📊' },
    color: 'green',
    sample,
    options: [displayOption, thresholdOption, paceOption, ...barOptions],
    render: (ctx, item) => usage(ctx, item, key),
  };
}

function resetWidget(type: string, name: string, label: string, key: Key, sample: string): WidgetDef {
  return {
    type,
    name,
    category: 'limits',
    description: `Time until the ${name.toLowerCase().replace(' reset', '')} window resets`,
    label,
    icon: { nerd: '󰑓', emoji: '🔄' },
    color: 'blue',
    sample,
    options: [clockOption],
    render: (ctx, item) => reset(ctx, item, key),
  };
}

const WINDOW_MS = { '5h': 5 * 3_600_000, '7d': 7 * 86_400_000 };
const WEEK = 7 * 86_400_000;

const modelOption: OptionSpec = {
  key: 'model',
  label: 'Model',
  kind: 'text',
  default: '',
  help: 'Model name such as Fable; empty shows whichever model has a weekly limit',
};

// kept for old configs
function legacyModel(type: string, model: string): WidgetDef {
  return {
    ...usageWidget(
      type,
      `Weekly ${model} usage`,
      `${model} `,
      'seven_day',
      '23%',
      `Usage of the weekly ${model} limit`,
    ),
    hidden: true,
    render: (ctx, item) => usageOf(ctx, item, modelWindow(ctx, model), WEEK),
  };
}

export const widgets: WidgetDef[] = [
  usageWidget(
    'five-hour-usage',
    'Five-hour usage',
    '5h ',
    'five_hour',
    '42%',
    'Usage of the 5-hour rate limit',
  ),
  resetWidget('five-hour-reset', 'Five-hour reset', 'Resets ', 'five_hour', '2h 14m'),
  usageWidget('weekly-usage', 'Weekly usage', '7d ', 'seven_day', '61%', 'Usage of the weekly rate limit'),
  resetWidget('weekly-reset', 'Weekly reset', 'Resets ', 'seven_day', '1d 5h'),
  {
    type: 'weekly-model-usage',
    name: 'Weekly model limit',
    category: 'limits',
    description: 'Weekly limit of a single model, such as Fable, when your plan has one',
    label: '',
    icon: { nerd: '󰾆', emoji: '📊' },
    color: 'magenta',
    sample: 'Fable 23%',
    options: [modelOption, displayOption, thresholdOption, paceOption, ...barOptions],
    render(ctx, item) {
      const m = modelWindow(ctx, opt(item, 'model', ''));
      if (!m) return limitsLoading(ctx, item);
      const r = usageOf(ctx, item, m, WEEK);
      if (!r) return null;
      return typeof r === 'string' ? `${m.model} ${r}` : { ...r, text: `${m.model} ${r.text}` };
    },
  },
  {
    type: 'weekly-model-reset',
    name: 'Weekly model reset',
    category: 'limits',
    description: 'Time until a single model’s weekly limit resets',
    label: 'Resets ',
    icon: { nerd: '󰑓', emoji: '🔄' },
    color: 'blue',
    sample: '1d 5h',
    options: [modelOption, clockOption],
    render: (ctx, item) => resetOf(ctx, item, modelWindow(ctx, opt(item, 'model', ''))),
  },
  legacyModel('weekly-sonnet-usage', 'Sonnet'),
  legacyModel('weekly-opus-usage', 'Opus'),
  {
    type: 'spend-limit',
    name: 'Spend limit',
    category: 'limits',
    description: 'Extra usage spend against its limit',
    label: 'Spend ',
    icon: { nerd: '󰇁', emoji: '💳' },
    color: 'yellow',
    sample: '$12/$50',
    render(ctx, item) {
      const s = ctx.payload.rate_limits?.spend_limit;
      if (typeof s?.used_usd !== 'number' || typeof s.limit_usd !== 'number') return limitsLoading(ctx, item);
      const f = (n: number) => formatCurrency(n, Number.isInteger(n) ? 0 : 2);
      return `${f(s.used_usd)}/${f(s.limit_usd)}`;
    },
  },
  {
    type: 'usage-pace',
    name: 'Usage pace',
    category: 'limits',
    description: 'Usage compared with an even burn over the window',
    label: 'Pace ',
    icon: { nerd: '󰓅', emoji: '🏃' },
    color: 'green',
    sample: '⇣13%',
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
    ],
    render(ctx, item) {
      const w = opt<string>(item, 'window', '5h') === '7d' ? '7d' : '5h';
      const rw = win(ctx, w === '7d' ? 'seven_day' : 'five_hour');
      const at = toEpochMs(rw?.resets_at);
      if (typeof rw?.used_percentage !== 'number' || at === null) return limitsLoading(ctx, item);
      const len = WINDOW_MS[w];
      const left = Math.max(0, Math.min(len, at - ctx.now.getTime()));
      const diff = Math.round(rw.used_percentage - (1 - left / len) * 100);
      if (diff === 0) return { text: t('widget.limit.onPace'), color: 'green' };
      return diff > 0 ? { text: `⇡${diff}%`, color: 'red' } : { text: `⇣${-diff}%`, color: 'green' };
    },
  },
  {
    type: 'usage-projection',
    timeBased: true,
    name: 'Usage projection',
    category: 'limits',
    description: 'Expected usage at the end of the window at the current pace',
    label: '',
    icon: { nerd: '󰓅', emoji: '🏃' },
    color: 'green',
    sample: '5h →76%',
    options: [projectionWindowOption, projectionPaceOption],
    render(ctx, item) {
      const key = itemKey(item);
      const p = projectionFor(ctx, key, itemPace(item));
      if (!p) return limitsLoading(ctx, item);
      if (p.state === 'warming') return null;
      const w = key === 'seven_day' ? '7d' : '5h';
      return { text: `${w} →${formatProjection(p.proj)}`, color: riskColor(p.proj, 90) };
    },
  },
  {
    type: 'limit-eta',
    timeBased: true,
    name: 'Limit ETA',
    category: 'limits',
    description: 'Time until a usage limit reaches 100% at the current pace',
    label: 'ETA ',
    icon: { nerd: '󰑓', emoji: '🔄' },
    color: 'yellow',
    sample: '100% in 1h 12m',
    options: [
      limitWindowOption,
      projectionPaceOption,
      { key: 'hideWhenSafe', label: 'Hide when safe', kind: 'boolean', default: false },
    ],
    render(ctx, item) {
      const r = pickWindow(ctx, item);
      if (r === 'warming') return null;
      if (!r) return limitsLoading(ctx, item);
      const { prefix, p } = r;
      if (p.used >= 100) return { text: `${prefix}${t('widget.limit.reached')}`, color: 'red' };
      if (p.safe)
        return opt(item, 'hideWhenSafe', false) ? null : { text: t('widget.limit.safe'), color: 'green' };
      return { text: `${prefix}${t('widget.limit.eta', { time: etaText(p.eta) })}`, color: 'yellow' };
    },
  },
  {
    type: 'limit-risk',
    timeBased: true,
    name: 'Limit risk',
    category: 'limits',
    description: 'Warning chip when a usage limit is projected to run out before it resets',
    label: '',
    icon: { nerd: '\uf071', emoji: '\u26a0\ufe0f', text: '!' },
    color: 'yellow',
    sample: '5h 112%',
    options: [
      limitWindowOption,
      {
        key: 'warnAt',
        label: 'Warn at (%)',
        kind: 'number',
        default: 90,
        help: 'Show the chip from this projected percentage',
      },
      projectionPaceOption,
    ],
    render: riskChip,
  },
];
