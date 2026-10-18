import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, IconMode, OptionValue, ThemeStyle, WidgetItem } from '../core/types.js';
import { flagValue, isBin } from './args.js';
import { namedColor } from './colors.js';
import type { ImportNote, ImportResult } from './index.js';
import { expand, readToml, tableOf } from './io.js';
import type { ImportCtx, ImporterDef } from './registry.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'claude-code-statusline-pro';

export const TARGETS: readonly string[] = [
  'project-dir',
  'model',
  'git-branch',
  'git-status',
  'git-ahead-behind',
  'git-stash',
  'context-bar',
  'context-percentage',
  'context-length',
  'session-cost',
  'lines-changed',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'tool-activity',
];

export const DEFAULT_PRESET = 'PMBTURS';

const PRESET_LETTERS: Record<string, string> = {
  P: 'project',
  M: 'model',
  B: 'branch',
  T: 'tokens',
  U: 'usage',
  R: 'rate_limit',
  S: 'status',
};

// emoji, nerd, text
const ICONS: Record<string, [string, string, string]> = {
  project: ['\u{1f4c1}', '', '[P]'],
  model: ['\u{1f916}', '\u{f09d1}', '[M]'],
  branch: ['\u{1f33f}', '', '[B]'],
  tokens: ['\u{1f4ca}', '', '[T]'],
  usage: ['\u{1f4b0}', '', '[U]'],
  rate_limit: ['⏱️', '', '[R]'],
  status: ['✨', '', '[S]'],
};

const THEMES: ThemeTable = {
  exact: { classic: 'classic', powerline: 'powerline', capsule: 'capsule' },
};

const STYLES: Record<string, ThemeStyle> = { classic: 'text', powerline: 'powerline', capsule: 'capsule' };

// ccsp color names outside the 16 ANSI names
const EXTRA_COLORS: Record<string, string> = {
  orange: 'yellow',
  bright_orange: 'yellow',
  pink: 'magenta',
  bright_pink: 'magenta',
};

export interface StatuslineProOptions {
  preset?: string;
  theme?: string;
  defaulted?: boolean;
  projectLayer?: boolean;
  force?: 'text' | 'nerd' | 'emoji';
  noColors?: boolean;
  noEmoji?: boolean;
  noIcons?: boolean;
}

// label null keeps the widget's own label
type Types = [string, Record<string, OptionValue> | null, string | null][];

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

function color(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const key = v.trim().toLowerCase();
  return namedColor(Object.hasOwn(EXTRA_COLORS, key) ? EXTRA_COLORS[key] : key);
}

function iconMode(c: Record<string, unknown>, opts: StatuslineProOptions): IconMode {
  const term = tableOf(c.terminal) ?? {};
  const style = tableOf(c.style) ?? {};
  if (opts.force === 'text' || term.force_text === true) return 'text';
  if (opts.force === 'nerd' || (term.force_nerd_font === true && !opts.noIcons)) return 'nerd';
  if (opts.force === 'emoji' || (term.force_emoji === true && !opts.noEmoji)) return 'emoji';
  // auto: Nerd Fonts need NERD_FONT in the env, emoji only a UTF-8 terminal
  if (style.enable_nerd_font === true && !opts.noIcons) return 'nerd';
  if (style.enable_emoji !== false && !opts.noEmoji) return 'emoji';
  return 'text';
}

function presetOrder(preset: string, mapping: Record<string, unknown> | null): string[] {
  const letters = new Map(Object.entries(PRESET_LETTERS));
  for (const [k, v] of Object.entries(mapping ?? {})) {
    if (k.length === 1 && typeof v === 'string') letters.set(k.toUpperCase(), v);
  }
  const out: string[] = [];
  for (const ch of new Set([...preset.toUpperCase()])) if (ch.trim()) out.push(letters.get(ch) ?? ch);
  return out;
}

export function importStatuslinePro(raw: unknown, opts: StatuslineProOptions = {}): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const c = tableOf(raw) ?? {};
  const style = tableOf(c.style) ?? {};
  const comps = tableOf(c.components) ?? {};
  const mode = iconMode(c, opts);
  const colors = style.enable_colors !== false && !opts.noColors;
  const iconIndex = mode === 'emoji' ? 0 : mode === 'nerd' ? 1 : 2;
  const iconKey = (['emoji_icon', 'nerd_icon', 'text_icon'] as const)[iconIndex];

  const comp = (id: string) => (Object.hasOwn(comps, id) ? (tableOf(comps[id]) ?? {}) : {});

  const componentTypes = (id: string, cfg: Record<string, unknown>): Types | null => {
    switch (id) {
      case 'project':
        return [['project-dir', null, null]];
      case 'model':
        return [['model', null, null]];
      case 'branch': {
        const st = tableOf(cfg.status) ?? {};
        const out: Types = [['git-branch', null, null]];
        if (st.show_dirty === true) out.push(['git-status', null, '']);
        if (st.show_ahead_behind === true) out.push(['git-ahead-behind', null, '']);
        if (st.show_stash_count === true) out.push(['git-stash', null, '']);
        return out;
      }
      case 'tokens': {
        const out: Types = [];
        const pct = bool(cfg.show_percentage, true);
        if (bool(cfg.show_progress_bar, true)) {
          const width = intIn(cfg.progress_width, 1, 100) ?? 15;
          out.push(['context-bar', { width, ...(pct ? {} : { showPercent: false }) }, null]);
        } else if (pct) {
          out.push(['context-percentage', null, null]);
        }
        // ccsp always shows used/total tokens
        out.push(['context-length', { showMax: true }, '']);
        return out;
      }
      case 'usage': {
        const decimals = intIn(cfg.precision, 0, 4);
        const out: Types = [['session-cost', decimals !== null ? { decimals } : null, null]];
        if (cfg.show_lines_added === true || cfg.show_lines_removed === true) {
          out.push(['lines-changed', null, '']);
        }
        return out;
      }
      case 'rate_limit': {
        const out: Types = [];
        const reset = bool(cfg.show_reset, true);
        if (bool(cfg.show_five_hour, true)) {
          out.push(['five-hour-usage', null, '5h']);
          if (reset) out.push(['five-hour-reset', null, null]);
        }
        if (bool(cfg.show_seven_day, true)) {
          out.push(['weekly-usage', null, '7d']);
          if (reset) out.push(['weekly-reset', null, null]);
        }
        return out;
      }
      case 'status':
        return [['tool-activity', { mode: 'running' }, null]];
      default:
        return null;
    }
  };

  const order = Array.isArray(comps.order) && comps.order.length ? (comps.order as unknown[]) : null;
  const filePreset = typeof c.preset === 'string' ? c.preset : DEFAULT_PRESET;
  // a preset in the command always wins; in the file only without components.order
  const list: unknown[] = opts.preset
    ? presetOrder(opts.preset, tableOf(c.preset_mapping))
    : (order ?? presetOrder(filePreset, tableOf(c.preset_mapping)));

  const items: WidgetItem[] = [];
  const used = new Set<string>();
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : '';
    const name = sanitizeText(typeof entry === 'string' ? entry : String(entry));
    const cfg = comp(id);
    const types = Object.hasOwn(ICONS, id) ? componentTypes(id, cfg) : null;
    if (!types) {
      notes.push({ kind: 'drop', text: t('import.note.noSegment', { tool: TOOL, name }) });
      continue;
    }
    if (cfg.enabled === false || !types.length) continue;
    if (id === 'status') {
      notes.push({
        kind: 'approx',
        text: t('import.note.hudApprox', { tool: TOOL, name, widget: 'tool-activity' }),
      });
    }
    const icon = str(cfg[iconKey], ICONS[id]![iconIndex]);
    const textColor = colors ? color(cfg.text_color) : undefined;
    if (colors && icon && Object.hasOwn(cfg, 'icon_color') && color(cfg.icon_color) !== textColor) {
      notes.push({ kind: 'approx', text: t('import.note.iconColor', { tool: TOOL, name }) });
    }
    types.forEach(([type, options, fixed], i) => {
      let itemId = `ccsp-${id}-${type}`;
      for (let n = 2; used.has(itemId); n++) itemId = `ccsp-${id}-${type}-${n}`;
      used.add(itemId);
      const it: WidgetItem = { id: itemId, type, ...(options ? { options } : {}) };
      if (i === 0) it.label = [icon, fixed ?? ''].filter(Boolean).join(' ');
      else if (fixed !== null) it.label = fixed;
      if (textColor) it.color = textColor;
      items.push(it);
    });
  }

  const model = comp('model');
  const tokens = comp('tokens');
  const approx = [
    ...['mapping', 'long_name_mapping'].filter((k) => Object.hasOwn(model, k)).map((k) => `model.${k}`),
    ...['thresholds', 'context_windows'].filter((k) => Object.hasOwn(tokens, k)).map((k) => `tokens.${k}`),
  ];
  if (approx.length) {
    notes.push({
      kind: 'approx',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: approx.join(', ') }),
    });
  }
  const widgets = Object.values(tableOf(c.widgets) ?? {}).filter((v) => tableOf(v) !== null).length;
  const multiline = tableOf(c.multiline);
  if (widgets > 0 || (multiline && multiline.enabled !== false)) {
    notes.push({ kind: 'drop', text: t('import.note.multilineDropped', { tool: TOOL, count: widgets }) });
  }
  if (typeof c.language === 'string' && c.language !== 'en') {
    const name = sanitizeText(c.language);
    notes.push({ kind: 'info', text: t('import.note.hudLanguage', { tool: TOOL, name }) });
  }
  if (opts.projectLayer) notes.push({ kind: 'info', text: t('import.note.projectLayer', { tool: TOOL }) });

  const { theme, notes: themeNotes } = mapTheme(opts.theme ?? c.theme ?? 'classic', THEMES, TOOL);
  notes.push(...themeNotes);
  const config: Partial<Config> = { lines: [items], style: STYLES[theme]!, icons: mode };
  if (theme === 'classic') {
    config.separator =
      str(style.separator_before, ' ') + str(style.separator, '|') + str(style.separator_after, ' ');
  }
  if (!colors) config.colorLevel = 0;
  const maxWidth = intIn(style.max_width, 1, 10000);
  if (maxWidth !== null) config.maxWidth = maxWidth;
  return { config, notes, source: 'statusline-pro' };
}

const TOOL_TOKEN = /claude-code-statusline-pro|\bccsp\b/i;
const VALUE_FLAGS = new Set(['-c', '--config', '-p', '--preset', '-t', '--theme', '--mock']);

// positional PRESET after the binary, as in `ccsp PMBT`
function positionalPreset(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('-')) return /^[A-Za-z]+$/.test(a) ? a : null;
  }
  return null;
}

function commandOptions(ctx: ImportCtx): StatuslineProOptions {
  const a = ctx.argv;
  const preset = flagValue(a, ['-p', '--preset']) ?? positionalPreset(a);
  const theme = flagValue(a, ['-t', '--theme']);
  const has = (f: string) => a.includes(f);
  const force = has('--force-text')
    ? 'text'
    : has('--force-nerd-font')
      ? 'nerd'
      : has('--force-emoji')
        ? 'emoji'
        : undefined;
  return {
    ...(preset ? { preset } : {}),
    ...(theme ? { theme } : {}),
    ...(force ? { force } : {}),
    ...(has('--no-colors') ? { noColors: true } : {}),
    ...(has('--no-emoji') ? { noEmoji: true } : {}),
    ...(has('--no-icons') ? { noIcons: true } : {}),
  };
}

function named(ctx: ImportCtx): string | null {
  const flag = flagValue(ctx.argv, ['-c', '--config']);
  return flag ? path.resolve(ctx.cwd, expand(flag, ctx.home)) : null;
}

const discover = (ctx: ImportCtx): string =>
  named(ctx) ?? path.join(ctx.home, '.claude', 'statusline-pro', 'config.toml');

export const statuslineProImporter: ImporterDef = {
  source: 'statusline-pro',
  name: TOOL,
  repo: 'Wangnov/claude-code-statusline-pro',
  aliases: ['ccsp', 'claude-code-statusline-pro'],
  shown: '~/.claude/statusline-pro/config.toml',
  hasDefault: true,
  detect: [TOOL_TOKEN],
  tool: isBin('ccsp', 'claude-code-statusline-pro'),
  named,
  discover,
  load: (file, ctx) => {
    const opts = commandOptions(ctx);
    // the project layer sits under a hashed path that is not reproduced
    const projectLayer = !file || file === discover(ctx);
    if (!file) return { ...importStatuslinePro({}, { ...opts, defaulted: true, projectLayer }), file: null };
    return { ...importStatuslinePro(readToml(file, TOOL, ctx.home), { ...opts, projectLayer }), file };
  },
};
