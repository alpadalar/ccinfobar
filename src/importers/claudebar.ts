import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Charset, Config, IconMode, OptionValue, WidgetItem } from '../core/types.js';
import { flagValue, isBin } from './args.js';
import type { ImportNote, ImportResult } from './index.js';
import { expand, readToml, tableOf } from './io.js';
import type { ImporterDef } from './registry.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'claudebar';

export const TARGETS: readonly string[] = [
  'cwd',
  'git-branch',
  'git-status',
  'model',
  'effort',
  'context-bar',
  'context-length',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'session-cost',
  'lines-changed',
  'session-duration',
  'limit-eta',
  'clock',
];

export const DEFAULT_SEGMENTS = [
  'directory',
  'git',
  'model',
  'context',
  'lines',
  'rate-limits',
  'cost',
  'duration',
];

const THEMES: ThemeTable = {
  exact: {
    'tokyo-night': 'tokyo-night',
    catppuccin: 'catppuccin',
    'everforest-dark': 'everforest',
    gruvbox: 'gruvbox',
    'kanagawa-wave': 'kanagawa',
    nord: 'nord',
    'one-dark': 'one-dark',
    dracula: 'dracula',
    'rose-pine': 'rose-pine',
    'solarized-dark': 'solarized',
  },
  approx: {
    'ayu-mirage': 'dark',
    cobalt2: 'dark',
    'github-dark': 'dark',
    moonfly: 'dark',
    'night-owl': 'dark',
    sonokai: 'dark',
  },
  // claudebar falls back to tokyo-night
  fallback: 'tokyo-night',
};

interface StyleMap {
  separator: string;
  bar: string;
  icons: IconMode;
  charset?: Charset;
}

// claudebar never fills backgrounds: colored text between separator glyphs
const STYLES: Record<string, StyleMap> = {
  powerline: { separator: '  ', bar: 'line', icons: 'nerd' },
  lean: { separator: ' ', bar: 'line', icons: 'nerd' },
  plain: { separator: ' | ', bar: 'ascii', icons: 'none', charset: 'text' },
  rounded: { separator: '  ', bar: 'line', icons: 'nerd' },
  minimal: { separator: ' · ', bar: 'line', icons: 'none' },
  unicode: { separator: ' ❯ ', bar: 'blocks', icons: 'text' },
  ascii: { separator: ' | ', bar: 'ascii', icons: 'none', charset: 'text' },
  dots: { separator: '  ', bar: 'dots', icons: 'nerd' },
};

const IGNORED = ['burn_lookback', 'limit_sync', 'max_lines', 'wrap_margin'];

export interface ClaudebarOverrides {
  theme?: string;
  style?: string;
  segments?: string[];
}

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

const pct = (v: unknown, fallback: number) => intIn(v, 0, 65535) ?? fallback;

type Types = [string, Record<string, OptionValue>?][];

export function importClaudebar(
  raw: unknown,
  opts: { defaulted?: boolean; overrides?: ClaudebarOverrides } = {},
): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const c = tableOf(raw) ?? {};
  const th = tableOf(c.thresholds) ?? {};
  const over = opts.overrides ?? {};

  const styleName = over.style ?? (typeof c.style === 'string' ? c.style : 'powerline');
  let style = Object.hasOwn(STYLES, styleName) ? STYLES[styleName]! : null;
  if (!style) {
    style = STYLES.powerline!;
    const name = sanitizeText(styleName);
    notes.push({
      kind: 'info',
      text: t('import.note.styleUnknown', { tool: TOOL, name, style: 'powerline' }),
    });
  }

  const width = intIn(th.bar_width, 1, 100);
  const bar = (extra: Record<string, OptionValue> = {}) => ({
    ...extra,
    ...(width !== null ? { width } : {}),
    style: style.bar,
  });
  const decimals = intIn(th.cost_decimals, 0, 4);
  const clockMode = typeof th.clock_mode === 'string' ? th.clock_mode : 'auto';
  const weeklyAt = pct(th.weekly_show_at, 75);

  const segmentTypes = (id: string): Types | null => {
    switch (id) {
      case 'directory':
        return [['cwd', { style: 'short' }]];
      case 'git':
        return [['git-branch'], ['git-status']];
      case 'model':
        return [['model'], ['effort']];
      case 'context':
        return [['context-bar', bar()], ['context-length']];
      case 'rate-limits':
        return [
          ['five-hour-usage', bar({ display: 'bar' })],
          ['five-hour-reset'],
          ['weekly-usage', bar({ display: 'bar' })],
          ['weekly-reset'],
        ];
      case 'cost':
        return [decimals !== null ? ['session-cost', { decimals }] : ['session-cost']];
      case 'lines':
        return [['lines-changed']];
      case 'duration':
        return [['session-duration']];
      case 'burn':
        return [['limit-eta', { pace: 'recent' }]];
      case 'clock':
        return [clockMode === '12h' ? ['clock', { h12: true }] : ['clock']];
      default:
        return null;
    }
  };

  const list =
    over.segments ??
    (Array.isArray(c.segments) ? (c.segments as unknown[]) : (DEFAULT_SEGMENTS as unknown[]));
  const items: WidgetItem[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  for (const s of list) {
    const id = typeof s === 'string' ? s : '';
    const name = sanitizeText(typeof s === 'string' ? s : String(s));
    if (id === 'update-notice') {
      notes.push({ kind: 'drop', text: t('import.note.selfUpdate', { tool: TOOL, name }) });
      continue;
    }
    if (id === 'clock' && clockMode === 'off') {
      notes.push({ kind: 'drop', text: t('import.note.clockOff', { tool: TOOL }) });
      continue;
    }
    const types = segmentTypes(id);
    if (!types) {
      notes.push({ kind: 'drop', text: t('import.note.noSegment', { tool: TOOL, name }) });
      continue;
    }
    seen.add(id);
    for (const [type, options] of types) {
      let itemId = `${TOOL}-${id}-${type}`;
      for (let n = 2; used.has(itemId); n++) itemId = `${TOOL}-${id}-${type}-${n}`;
      used.add(itemId);
      items.push({ id: itemId, type, ...(options ? { options } : {}) });
    }
  }

  if (seen.has('clock') && !['12h', '24h', 'off'].includes(clockMode)) {
    const value = sanitizeText(clockMode);
    notes.push({ kind: 'approx', text: t('import.note.clockAuto', { tool: TOOL, value }) });
  }
  if (seen.has('rate-limits') && weeklyAt > 0) {
    notes.push({
      kind: 'approx',
      text: t('import.note.hudShownAlways', {
        tool: TOOL,
        name: 'weekly_show_at',
        value: weeklyAt,
        widget: 'weekly-usage',
      }),
    });
  }
  const warn = pct(th.warn, 50);
  const critical = pct(th.crit, 80);
  if (warn !== 50 || critical !== 80) {
    notes.push({ kind: 'approx', text: t('import.note.barThresholds', { tool: TOOL, warn, critical }) });
  }
  const auto = th.layout === 'auto';
  if (auto) notes.push({ kind: 'approx', text: t('import.note.autoLayout', { tool: TOOL }) });
  if (th.float === true) notes.push({ kind: 'drop', text: t('import.note.floatReadout', { tool: TOOL }) });
  const ignored = IGNORED.filter((k) => Object.hasOwn(th, k));
  if (ignored.length) {
    notes.push({
      kind: 'drop',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: ignored.join(', ') }),
    });
  }

  const { theme, notes: themeNotes } = mapTheme(over.theme ?? c.theme ?? 'tokyo-night', THEMES, TOOL);
  notes.push(...themeNotes);
  const config: Partial<Config> = {
    lines: [items],
    theme,
    style: 'text',
    separator: style.separator,
    icons: style.icons,
    autoWrap: auto,
    ...(style.charset ? { charset: style.charset } : {}),
  };
  return { config, notes, source: 'claudebar' };
}

function overrides(args: readonly string[]): ClaudebarOverrides {
  const theme = flagValue(args, ['--theme']);
  const style = flagValue(args, ['--style']);
  const segments = flagValue(args, ['--segments']);
  return {
    ...(theme ? { theme } : {}),
    ...(style ? { style } : {}),
    ...(segments ? { segments: segments.split(',').map((s) => s.trim()) } : {}),
  };
}

export const claudebarImporter: ImporterDef = {
  source: 'claudebar',
  name: 'claudebar',
  repo: 'micschr0/claudebar',
  shown: '~/.config/claudebar/config.toml',
  hasDefault: true,
  detect: [/\bclaudebar\b/i],
  tool: isBin('claudebar'),
  // claudebar reads HOME and XDG_CONFIG_HOME on every OS
  discover: (ctx) => {
    const home = ctx.env.HOME || ctx.home;
    const flag = flagValue(ctx.argv, ['--config']);
    if (flag) return path.resolve(ctx.cwd, expand(flag, home));
    const xdg = ctx.env.XDG_CONFIG_HOME;
    const base = xdg ? path.resolve(ctx.cwd, xdg) : path.join(home, '.config');
    return path.join(base, 'claudebar', 'config.toml');
  },
  load: (file, ctx) => {
    const over = overrides(ctx.argv);
    if (!file) return { ...importClaudebar({}, { defaulted: true, overrides: over }), file: null };
    return { ...importClaudebar(readToml(file, TOOL), { overrides: over }), file };
  },
};
