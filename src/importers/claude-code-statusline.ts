import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { commandScript } from './cc-statusline.js';
import type { ImportNote, ImportResult } from './index.js';
import { readToml, tableOf } from './io.js';
import type { ImporterDef } from './registry.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'claude-code-statusline';

export const TARGETS: readonly string[] = [
  'cwd',
  'git-branch',
  'git-status',
  'model',
  'provider',
  'claude-version',
  'clock',
  'cost-project',
  'session-cost',
  'cost-today',
  'cost-week',
  'cost-rate',
  'cache-hit-rate',
  'usage-projection',
  'lines-changed',
  'context-percentage',
  'five-hour-usage',
  'weekly-usage',
  'five-hour-reset',
  'weekly-reset',
  'session-id',
  'session-name',
  'output-style',
  'tokens-input',
  'tokens-output',
  'vim-mode',
  'agent-name',
  'pr',
  'env-counts',
];

type Types = [string, Record<string, OptionValue> | null][];

const MCP_ONLY = { showClaudeMd: false, showAgentsMd: false, showRules: false, showHooks: false };

const COMPONENTS: Record<string, Types> = {
  repo_info: [
    ['cwd', null],
    ['git-branch', null],
    ['git-status', null],
  ],
  model_info: [['model', null]],
  bedrock_model: [['provider', null]],
  version_info: [['claude-version', null]],
  version_display: [['claude-version', null]],
  time_display: [['clock', null]],
  cost_repo: [['cost-project', null]],
  cost_live: [['session-cost', null]],
  cost_daily: [['cost-today', null]],
  cost_weekly: [['cost-week', null]],
  cost_monthly: [['cost-project', { period: 'month' }]],
  burn_rate: [['cost-rate', null]],
  cache_efficiency: [['cache-hit-rate', null]],
  block_projection: [['usage-projection', null]],
  code_productivity: [['lines-changed', null]],
  context_window: [['context-percentage', null]],
  usage_limits: [
    ['five-hour-usage', null],
    ['weekly-usage', null],
  ],
  usage_reset: [
    ['five-hour-reset', null],
    ['weekly-reset', null],
  ],
  reset_timer: [['five-hour-reset', null]],
  session_info: [
    ['session-id', { short: true }],
    ['session-name', null],
  ],
  session_mode: [['output-style', null]],
  total_tokens: [
    ['tokens-input', null],
    ['tokens-output', null],
  ],
  vim_mode: [['vim-mode', null]],
  agent_display: [['agent-name', null]],
  github: [['pr', null]],
  mcp_status: [['env-counts', MCP_ONLY]],
  mcp_native: [['env-counts', MCP_ONLY]],
  mcp_servers: [['env-counts', MCP_ONLY]],
  mcp_plugins: [['env-counts', MCP_ONLY]],
};

// close but not the same data
const APPROX: Record<string, string> = {
  bedrock_model: 'provider',
  cost_weekly: 'cost-week',
  cost_monthly: 'cost-project',
  block_projection: 'usage-projection',
  github: 'pr',
  mcp_status: 'env-counts',
  mcp_native: 'env-counts',
  mcp_servers: 'env-counts',
  mcp_plugins: 'env-counts',
};

const THEMES: ThemeTable = {
  exact: { classic: 'classic', catppuccin: 'catppuccin' },
  approx: { garden: 'everforest', ocean: 'nord', custom: 'classic' },
  fallback: 'catppuccin',
};

const DEFAULT_SEPARATOR = ' │ ';
const USED = new Set(['theme', 'display']);

const leafCount = (v: unknown): number => {
  const tb = tableOf(v);
  return tb ? Object.values(tb).reduce<number>((n, x) => n + leafCount(x), 0) : 1;
};

function componentList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

export function importClaudeCodeStatusline(raw: unknown): ImportResult {
  const notes: ImportNote[] = [];
  const c = tableOf(raw) ?? {};
  const display = tableOf(c.display) ?? {};
  const count =
    typeof display.lines === 'number' && Number.isInteger(display.lines) && display.lines >= 1
      ? Math.min(display.lines, 9)
      : 5;

  const lines: WidgetItem[][] = [];
  const separators: string[] = [];
  const used = new Set<string>();
  const dropped = new Set<string>();
  const approxed = new Set<string>();
  let mcp = false;
  for (let n = 1; n <= count; n++) {
    const key = `line${n}`;
    const line = Object.hasOwn(display, key) ? (tableOf(display[key]) ?? {}) : {};
    const items: WidgetItem[] = [];
    for (const entry of componentList(line.components)) {
      const id = typeof entry === 'string' ? entry.trim() : '';
      const name = sanitizeText(typeof entry === 'string' ? entry.trim() : String(entry));
      const types = Object.hasOwn(COMPONENTS, id) ? COMPONENTS[id]! : null;
      if (!types) {
        if (!dropped.has(name))
          notes.push({ kind: 'drop', text: t('import.note.noSegment', { tool: TOOL, name }) });
        dropped.add(name);
        continue;
      }
      if (id.startsWith('mcp_')) {
        if (mcp) continue;
        mcp = true;
      }
      if (Object.hasOwn(APPROX, id) && !approxed.has(id)) {
        approxed.add(id);
        notes.push({
          kind: 'approx',
          text: t('import.note.hudApprox', { tool: TOOL, name, widget: APPROX[id]! }),
        });
      }
      for (const [type, options] of types) {
        let itemId = `ccs-${id}-${type}`;
        for (let i = 2; used.has(itemId); i++) itemId = `ccs-${id}-${type}-${i}`;
        used.add(itemId);
        items.push({ id: itemId, type, ...(options ? { options: { ...options } } : {}) });
      }
    }
    if (!items.length) continue;
    lines.push(items);
    separators.push(
      typeof line.separator === 'string' && line.separator ? line.separator : DEFAULT_SEPARATOR,
    );
  }

  // ccinfobar has one separator, so the most common one wins
  const tally = new Map<string, number>();
  for (const s of separators) tally.set(s, (tally.get(s) ?? 0) + 1);
  let separator = DEFAULT_SEPARATOR;
  let best = 0;
  for (const [s, n] of tally) {
    if (n > best) {
      separator = s;
      best = n;
    }
  }
  if (tally.size > 1) {
    const shown = `"${sanitizeText(separator)}"`;
    notes.push({ kind: 'approx', text: t('import.note.separatorMerged', { tool: TOOL, separator: shown }) });
  }

  const themeName = tableOf(c.theme)?.name ?? 'catppuccin';
  const { theme, notes: themeNotes } = mapTheme(themeName, THEMES, TOOL);
  notes.push(...themeNotes);

  // section names and key counts only, never values
  const ignored = Object.keys(c)
    .filter((k) => !USED.has(k))
    .map((k) => `${sanitizeText(k)} (${leafCount(c[k])})`);
  if (ignored.length) {
    notes.push({
      kind: 'info',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: ignored.join(', ') }),
    });
  }

  const config: Partial<Config> = { lines, theme, style: 'text', separator: sanitizeText(separator) };
  return { config, notes, source: 'claude-code-statusline' };
}

export const claudeCodeStatuslineImporter: ImporterDef = {
  source: 'claude-code-statusline',
  name: 'claude-code-statusline (rz1989s)',
  repo: 'rz1989s/claude-code-statusline',
  aliases: ['rz1989s'],
  shown: '~/.claude/statusline/Config.toml',
  hasDefault: false,
  // daniel3303/ClaudeCodeStatusLine installs the same path, so the script is read
  sniff: {
    file: commandScript,
    marker: /\.claude\/statusline\/Config\.toml|STATUSLINE_CORE_LOADED/,
    bytes: 8192,
  },
  discover: (ctx) => path.join(ctx.home, '.claude', 'statusline', 'Config.toml'),
  load: (file, ctx) => {
    const f = file ?? path.join(ctx.home, '.claude', 'statusline', 'Config.toml');
    return { ...importClaudeCodeStatusline(readToml(f, TOOL)), file: f };
  },
};
