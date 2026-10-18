import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import type { ImportNote, ImportResult } from './index.js';
import { readJsonTool, shownFile, tableOf } from './io.js';
import type { ImportCtx, ImporterDef } from './registry.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'token-tracker';

export const TARGETS: readonly string[] = [
  'project-dir',
  'git-branch',
  'git-changes',
  'tokens-total',
  'session-cost',
  'lines-changed',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'context-bar',
  'tokens-input',
  'tokens-output',
  'tokens-cached',
  'output-speed',
  'model',
  'effort',
  'fast-mode',
  'session-duration',
  'git-repo',
];

// config.py resolve_theme: light/dark aliases, auto and anything else fall back to mocha
const THEMES: ThemeTable = {
  exact: {
    mocha: 'catppuccin-mocha',
    latte: 'catppuccin-latte',
    frappe: 'catppuccin-frappe',
    macchiato: 'catppuccin-macchiato',
    nord: 'nord',
    dracula: 'dracula',
    dark: 'catppuccin-mocha',
    light: 'catppuccin-latte',
  },
  approx: { auto: 'catppuccin-mocha' },
  fallback: 'catppuccin-mocha',
};

// claude_statusline.py bar_w on a wide terminal
const BAR = { display: 'bar', width: 8 };

type Part = [string, Record<string, OptionValue> | null];

// claude_statusline.py render(), four fixed rows
const LAYOUT: Part[][] = [
  [
    ['project-dir', null],
    ['git-branch', null],
    ['git-changes', null],
    ['tokens-total', null],
    ['session-cost', null],
    ['lines-changed', { hideZero: true }],
  ],
  [
    ['five-hour-usage', BAR],
    ['five-hour-reset', null],
    ['weekly-usage', BAR],
    ['weekly-reset', null],
    ['context-bar', { width: 8 }],
  ],
  [
    ['tokens-input', null],
    ['tokens-output', null],
    ['tokens-cached', null],
    ['output-speed', null],
  ],
  [
    ['model', null],
    ['effort', null],
    ['fast-mode', { showOff: true }],
    ['session-duration', null],
    ['git-repo', null],
  ],
];

// close but not the same data
const APPROX: [string, string][] = [
  ['Total', 'tokens-total'],
  ['cache', 'tokens-cached'],
  ['Remote', 'git-repo'],
];

export function importTokenTracker(
  raw: unknown,
  opts: { defaulted?: boolean; file?: string } = {},
): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const table = tableOf(raw);
  if (!table && opts.file)
    notes.push({ kind: 'info', text: t('import.note.hudIgnored', { file: opts.file }) });
  const c = table ?? {};

  const theme = Object.hasOwn(c, 'theme') ? c.theme : undefined;
  const mapped =
    theme === undefined ? { theme: 'catppuccin-mocha', notes: [] } : mapTheme(theme, THEMES, TOOL);
  notes.push(...mapped.notes);
  for (const [name, widget] of APPROX) {
    notes.push({ kind: 'approx', text: t('import.note.hudApprox', { tool: TOOL, name, widget }) });
  }
  if (Object.hasOwn(c, 'lang') && c.lang !== null && c.lang !== undefined) {
    const name = sanitizeText(typeof c.lang === 'string' ? c.lang : String(c.lang));
    notes.push({ kind: 'info', text: t('import.note.hudLanguage', { tool: TOOL, name }) });
  }

  const lines: WidgetItem[][] = LAYOUT.map((line) =>
    line.map(([type, options]) => ({
      id: `tt-${type}`,
      type,
      ...(options ? { options: { ...options } } : {}),
    })),
  );
  const config: Partial<Config> = { lines, theme: mapped.theme, style: 'text', separator: ' | ' };
  return { config, notes, source: 'token-tracker' };
}

// config.py CONFIG_PATH: ~/.config/token-tracker on every OS, never XDG_CONFIG_HOME
const configPath = (ctx: ImportCtx) => path.join(ctx.home, '.config', 'token-tracker', 'config.json');

export const tokenTrackerImporter: ImporterDef = {
  source: 'token-tracker',
  name: 'token-tracker',
  repo: 'stormzhang/token-tracker',
  shown: '~/.config/token-tracker/config.json',
  hasDefault: true,
  // hooks.py: "<python>" "~/.config/token-tracker/claude-statusline.py", older ~/.claude/tt-statusline.py
  detect: [/token-tracker[\\/][^"']*claude[-_]statusline\.py/i, /[\\/]\.claude[\\/]tt-statusline\.py/i],
  discover: configPath,
  load: (file, ctx) =>
    file
      ? {
          ...importTokenTracker(readJsonTool(file, TOOL, ctx.home), { file: shownFile(file, ctx.home) }),
          file,
        }
      : { ...importTokenTracker({}, { defaulted: true }), file: null },
};
