import '../core/i18n/lazy.js';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { rgbColor } from './colors.js';
import type { ImportNote, ImportResult } from './index.js';
import { readJsonTool, shownFile, tableOf } from './io.js';
import type { ImporterDef } from './registry.js';

const TOOL = 'ccpet';
const SHOWN = '~/.claude-pet/config.json';

export const TARGETS: readonly string[] = [
  'pet',
  'tokens-input',
  'tokens-output',
  'tokens-cached',
  'tokens-total',
  'context-length',
  'context-percentage',
  'session-cost',
];

// ConfigService.ts DEFAULT_CONFIG, without its supabase block
const DEFAULT_COLORS: Record<string, string> = {
  petExpression: '#FFFF00:bright:bold',
  petName: '#00FFFF:bright',
  energyBar: '#00FF00',
  energyValue: '#00FFFF',
  accumulatedTokens: '#778899',
  lifetimeTokens: '#FF00FF',
  sessionInput: '#00FF00',
  sessionOutput: '#FFFF00',
  sessionCached: '#F4A460',
  sessionTotal: '#FFFFFF',
  contextLength: '#00DDFF',
  contextPercentage: '#0099DD',
  contextPercentageUsable: '#90EE90',
  cost: '#FFD700',
};

const DEFAULT_ITEMS: readonly (readonly string[])[] = [
  ['expression', 'energy-bar', 'energy-value', 'accumulated-tokens', 'lifetime-tokens'],
  ['input', 'output', 'cached', 'total'],
  ['context-length', 'context-percentage', 'context-percentage-usable', 'cost'],
];

const PET_ITEMS = ['expression', 'energy-bar', 'energy-value', 'pet-name'];
const LINE1_DROPS = ['accumulated-tokens', 'lifetime-tokens'];

const SESSION: Record<string, [string, Record<string, OptionValue>?]> = {
  input: ['tokens-input'],
  output: ['tokens-output'],
  cached: ['tokens-cached'],
  total: ['tokens-total'],
  'context-length': ['context-length'],
  'context-percentage': ['context-percentage'],
  'context-percentage-usable': ['context-percentage', { basis: 'usable' }],
  cost: ['session-cost'],
};

const COLOR_KEY: Record<string, string> = {
  expression: 'petExpression',
  'energy-bar': 'energyBar',
  'energy-value': 'energyValue',
  'pet-name': 'petName',
  input: 'sessionInput',
  output: 'sessionOutput',
  cached: 'sessionCached',
  total: 'sessionTotal',
  'context-length': 'contextLength',
  'context-percentage': 'contextPercentage',
  'context-percentage-usable': 'contextPercentageUsable',
  cost: 'cost',
};

type Style = Pick<WidgetItem, 'color' | 'bold'>;
type Part = [string, Record<string, OptionValue> | undefined, Style];

export function importCcpet(raw: unknown, opts: { defaulted?: boolean; file?: string } = {}): ImportResult {
  const notes: ImportNote[] = [];
  const drops: ImportNote[] = [];
  const ignored: string[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const table = tableOf(raw);
  if (!table && !opts.defaulted) {
    notes.push({
      kind: 'info',
      text: t('import.note.hudIgnored', { file: sanitizeText(opts.file ?? SHOWN) }),
    });
  }
  const user = table ?? {};
  // only its presence is checked, never its values
  if (Object.hasOwn(user, 'supabase')) {
    notes.push({ kind: 'info', text: t('import.note.secretDropped', { tool: TOOL, name: 'supabase' }) });
  }
  const pet = Object.hasOwn(user, 'pet') ? tableOf(user.pet) : null;
  if (pet && Object.keys(pet).length) ignored.push('pet');

  const colors = (Object.hasOwn(user, 'colors') ? tableOf(user.colors) : null) ?? {};
  const badColors = new Set<string>();
  const styleOf = (name: string): Style => {
    if (!Object.hasOwn(COLOR_KEY, name)) return {};
    const key = COLOR_KEY[name]!;
    const value = Object.hasOwn(colors, key) ? colors[key] : DEFAULT_COLORS[key];
    const parts = typeof value === 'string' ? value.split(':') : [];
    const hex = parts[0] ?? '';
    const color = hex.startsWith('#') ? rgbColor(hex) : undefined;
    if (!color) {
      badColors.add(`colors.${key}`);
      return {};
    }
    // :bright only picks a brighter color without true color
    return parts.includes('bold') ? { color, bold: true } : { color };
  };

  const display = (Object.hasOwn(user, 'display') ? tableOf(user.display) : null) ?? {};
  const max = (Object.hasOwn(display, 'maxLines') ? display.maxLines : undefined) || 3;
  const lineOf = (n: number) => {
    const own = Object.hasOwn(display, `line${n}`) ? (tableOf(display[`line${n}`]) ?? {}) : {};
    const enabled = Object.hasOwn(own, 'enabled') ? own.enabled : true;
    const items = Object.hasOwn(own, 'items') ? own.items : DEFAULT_ITEMS[n - 1];
    return { enabled, items: Array.isArray(items) ? items.filter((i) => typeof i === 'string') : null };
  };
  const misplaced = (n: number, name: string) => {
    if (PET_ITEMS.includes(name) || LINE1_DROPS.includes(name) || Object.hasOwn(SESSION, name)) {
      ignored.push(`display.line${n}.items "${name}"`);
    } else {
      drops.push({
        kind: 'drop',
        text: t('import.note.noEquivalent', { tool: TOOL, name: sanitizeText(name) }),
      });
    }
  };

  const lines: Part[][] = [];
  const first = lineOf(1);
  if (first.enabled !== false && Number(max) >= 1) {
    const valid = (first.items ?? []).filter((i) => PET_ITEMS.includes(i) || LINE1_DROPS.includes(i));
    // ccpet falls back to its default pet line
    const items = valid.length ? valid : [...DEFAULT_ITEMS[0]!];
    for (const name of first.items ?? []) if (!valid.includes(name)) misplaced(1, name);
    const group = items.filter((i) => PET_ITEMS.includes(i));
    const parts: Part[] = [];
    let petDone = false;
    for (const name of items) {
      if (LINE1_DROPS.includes(name)) {
        drops.push({ kind: 'drop', text: t('import.note.noEquivalent', { tool: TOOL, name }) });
      } else if (!petDone) {
        petDone = true;
        parts.push(['pet', undefined, styleOf(group.includes('expression') ? 'expression' : name)]);
      }
    }
    if (group.length) {
      const name = [...new Set(group)].join(', ');
      notes.push({ kind: 'approx', text: t('import.note.hudApprox', { tool: TOOL, name, widget: 'pet' }) });
    }
    lines.push(parts);
  }
  let total = false;
  for (const n of [2, 3]) {
    const line = lineOf(n);
    if (!line.enabled || Number(max) < n) continue;
    const parts: Part[] = [];
    for (const name of line.items ?? []) {
      if (!Object.hasOwn(SESSION, name)) {
        misplaced(n, name);
        continue;
      }
      const [type, options] = SESSION[name]!;
      if (name === 'total') total = true;
      parts.push([type, options, styleOf(name)]);
    }
    lines.push(parts);
  }
  // ccpet's total also counts cached tokens
  if (total) {
    notes.push({
      kind: 'approx',
      text: t('import.note.hudApprox', { tool: TOOL, name: 'total', widget: 'tokens-total' }),
    });
  }
  ignored.push(...badColors);
  notes.push(...drops);
  if (ignored.length) {
    notes.push({
      kind: 'drop',
      text: t('import.note.ignoredSettings', { tool: TOOL, names: ignored.join(', ') }),
    });
  }

  const used = new Set<string>();
  const out: WidgetItem[][] = lines
    .filter((l) => l.length > 0)
    .map((l) =>
      l.map(([type, options, style]) => {
        let id = `${TOOL}-${type}`;
        for (let n = 2; used.has(id); n++) id = `${TOOL}-${type}-${n}`;
        used.add(id);
        return { id, type, ...(options ? { options } : {}), ...style };
      }),
    );
  const config: Partial<Config> = { lines: out, style: 'text', separator: ' ' };
  return { config, notes, source: 'ccpet' };
}

export const ccpetImporter: ImporterDef = {
  source: 'ccpet',
  name: 'ccpet',
  repo: 'terryso/ccpet',
  shown: SHOWN,
  hasDefault: true,
  detect: [/\bccpet\b/i],
  // os.homedir() on every OS
  discover: (ctx) => path.join(ctx.home, '.claude-pet', 'config.json'),
  load: (file, ctx) =>
    file
      ? { ...importCcpet(readJsonTool(file, TOOL, ctx.home), { file: shownFile(file, ctx.home) }), file }
      : { ...importCcpet({}, { defaulted: true }), file: null },
};
