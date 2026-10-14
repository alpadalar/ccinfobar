import { latestMiss } from '../core/cache-rule.js';
import { t } from '../core/i18n/index.js';
import type { MissCause, RenderContext, WidgetDef } from '../core/types.js';
import { tok } from './context.js';
import { formatDuration, loading, opt, toEpochMs } from './shared.js';

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

function missText(c: MissCause | string | null | undefined): string | null {
  if (typeof c === 'string') return c.replace(/_/g, ' ').trim() || null;
  if (!c || typeof c !== 'object' || !Array.isArray(c.causes)) return null;
  const parts = c.causes.filter((x): x is string => typeof x === 'string').map((x) => missPart(x, c));
  return parts.filter(Boolean).join(', ') || null;
}

export function hitRate(ctx: RenderContext): number | null {
  const r = num(ctx.payload.prompt_cache?.hit_ratio);
  if (r !== null) return r <= 1 ? r * 100 : r;
  const t = ctx.data.transcript();
  const all = t ? t.cacheReadTokens + t.cacheWriteTokens + t.inputTokens : 0;
  return t && all > 0 ? (t.cacheReadTokens / all) * 100 : null;
}

// resume restores api time but resets requests
const MAX_AVG_MS = 300_000;

export function avgResponseMs(ctx: RenderContext): number | null {
  const ms = num(ctx.payload.cost?.total_api_duration_ms);
  const n = num(ctx.payload.prompt_cache?.requests);
  if (ms !== null && n !== null && n > 0) {
    const avg = ms / n;
    if (avg > 0 && avg <= MAX_AVG_MS) return avg;
  }
  const v = num(ctx.data.transcript()?.responseMs);
  return v !== null && v > 0 ? v : null;
}

function misses(ctx: RenderContext): number | null {
  const pc = ctx.payload.prompt_cache;
  if (pc) return num(pc.misses);
  return num(ctx.data.transcript()?.cacheMisses);
}

const secs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms));

const LEVEL = ['green', 'yellow', 'red'] as const;

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
      const h = hitRate(ctx);
      return h === null ? null : `${Math.round(h)}%`;
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
    options: [
      {
        key: 'showTtl',
        label: 'Show TTL',
        kind: 'boolean',
        default: false,
        help: 'Append the cache lifetime, for example 41m/1h',
      },
    ],
    render(ctx, item) {
      const c = ctx.payload.prompt_cache;
      if (!c) return null;
      if (c.caching_observed === false) {
        return { text: t('widget.cache.off'), color: ctx.theme?.colors.muted ?? 'brightBlack' };
      }
      const cold = { text: t('widget.cache.cold'), color: 'red' };
      if (c.warm === false) return cold;
      const exp = toEpochMs(c.expires_at);
      if (exp === null || !Number.isFinite(exp)) return null;
      const left = exp - ctx.now.getTime();
      if (left <= 0) return cold;
      const ttl = opt(item, 'showTtl', false) && typeof c.ttl === 'string' && c.ttl ? `/${c.ttl}` : '';
      return { text: formatDuration(left) + ttl, color: left < 5 * 60_000 ? 'yellow' : 'green' };
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
    options: [
      {
        key: 'show',
        label: 'Show',
        kind: 'select',
        default: 'latest',
        choices: [
          { value: 'latest', label: 'Latest miss only' },
          { value: 'always', label: 'Always' },
        ],
        help: 'Latest: only while the last request missed the cache',
      },
    ],
    render(ctx, item) {
      const pc = ctx.payload.prompt_cache;
      const text = missText(pc?.last_miss_cause);
      if (!text) return null;
      return opt<string>(item, 'show', 'latest') === 'latest' && latestMiss(pc) === 'no' ? null : text;
    },
  },
  {
    type: 'performance',
    name: 'Performance',
    category: 'tokens',
    description: 'Cache hit rate and average API time per main request',
    label: 'Perf ',
    icon: { nerd: '󰓾', emoji: '🎯' },
    color: 'green',
    sample: '94% · 3.2s',
    options: [
      {
        key: 'show',
        label: 'Show',
        kind: 'select',
        default: 'both',
        choices: [
          { value: 'both', label: 'Hit rate and time' },
          { value: 'hit', label: 'Hit rate' },
          { value: 'time', label: 'Time' },
        ],
        help: 'Time is the average API time per main request',
      },
      {
        key: 'display',
        label: 'Display',
        kind: 'select',
        default: 'text',
        choices: [
          { value: 'text', label: 'Text' },
          { value: 'badge', label: 'Traffic-light badge' },
        ],
        help: 'Badge colors the widget by the worse of the two values',
      },
      {
        key: 'hitWarn',
        label: 'Hit rate warning',
        kind: 'number',
        default: 70,
        help: 'Badge warns below this hit rate, in %',
        showWhen: { key: 'display', values: ['badge'] },
      },
      {
        key: 'timeWarn',
        label: 'Time warning',
        kind: 'number',
        default: 10,
        help: 'Badge warns above this average time, in seconds',
        showWhen: { key: 'display', values: ['badge'] },
      },
      {
        key: 'showMisses',
        label: 'Show misses',
        kind: 'boolean',
        default: false,
        help: 'Append the cache miss count',
      },
    ],
    render(ctx, item) {
      const l = loading(ctx, item);
      if (l) return l;
      const show = opt<string>(item, 'show', 'both');
      const h = show === 'time' ? null : hitRate(ctx);
      const ms = show === 'hit' ? null : avgResponseMs(ctx);
      if (h === null && ms === null) return null;
      const parts: string[] = [];
      if (h !== null) parts.push(`${Math.round(h)}%`);
      if (ms !== null) parts.push(secs(ms));
      const m = opt(item, 'showMisses', false) ? misses(ctx) : null;
      if (m !== null) parts.push(`${m} ${t('widget.performance.miss')}`);
      const text = parts.join(' · ');
      if (opt<string>(item, 'display', 'text') !== 'badge') return text;
      const hw = opt(item, 'hitWarn', 70);
      const tw = opt(item, 'timeWarn', 10) * 1000;
      const hl = h === null ? 0 : h >= hw ? 0 : h >= hw - 20 ? 1 : 2;
      const tl = ms === null ? 0 : ms <= tw ? 0 : ms <= 2 * tw ? 1 : 2;
      return { text, color: LEVEL[Math.max(hl, tl)] };
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
