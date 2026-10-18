import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import type { ImportNote, ImportResult } from './index.js';
import { readJsonTool, shownFile, tableOf } from './io.js';
import type { ImporterDef } from './registry.js';

const TOOL = 'claude-ultimate-hud';
const SHOWN = '~/.claude/claude-ultimate-hud.local.json';

export const TARGETS: readonly string[] = [
  'model',
  'context-bar',
  'context-length',
  'tokens-input',
  'tokens-cached',
  'session-cost',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-model-usage',
  'thinking',
  'skills',
  'lines-changed',
  'cwd',
  'git-branch',
  'git-status',
  'git-ahead-behind',
  'env-counts',
  'session-duration',
  'tool-activity',
  'agents',
  'todo-list',
];

const PLANS = ['pro', 'max100', 'max200', 'enterprise'];

// types.ts DEFAULT_CONFIG
const DEFAULTS: Record<string, unknown> = { language: 'ko', plan: 'max100', cache: { ttlSeconds: 300 } };

type Types = [string, Record<string, OptionValue>?, Partial<WidgetItem>?][];

export function importClaudeUltimateHud(
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
  const user = table ?? {};
  // upstream merges { ...DEFAULT_CONFIG, ...user }
  const get = (k: string) =>
    Object.hasOwn(user, k) ? user[k] : Object.hasOwn(DEFAULTS, k) ? DEFAULTS[k] : undefined;
  const display = tableOf(get('display')) ?? {};
  const show = (k: string) => !Object.hasOwn(display, k) || display[k] !== false;
  const approx = (name: string, widget: string) =>
    notes.push({ kind: 'approx', text: t('import.note.hudApprox', { tool: TOOL, name, widget }) });

  const language = String(get('language'));
  if (language !== 'en' && language !== 'auto') {
    notes.push({
      kind: 'info',
      text: t('import.note.hudLanguage', { tool: TOOL, name: sanitizeText(language) }),
    });
  }
  const planName = String(get('plan'));
  const plan = PLANS.includes(planName) ? planName : 'pro';
  if (plan !== planName) {
    notes.push({
      kind: 'info',
      text: t('import.note.planUnknown', { tool: TOOL, name: sanitizeText(planName), plan }),
    });
  }
  const cache = tableOf(user.cache);
  if (Object.hasOwn(user, 'cache') && cache && Object.hasOwn(cache, 'ttlSeconds')) {
    notes.push({
      kind: 'info',
      text: t('import.note.usageCacheTtl', { tool: TOOL, name: 'cache.ttlSeconds' }),
    });
  }

  const fiveHour: Types = [['five-hour-usage'], ['five-hour-reset']];
  const limits: Types =
    plan === 'enterprise'
      ? [['session-cost'], ...fiveHour]
      : plan === 'pro'
        ? fiveHour
        : [...fiveHour, ['weekly-usage'], ['weekly-model-usage', { model: 'Sonnet' }]];
  const breakdown: Types = show('showTokenBreakdown')
    ? [
        ['tokens-input', undefined, { showWhen: 'context.pct >= 85' }],
        ['tokens-cached', undefined, { showWhen: 'context.pct >= 85' }],
      ]
    : [];
  if (breakdown.length) approx('showTokenBreakdown', 'tokens-input');
  const session: Types = [
    ['model'],
    ['context-bar'],
    ['context-length', { showMax: true }],
    ...breakdown,
    ...limits,
  ];

  const stats: Types = show('showStats')
    ? [
        ['thinking', { hideOff: true }],
        ['skills', { mode: 'current' }, { hideEmpty: true }],
        ['lines-changed', { hideZero: true }],
      ]
    : [];
  const project: Types = [
    ['cwd', { style: 'basename' }],
    ['git-branch'],
    ['git-status', { counts: false }],
    ['git-ahead-behind'],
    ['env-counts', { showAgentsMd: false }],
    ['session-duration'],
  ];
  const hide = { hideEmpty: true };
  const tools: Types = show('showTools') ? [['tool-activity', { mode: 'both', scope: 'session' }, hide]] : [];
  const agents: Types = show('showAgents') ? [['agents', { maxAgents: 3 }, hide]] : [];
  const todos: Types = show('showTodos') ? [['todo-list', { display: 'current' }, hide]] : [];
  // the context warning line has no widget, the bar colors stand in
  approx('contextWarning', 'context-bar');

  const used = new Set<string>();
  const lines: WidgetItem[][] = [session, stats, project, tools, agents, todos]
    .filter((l) => l.length > 0)
    .map((l) =>
      l.map(([type, options, extra]) => {
        let id = `${TOOL}-${type}`;
        for (let n = 2; used.has(id); n++) id = `${TOOL}-${type}-${n}`;
        used.add(id);
        return { id, type, ...(options ? { options } : {}), ...extra };
      }),
    );

  const config: Partial<Config> = { lines, style: 'text', separator: ' │ ' };
  return { config, notes, source: 'claude-ultimate-hud' };
}

export const claudeUltimateHudImporter: ImporterDef = {
  source: 'claude-ultimate-hud',
  name: 'claude-ultimate-hud',
  repo: 'ai-younggle-man/claude-ultimate-hud',
  shown: SHOWN,
  hasDefault: true,
  detect: [/claude-ultimate-hud/i],
  // os.homedir() on every OS
  discover: (ctx) => path.join(ctx.home, '.claude', 'claude-ultimate-hud.local.json'),
  load: (file, ctx) =>
    file
      ? {
          ...importClaudeUltimateHud(readJsonTool(file, TOOL, ctx.home), { file: shownFile(file, ctx.home) }),
          file,
        }
      : { ...importClaudeUltimateHud({}, { defaulted: true }), file: null },
};
