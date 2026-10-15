import { detectLevel, fgCode, gradientColor, type Level } from '../core/ansi.js';
import { t } from '../core/i18n/index.js';
import { isFreshSession } from '../core/payload.js';
import type { OptionSpec, OptionValue, RenderContext, WidgetItem, WidgetOutput } from '../core/types.js';
import { detectProvider } from '../data/provider.js';

export function opt<T extends OptionValue>(item: WidgetItem, key: string, fallback: T): T {
  const v = item.options?.[key];
  if (v === undefined) return fallback;
  if (typeof fallback === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    return (Number.isFinite(n) ? n : fallback) as T;
  }
  if (typeof fallback === 'boolean') return (typeof v === 'boolean' ? v : v === 'true') as T;
  return String(v) as T;
}

const LOADING = new WeakSet<WidgetOutput>();

export function isLoadingOutput(o: unknown): boolean {
  return !!o && typeof o === 'object' && LOADING.has(o as WidgetOutput);
}

export function loading(ctx: RenderContext, item: WidgetItem): WidgetOutput | null {
  if (item.hideEmpty || ctx.config.loadingText === '') return null;
  if (!isFreshSession(ctx.payload, ctx.data.transcript())) return null;
  const out = {
    text: ctx.config.loadingText ?? t('loading.default'),
    color: ctx.theme?.colors.muted ?? 'brightBlack',
  };
  LOADING.add(out);
  return out;
}

// payload wins; other providers never send plan limits
export function limitsLoading(ctx: RenderContext, item: WidgetItem): WidgetOutput | null {
  const r = ctx.payload.rate_limits;
  if (r && Object.values(r).some((v) => v != null && !(Array.isArray(v) && !v.length))) return null;
  if (!detectProvider(ctx.env).planLimits) return null;
  return loading(ctx, item);
}

export interface BarStyle {
  filled: string;
  empty: string;
  cap?: string;
  marker?: string;
}

export const BAR_STYLES: Record<string, BarStyle> = {
  blocks: { filled: '█', empty: '░' },
  'blocks-line': { filled: '█', empty: '─' },
  shade: { filled: '▓', empty: '░' },
  bar: { filled: '▪', empty: '▫' },
  thin: { filled: '━', empty: '─' },
  line: { filled: '━', empty: '┄' },
  capped: { filled: '━', empty: '┄', cap: '╸' },
  ball: { filled: '─', empty: '─', marker: '●' },
  dots: { filled: '●', empty: '○' },
  filled: { filled: '■', empty: '□' },
  squares: { filled: '◼', empty: '◻' },
  geometric: { filled: '▰', empty: '▱' },
  ascii: { filled: '#', empty: '-' },
  ring: { filled: '⣿', empty: '\u2800' },
  matrix: { filled: '⣿', empty: '⣀' },
};

const TEXT_BAR: BarStyle = { filled: '=', empty: '-' };
// clockwise from top-left
const RING = ['\u2800', '⠁', '⠉', '⠙', '⠹', '⢹', '⣹', '⣽', '⣿'];
const MATRIX = { empty: '⣀', half: '⣇', full: '⣿' };

export interface BarOpts {
  pace?: number | null;
  ascii?: boolean;
  gradient?: { level: Level; stops?: readonly string[] | undefined };
}

function paceMark(cells: string[], pct: number, opts: BarOpts, marker?: string): void {
  if (typeof opts.pace !== 'number' || !Number.isFinite(opts.pace)) return;
  const w = cells.length;
  const p = Math.max(0, Math.min(100, opts.pace));
  const at = Math.min(Math.round((p / 100) * w), w - 1);
  const over = pct > p;
  if (marker && cells[at] === marker) cells[at] = opts.ascii ? '*' : '◈';
  else cells[at] = opts.ascii ? (over ? '!' : ':') : over ? '◆' : '◇';
}

function paint(cells: string[], n: number, g: BarOpts['gradient'], value?: number): string {
  if (!g || g.level === 0 || n <= 0) return cells.join('');
  let out = '';
  let prev = '';
  for (let i = 0; i < cells.length; i++) {
    if (i < n) {
      const p = value ?? ((i + 0.5) / cells.length) * 100;
      const code = g.level === 1 ? fgCode(thresholdColor(p), 1) : fgCode(gradientColor(p, g.stops), g.level);
      if (code !== prev) out += code;
      prev = code;
    } else if (i === n) out += '\x1b[39m';
    out += cells[i];
  }
  return n >= cells.length ? `${out}\x1b[39m` : out;
}

export function bar(percent: number, width = 10, styleName = 'blocks', opts: BarOpts = {}): string {
  const w = Math.max(1, Math.floor(width));
  const pct = Math.max(0, Math.min(100, percent));
  if (!opts.ascii && styleName === 'ring') {
    const i = Math.round(pct / 12.5);
    return paint([RING[i] ?? RING[0]!], i > 0 ? 1 : 0, opts.gradient, pct);
  }
  if (!opts.ascii && styleName === 'matrix') {
    const halves = Math.round((pct / 100) * 2 * w);
    const cells = Array.from({ length: w }, (_, i) =>
      halves >= 2 * i + 2 ? MATRIX.full : halves === 2 * i + 1 ? MATRIX.half : MATRIX.empty,
    );
    paceMark(cells, pct, opts);
    return paint(cells, Math.ceil(halves / 2), opts.gradient);
  }
  const s = opts.ascii ? TEXT_BAR : (BAR_STYLES[styleName] ?? BAR_STYLES.blocks!);
  const filled = Math.round((pct / 100) * w);
  let cells: string[];
  let lit = filled;
  if (s.marker) {
    const pos = Math.min(filled, w - 1);
    cells = [...s.filled.repeat(pos), s.marker, ...s.empty.repeat(w - pos - 1)];
    lit = filled > 0 ? pos + 1 : 0;
  } else if (s.cap && filled < w) {
    cells =
      filled === 0
        ? [s.cap, ...s.empty.repeat(w - 1)]
        : [...s.filled.repeat(filled - 1), s.cap, ...s.empty.repeat(w - filled)];
  } else {
    cells = [...s.filled.repeat(filled), ...s.empty.repeat(w - filled)];
  }
  paceMark(cells, pct, opts, s.marker);
  return paint(cells, lit, opts.gradient);
}

export function barFor(ctx: RenderContext, item: WidgetItem, percent: number, pace?: number | null): string {
  const grow = opt(item, 'fill', false) ? (ctx.extra ?? 0) : 0;
  const gradient =
    opt<string>(item, 'barColor', 'solid') === 'gradient'
      ? { level: detectLevel(ctx.config.colorLevel, ctx.env), stops: ctx.gradient ?? ctx.theme?.gradient }
      : undefined;
  return bar(percent, opt(item, 'width', 10) + grow, opt<string>(item, 'style', 'blocks'), {
    pace: pace ?? null,
    ascii: ctx.config.charset === 'text',
    ...(gradient ? { gradient } : {}),
  });
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatDuration(ms: number, compact = true): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (compact) {
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }
  const hh = String(h + d * 24).padStart(2, '0');
  return `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 42s, 2m14s, then formatDuration
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return formatDuration(ms);
}

export function formatCurrency(usd: number, decimals = 2): string {
  return `$${usd.toFixed(decimals)}`;
}

const MONEY_SIGNS: Record<string, string> = { CNY: '¥', EUR: '€' };

export function formatMoney(amount: number, currency: string, decimals = 2): string {
  if (currency === 'USD') return formatCurrency(amount, decimals);
  const sign = MONEY_SIGNS[currency];
  return sign ? `${sign}${amount.toFixed(decimals)}` : `${currency} ${amount.toFixed(decimals)}`;
}

export function formatPercent(p: number, decimals = 0): string {
  return `${p.toFixed(decimals)}%`;
}

export { toEpochMs } from '../core/time.js';

export function thresholdColor(pct: number, warn = 50, danger = 80): string {
  if (pct >= danger) return 'red';
  if (pct >= warn) return 'yellow';
  return 'green';
}

export const fillOption: OptionSpec = {
  key: 'fill',
  label: 'Fill the cell',
  kind: 'boolean',
  default: false,
  help: 'In the Panel style, grow to the width of the grid cell',
};

export const barOptions: OptionSpec[] = [
  { key: 'width', label: 'Bar width', kind: 'number', default: 10 },
  {
    key: 'style',
    label: 'Bar style',
    kind: 'select',
    default: 'blocks',
    choices: Object.keys(BAR_STYLES).map((k) => ({ value: k, label: k })),
  },
  {
    key: 'barColor',
    label: 'Bar color',
    kind: 'select',
    default: 'solid',
    choices: [
      { value: 'solid', label: 'solid' },
      { value: 'gradient', label: 'gradient' },
    ],
  },
  { key: 'showPercent', label: 'Show percent', kind: 'boolean', default: true },
  fillOption,
];

export const thresholdOption: OptionSpec = {
  key: 'thresholdColors',
  label: 'Color by threshold',
  kind: 'boolean',
  default: true,
  help: 'Green below 50%, yellow below 80%, red above',
};

const SPARK = '▁▂▃▄▅▆▇█';
const SPARK_ASCII = '_.-=+*#';

export function sparkline(
  values: number[],
  width: number,
  opts: { min?: number; max?: number; ascii?: boolean } = {},
): string {
  const ramp = opts.ascii ? SPARK_ASCII : SPARK;
  const vals = values.filter((v) => Number.isFinite(v)).slice(-Math.max(1, width));
  if (!vals.length) return '';
  const lo = opts.min ?? Math.min(...vals);
  const hi = opts.max ?? Math.max(...vals);
  const span = hi - lo || 1;
  const chars = vals.map((v) => {
    const f = Math.max(0, Math.min(1, (v - lo) / span));
    return ramp[Math.round(f * (ramp.length - 1))]!;
  });
  return ramp[0]!.repeat(Math.max(0, width - chars.length)) + chars.join('');
}
