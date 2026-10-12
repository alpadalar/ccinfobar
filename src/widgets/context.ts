import type { OptionSpec, RenderContext, WidgetDef, WidgetItem, WidgetResult } from '../core/types.js';
import { barFor, barOptions, formatTokens, opt, thresholdColor, thresholdOption } from './shared.js';

export const AUTOCOMPACT_BUFFER = 0.165;

export function tok(n: number): string {
  return formatTokens(n).replace(/\.0(?=[kM]$)/, '');
}

export function windowSize(ctx: RenderContext): number | null {
  const n = ctx.payload.context_window?.context_window_size;
  return typeof n === 'number' && n > 0 ? n : null;
}

export function contextTokens(ctx: RenderContext): number | null {
  const cw = ctx.payload.context_window;
  const u = cw?.current_usage;
  if (u) {
    const sum =
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (sum > 0) return sum;
  }
  const size = windowSize(ctx);
  if (size && typeof cw?.used_percentage === 'number') return (cw.used_percentage / 100) * size;
  return ctx.data.transcript()?.contextLength ?? null;
}

export function usableLimit(ctx: RenderContext, size: number): number {
  const env = Number(ctx.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (Number.isFinite(env) && env > 0) return Math.min(env, size);
  return size * (1 - AUTOCOMPACT_BUFFER);
}

export function contextPercent(ctx: RenderContext, usable: boolean): number | null {
  const cw = ctx.payload.context_window;
  const size = windowSize(ctx);
  const used = contextTokens(ctx);
  let pct: number | null = null;
  if (usable && size && used !== null) pct = (used / usableLimit(ctx, size)) * 100;
  else if (typeof cw?.used_percentage === 'number') pct = cw.used_percentage;
  else if (typeof cw?.remaining_percentage === 'number') pct = 100 - cw.remaining_percentage;
  else if (size && used !== null) pct = (used / size) * 100;
  return pct === null ? null : Math.max(0, Math.min(100, pct));
}

const usableOption: OptionSpec = {
  key: 'usable',
  label: 'Relative to usable window',
  kind: 'boolean',
  default: false,
  help: 'Accounts for the autocompact buffer (~16.5%) or CLAUDE_CODE_AUTO_COMPACT_WINDOW',
};

function colored(text: string, pct: number, item: WidgetItem): WidgetResult {
  return opt(item, 'thresholdColors', true) ? { text, color: thresholdColor(pct) } : text;
}

export const widgets: WidgetDef[] = [
  {
    type: 'context-percentage',
    name: 'Context percentage',
    category: 'context',
    description: 'Context window used or remaining as a percentage',
    label: 'Ctx ',
    icon: { nerd: '󰍛', emoji: '🧮' },
    color: 'green',
    sample: '34%',
    options: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        default: 'used',
        choices: [
          { value: 'used', label: 'Used' },
          { value: 'remaining', label: 'Remaining' },
        ],
      },
      usableOption,
      thresholdOption,
    ],
    render(ctx, item) {
      const pct = contextPercent(ctx, opt(item, 'usable', false));
      if (pct === null) return null;
      const shown = opt<string>(item, 'mode', 'used') === 'remaining' ? 100 - pct : pct;
      return colored(`${Math.round(shown)}%`, pct, item);
    },
  },
  {
    type: 'context-bar',
    name: 'Context bar',
    category: 'context',
    description: 'Progress bar of context window usage',
    label: 'Ctx ',
    icon: { nerd: '󰍛', emoji: '🧮' },
    color: 'green',
    sample: '███░░░░░░░ 34%',
    options: [...barOptions, usableOption, thresholdOption],
    render(ctx, item) {
      const pct = contextPercent(ctx, opt(item, 'usable', false));
      if (pct === null) return null;
      const b = barFor(ctx, item, pct);
      const text = opt(item, 'showPercent', true) ? `${b} ${Math.round(pct)}%` : b;
      return colored(text, pct, item);
    },
  },
  {
    type: 'context-length',
    name: 'Context length',
    category: 'context',
    description: 'Tokens currently in the context window',
    label: 'Ctx ',
    icon: { nerd: '󰊄', emoji: '📏' },
    color: 'green',
    sample: '340k',
    options: [{ key: 'showMax', label: 'Show window size', kind: 'boolean', default: false }],
    render(ctx, item) {
      const used = contextTokens(ctx);
      if (used === null) return null;
      const size = windowSize(ctx);
      return opt(item, 'showMax', false) && size ? `${tok(used)}/${tok(size)}` : tok(used);
    },
  },
  {
    type: 'context-window-size',
    name: 'Context window size',
    category: 'context',
    description: 'Maximum context window size',
    label: 'Window ',
    icon: { nerd: '󰆾', emoji: '🪟' },
    color: 'brightBlack',
    sample: '1M',
    render(ctx) {
      const size = windowSize(ctx);
      return size ? tok(size) : null;
    },
  },
  {
    type: 'compactions',
    name: 'Compactions',
    category: 'context',
    description: 'Number of context compactions in this session',
    label: 'Compacted ',
    icon: { nerd: '󰁨', emoji: '🗜️' },
    color: 'yellow',
    sample: '1x',
    options: [{ key: 'showZero', label: 'Show when zero', kind: 'boolean', default: false }],
    render(ctx, item) {
      const t = ctx.data.transcript();
      if (!t) return null;
      if (t.compactions === 0 && !opt(item, 'showZero', false)) return null;
      return `${t.compactions}x`;
    },
  },
];
