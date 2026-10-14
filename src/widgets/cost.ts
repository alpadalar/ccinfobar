import type { OptionSpec, RenderContext, WidgetDef, WidgetItem, WidgetResult } from '../core/types.js';
import { barFor, barOptions, formatCurrency, formatDuration, opt } from './shared.js';

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

const decimalsOption: OptionSpec = { key: 'decimals', label: 'Decimals', kind: 'number', default: 2 };

export function budgetColor(fraction: number, warnAt: number): 'red' | 'yellow' | null {
  if (fraction >= 1) return 'red';
  return fraction >= warnAt ? 'yellow' : null;
}

export const budgetPeriod = (item: WidgetItem): 'daily' | 'session' =>
  item.options?.period === 'session' ? 'session' : 'daily';

function budget(ctx: RenderContext, item: WidgetItem): WidgetResult {
  const period = budgetPeriod(item);
  const limit = ctx.config.budget?.[period];
  if (typeof limit !== 'number' || !(limit > 0)) return null;
  const spend = period === 'session' ? ctx.payload.cost?.total_cost_usd : ctx.data.ledger?.()?.today;
  if (typeof spend !== 'number' || !Number.isFinite(spend)) return null;
  const fraction = Math.max(0, spend) / limit;
  const pct = `${Math.round(fraction * 100)}%`;
  const display = opt<string>(item, 'display', 'amount');
  let text: string;
  if (display === 'percent') text = pct;
  else if (display === 'bar') {
    const b = barFor(ctx, item, Math.min(100, fraction * 100));
    text = opt(item, 'showPercent', true) ? `${b} ${pct}` : b;
  } else {
    const d = opt(item, 'decimals', 2);
    text = `~${formatCurrency(spend, d)}/${formatCurrency(limit, Number.isInteger(limit) ? 0 : d)}`;
  }
  const color = budgetColor(fraction, ctx.config.budget?.warnAt ?? 0.8);
  return color ? { text, color } : text;
}

const forBar = { key: 'display', values: ['bar'] };

export const widgets: WidgetDef[] = [
  {
    type: 'session-cost',
    name: 'Session cost',
    category: 'cost',
    description: 'Total cost of this session in USD',
    icon: { nerd: '󰈸', emoji: '💰' },
    color: 'yellow',
    sample: '$1.87',
    options: [decimalsOption],
    render(ctx, item) {
      const c = ctx.payload.cost?.total_cost_usd;
      return typeof c === 'number' ? formatCurrency(c, opt(item, 'decimals', 2)) : null;
    },
  },
  {
    type: 'cost-today',
    name: 'Cost today',
    category: 'cost',
    description: 'Estimated cost of all sessions today (from the local ledger)',
    label: 'Today ~',
    icon: { nerd: '󰈸', emoji: '💰' },
    color: 'yellow',
    sample: '$4.12',
    options: [decimalsOption],
    render(ctx, item) {
      const view = ctx.data.ledger?.();
      return view ? formatCurrency(view.today, opt(item, 'decimals', 2)) : null;
    },
  },
  {
    type: 'cost-week',
    name: 'Cost this week',
    category: 'cost',
    description: 'Estimated cost of all sessions this ISO week, Monday to Sunday, local time',
    label: 'Week ~',
    icon: { nerd: '󰈸', emoji: '💰' },
    color: 'yellow',
    sample: '$18.40',
    options: [decimalsOption],
    render(ctx, item) {
      const view = ctx.data.ledger?.();
      return view ? formatCurrency(view.week, opt(item, 'decimals', 2)) : null;
    },
  },
  {
    type: 'cost-project',
    name: 'Project cost',
    category: 'cost',
    description: 'Estimated cost of this project across sessions',
    label: 'Project ~',
    icon: { nerd: '󰈸', emoji: '💰' },
    color: 'yellow',
    sample: '$62',
    options: [
      {
        key: 'period',
        label: 'Period',
        kind: 'select',
        default: 'all',
        choices: [
          { value: 'today', label: 'Today' },
          { value: 'week', label: 'This week' },
          { value: 'month', label: 'This month' },
          { value: 'all', label: 'All' },
        ],
        help: 'All: since the ledger started (rows are kept 400 days)',
      },
      decimalsOption,
    ],
    render(ctx, item) {
      const view = ctx.data.ledger?.();
      if (!view) return null;
      const p = opt<string>(item, 'period', 'all');
      const key = p === 'today' || p === 'week' || p === 'month' ? p : 'all';
      return formatCurrency(view.project[key], opt(item, 'decimals', 2));
    },
  },
  {
    type: 'budget',
    name: 'Budget',
    category: 'cost',
    description: 'Estimated spend against your daily or session budget',
    label: 'Budget ',
    icon: { nerd: '󰈸', emoji: '💰' },
    color: 'green',
    sample: '~$4.10/$10',
    options: [
      {
        key: 'period',
        label: 'Period',
        kind: 'select',
        default: 'daily',
        choices: [
          { value: 'daily', label: 'Today (budget.daily)' },
          { value: 'session', label: 'This session (budget.session)' },
        ],
        help: 'Set the amount in Settings or with ccinfobar config set budget.daily 10',
      },
      {
        key: 'display',
        label: 'Display',
        kind: 'select',
        default: 'amount',
        choices: [
          { value: 'amount', label: '~$4.10/$10' },
          { value: 'percent', label: '41%' },
          { value: 'bar', label: 'Bar' },
        ],
      },
      ...barOptions.map((o) => ({ ...o, showWhen: forBar })),
      decimalsOption,
    ],
    render: budget,
  },
  {
    type: 'cost-rate',
    name: 'Cost rate',
    category: 'cost',
    description: 'Burn rate in USD per hour',
    icon: { nerd: '󰓅', emoji: '🔥' },
    color: 'yellow',
    sample: '$2.47/h',
    options: [decimalsOption],
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
