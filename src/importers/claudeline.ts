import '../core/i18n/lazy.js';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { boolFlag, flagValue } from './args.js';
import type { ImportNote, ImportResult } from './index.js';
import type { ImporterDef } from './registry.js';

const TOOL = 'claudeline';

export const TARGETS: readonly string[] = [
  'provider',
  'model',
  'effort',
  'cwd',
  'git-branch',
  'context-bar',
  'cache-miss-cause',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'session-cost',
  'spend-limit',
  'service-status',
];

// main.go flag set
const BOOL_FLAGS = ['cwd', 'git-branch', 'cost', 'effort', 'debug', 'version'];
const VALUE_FLAGS = ['cwd-max-len', 'git-branch-max-len', 'usage-file', 'status-file', 'update-file'];

const dash = (name: string) => [`-${name}`, `--${name}`];
const isClaudeline = (a: string) => /^claudeline(?:\.exe)?(?:@\S*)?$/i.test(a.split(/[\\/]/).pop() ?? '');

// Go's flag package stops at the first non-flag or "--"
function goFlags(args: readonly string[]): { flags: string[]; unknown: string[] } {
  const at = args.findIndex(isClaudeline);
  const tail = at >= 0 ? args.slice(at + 1) : args[0]?.startsWith('-') ? args : args.slice(1);
  const flags: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a === '--' || a === '-' || !a.startsWith('-')) break;
    flags.push(a);
    const eq = a.indexOf('=');
    const name = (eq < 0 ? a : a.slice(0, eq)).replace(/^--?/, '');
    if (VALUE_FLAGS.includes(name)) {
      if (eq < 0 && i + 1 < tail.length) flags.push(tail[++i]!);
    } else if (!BOOL_FLAGS.includes(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return { flags, unknown };
}

type Types = [string, Record<string, OptionValue>?][];

export function importClaudeline(args: string[]): ImportResult {
  const notes: ImportNote[] = [];
  const { flags, unknown } = goFlags(args);
  const on = (name: string) => boolFlag(flags, dash(name)) === true;
  const given = (name: string) => flagValue(flags, dash(name)) !== null;

  const bar = { display: 'bar', width: 5 };
  const types: Types = [
    ['provider'],
    ['model'],
    ...(on('effort') ? ([['effort']] as Types) : []),
    ...(on('cwd') ? ([['cwd', { style: 'basename' }]] as Types) : []),
    ...(on('git-branch') ? ([['git-branch']] as Types) : []),
    ['context-bar', { width: 5 }],
    ['cache-miss-cause'],
    ['five-hour-usage', bar],
    ['five-hour-reset'],
    ['weekly-usage', bar],
    ['weekly-reset'],
    ...(on('cost') ? ([['session-cost']] as Types) : []),
    ['spend-limit'],
    ['service-status'],
  ];

  // the plan or login type sits before the model
  notes.push({
    kind: 'approx',
    text: t('import.note.hudApprox', { tool: TOOL, name: 'login type', widget: 'provider' }),
  });
  notes.push({ kind: 'drop', text: t('import.note.selfUpdate', { tool: TOOL, name: 'update' }) });
  const maxLen = [
    ...(on('cwd') && given('cwd-max-len') ? ['-cwd-max-len'] : []),
    ...(on('git-branch') && given('git-branch-max-len') ? ['-git-branch-max-len'] : []),
  ];
  if (maxLen.length) {
    notes.push({
      kind: 'approx',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: maxLen.join(', ') }),
    });
  }
  if (unknown.length) {
    const names = unknown.map((n) => `-${sanitizeText(n)}`).join(', ');
    notes.push({ kind: 'drop', text: t('import.note.ignoredSettings', { tool: TOOL, names }) });
  }

  const lines: WidgetItem[][] = [
    types.map(([type, options]) => ({ id: `${TOOL}-${type}`, type, ...(options ? { options } : {}) })),
  ];
  const config: Partial<Config> = { lines, style: 'text', separator: ' │ ' };
  return { config, notes, source: 'claudeline' };
}

export const claudelineImporter: ImporterDef = {
  source: 'claudeline',
  name: 'claudeline',
  repo: 'fredrikaverpil/claudeline',
  shown: null,
  hasDefault: true,
  detect: [/\bclaudeline\b/i],
  discover: () => null,
  load: (file, ctx) => {
    const r = importClaudeline(ctx.args);
    if (file) r.notes.unshift({ kind: 'info', text: t('import.note.fileIgnored', { tool: TOOL }) });
    return { ...r, file: null };
  },
};
