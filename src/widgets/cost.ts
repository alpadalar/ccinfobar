import type { OptionSpec, WidgetDef } from '../core/types.js';
import { formatCurrency, formatDuration, opt } from './shared.js';

const durationOption: OptionSpec = {
  key: 'format',
  label: 'Format',
  kind: 'select',
  default: 'compact',
  choices: [
    { value: 'compact', label: '1h 12m' },
    { value: 'clock', label: '01:12:00' },
  ],
};

export const widgets: WidgetDef[] = [
  {
    type: 'session-cost',
    name: 'Session cost',
    category: 'cost',
    description: 'Total cost of this session in USD',
    icon: { nerd: '󰈸', emoji: '💰' },
    color: 'yellow',
    sample: '$1.87',
    options: [{ key: 'decimals', label: 'Decimals', kind: 'number', default: 2 }],
    render(ctx, item) {
      const c = ctx.payload.cost?.total_cost_usd;
      return typeof c === 'number' ? formatCurrency(c, opt(item, 'decimals', 2)) : null;
    },
  },
  {
    type: 'cost-rate',
    name: 'Cost rate',
    category: 'cost',
    description: 'Burn rate in USD per hour',
    icon: { nerd: '󰓅', emoji: '🔥' },
    color: 'yellow',
    sample: '$2.47/h',
    options: [{ key: 'decimals', label: 'Decimals', kind: 'number', default: 2 }],
    render(ctx, item) {
      const cost = ctx.payload.cost?.total_cost_usd;
      const ms = ctx.payload.cost?.total_duration_ms;
      if (typeof cost !== 'number' || typeof ms !== 'number' || ms < 60_000) return null;
      return `${formatCurrency(cost / (ms / 3_600_000), opt(item, 'decimals', 2))}/h`;
    },
  },
  {
    type: 'session-duration',
    name: 'Session duration',
    category: 'cost',
    description: 'Wall-clock time of this session',
    icon: { nerd: '󰔟', emoji: '⏱️' },
    color: 'blue',
    sample: '45m',
    options: [durationOption],
    render(ctx, item) {
      const ms = ctx.payload.cost?.total_duration_ms;
      return typeof ms === 'number'
        ? formatDuration(ms, opt<string>(item, 'format', 'compact') !== 'clock')
        : null;
    },
  },
  {
    type: 'api-duration',
    name: 'API duration',
    category: 'cost',
    description: 'Time spent waiting on the API',
    label: 'API ',
    icon: { nerd: '󰔟', emoji: '🌐' },
    color: 'blue',
    sample: '13m',
    options: [durationOption],
    render(ctx, item) {
      const ms = ctx.payload.cost?.total_api_duration_ms;
      return typeof ms === 'number'
        ? formatDuration(ms, opt<string>(item, 'format', 'compact') !== 'clock')
        : null;
    },
  },
  {
    type: 'lines-changed',
    name: 'Lines changed',
    category: 'cost',
    description: 'Lines added and removed this session',
    icon: { nerd: '󰦒', emoji: '✏️' },
    color: 'green',
    sample: '+214 -63',
    options: [{ key: 'hideZero', label: 'Hide when no changes', kind: 'boolean', default: false }],
    render(ctx, item) {
      const c = ctx.payload.cost;
      if (typeof c?.total_lines_added !== 'number' && typeof c?.total_lines_removed !== 'number') return null;
      const a = c.total_lines_added ?? 0;
      const r = c.total_lines_removed ?? 0;
      if (a === 0 && r === 0 && opt(item, 'hideZero', false)) return null;
      return `+${a} -${r}`;
    },
  },
  {
    type: 'message-count',
    name: 'Message count',
    category: 'cost',
    description: 'Messages in the transcript',
    label: 'Msgs ',
    icon: { nerd: '󰍡', emoji: '💬' },
    color: 'blue',
    sample: '86',
    render(ctx) {
      const t = ctx.data.transcript();
      return t ? String(t.messageCount) : null;
    },
  },
];
