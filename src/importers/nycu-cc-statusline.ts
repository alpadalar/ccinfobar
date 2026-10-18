import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import type { ImportNote, ImportResult } from './index.js';
import { readJsonTool, shownFile, tableOf } from './io.js';
import type { ImporterDef } from './registry.js';

const TOOL = 'cc-statusline';
const NAME = 'cc-statusline (NYCU-Chung)';
const SHOWN = '~/.claude/cc-statusline-rows.json';

export const TARGETS: readonly string[] = [
  'session-name',
  'cwd',
  'lines-changed',
  'git-repo',
  'git-branch',
  'git-status',
  'model',
  'effort',
  'session-duration',
  'cost-today',
  'cost-week',
  'session-cost',
  'tokens-total',
  'context-bar',
  'compactions',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'agents',
  'env-counts',
];

// statusline.js rowDefaults, in commands/rows.md order
const ROWS = [
  'summary',
  'dir',
  'repo',
  'model',
  'duration',
  'cost',
  'usage',
  'quota',
  'agents',
  'memory_mcp',
  'edited',
  'history',
];
const OPTIONS = ['enabled', 'summaryInterval', 'aggWindowDays', 'statuslineWidth', 'statuslineWidthOffset'];

type Types = [string, Record<string, OptionValue>?, Partial<WidgetItem>?][];

const num = (v: unknown, min: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : null;

export function importNycuCcStatusline(
  raw: unknown,
  opts: { defaulted?: boolean; file?: string } = {},
): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: NAME }) });
  const table = tableOf(raw);
  if (!table && !opts.defaulted) {
    notes.push({
      kind: 'info',
      text: t('import.note.hudIgnored', { file: sanitizeText(opts.file ?? SHOWN) }),
    });
  }
  const c = table ?? {};
  const has = (k: string) => Object.hasOwn(c, k);
  const on = (k: string) => (has(k) ? !!c[k] : true);
  if (has('enabled') && c.enabled === false) {
    notes.push({ kind: 'info', text: t('import.note.toolDisabled', { tool: NAME }) });
  }
  const approx = (name: string, widget: string) =>
    notes.push({ kind: 'approx', text: t('import.note.hudApprox', { tool: NAME, name, widget }) });

  const days = num(c.aggWindowDays, 0) ?? 0;
  const total = days === 1 ? 'cost-today' : 'cost-week';
  const lines: Types[] = [];
  if (on('summary')) {
    lines.push([['session-name']]);
    approx('summary', 'session-name');
  }
  if (on('dir')) lines.push([['cwd', { style: 'segments', segments: 2 }], ['lines-changed']]);
  if (on('repo')) lines.push([['git-repo'], ['git-branch'], ['git-status']]);
  // duration shares the model row
  const model: Types = [
    ...(on('model') ? ([['model'], ['effort']] as Types) : []),
    ...(on('duration') ? ([['session-duration']] as Types) : []),
  ];
  if (model.length) lines.push(model);
  if (on('duration')) approx('duration', 'session-duration');
  if (on('cost')) {
    lines.push([[total], ['session-cost']]);
    approx('cost', total);
  }
  if (on('usage')) lines.push([['tokens-total'], ['context-bar'], ['compactions', { showZero: true }]]);
  if (on('quota')) {
    lines.push([
      ['five-hour-usage', { display: 'bar' }],
      ['five-hour-reset'],
      ['weekly-usage', { display: 'bar' }],
      ['weekly-reset'],
    ]);
  }
  if (on('agents')) lines.push([['agents', undefined, { hideEmpty: true }]]);
  if (on('memory_mcp')) {
    lines.push([
      ['env-counts', { showAgentsMd: false, showHooks: false, mcpHealth: true }, { hideEmpty: true }],
    ]);
    approx('memory_mcp', 'env-counts');
  }

  const used = new Set<string>();
  const items: WidgetItem[][] = lines.map((l) =>
    l.map(([type, options, extra]) => {
      let id = `nycu-${TOOL}-${type}`;
      for (let n = 2; used.has(id); n++) id = `nycu-${TOOL}-${type}-${n}`;
      used.add(id);
      return { id, type, ...(options ? { options } : {}), ...extra };
    }),
  );

  const ignored = [
    ...['edited', 'history'].filter(on),
    ...(has('summaryInterval') && c.summaryInterval !== 10 ? ['summaryInterval'] : []),
    ...Object.keys(c)
      .filter((k) => !ROWS.includes(k) && !OPTIONS.includes(k))
      .map((k) => sanitizeText(k)),
  ];
  if (ignored.length) {
    notes.push({
      kind: 'drop',
      text: t('import.note.ignoredSettings', { tool: NAME, names: ignored.join(', ') }),
    });
  }

  const config: Partial<Config> = {
    lines: items,
    style: 'tui',
    tui: { box: 'square', title: { left: '', right: false } },
  };
  const offset = num(c.statuslineWidthOffset, 0);
  const width = num(c.statuslineWidth, 1);
  if (offset !== null) config.widthOffset = offset;
  // the box is statuslineWidth minus the offset
  if (width !== null) config.maxWidth = Math.max(20, width - (offset ?? 4));
  return { config, notes, source: 'nycu-cc-statusline' };
}

export const nycuCcStatuslineImporter: ImporterDef = {
  source: 'nycu-cc-statusline',
  name: NAME,
  repo: 'NYCU-Chung/cc-statusline',
  shown: SHOWN,
  hasDefault: true,
  detect: [/cc-statusline[\\/][^"']*statusline\.js/i],
  // os.homedir() on every OS
  discover: (ctx) => path.join(ctx.home, '.claude', 'cc-statusline-rows.json'),
  load: (file, ctx) =>
    file
      ? { ...importNycuCcStatusline(readJsonTool(file, NAME), { file: shownFile(file, ctx.home) }), file }
      : { ...importNycuCcStatusline({}, { defaulted: true }), file: null },
};
