import { t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { ansiColor } from './colors.js';
import type { ImportNote, ImportResult } from './index.js';

const TOOL = 'CCometixLine';
const POWERLINE_ARROW = '\ue0b0';
const USAGE_API_OPTIONS = ['api_base_url', 'cache_duration', 'timeout'];

type Raw = Record<string, unknown>;

const segment = (id: string, enabled: boolean, plain: string, nerd: string, icon: number, text = icon) => ({
  id,
  enabled,
  icon: { plain, nerd_font: nerd },
  colors: { icon: { c16: icon }, text: { c16: text } },
  styles: { text_bold: false },
  options: {} as Raw,
});

export const CCLINE_DEFAULT: Record<string, unknown> = {
  theme: 'default',
  style: { mode: 'plain', separator: ' | ' },
  segments: [
    segment('model', true, '\u{1f916}', '\ue26d', 14),
    segment('directory', true, '\u{1f4c1}', '\u{f024b}', 11, 10),
    { ...segment('git', true, '\u{1f33f}', '\u{f02a2}', 12), options: { show_sha: false } },
    segment('context_window', true, '\u26a1\ufe0f', '\uf49b', 13),
    {
      ...segment('usage', false, '\u{1f4ca}', '\u{f0a9e}', 14),
      options: { api_base_url: 'https://api.anthropic.com', cache_duration: 180, timeout: 2 },
    },
    segment('cost', false, '\u{1f4b0}', '\ueec1', 3),
    segment('session', false, '\u23f1\ufe0f', '\u{f19bb}', 2),
    segment('output_style', false, '\u{1f3af}', '\u{f12f5}', 6),
  ],
};

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

export function importCcometixline(raw: unknown, opts: { defaulted?: boolean } = {}): ImportResult {
  const notes: ImportNote[] = [];
  if (opts.defaulted) notes.push({ kind: 'info', text: t('import.note.defaultLayout', { tool: TOOL }) });
  const c = obj(raw);
  const style = obj(c.style);
  const nerd = style.mode === 'nerd_font' || style.mode === 'powerline';
  const mode = nerd ? 'nerd_font' : 'plain';
  const items: WidgetItem[] = [];
  const used = new Set<string>();
  for (const s of Array.isArray(c.segments) ? c.segments : []) {
    const seg = obj(s);
    if (seg.enabled === false) continue;
    const id = typeof seg.id === 'string' ? seg.id : '';
    const name = sanitizeText(id);
    const options = obj(seg.options);
    if (id === 'update') {
      notes.push({ kind: 'drop', text: t('import.note.selfUpdate', { tool: TOOL, name }) });
      continue;
    }
    const types = segmentTypes(id, options);
    if (!types) {
      notes.push({ kind: 'drop', text: t('import.note.noSegment', { tool: TOOL, name }) });
      continue;
    }
    const api = USAGE_API_OPTIONS.filter((k) => Object.hasOwn(options, k));
    if (api.length) {
      notes.push({
        kind: 'drop',
        text: t('import.note.usageApi', { tool: TOOL, name, options: api.join(', ') }),
      });
    }
    const colors = obj(seg.colors);
    const color = ansiColor(colors.text);
    const background = ansiColor(colors.background);
    const icon = obj(seg.icon)[mode];
    const label = typeof icon === 'string' ? icon : '';
    if (label && colors.icon !== undefined && ansiColor(colors.icon) !== color) {
      notes.push({ kind: 'approx', text: t('import.note.iconColor', { tool: TOOL, name }) });
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
  }
  const config: Partial<Config> = { lines: [items], icons: nerd ? 'nerd' : 'emoji' };
  const separator = typeof style.separator === 'string' ? style.separator : ' | ';
  if (separator === POWERLINE_ARROW) config.style = 'powerline';
  else config.separator = separator;
  return { config, notes, source: 'ccometixline' };
}
