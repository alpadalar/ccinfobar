import type { OptionSpec, OptionValue, WidgetItem } from '../core/types.js';

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

export const BAR_STYLES: Record<string, [string, string]> = {
  blocks: ['█', '░'],
  shade: ['▓', '░'],
  thin: ['━', '─'],
  dots: ['●', '○'],
  squares: ['■', '□'],
  ascii: ['#', '-'],
};

export function bar(percent: number, width = 10, styleName = 'blocks'): string {
  const [full, empty] = BAR_STYLES[styleName] ?? BAR_STYLES.blocks!;
  const pct = Math.max(0, Math.min(100, percent));
  const filled = Math.round((pct / 100) * width);
  return full.repeat(filled) + empty.repeat(width - filled);
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
];

export const thresholdOption: OptionSpec = {
  key: 'thresholdColors',
  label: 'Color by threshold',
  kind: 'boolean',
  default: true,
  help: 'Green below 50%, yellow below 80%, red above',
};
