import '../core/i18n/lazy.js';
import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { CCLINE_THEMES } from './ccometixline-themes.js';
import { ansiColor } from './colors.js';
import type { ImportNote, ImportResult, ImportSource } from './index.js';

const TOOL = 'CCometixLine';
const POWERLINE_ARROW = '\ue0b0';
const USAGE_API_OPTIONS = ['api_base_url', 'cache_duration', 'timeout'];

type Raw = Record<string, unknown>;

export const CCLINE_DEFAULT = CCLINE_THEMES.default;

export const TARGETS: readonly string[] = [
  'model',
  'cwd',
  'git-branch',
  'git-status',
  'git-sha',
  'context-percentage',
  'five-hour-usage',
  'weekly-reset',
  'session-cost',
  'session-duration',
  'lines-changed',
  'output-style',
];

const unquote = (s: string) => s.replace(/"([^"]*)"|'([^']*)'/g, '$1$2');

export function parseCclineTheme(command: string): string | null {
  const args = [...command.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g)].map((m) => unquote(m[0]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '-t' || a === '--theme') && i + 1 < args.length) return args[i + 1]!;
    if (a.startsWith('--theme=')) return a.slice(8);
  }
  return null;
}

const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

function segmentTypes(id: string, options: Raw): [string, Record<string, OptionValue>?][] | null {
  switch (id) {
    case 'model':
      return [['model']];
    case 'directory':
      return [['cwd', { style: 'basename' }]];
    case 'git':
      return [
        ['git-branch'],
        ['git-status'],
        ...(options.show_sha === true ? [['git-sha'] as [string]] : []),
      ];
    case 'context_window':
      return [['context-percentage']];
    case 'usage':
      return [['five-hour-usage'], ['weekly-reset']];
    case 'cost':
      return [['session-cost']];
    case 'session':
      return [['session-duration'], ['lines-changed']];
    case 'output_style':
      return [['output-style']];
    default:
      return null;
  }
}

export function importCcometixline(
  raw: unknown,
  opts: { defaulted?: boolean; tool?: string; source?: ImportSource; lineBreakAfter?: number } = {},
): ImportResult {
  const tool = opts.tool ?? TOOL;
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool }) });
  const c = obj(raw);
  const style = obj(c.style);
  const nerd = style.mode === 'nerd_font' || style.mode === 'powerline';
  const mode = nerd ? 'nerd_font' : 'plain';
  const items: WidgetItem[] = [];
  const used = new Set<string>();
  // items.length after each mapped segment
  const ends: number[] = [];
  for (const s of Array.isArray(c.segments) ? c.segments : []) {
    const seg = obj(s);
    if (seg.enabled === false) continue;
    const id = typeof seg.id === 'string' ? seg.id : '';
    const name = sanitizeText(id);
    const options = obj(seg.options);
    if (id === 'update') {
      notes.push({ kind: 'drop', text: t('import.note.selfUpdate', { tool, name }) });
      continue;
    }
    const types = segmentTypes(id, options);
    if (!types) {
      notes.push({ kind: 'drop', text: t('import.note.noSegment', { tool, name }) });
      continue;
    }
    const api = USAGE_API_OPTIONS.filter((k) => Object.hasOwn(options, k));
    if (api.length) {
      notes.push({
        kind: 'drop',
        text: t('import.note.usageApi', { tool, name, options: api.join(', ') }),
      });
    }
    const colors = obj(seg.colors);
    const color = ansiColor(colors.text);
    const background = ansiColor(colors.background);
    const icon = obj(seg.icon)[mode];
    const label = typeof icon === 'string' ? icon : '';
    if (label && colors.icon !== undefined && ansiColor(colors.icon) !== color) {
      notes.push({ kind: 'approx', text: t('import.note.iconColor', { tool, name }) });
    }
    const bold = obj(seg.styles).text_bold === true;
    types.forEach(([type, itemOptions], i) => {
      let itemId = `${id}-${type}`;
      for (let n = 2; used.has(itemId); n++) itemId = `${id}-${type}-${n}`;
      used.add(itemId);
      const it: WidgetItem = { id: itemId, type, ...(itemOptions ? { options: itemOptions } : {}) };
      if (i === 0) it.label = label;
      if (color) it.color = color;
      if (background) it.background = background;
      if (bold) it.bold = true;
      items.push(it);
    });
    ends.push(items.length);
  }
  const n = opts.lineBreakAfter;
  const split = Number.isInteger(n) && n! > 0 && n! < ends.length ? ends[n! - 1]! : null;
  const lines = split === null ? [items] : [items.slice(0, split), items.slice(split)];
  if (split !== null) notes.push({ kind: 'approx', text: t('import.note.lineBreak', { tool, count: n! }) });
  const config: Partial<Config> = { lines, icons: nerd ? 'nerd' : 'emoji' };
  const separator = typeof style.separator === 'string' ? style.separator : ' | ';
  if (separator === POWERLINE_ARROW) config.style = 'powerline';
  else config.separator = separator;
  return { config, notes, source: opts.source ?? 'ccometixline' };
}
