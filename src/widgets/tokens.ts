import type { MissCause, WidgetDef } from '../core/types.js';
import { tok } from './context.js';
import { formatDuration, loading, toEpochMs } from './shared.js';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function missPart(cause: string, c: MissCause): string {
  const name = cause.replace(/_/g, ' ').trim();
  if (cause === 'tools_changed') {
    const add = num(c.tools_added);
    const rem = num(c.tools_removed);
    if (add !== null || rem !== null) return `${name} (+${add ?? 0}/-${rem ?? 0})`;
  }
  if (cause === 'system_prompt_changed') {
    const d = num(c.system_char_delta);
    if (d !== null) return `${name} (${d < 0 ? '-' : '+'}${Math.abs(d)} chars)`;
  }
  return name;
}

export const widgets: WidgetDef[] = [
  {
    type: 'tokens-input',
    name: 'Input tokens',
    category: 'tokens',
    description: 'Total input tokens in this session',
    label: 'In ',
    icon: { nerd: '󰁅', emoji: '📥' },
    color: 'cyan',
    sample: '412k',
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const n = ctx.payload.context_window?.total_input_tokens ?? ctx.data.transcript()?.inputTokens;
      return typeof n === 'number' ? tok(n) : null;
    },
  },
  {
    type: 'tokens-output',
    name: 'Output tokens',
    category: 'tokens',
    description: 'Total output tokens in this session',
    label: 'Out ',
    icon: { nerd: '󰁝', emoji: '📤' },
    color: 'cyan',
    sample: '38k',
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const n = ctx.payload.context_window?.total_output_tokens ?? ctx.data.transcript()?.outputTokens;
      return typeof n === 'number' ? tok(n) : null;
    },
  },
  {
    type: 'tokens-cached',
    name: 'Cached tokens',
    category: 'tokens',
    description: 'Cache read and write tokens',
    label: 'Cache ',
    icon: { nerd: '󰆼', emoji: '💾' },
    color: 'cyan',
    sample: '3.2M',
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const t = ctx.data.transcript();
      if (t) return tok(t.cacheReadTokens + t.cacheWriteTokens);
      const u = ctx.payload.context_window?.current_usage;
      if (!u) return null;
      return tok((u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0));
    },
  },
  {
    type: 'tokens-total',
    name: 'Total tokens',
    category: 'tokens',
    description: 'Input plus output tokens',
    label: 'Tokens ',
    icon: { nerd: '󰊤', emoji: '🔢' },
    color: 'cyan',
    sample: '450k',
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const cw = ctx.payload.context_window;
      if (typeof cw?.total_input_tokens === 'number' || typeof cw?.total_output_tokens === 'number') {
        return tok((cw.total_input_tokens ?? 0) + (cw.total_output_tokens ?? 0));
      }
      const t = ctx.data.transcript();
      return t ? tok(t.inputTokens + t.outputTokens) : null;
    },
  },
  {
    type: 'cache-hit-rate',
    name: 'Cache hit rate',
    category: 'tokens',
    description: 'Prompt cache hit ratio',
    label: 'Hit ',
    icon: { nerd: '󰓾', emoji: '🎯' },
    color: 'green',
    sample: '94%',
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const r = ctx.payload.prompt_cache?.hit_ratio;
      if (typeof r === 'number') return `${Math.round(r <= 1 ? r * 100 : r)}%`;
      const t = ctx.data.transcript();
      const all = t ? t.cacheReadTokens + t.cacheWriteTokens + t.inputTokens : 0;
      return t && all > 0 ? `${Math.round((t.cacheReadTokens / all) * 100)}%` : null;
    },
  },
  {
    type: 'cache-timer',
    name: 'Cache timer',
    category: 'tokens',
    description: 'Time left before the prompt cache expires',
    label: 'Cache ',
    icon: { nerd: '󱎫', emoji: '⏳' },
    color: 'green',
    sample: '41m',
    render(ctx) {
      const c = ctx.payload.prompt_cache;
      if (!c) return null;
      if (c.warm === false) return { text: 'cold', color: 'red' };
      const exp = toEpochMs(c.expires_at);
      if (exp === null) return null;
      const left = exp - ctx.now.getTime();
      if (left <= 0) return { text: 'cold', color: 'red' };
      return { text: formatDuration(left), color: left < 5 * 60_000 ? 'yellow' : 'green' };
    },
  },
  {
    type: 'cache-miss-cause',
    name: 'Cache miss cause',
    category: 'tokens',
    description: 'Reason for the last prompt cache miss',
    label: 'Miss ',
    icon: { nerd: '󰀦', emoji: '❄️' },
    color: 'yellow',
    sample: 'tools changed (+2/-0)',
    render(ctx) {
      const c = ctx.payload.prompt_cache?.last_miss_cause;
      if (typeof c === 'string') return c.replace(/_/g, ' ').trim() || null;
      if (!c || typeof c !== 'object' || !Array.isArray(c.causes)) return null;
      const parts = c.causes.filter((x): x is string => typeof x === 'string').map((x) => missPart(x, c));
      return parts.filter(Boolean).join(', ') || null;
    },
  },
  {
    type: 'output-speed',
    name: 'Output speed',
    category: 'tokens',
    description: 'Recent output tokens per second',
    icon: { nerd: '󰓅', emoji: '🚀' },
    color: 'cyan',
    sample: '72 t/s',
    render(ctx) {
      const v = ctx.data.transcript()?.outputSpeed;
      return typeof v === 'number' && v > 0 ? `${Math.round(v)} t/s` : null;
    },
  },
];
