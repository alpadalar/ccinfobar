import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { flagValue, isBin } from './args.js';
import type { ImportNote, ImportResult } from './index.js';
import { readJsonTool, shownFile, tableOf } from './io.js';
import type { ImporterDef } from './registry.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'claude-statusbar';
const SHOWN = '~/.claude/claude-statusbar.json';

export const TARGETS: readonly string[] = [
  'five-hour-usage',
  'five-hour-reset',
  'usage-projection',
  'limit-risk',
  'weekly-usage',
  'weekly-reset',
  'model',
  'context-length',
  'session-cost',
  'cache-timer',
  'weekly-model-usage',
  'weekly-model-reset',
  'git-worktree',
  'project-dir',
  'git-branch',
  'git-status',
  'git-ahead-behind',
  'cwd',
  'session-duration',
  'lines-changed',
  'effort',
  'thinking',
  'fast-mode',
  'output-style',
  'todo-list',
  'tool-activity',
  'agents',
];

const THEMES: ThemeTable = {
  exact: {
    nord: 'nord',
    dracula: 'dracula',
    mono: 'mono',
    'catppuccin-mocha': 'catppuccin-mocha',
    'tokyo-night': 'tokyo-night',
  },
  approx: { graphite: 'dark', twilight: 'one-dark', linen: 'light', sakura: 'rose-pine' },
  // claude-statusbar falls back to graphite
  fallback: 'dark',
};

const STYLES = ['classic', 'capsule', 'hairline'];
const PAD: Record<string, string> = { compact: '', regular: ' ', cozy: '  ' };

// config.py defaults
const DEFAULTS: Record<string, boolean> = {
  show_weekly: true,
  show_per_model: false,
  show_cost: false,
  show_cache_age: true,
  show_project_branch: true,
  show_cwd: false,
  show_todos: true,
  show_tools: false,
  show_tool_rollup: false,
  show_agents: false,
  show_duration: false,
  show_lines: true,
  show_ahead_behind: false,
  show_mode: true,
  show_forecast: true,
  show_projection: true,
};

const toBool = (v: unknown): boolean =>
  typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on', 'y', 't'].includes(String(v).trim().toLowerCase());

const nonZero = (v: unknown) =>
  typeof v === 'number' ? v !== 0 : typeof v === 'string' && v.trim() !== '' && Number(v) !== 0;
const filled = (v: unknown) => v !== null && v !== undefined && v !== '';

// keys ccinfobar cannot import, listed when set to something that shows
const DROPPED: [string, (v: unknown, style: string) => boolean][] = [
  ['density', (v, style) => style !== 'hairline' && String(v) !== 'regular'],
  ['auto_compact_width', nonZero],
  ['show_language', toBool],
  ['show_balance', toBool],
  ['balance_bar', toBool],
  ['show_ocs', toBool],
  ['show_ip_risk', toBool],
  ['show_fp_risk', toBool],
  ['show_version', toBool],
  ['mode_gradient', toBool],
  ['bar_shimmer', toBool],
  ['api_mode', (v) => String(v) !== 'auto'],
  ['warning_threshold', filled],
  ['critical_threshold', filled],
  ['color_ok', (v) => !!v],
  ['color_warn', (v) => !!v],
  ['color_hot', (v) => !!v],
  ['color_worktree', (v) => !!v],
  ['worktree_glyph', (v) => !!v && String(v) !== '⑂'],
  ['auto_upgrade', toBool],
];

type Types = [string, Record<string, OptionValue>?][];

export function importClaudeStatusbar(
  raw: unknown,
  opts: { defaulted?: boolean; file?: string } = {},
): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const table = tableOf(raw);
  if (!table && !opts.defaulted) {
    notes.push({
      kind: 'info',
      text: t('import.note.hudIgnored', { file: sanitizeText(opts.file ?? SHOWN) }),
    });
  }
  const c = table ?? {};
  const has = (k: string) => Object.hasOwn(c, k);
  const on = (k: string) => (has(k) ? toBool(c[k]) : DEFAULTS[k]!);

  const styleName = has('style') ? String(c.style) : 'classic';
  const style = STYLES.includes(styleName) ? styleName : 'classic';
  if (style !== styleName) {
    const name = sanitizeText(styleName);
    notes.push({ kind: 'info', text: t('import.note.styleUnknown', { tool: TOOL, name, style }) });
  }
  if (style === 'hairline') {
    notes.push({
      kind: 'approx',
      text: t('import.note.styleApprox', { tool: TOOL, name: 'hairline', style: 'text' }),
    });
  }

  const classic = style === 'classic';
  const usage = (): Record<string, OptionValue> | undefined =>
    style === 'capsule'
      ? undefined
      : style === 'hairline'
        ? { display: 'bar', width: 3 }
        : { display: 'bar' };
  const window = (w: '5h' | '7d'): Types =>
    classic
      ? [
          ...(on('show_projection') ? ([['usage-projection', { window: w }]] as Types) : []),
          ...(on('show_forecast') ? ([['limit-risk', { window: w }]] as Types) : []),
        ]
      : [];

  const main: Types = [
    ['five-hour-usage', usage()],
    ['five-hour-reset'],
    ...window('5h'),
    ...(on('show_weekly') ? ([['weekly-usage', usage()], ['weekly-reset'], ...window('7d')] as Types) : []),
    ['model'],
    ['context-length', { showMax: true }],
    ...(on('show_cost') ? ([['session-cost']] as Types) : []),
    ...(on('show_cache_age') ? ([['cache-timer']] as Types) : []),
  ];

  const perModel: Types = [];
  if (on('show_per_model')) {
    perModel.push(['weekly-model-usage', { display: 'bar' }], ['weekly-model-reset']);
    notes.push({
      kind: 'approx',
      text: t('import.note.hudApprox', { tool: TOOL, name: 'show_per_model', widget: 'weekly-model-usage' }),
    });
  }

  const cwd: Types = on('show_cwd')
    ? [['cwd', { style: has('cwd_style') && String(c.cwd_style) === 'full' ? 'full' : 'basename' }]]
    : [];
  const identity: Types = on('show_project_branch')
    ? [
        ['git-worktree'],
        ['project-dir'],
        ['git-branch'],
        ['git-status', { counts: false }],
        ...(on('show_ahead_behind') ? ([['git-ahead-behind']] as Types) : []),
        ...cwd,
        ...(on('show_duration') ? ([['session-duration']] as Types) : []),
        ...(on('show_lines') ? ([['lines-changed']] as Types) : []),
      ]
    : cwd;

  const mode: Types = on('show_mode')
    ? [['effort'], ['thinking'], ['fast-mode', { showOff: true }], ['output-style', { showDefault: true }]]
    : [];

  const tools = on('show_tools');
  const rollup = on('show_tool_rollup');
  const activity: Types = [
    ...(on('show_todos') ? ([['todo-list', { display: 'current' }]] as Types) : []),
    ...(tools || rollup
      ? ([['tool-activity', { mode: tools && rollup ? 'both' : tools ? 'running' : 'counts' }]] as Types)
      : []),
  ];
  const agents: Types = on('show_agents') ? [['agents', { runningOnly: true }]] : [];

  const used = new Set<string>();
  const lines: WidgetItem[][] = [main, perModel, identity, mode, activity, agents]
    .filter((l) => l.length > 0)
    .map((l) =>
      l.map(([type, options]) => {
        let id = `${TOOL}-${type}`;
        for (let n = 2; used.has(id); n++) id = `${TOOL}-${type}-${n}`;
        used.add(id);
        return { id, type, ...(options ? { options } : {}) };
      }),
    );

  const ignored = DROPPED.filter(([k, active]) => has(k) && active(c[k], style)).map(([k]) => k);
  if (ignored.length) {
    notes.push({
      kind: 'drop',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: ignored.join(', ') }),
    });
  }

  const { theme, notes: themeNotes } = mapTheme(has('theme') ? c.theme : 'graphite', THEMES, TOOL);
  notes.push(...themeNotes);
  const density = has('density') && Object.hasOwn(PAD, String(c.density)) ? String(c.density) : 'regular';
  const config: Partial<Config> =
    style === 'capsule'
      ? { lines, theme, style: 'capsule' }
      : {
          lines,
          theme,
          style: 'text',
          separator: classic ? ' | ' : `${PAD[density]}┊${PAD[density]}`,
        };
  return { config, notes, source: 'claude-statusbar' };
}

const OVERRIDE_ENV = ['STYLE', 'THEME', 'WARNING_THRESHOLD', 'CRITICAL_THRESHOLD'].map(
  (k) => `CLAUDE_STATUSBAR_${k}`,
);

// claude-statusbar flags and env win over its file; ccinfobar reads the file only
function overrideNames(args: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return [
    ...['--style', '--theme'].filter((f) => flagValue(args, [f]) !== null),
    ...OVERRIDE_ENV.filter((k) => Object.hasOwn(env, k) && !!env[k]),
  ];
}

export const claudeStatusbarImporter: ImporterDef = {
  source: 'claude-statusbar',
  name: 'claude-statusbar',
  repo: 'leeguooooo/claude-code-usage-bar',
  shown: SHOWN,
  hasDefault: true,
  detect: [/(?:^|[\\/\s"'])(?:cs|cstatus|claude-statusbar)(?:\.exe)?["']?\s+render\b/i, /claude-statusbar/i],
  tool: isBin('cs', 'cstatus', 'claude-statusbar'),
  // Path.home() on every OS, never CLAUDE_CONFIG_DIR
  discover: (ctx) => path.join(ctx.home, '.claude', 'claude-statusbar.json'),
  load: (file, ctx) => {
    const r = file
      ? { ...importClaudeStatusbar(readJsonTool(file, TOOL), { file: shownFile(file, ctx.home) }), file }
      : { ...importClaudeStatusbar({}, { defaulted: true }), file: null };
    const names = overrideNames(ctx.argv, ctx.env);
    if (names.length) {
      r.notes.push({
        kind: 'info',
        text: t('import.note.envFlagsIgnored', { tool: TOOL, names: names.join(', ') }),
      });
    }
    return r;
  },
};
