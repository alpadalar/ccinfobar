import { resolveProfile } from '../core/profiles.js';
import type { OptionSpec, RenderContext, WidgetDef, WidgetItem, WidgetResult } from '../core/types.js';
import { detectProvider } from '../data/provider.js';
import { barFor, barOptions, formatTokens, loading, opt, thresholdColor, thresholdOption } from './shared.js';

export function tok(n: number): string {
  return formatTokens(n).replace(/\.0(?=[kM]$)/, '');
}

function positive(v: string | undefined): number | null {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : null;
}

function payloadSize(ctx: RenderContext): number | null {
  const n = ctx.payload.context_window?.context_window_size;
  return typeof n === 'number' && n > 0 ? n : null;
}

function guessSize(ctx: RenderContext): number | null {
  const m = ctx.payload.model;
  if (!m) return null;
  if (/\[1m\]|\b1m\b/i.test(`${m.id ?? ''} ${m.display_name ?? ''}`)) return 1_000_000;
  const len = ctx.data.transcript()?.contextLength ?? 0;
  return ctx.payload.exceeds_200k_tokens || len > 200_000 ? 1_000_000 : 200_000;
}

const envWindow = (ctx: RenderContext): number | null =>
  detectProvider(ctx.env).kind === 'firstParty' ? null : positive(ctx.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);

// env > payload > profile, non-first-party only (D-48)
function overrideSize(ctx: RenderContext, n: number | null): number | null {
  const provider = detectProvider(ctx.env);
  if (provider.kind === 'firstParty') return null;
  const env = envWindow(ctx);
  if (env) return env === n ? null : env;
  if (n !== null && n !== 200_000) return null;
  const p = resolveProfile(ctx.payload.model, provider, ctx.config)?.contextWindow ?? null;
  return p && (n === null || p > n) ? p : null;
}

export function windowSize(ctx: RenderContext): number | null {
  const n = payloadSize(ctx);
  return overrideSize(ctx, n) ?? n ?? guessSize(ctx);
}

// where Claude Code compacts: a profile window never moves it
export function compactWindow(ctx: RenderContext): number | null {
  return envWindow(ctx) ?? payloadSize(ctx) ?? guessSize(ctx);
}

export function windowFromPayload(ctx: RenderContext): boolean {
  return overrideSize(ctx, payloadSize(ctx)) === null;
}

export function contextTokens(ctx: RenderContext): number | null {
  const cw = ctx.payload.context_window;
  const u = cw?.current_usage;
  if (u) {
    const sum =
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (sum > 0) return sum;
  }
  const size = windowFromPayload(ctx) ? windowSize(ctx) : payloadSize(ctx);
  if (size && typeof cw?.used_percentage === 'number') return (cw.used_percentage / 100) * size;
  return ctx.data.transcript()?.contextLength ?? null;
}

const OUTPUT_RESERVE_CAP = 20_000;
const COMPACT_BUFFER = 13_000;
const BASES = ['raw', 'usable', 'reserve'] as const;

export type ContextBasis = (typeof BASES)[number];

export function basisOf(item: WidgetItem): ContextBasis {
  const b = item.options?.basis;
  if (BASES.includes(b as ContextBasis)) return b as ContextBasis;
  return opt(item, 'usable', false) ? 'usable' : 'raw';
}

export function usableLimit(ctx: RenderContext, size: number): number {
  const env = positive(ctx.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const window = env ? Math.min(env, size) : size;
  const out = Math.min(
    positive(ctx.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) ?? OUTPUT_RESERVE_CAP,
    OUTPUT_RESERVE_CAP,
  );
  return window - out - COMPACT_BUFFER;
}

function limitFor(ctx: RenderContext, basis: ContextBasis, size: number, reserveTokens: number): number {
  if (basis === 'usable') return usableLimit(ctx, size);
  const r = Number.isFinite(reserveTokens) ? reserveTokens : OUTPUT_RESERVE_CAP;
  return size - Math.min(Math.max(0, r), size - 1);
}

export function contextPercent(
  ctx: RenderContext,
  basis: ContextBasis,
  reserveTokens = OUTPUT_RESERVE_CAP,
): number | null {
  const cw = ctx.payload.context_window;
  const size = windowSize(ctx);
  const used = contextTokens(ctx);
  const own = windowFromPayload(ctx);
  let pct: number | null = null;
  const base = basis === 'raw' ? null : (compactWindow(ctx) ?? size);
  if (base && used !== null) {
    const limit = limitFor(ctx, basis, base, reserveTokens);
    pct = limit > 0 ? (used / limit) * 100 : 100;
  } else if (own && typeof cw?.used_percentage === 'number') pct = cw.used_percentage;
  else if (own && typeof cw?.remaining_percentage === 'number') pct = 100 - cw.remaining_percentage;
  else if (size && used !== null) pct = (used / size) * 100;
  else if (cw && size) pct = 0;
  return pct === null || Number.isNaN(pct) ? null : Math.max(0, Math.min(100, pct));
}

const basisOption: OptionSpec = {
  key: 'basis',
  label: 'Percentage of',
  kind: 'select',
  default: 'raw',
  choices: [
    { value: 'raw', label: 'Full window' },
    { value: 'usable', label: 'Before auto-compact' },
    { value: 'reserve', label: 'Minus output reserve' },
  ],
  help: "Usable matches Claude Code's auto-compact threshold; reserve subtracts the output reserve below",
};

const reserveTokensOption: OptionSpec = {
  key: 'reserveTokens',
  label: 'Output reserve tokens',
  kind: 'number',
  default: OUTPUT_RESERVE_CAP,
  help: 'Approximate: tokens Claude Code keeps for output (20,000 in Claude Code 2.1.299, may change)',
  showWhen: { key: 'basis', values: ['reserve'] },
};

function percentFor(ctx: RenderContext, item: WidgetItem): number | null {
  return contextPercent(ctx, basisOf(item), opt(item, 'reserveTokens', OUTPUT_RESERVE_CAP));
}

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
      basisOption,
      reserveTokensOption,
      thresholdOption,
    ],
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const pct = percentFor(ctx, item);
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
    options: [...barOptions, basisOption, reserveTokensOption, thresholdOption],
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const pct = percentFor(ctx, item);
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
      const l = loading(ctx, item);
      if (l) return l;
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
