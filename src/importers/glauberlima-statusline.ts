import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { firstPathToken } from './args.js';
import type { ImportNote, ImportResult } from './index.js';
import { isFile, readToml, tableOf } from './io.js';
import type { ImportCtx, ImporterDef } from './registry.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'glauberlima-statusline';
const FILE = 'statusline.toml';

export const TARGETS: readonly string[] = [
  'cwd',
  'git-branch',
  'git-status',
  'model',
  'context-bar',
  'context-length',
  'session-cost',
];

const THEMES: ThemeTable = {
  exact: {
    default: 'classic',
    dracula: 'dracula',
    'tokyo-night': 'tokyo-night',
    'one-dark': 'one-dark',
    'solarized-dark': 'solarized',
  },
  approx: { phosphor: 'matrix' },
  fallback: 'classic',
};

// usage_bar_style → context-bar barColor; exact only for plain and gradient
const BARS: Record<string, { color: 'solid' | 'gradient'; approx: boolean }> = {
  plain: { color: 'solid', approx: false },
  gradient: { color: 'gradient', approx: false },
  rainbow: { color: 'gradient', approx: true },
  gsd: { color: 'solid', approx: true },
  dracula: { color: 'gradient', approx: true },
  'tokyo-night': { color: 'gradient', approx: true },
  'one-dark': { color: 'gradient', approx: true },
  'solarized-dark': { color: 'gradient', approx: true },
  phosphor: { color: 'gradient', approx: true },
};

const KEYS = new Set(['cost', 'messages', 'messages_language', 'usage_bar_style', 'theme']);
const BAR_WIDTH = 15;

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

export function importGlauberlima(raw: unknown, opts: { defaulted?: boolean } = {}): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const c = tableOf(raw) ?? {};
  const get = (k: string) => (Object.hasOwn(c, k) ? c[k] : undefined);

  const bar: Record<string, OptionValue> = { width: BAR_WIDTH };
  const style = get('usage_bar_style');
  if (style !== undefined) {
    const key = typeof style === 'string' ? style : '';
    const name = sanitizeText(typeof style === 'string' ? style : String(style));
    const known = Object.hasOwn(BARS, key) ? BARS[key]! : null;
    if (!known) {
      notes.push({ kind: 'info', text: t('import.note.styleUnknown', { tool: TOOL, name, style: 'plain' }) });
    } else {
      if (known.color === 'gradient') bar.barColor = 'gradient';
      if (known.approx) {
        notes.push({
          kind: 'approx',
          text: t('import.note.barStyleApprox', { tool: TOOL, name, color: known.color }),
        });
      }
    }
  }

  const items: [string, Record<string, OptionValue> | null][] = [
    ['cwd', null],
    ['git-branch', null],
    ['git-status', null],
    ['model', null],
    ['context-bar', bar],
    ['context-length', { showMax: true }],
  ];
  if (bool(get('cost'), true)) items.push(['session-cost', null]);
  notes.push({
    kind: 'approx',
    text: t('import.note.hudApprox', { tool: TOOL, name: 'files', widget: 'git-status' }),
  });

  if (bool(get('messages'), false)) {
    notes.push({ kind: 'drop', text: t('import.note.contextMessages', { tool: TOOL, setting: 'messages' }) });
  }

  const themeName = get('theme');
  const mapped =
    themeName === undefined ? { theme: 'classic', notes: [] } : mapTheme(themeName, THEMES, TOOL);
  notes.push(...mapped.notes);

  const ignored = Object.keys(c)
    .filter((k) => !KEYS.has(k))
    .map(sanitizeText);
  if (ignored.length) {
    notes.push({
      kind: 'drop',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: ignored.join(', ') }),
    });
  }

  const lines: WidgetItem[][] = [
    items.map(([type, options]) => ({ id: `gl-${type}`, type, ...(options ? { options } : {}) })),
  ];
  const config: Partial<Config> = {
    lines,
    theme: mapped.theme,
    style: 'text',
    separator: ' | ',
    icons: 'emoji',
  };
  return { config, notes, source: 'glauberlima-statusline' };
}

// statusline.toml sits next to the binary (config.rs config_path)
function besideBinary(ctx: ImportCtx): string | null {
  const bin = firstPathToken(ctx.command, ctx.home);
  if (!bin || !/^statusline(?:\.exe)?$/i.test(path.basename(bin))) return null;
  const file = path.join(path.dirname(bin), FILE);
  return isFile(file) ? file : null;
}

export const glauberlimaImporter: ImporterDef = {
  source: 'glauberlima-statusline',
  name: 'claude-code-statusline (glauberlima)',
  repo: 'glauberlima/claude-code-statusline',
  aliases: ['glauberlima'],
  shown: '~/.claude/statusline.toml',
  hasDefault: true,
  // the bare binary only, never statusline.sh or statusline/statusline.sh
  detect: [/[\\/]\.claude[\\/]statusline(?:\.exe)?["']?\s*$/i],
  discover: (ctx) => besideBinary(ctx) ?? path.join(ctx.home, '.claude', FILE),
  load: (file) =>
    file
      ? { ...importGlauberlima(readToml(file, TOOL)), file }
      : { ...importGlauberlima({}, { defaulted: true }), file: null },
};
