import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { rgbColor } from './colors.js';
import type { ImportNote, ImportResult } from './index.js';
import { expand, isFile, readSource, SourceTooLargeError, safeThemeName, shownFile } from './io.js';
import type { ImportCtx, ImporterDef } from './registry.js';
import { parseShellEnv } from './shell-env.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'coralline';

export const TARGETS: readonly string[] = [
  'cwd',
  'git-repo',
  'git-branch',
  'git-status',
  'git-ahead-behind',
  'model',
  'effort',
  'context-bar',
  'cache-hit-rate',
  'cache-timer',
  'output-speed',
  'performance',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'limit-eta',
  'lines-changed',
  'session-cost',
  'output-style',
  'session-duration',
  'git-stash',
  'clock',
];

// statusline.sh defaults
const DEFAULT_SEGMENTS = ['dir', 'git', 'model', 'ctx', 'limit5h', 'limit7d', 'cost', 'clock'].join(' ');

export const THEMES: ThemeTable = {
  exact: {
    'catppuccin-mocha': 'catppuccin-mocha',
    'gruvbox-dark': 'gruvbox',
    'tokyo-night': 'tokyo-night',
    nord: 'nord',
    dracula: 'dracula',
    mono: 'mono',
  },
  approx: {
    'claude-coral': 'classic',
    reverie: 'classic',
    'morning-haze': 'classic',
    'lunar-pink': 'classic',
  },
};

interface Segment {
  types: [string, Record<string, OptionValue>?][];
  // VL_BG_* keys, first set one wins
  bg: string[];
  // drawn in VL_FG_TEXT; gauges pick their own colors
  text: boolean;
  bold?: boolean;
  approx?: string;
}

// settings with no ccinfobar equivalent, quiet while they keep the default
const QUIET: Record<string, string> = {
  VL_MAX_LINES: '3',
  VL_WRAP_MARGIN: '4',
  VL_PATH_DEPTH: '4',
  VL_NAME_MAX: '0',
  VL_CTX_ALWAYS_SHOW: '0',
  VL_COST_ALWAYS_SHOW: '0',
  VL_LIMIT_SYNC: '0',
  VL_RUNTIME_PROBE: '0',
  VL_LEAN_BG: '',
  VL_LEAN_CAP_L: '',
  VL_LEAN_CAP_R: '',
  VL_LEAN_FG: '',
  VL_BAR_FILL: '▰',
  VL_BAR_EMPTY: '▱',
  VL_CTX_GLYPH: '⬡',
  VL_PROJECT_GLYPH: '⬢',
  VL_CACHE_GLYPH: '⛁',
};

const HANDLED = new Set([
  'VL_STYLE',
  'VL_LAYOUT',
  'VL_SEGMENTS',
  'VL_SEGMENTS2',
  'VL_SEGMENTS3',
  'VL_CLOCK',
  'VL_CLOCK_SECONDS',
  'VL_BAR_WIDTH',
  'VL_COST_DECIMALS',
  'VL_ASCII',
  'VL_LEAN_SEP',
  'VL_WARN_PCT',
  'VL_HOT_PCT',
  'VL_FLOAT',
  'VL_FLOAT_SEGMENTS',
  'VL_FLOAT_SEP',
  'VL_FLOAT_FILE',
]);

const MAX_LISTED = 10;

const listed = (xs: (string | number)[]) =>
  xs.slice(0, MAX_LISTED).join(', ') + (xs.length > MAX_LISTED ? ', …' : '');

const intIn = (v: string | undefined, min: number, max: number): number | null => {
  if (v === undefined || !/^\d{1,3}$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= min && n <= max ? n : null;
};

export interface CorallineOpts {
  theme: string | null;
  themeVars: Record<string, string> | null;
  // shown path of the theme file read
  themeFile: string | null;
  skipped: number[];
  defaulted?: boolean;
}

export function importCoralline(vars: Record<string, string>, opts: CorallineOpts): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const get = (k: string): string | undefined => (Object.hasOwn(vars, k) ? vars[k] : undefined);

  const styleName = get('VL_STYLE') ?? 'pill';
  const lean = styleName === 'lean' || styleName === 'classic';
  if (styleName === 'classic') {
    notes.push({
      kind: 'approx',
      text: t('import.note.styleApprox', { tool: TOOL, name: 'classic', style: 'text' }),
    });
  } else if (!lean && styleName !== 'pill') {
    const name = sanitizeText(styleName);
    notes.push({ kind: 'info', text: t('import.note.styleUnknown', { tool: TOOL, name, style: 'pill' }) });
  }

  const ascii = get('VL_ASCII') === '1';
  const width = intIn(get('VL_BAR_WIDTH'), 1, 64) ?? 5;
  const decimals = intIn(get('VL_COST_DECIMALS'), 0, 9) ?? 2;
  const clockMode = get('VL_CLOCK') ?? '12h';
  const seconds = (get('VL_CLOCK_SECONDS') ?? '1') === '1';
  const bar = (extra: Record<string, OptionValue> = {}) => ({
    ...extra,
    width,
    style: ascii ? 'ascii' : 'geometric',
  });
  const clock: Record<string, OptionValue> = {
    ...(clockMode === '24h' ? {} : { h12: true }),
    ...(seconds ? { seconds: true } : {}),
  };

  const SEGMENTS: Record<string, Segment> = {
    dir: { types: [['cwd', { style: 'tilde' }]], bg: ['VL_BG_DIR'], text: true, bold: true },
    project: {
      types: [['git-repo', { nameOnly: true }]],
      bg: ['VL_BG_PROJECT', 'VL_BG_DIR'],
      text: true,
      bold: true,
    },
    git: {
      types: [['git-branch'], ['git-status'], ['git-ahead-behind']],
      bg: ['VL_BG_GIT_OK'],
      text: true,
      bold: true,
    },
    model: { types: [['model']], bg: ['VL_BG_MODEL'], text: true, bold: true },
    effort: { types: [['effort']], bg: ['VL_BG_EFFORT'], text: true },
    ctx: { types: [['context-bar', bar()]], bg: ['VL_BG_CTX'], text: false, approx: 'context-bar' },
    cache: { types: [['cache-hit-rate'], ['cache-timer']], bg: ['VL_BG_CACHE', 'VL_BG_CTX'], text: false },
    toks: { types: [['output-speed']], bg: ['VL_BG_TOKS', 'VL_BG_CTX'], text: true },
    ttft: {
      types: [['performance', { show: 'time' }]],
      bg: ['VL_BG_TTFT', 'VL_BG_CTX'],
      text: true,
      approx: 'performance',
    },
    limit5h: {
      types: [['five-hour-usage', bar({ display: 'bar' })], ['five-hour-reset']],
      bg: ['VL_BG_5H'],
      text: false,
    },
    limit7d: {
      types: [['weekly-usage', bar({ display: 'bar' })], ['weekly-reset']],
      bg: ['VL_BG_7D'],
      text: false,
    },
    burn: { types: [['limit-eta', { pace: 'recent' }]], bg: ['VL_BG_BURN', 'VL_BG_5H'], text: true },
    lines: { types: [['lines-changed', { hideZero: true }]], bg: ['VL_BG_LINES'], text: false },
    cost: { types: [['session-cost', { decimals }]], bg: ['VL_BG_COST'], text: true },
    style: { types: [['output-style']], bg: ['VL_BG_STYLE'], text: true },
    duration: { types: [['session-duration']], bg: ['VL_BG_DURATION'], text: true },
    stash: { types: [['git-stash']], bg: ['VL_BG_STASH', 'VL_BG_GIT_OK'], text: true },
    clock: { types: [['clock', clock]], bg: ['VL_BG_CLOCK'], text: true },
  };

  // main file colors win over the theme file
  const palette = (k: string): string | undefined => {
    const v = get(k) ?? (opts.themeVars && Object.hasOwn(opts.themeVars, k) ? opts.themeVars[k] : undefined);
    return v === undefined || v === '' ? undefined : rgbColor(v);
  };
  const textColor = palette('VL_FG_TEXT');

  const auto = get('VL_LAYOUT') === 'auto';
  const rows = auto
    ? [get('VL_SEGMENTS') ?? DEFAULT_SEGMENTS]
    : [get('VL_SEGMENTS') ?? DEFAULT_SEGMENTS, get('VL_SEGMENTS2') ?? '', get('VL_SEGMENTS3') ?? ''];

  const used = new Set<string>();
  const dropped = new Set<string>();
  const approx = new Set<string>();
  let clockSkipped = false;
  const lines: WidgetItem[][] = [];
  for (const row of rows) {
    const items: WidgetItem[] = [];
    for (const seg of row.split(/\s+/).filter(Boolean)) {
      if (seg === 'clock' && clockMode === 'off') {
        clockSkipped = true;
        continue;
      }
      if (!Object.hasOwn(SEGMENTS, seg)) {
        if (!dropped.has(seg)) {
          dropped.add(seg);
          notes.push({
            kind: 'drop',
            text: t('import.note.noSegment', { tool: TOOL, name: sanitizeText(seg) }),
          });
        }
        continue;
      }
      const def = SEGMENTS[seg]!;
      if (def.approx) approx.add(seg);
      const bg = def.bg.map(palette).find((c) => c !== undefined);
      for (const [type, options] of def.types) {
        let id = `${TOOL}-${seg}-${type}`;
        for (let n = 2; used.has(id); n++) id = `${TOOL}-${seg}-${type}-${n}`;
        used.add(id);
        const item: WidgetItem = { id, type, ...(options ? { options: { ...options } } : {}) };
        // lean draws the segment color as text
        if (lean) {
          if (bg && def.text) item.color = bg;
        } else {
          if (bg) item.background = bg;
          if (textColor && def.text) item.color = textColor;
        }
        if (def.bold) item.bold = true;
        items.push(item);
      }
    }
    if (items.length) lines.push(items);
  }

  for (const seg of approx) {
    const widget = SEGMENTS[seg]!.approx!;
    notes.push({ kind: 'approx', text: t('import.note.hudApprox', { tool: TOOL, name: seg, widget }) });
  }
  if (clockSkipped) {
    notes.push({ kind: 'drop', text: t('import.note.clockSettingOff', { tool: TOOL, setting: 'VL_CLOCK' }) });
  }
  if (auto) notes.push({ kind: 'approx', text: t('import.note.autoLayout', { tool: TOOL }) });
  const warn = intIn(get('VL_WARN_PCT'), 0, 100) ?? 50;
  const critical = intIn(get('VL_HOT_PCT'), 0, 100) ?? 75;
  if (warn !== 50 || critical !== 75) {
    notes.push({ kind: 'approx', text: t('import.note.barThresholds', { tool: TOOL, warn, critical }) });
  }
  if (get('VL_FLOAT') === '1')
    notes.push({ kind: 'drop', text: t('import.note.floatReadout', { tool: TOOL }) });

  const ignored: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (HANDLED.has(k) || (Object.hasOwn(QUIET, k) && QUIET[k] === v)) continue;
    const sub = k.startsWith('VL_SUB_') || /^VL_(?:BG|FG)_SUB_/.test(k);
    if (/^VL_(?:BG|FG)_/.test(k) && !sub) continue;
    if (k.startsWith('VL_') || k.startsWith('CORALLINE_')) ignored.push(sanitizeText(k));
  }
  if (ignored.length) {
    notes.push({
      kind: 'drop',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: listed(ignored) }),
    });
  }

  const themeName = opts.theme ?? 'claude-coral';
  const exact = Object.hasOwn(THEMES.exact, themeName.toLowerCase());
  let theme = 'classic';
  if (!exact && opts.themeVars && opts.themeFile) {
    const text = t('import.note.themeFileColors', {
      tool: TOOL,
      name: sanitizeText(themeName),
      file: opts.themeFile,
    });
    notes.push({ kind: 'info', text });
  } else if (!exact && !safeThemeName(themeName)) {
    notes.push({
      kind: 'info',
      text: t('import.note.includeUnsafe', { tool: TOOL, name: sanitizeText(themeName) }),
    });
  } else {
    const mapped = mapTheme(themeName, THEMES, TOOL);
    theme = mapped.theme;
    notes.push(...mapped.notes);
  }

  if (opts.skipped.length) {
    const skipped = [...opts.skipped].sort((a, b) => a - b);
    notes.push({
      kind: 'drop',
      text: t('import.note.shellSkipped', { tool: TOOL, lines: listed(skipped), count: skipped.length }),
    });
  }

  const config: Partial<Config> = { lines, theme, style: lean ? 'text' : 'capsule', autoWrap: auto };
  if (lean) {
    const sep = get('VL_LEAN_SEP') ?? '';
    config.separator = sep ? ` ${sanitizeText(sep)} ` : '  ';
  }
  if (ascii) config.charset = 'text';
  return { config, notes, source: 'coralline' };
}

export function themesDir(ctx: Pick<ImportCtx, 'env' | 'cwd' | 'home'>): string {
  const base = ctx.env.CLAUDE_CONFIG_DIR
    ? path.resolve(ctx.cwd, expand(ctx.env.CLAUDE_CONFIG_DIR, ctx.home))
    : path.join(ctx.home, '.claude');
  return path.join(base, 'coralline', 'themes');
}

// only <themes dir>/<safe name>.conf, never the include path itself
function readTheme(name: string, ctx: ImportCtx): { vars: Record<string, string>; file: string } | null {
  if (Object.hasOwn(THEMES.exact, name.toLowerCase()) || !safeThemeName(name)) return null;
  const file = path.join(themesDir(ctx), `${name}.conf`);
  if (!isFile(file)) return null;
  try {
    const vars = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(parseShellEnv(readSource(file)).vars)) {
      if (/^VL_(?:BG|FG)_/.test(k)) vars[k] = v;
    }
    return { vars, file };
  } catch {
    return null;
  }
}

export const corallineImporter: ImporterDef = {
  source: 'coralline',
  name: 'coralline',
  repo: 'Nanako0129/coralline',
  shown: '~/.claude/coralline.conf',
  hasDefault: true,
  detect: [/coralline[\\/]statusline\.(sh|ps1)/i],
  named: (ctx) => {
    const own = ctx.env.CORALLINE_CONFIG;
    return own ? path.resolve(ctx.cwd, expand(own, ctx.home)) : null;
  },
  discover: (ctx) => corallineImporter.named!(ctx) ?? path.join(ctx.home, '.claude', 'coralline.conf'),
  load: (file, ctx) => {
    if (!file) {
      const r = importCoralline(
        {},
        { theme: null, themeVars: null, themeFile: null, skipped: [], defaulted: true },
      );
      return { ...r, file: null };
    }
    let text: string;
    try {
      text = readSource(file);
    } catch (err) {
      if (err instanceof SourceTooLargeError) throw err;
      throw new Error(t('import.cannotReadTool', { tool: TOOL, file: shownFile(file, ctx.home) }));
    }
    const parsed = parseShellEnv(text);
    // the theme include wins over a later overrides file
    const themed = [...parsed.includes].reverse().find((i) => /coralline[\\/]themes[\\/]/i.test(i.path));
    const pick = themed ?? parsed.includes.at(-1);
    const skipped = [...parsed.skipped, ...parsed.includes.filter((i) => i !== pick).map((i) => i.line)];
    const theme = pick?.name ?? null;
    const read = theme === null ? null : readTheme(theme, ctx);
    const r = importCoralline(parsed.vars, {
      theme,
      themeVars: read?.vars ?? null,
      themeFile: read ? shownFile(read.file, ctx.home) : null,
      skipped,
    });
    return { ...r, file };
  },
};
