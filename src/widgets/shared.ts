import type { OptionSpec, OptionValue, RenderContext, WidgetItem } from '../core/types.js';

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
};

const TEXT_BAR: BarStyle = { filled: '=', empty: '-' };

export interface BarOpts {
  pace?: number | null;
  ascii?: boolean;
}

export function bar(percent: number, width = 10, styleName = 'blocks', opts: BarOpts = {}): string {
  const s = opts.ascii ? TEXT_BAR : (BAR_STYLES[styleName] ?? BAR_STYLES.blocks!);
  const w = Math.max(1, Math.floor(width));
  const pct = Math.max(0, Math.min(100, percent));
  const filled = Math.round((pct / 100) * w);
  let cells: string[];
  if (s.marker) {
    const pos = Math.min(filled, w - 1);
    cells = [...s.filled.repeat(pos), s.marker, ...s.empty.repeat(w - pos - 1)];
  } else if (s.cap && filled < w) {
    cells =
      filled === 0
        ? [s.cap, ...s.empty.repeat(w - 1)]
        : [...s.filled.repeat(filled - 1), s.cap, ...s.empty.repeat(w - filled)];
  } else {
    cells = [...s.filled.repeat(filled), ...s.empty.repeat(w - filled)];
  }
  if (typeof opts.pace === 'number' && Number.isFinite(opts.pace)) {
    const p = Math.max(0, Math.min(100, opts.pace));
    const at = Math.min(Math.round((p / 100) * w), w - 1);
    const over = pct > p;
    if (s.marker && cells[at] === s.marker) cells[at] = opts.ascii ? '*' : '◈';
    else cells[at] = opts.ascii ? (over ? '!' : ':') : over ? '◆' : '◇';
  }
  return cells.join('');
}

export function barFor(ctx: RenderContext, item: WidgetItem, percent: number, pace?: number | null): string {
  const grow = opt(item, 'fill', false) ? (ctx.extra ?? 0) : 0;
  return bar(percent, opt(item, 'width', 10) + grow, opt<string>(item, 'style', 'blocks'), {
    pace: pace ?? null,
    ascii: ctx.config.charset === 'text',
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

export function formatCurrency(usd: number, decimals = 2): string {
  return `$${usd.toFixed(decimals)}`;
}

export function formatPercent(p: number, decimals = 0): string {
  return `${p.toFixed(decimals)}%`;
}

export function toEpochMs(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

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
