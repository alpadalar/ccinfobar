import type {
  OptionSpec,
  RateWindow,
  RenderContext,
  WidgetDef,
  WidgetItem,
  WidgetResult,
} from '../core/types.js';
import {
  bar,
  barOptions,
  formatCurrency,
  formatDuration,
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

const clockOption: OptionSpec = {
  key: 'showClockTime',
  label: 'Show clock time',
  kind: 'boolean',
  default: false,
};

function win(ctx: RenderContext, key: Key): RateWindow | null {
  return ctx.payload.rate_limits?.[key] ?? null;
}

function usage(ctx: RenderContext, item: WidgetItem, key: Key): WidgetResult {
  const pct = win(ctx, key)?.used_percentage;
  if (typeof pct !== 'number') return null;
  const clamped = Math.max(0, Math.min(100, pct));
  let text = `${Math.round(pct)}%`;
  if (opt<string>(item, 'display', 'percent') === 'bar') {
    const b = bar(clamped, opt(item, 'width', 10), opt<string>(item, 'style', 'blocks'));
    text = opt(item, 'showPercent', true) ? `${b} ${text}` : b;
  }
  return opt(item, 'thresholdColors', true) ? { text, color: thresholdColor(clamped) } : text;
}

function reset(ctx: RenderContext, item: WidgetItem, key: Key): string | null {
  const at = toEpochMs(win(ctx, key)?.resets_at);
  if (at === null) return null;
  const left = at - ctx.now.getTime();
  if (left <= 0) return null;
  if (opt(item, 'showClockTime', false)) {
    const d = new Date(at);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return left > 86_400_000 ? `at ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}` : `at ${hm}`;
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
    options: [displayOption, thresholdOption, ...barOptions],
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
  resetWidget('weekly-reset', 'Weekly reset', 'Resets ', 'seven_day', '3d 5h'),
  usageWidget(
    'weekly-sonnet-usage',
    'Weekly Sonnet usage',
    'Sonnet ',
    'seven_day_sonnet',
    '23%',
    'Usage of the weekly Sonnet limit',
  ),
  usageWidget(
    'weekly-opus-usage',
    'Weekly Opus usage',
    'Opus ',
    'seven_day_opus',
    '48%',
    'Usage of the weekly Opus limit',
  ),
  {
    type: 'spend-limit',
    name: 'Spend limit',
    category: 'limits',
    description: 'Extra usage spend against its limit',
    label: 'Spend ',
    icon: { nerd: '󰇁', emoji: '💳' },
    color: 'yellow',
    sample: '$12/$50',
    render(ctx) {
      const s = ctx.payload.rate_limits?.spend_limit;
      if (typeof s?.used_usd !== 'number' || typeof s.limit_usd !== 'number') return null;
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
      if (typeof rw?.used_percentage !== 'number' || at === null) return null;
      const len = WINDOW_MS[w];
      const left = Math.max(0, Math.min(len, at - ctx.now.getTime()));
      const diff = Math.round(rw.used_percentage - (1 - left / len) * 100);
      if (diff === 0) return { text: 'on pace', color: 'green' };
      return diff > 0 ? { text: `⇡${diff}%`, color: 'red' } : { text: `⇣${-diff}%`, color: 'green' };
    },
  },
];
