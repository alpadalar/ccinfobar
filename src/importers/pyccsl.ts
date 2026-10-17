import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { flagValue } from './args.js';
import type { ImportNote, ImportResult } from './index.js';
import { expand, readSource, SourceTooLargeError, shownFile } from './io.js';
import type { ImporterDef } from './registry.js';
import { parseShellEnv } from './shell-env.js';
import { mapTheme, type ThemeTable } from './themes-map.js';

const TOOL = 'pyccsl';

export const TARGETS: readonly string[] = [
  'performance',
  'cwd',
  'git-branch',
  'git-status',
  'model',
  'cache-hit-rate',
  'session-duration',
  'message-count',
  'tokens-input',
  'tokens-output',
  'context-length',
  'session-cost',
];

const DEFAULT_FIELDS = ['badge', 'folder', 'git', 'model', 'tokens', 'cost'];

// pyccsl prints fields in this order, whatever order they are listed in
const FIELD_ORDER = [
  'badge',
  'folder',
  'git',
  'model',
  'perf-cache-rate',
  'perf-response-time',
  'perf-session-time',
  'perf-message-count',
  'perf-all-metrics',
  'input',
  'output',
  'tokens',
  'cost',
];

const THEMES: ThemeTable = {
  exact: {
    default: 'classic',
    solarized: 'solarized',
    nord: 'nord',
    dracula: 'dracula',
    gruvbox: 'gruvbox',
    tokyo: 'tokyo-night',
    catppuccin: 'catppuccin',
    minimal: 'minimal',
    none: 'mono',
  },
};

// pyccsl format_output; powerline without colors also uses ' > '
const SEPARATORS: Record<string, string> = { simple: ' > ', arrows: ' → ', pipes: ' | ', dots: ' · ' };

const VALUE_FLAGS = ['theme', 'style', 'numbers', 'env', 'perf-cache', 'perf-response'];
const BOOL_FLAGS = ['no-emoji', 'debug'];

// env file keys override these flags
const ENV_KEYS: Record<string, string> = {
  theme: 'PYCCSL_THEME',
  numbers: 'PYCCSL_NUMBERS',
  style: 'PYCCSL_STYLE',
  'perf-cache': 'PYCCSL_PERF_CACHE',
  'perf-response': 'PYCCSL_PERF_RESPONSE',
};

export interface PyccslInput {
  fields: string[] | null;
  flags: Record<string, string | true>;
  env: Record<string, string>;
}

type Types = [string, Record<string, OptionValue>?][];

const splitFields = (s: string) =>
  s
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);

const first = (s: string): number | null => {
  const n = Number(s.split(',')[0]?.trim());
  return s.trim() && Number.isFinite(n) ? n : null;
};

export function importPyccsl(input: PyccslInput): ImportResult {
  const notes: ImportNote[] = [];
  const { flags, env } = input;
  const value = (name: string, fallback: string): { v: string; given: boolean } => {
    const key = ENV_KEYS[name]!;
    if (Object.hasOwn(env, key)) return { v: env[key]!, given: true };
    const f = Object.hasOwn(flags, name) ? flags[name] : undefined;
    return typeof f === 'string' ? { v: f, given: true } : { v: fallback, given: false };
  };

  const listed = Object.hasOwn(env, 'PYCCSL_FIELDS') ? splitFields(env.PYCCSL_FIELDS!) : input.fields;
  const fields = listed?.length ? listed : DEFAULT_FIELDS;
  const noEmoji = Object.hasOwn(env, 'PYCCSL_NO_EMOJI')
    ? env.PYCCSL_NO_EMOJI!.toLowerCase() === 'true'
    : Object.hasOwn(flags, 'no-emoji') && flags['no-emoji'] === true;

  const cache = value('perf-cache', '95,90,75');
  const response = value('perf-response', '10,30,60');
  const hitWarn = first(cache.v) ?? 95;
  const timeWarn = first(response.v) ?? 10;
  const time: [string, Record<string, OptionValue>] = ['performance', { show: 'time' }];
  const FIELDS: Record<string, Types> = {
    badge: [['performance', { display: 'badge', hitWarn, timeWarn }]],
    folder: [['cwd']],
    git: [['git-branch'], ['git-status', { counts: false }]],
    model: [['model']],
    'perf-cache-rate': [['cache-hit-rate']],
    'perf-response-time': [time],
    'perf-session-time': [['session-duration']],
    'perf-message-count': [['message-count']],
    'perf-all-metrics': [['cache-hit-rate'], time, ['session-duration'], ['message-count']],
    input: [['tokens-input']],
    output: [['tokens-output']],
    tokens: [['context-length']],
    cost: [['session-cost']],
  };

  const wanted = new Set<string>();
  for (const f of fields) {
    if (wanted.has(f)) continue;
    wanted.add(f);
    if (Object.hasOwn(FIELDS, f)) continue;
    notes.push({ kind: 'drop', text: t('import.note.noSegment', { tool: TOOL, name: sanitizeText(f) }) });
  }

  const items: WidgetItem[] = [];
  const used = new Set<string>();
  for (const field of FIELD_ORDER) {
    if (!wanted.has(field)) continue;
    for (const [type, options] of FIELDS[field]!) {
      let id = `${TOOL}-${field}-${type}`;
      for (let n = 2; used.has(id); n++) id = `${TOOL}-${field}-${type}-${n}`;
      used.add(id);
      items.push({ id, type, ...(options ? { options: { ...options } } : {}) });
    }
  }

  if (wanted.has('badge')) {
    notes.push({
      kind: 'approx',
      text: t('import.note.hudApprox', { tool: TOOL, name: 'badge', widget: 'performance' }),
    });
    if (cache.given || response.given) {
      notes.push({
        kind: 'approx',
        text: t('import.note.perfThresholds', { tool: TOOL, hit: hitWarn, time: timeWarn }),
      });
    }
  }
  const numbers = value('numbers', 'compact').v;
  if (numbers !== 'compact') {
    notes.push({
      kind: 'info',
      text: t('import.note.numbersFormat', { tool: TOOL, value: sanitizeText(numbers) }),
    });
  }

  const themeName = value('theme', 'default').v;
  const { theme, notes: themeNotes } = mapTheme(themeName, THEMES, TOOL);
  notes.push(...themeNotes);
  const plain = themeName.trim().toLowerCase() === 'none';

  const styleName = value('style', 'simple').v;
  let separator = ' > ';
  let style: Config['style'] = 'text';
  if (styleName === 'powerline') {
    if (!plain) style = 'powerline';
  } else if (Object.hasOwn(SEPARATORS, styleName)) {
    separator = SEPARATORS[styleName]!;
  } else {
    notes.push({
      kind: 'info',
      text: t('import.note.styleUnknown', { tool: TOOL, name: sanitizeText(styleName), style: 'simple' }),
    });
  }

  const config: Partial<Config> = { lines: [items], theme, style };
  if (style === 'text') config.separator = separator;
  if (plain) config.colorLevel = 0;
  if (noEmoji) config.icons = 'text';
  return { config, notes, source: 'pyccsl' };
}

const isPyccsl = (a: string) => /^pyccsl(?:\.py)?$/i.test(a.split(/[\\/]/).pop() ?? '');

// args after the pyccsl script, as argparse reads them
export function pyccslCommand(args: readonly string[]): Pick<PyccslInput, 'fields' | 'flags'> {
  const at = args.findIndex(isPyccsl);
  const tail = at < 0 ? [] : args.slice(at + 1);
  const flags = Object.create(null) as Record<string, string | true>;
  let fields: string[] | null = null;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]!;
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      const name = (eq < 0 ? a : a.slice(0, eq)).replace(/^--?/, '');
      if (VALUE_FLAGS.includes(name)) {
        const v = eq < 0 ? tail[++i] : a.slice(eq + 1);
        if (v !== undefined) flags[name] = v;
      } else if (BOOL_FLAGS.includes(name)) {
        flags[name] = true;
      }
      continue;
    }
    fields ??= splitFields(a);
  }
  return { fields, flags };
}

function readEnvFile(file: string, home: string): string {
  try {
    return readSource(file);
  } catch (err) {
    if (err instanceof SourceTooLargeError) throw err;
    throw new Error(t('import.cannotReadTool', { tool: TOOL, file: shownFile(file, home) }));
  }
}

const MAX_LISTED = 10;

export const pyccslImporter: ImporterDef = {
  source: 'pyccsl',
  name: 'pyccsl',
  repo: 'wolfdenpublishing/pyccsl',
  shown: null,
  hasDefault: true,
  detect: [/pyccsl(\.py)?\b/i],
  discover: (ctx) => {
    const at = ctx.args.findIndex(isPyccsl);
    const env = at < 0 ? null : flagValue(ctx.args.slice(at + 1), ['--env']);
    return env ? path.resolve(ctx.cwd, expand(env, ctx.home)) : null;
  },
  load: (file, ctx) => {
    const cmd = pyccslCommand(ctx.args);
    if (!file) return { ...importPyccsl({ ...cmd, env: {} }), file: null };
    const parsed = parseShellEnv(readEnvFile(file, ctx.home));
    // pyccsl reads only PYCCSL_* keys and never the includes
    const env = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed.vars)) if (k.startsWith('PYCCSL_')) env[k] = v;
    const r = importPyccsl({ ...cmd, env });
    const skipped = [...parsed.skipped, ...parsed.includes.map((i) => i.line)].sort((a, b) => a - b);
    if (skipped.length) {
      const shown = skipped.slice(0, MAX_LISTED).join(', ') + (skipped.length > MAX_LISTED ? ', …' : '');
      r.notes.push({
        kind: 'drop',
        text: t('import.note.shellSkipped', { tool: TOOL, lines: shown, count: skipped.length }),
      });
    }
    return { ...r, file };
  },
};
