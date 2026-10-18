import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { claudeSettingsPath } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import type { ImportNote, ImportResult } from './index.js';
import { readJsonTool, tableOf } from './io.js';
import type { ImportCtx, ImporterDef } from './registry.js';

const TOOL = 'claude-usage-monitor';

export const TARGETS: readonly string[] = [
  'model',
  'project-dir',
  'git-branch',
  'context-bar',
  'context-percentage',
  'context-window-size',
  'tokens-input',
  'tokens-output',
  'five-hour-usage',
  'usage-pace',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'session-cost',
  'session-duration',
];

// statusline.py defaults, "1" = show
const DEFAULTS: Record<string, string> = {
  CQB_TOKENS: '1',
  CQB_RESET: '1',
  CQB_DURATION: '1',
  CQB_BRANCH: '1',
  CQB_CONTEXT_SIZE: '0',
  CQB_PACE: '0',
  CQB_COST: '0',
  CQB_REMAINING: '1',
  CQB_BAR: '1',
  CQB_EMAIL: '0',
};

const MAX_VALUE = 40;

type Types = [string, Record<string, OptionValue>?, Partial<WidgetItem>?][];

export function importClaudeUsageMonitor(
  envBlock: Record<string, unknown>,
  opts: { defaulted?: boolean } = {},
): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const raw = (k: string): string | undefined => {
    const v = Object.hasOwn(envBlock, k) ? envBlock[k] : undefined;
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
  };
  // os.environ.get(name, default) == "1"
  const on = (k: string) => (raw(k) ?? DEFAULTS[k]) === '1';
  const cqb = Object.keys(envBlock).filter((k) => k.startsWith('CQB_'));
  if (!cqb.length) notes.push({ kind: 'info', text: t('import.note.shellEnvIgnored', { tool: TOOL }) });

  const gauge = { width: 5, style: 'geometric' };
  const line1: Types = [['model'], ['project-dir'], ...(on('CQB_BRANCH') ? ([['git-branch']] as Types) : [])];
  const line2: Types = on('CQB_REMAINING')
    ? [
        // one gauge: bar, then the remaining percent
        ['context-bar', { ...gauge, showPercent: false }, { merge: true }],
        ['context-percentage', { mode: 'remaining' }, { label: ' ' }],
      ]
    : [['context-bar', gauge]];
  if (on('CQB_CONTEXT_SIZE')) line2.push(['context-window-size']);
  if (on('CQB_TOKENS')) line2.push(['tokens-input'], ['tokens-output']);
  const usage = on('CQB_BAR') ? { display: 'bar', ...gauge } : undefined;
  for (const [type, window, reset] of [
    ['five-hour-usage', '5h', 'five-hour-reset'],
    ['weekly-usage', '7d', 'weekly-reset'],
  ] as const) {
    line2.push(usage ? [type, usage] : [type]);
    if (on('CQB_PACE')) line2.push(['usage-pace', { window }]);
    if (on('CQB_RESET')) line2.push([reset]);
  }
  if (on('CQB_COST')) line2.push(['session-cost']);
  if (on('CQB_DURATION')) line2.push(['session-duration']);

  if (on('CQB_REMAINING')) {
    notes.push({
      kind: 'approx',
      text: t('import.note.remainingShare', { tool: TOOL, setting: 'CQB_REMAINING' }),
    });
  }
  if (on('CQB_PACE')) {
    notes.push({
      kind: 'approx',
      text: t('import.note.hudApprox', { tool: TOOL, name: 'CQB_PACE', widget: 'usage-pace' }),
    });
  }
  if (on('CQB_EMAIL')) {
    notes.push({ kind: 'drop', text: t('import.note.emailDropped', { tool: TOOL, setting: 'CQB_EMAIL' }) });
  }

  const config: Partial<Config> = { style: 'text', separator: ' │ ' };
  const ignored: string[] = [];
  const width = raw('CQB_MAX_WIDTH');
  if (width !== undefined) {
    // python int() and a positive width, else the terminal width
    const n = /^\s*\+?\d+\s*$/.test(width) ? Number.parseInt(width, 10) : 0;
    if (n > 0) config.maxWidth = n;
    else ignored.push(`CQB_MAX_WIDTH "${sanitizeText(width).slice(0, MAX_VALUE)}"`);
  }
  for (const k of cqb) {
    if (k !== 'CQB_MAX_WIDTH' && !Object.hasOwn(DEFAULTS, k))
      ignored.push(sanitizeText(k).slice(0, MAX_VALUE));
  }
  if (ignored.length) {
    notes.push({
      kind: 'drop',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: ignored.join(', ') }),
    });
  }

  const used = new Set<string>();
  config.lines = [line1, line2].map((l) =>
    l.map(([type, options, extra]): WidgetItem => {
      let id = `${TOOL}-${type}`;
      for (let n = 2; used.has(id); n++) id = `${TOOL}-${type}-${n}`;
      used.add(id);
      return { id, type, ...(options ? { options } : {}), ...extra };
    }),
  );
  return { config, notes, source: 'claude-usage-monitor' };
}

// the env block of Claude's settings.json, under the injected home
function settingsPath(ctx: ImportCtx): string {
  return claudeSettingsPath({
    CLAUDE_CONFIG_DIR: ctx.env.CLAUDE_CONFIG_DIR?.trim() || path.join(ctx.home, '.claude'),
  });
}

// only own CQB_* keys, nothing else of settings.json is kept
function cqbBlock(json: unknown): Record<string, unknown> {
  const block = tableOf(tableOf(json)?.env) ?? {};
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(block)) if (k.startsWith('CQB_')) out[k] = block[k];
  return out;
}

export const claudeUsageMonitorImporter: ImporterDef = {
  source: 'claude-usage-monitor',
  name: 'claude-usage-monitor',
  repo: 'aiedwardyi/claude-usage-monitor',
  shown: '~/.claude/settings.json (env)',
  hasDefault: true,
  detect: [/claude-usage-monitor/i],
  discover: settingsPath,
  load: (file, ctx) =>
    file
      ? { ...importClaudeUsageMonitor(cqbBlock(readJsonTool(file, TOOL, ctx.home))), file }
      : { ...importClaudeUsageMonitor({}, { defaulted: true }), file: null },
};
