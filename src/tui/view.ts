import { parseColor, stripAnsi, style, truncate, visibleWidth } from '../core/ansi.js';
import { presetText, themeDescription } from '../core/i18n/catalog-text.js';
import { language, type MessageId, t } from '../core/i18n/index.js';
import { widgetText } from '../core/i18n/widget-text.js';
import { renderPreview } from '../core/preview.js';
import { sanitizeText } from '../core/sanitize.js';
import { resolveTheme } from '../core/themes.js';
import type { Config, WidgetItem } from '../core/types.js';
import { padVisible as pad, setWidthMode, widthMode } from '../core/width.js';
import { getWidget } from '../widgets/index.js';
import { categoryName, pickerItems } from './catalog.js';
import { displayValue, type Field, listEntries } from './fields.js';
import type { Hit } from './hits.js';
import { shiftHits } from './hits.js';
import {
  type Mode,
  previewConfig,
  type State,
  selectedItem,
  settingsFields,
  type TuiInstallPlan,
  themeItems,
  withTheme,
} from './state.js';

export const MIN_COLS = 60;
export const MIN_ROWS = 16;

export interface Screen {
  lines: string[];
  hits: Hit[];
}

const ESC = '\x1b[';
const inv = (t: string) => `${ESC}7m${t}${ESC}27m`;
const dim = (t: string) => `${ESC}2m${t}${ESC}22m`;
const bold = (t: string) => `${ESC}1m${t}${ESC}22m`;
const under = (t: string) => `${ESC}4m${t}${ESC}24m`;
const fg = (t: string, color: string | undefined) => (color ? style(t, { fg: color }, 3) : t);

// box lines are two columns under ambiguousWidth 2
const lineW = () => visibleWidth('─');
const dashes = (width: number) => '─'.repeat(Math.max(0, Math.floor(width / lineW())));

function rule(title: string, cols: number): string {
  const head = ` ${truncate(title, cols - 4 - 2 * lineW())} `;
  return dim('──') + bold(head) + dim(dashes(cols - visibleWidth(`── ${title} `) - 1));
}

// whole dashes on the bottom edge
const boxCols = (cols: number) => cols - ((cols - 2 * lineW()) % lineW());
const boxInner = (cols: number) => boxCols(cols) - 2 - 2 * lineW();

function box(title: string, content: string[], full: number): string[] {
  const cw = lineW();
  const cols = boxCols(full);
  const inner = boxInner(cols);
  const name = ` ${truncate(title, cols - 3 - 3 * cw)} `;
  const fill = Math.max(0, cols - 3 * cw - visibleWidth(name));
  const head = name + ' '.repeat(fill % cw);
  return [
    dim(`┌─${head}${dashes(fill)}┐`),
    ...content.map((l) => `${dim('│')} ${pad(l, inner)} ${dim('│')}`),
    dim(`└${dashes(cols - 2 * cw)}┘`),
  ];
}

function itemLabel(item: WidgetItem): string {
  const def = getWidget(item.type);
  return def ? widgetText(def, 'name') : `? ${item.type}`;
}

interface Row {
  text: string;
  hits: Hit[];
}

function editorRows(state: State, cols: number): { rows: Row[]; selRow: number } {
  const rows: Row[] = [];
  let selRow = 0;
  const { lines } = state.config;
  if (!lines.length) {
    return { rows: [{ text: `    ${dim(t('tui.view.noLines'))}`, hits: [] }], selRow: 0 };
  }
  const mark = fg('┃', 'brightCyan');
  lines.forEach((items, l) => {
    const cur = l === state.sel.line;
    const prefix = `${cur ? fg('▸', 'brightCyan') : ' '}${(cur ? bold : dim)(String(l + 1).padStart(2))} `;
    let text = prefix;
    let x = 4;
    let hits: Hit[] = [];
    const flush = () => {
      const y = rows.length;
      rows.push({
        text,
        hits: [...hits.map((h) => ({ ...h, y })), { kind: 'line', line: l, y, count: items.length }],
      });
    };
    if (!items.length) {
      const dropHere = state.drag?.to?.line === l;
      text += dropHere ? mark : ' ';
      text += dim(t('tui.view.emptyLine'));
      if (cur) selRow = rows.length;
      flush();
      return;
    }
    items.forEach((item, i) => {
      const label = `[${truncate(itemLabel(item), 28)}]`;
      const w = visibleWidth(label);
      const dropHere = state.drag?.to?.line === l && state.drag.to.index === i;
      const gap = dropHere ? mark : ' ';
      const gw = visibleWidth(gap);
      if (x + gw + w > cols - 1 && x > 4) {
        flush();
        text = '    ';
        x = 4;
        hits = [];
      }
      const selected = cur && i === state.sel.index;
      const dragged = state.drag?.from.line === l && state.drag.from.index === i;
      let chip: string;
      if (selected) chip = bold(inv(label));
      else if (dragged) chip = dim(under(label));
      else chip = fg(label, item.color ?? getWidget(item.type)?.color);
      if (selected) selRow = rows.length;
      text += gap + chip;
      hits.push({ kind: 'chip', line: l, index: i, x: x + gw, y: 0, w });
      x += gw + w;
    });
    if (state.drag?.to?.line === l && state.drag.to.index >= items.length && x < cols) text += mark;
    flush();
  });
  return { rows, selRow };
}

function windowStart(total: number, cursor: number, height: number): number {
  if (total <= height) return 0;
  return Math.max(0, Math.min(total - height, cursor - Math.floor(height / 2)));
}

const FLAGS = ['bold', 'dim', 'italic', 'raw', 'merge'] as const;

function summary(item: WidgetItem): string {
  const parts: string[] = [];
  if (item.color) parts.push(t('tui.view.color', { value: item.color }));
  if (item.background) parts.push(t('tui.view.background', { value: item.background }));
  for (const f of FLAGS) if (item[f]) parts.push(t(`tui.view.flag.${f}`));
  if (item.label !== undefined) parts.push(t('tui.view.label', { value: item.label }));
  for (const [k, v] of Object.entries(item.options ?? {})) parts.push(`${k}=${v}`);
  return parts.length ? parts.join('  ') : t('tui.view.defaultStyle');
}

function contextPanel(state: State, cols: number, height: number): string[] {
  const out: string[] = [rule(t('tui.view.selected'), cols)];
  const item = selectedItem(state);
  const body: string[] = [];
  if (state.drag) {
    body.push(bold(t('tui.view.dragging')), dim(t('tui.view.dropHint')));
  } else if (item) {
    const def = getWidget(item.type);
    body.push(
      `${bold(def ? widgetText(def, 'name') : item.type)} ${dim(`(${item.type} · ${def ? categoryName(def.category) : t('tui.view.unknownWidget')})`)}`,
      def ? widgetText(def, 'description') : dim(t('tui.view.notRegistered')),
      summary(item),
      dim(`id ${item.id}`),
    );
  } else {
    body.push(dim(t('tui.view.noWidget')), dim(t('tui.view.noWidgetHint')));
  }
  for (let i = 0; i < height - 1; i++) out.push(` ${truncate(body[i] ?? '', cols - 2)}`);
  return out;
}

function swatch(color: string | undefined): string {
  return color ? `${style('██', { fg: color }, 3)} ` : '   ';
}

function settingValue(field: Field, config: Config, width: number): string {
  const { text, isDefault } = displayValue(field, config);
  const sw = field.kind === 'color' && parseColor(text.split(' ')[0]) ? swatch(text.split(' ')[0]) : '';
  const shown = truncate(text, Math.max(1, width - visibleWidth(sw)));
  if (field.kind === 'bool')
    return isDefault ? dim(shown) : fg(shown, text === t('tui.value.on') ? 'green' : undefined);
  return sw + (isDefault ? dim(shown) : shown);
}

interface Modal {
  lines: string[];
  hits: Hit[];
}

function pickerModal(state: State, mode: Extract<Mode, { kind: 'picker' }>, w: number, h: number): Modal {
  const items = pickerItems(mode.filter, state.gsd);
  const lines = [rule(t('tui.view.addWidget'), w), ` ${dim(t('tui.view.filter'))} ${mode.filter}${inv(' ')}`];
  const listH = Math.max(1, h - 3);
  type R = { header: string; gsd: boolean } | { index: number };
  const rows: R[] = [];
  let last = '';
  items.forEach((def, index) => {
    if (def.category !== last) {
      rows.push({ header: categoryName(def.category), gsd: def.category === 'gsd' });
      last = def.category;
    }
    rows.push({ index });
  });
  const curRow = Math.max(
    0,
    rows.findIndex((r) => 'index' in r && r.index === mode.cursor),
  );
  const start = windowStart(rows.length, curRow, listH);
  const hits: Hit[] = [];
  const nameW = Math.min(24, Math.floor(w / 3));
  const typeW = Math.min(26, Math.floor(w / 3));
  for (let i = 0; i < listH; i++) {
    const r = rows[start + i];
    if (!r) {
      lines.push('');
      continue;
    }
    if ('header' in r) {
      lines.push(` ${bold(fg(r.header, r.gsd ? 'brightYellow' : 'brightBlue'))}`);
      continue;
    }
    const def = items[r.index]!;
    const sel = r.index === mode.cursor;
    const name = widgetText(def, 'name');
    const desc = widgetText(def, 'description');
    const base = `   ${pad(name, nameW)} ${pad(def.type, typeW)} ${desc}`;
    lines.push(
      sel
        ? inv(pad(base, w))
        : `   ${pad(name, nameW)} ${dim(pad(def.type, typeW))} ${dim(truncate(desc, Math.max(0, w - nameW - typeW - 5)))}`,
    );
    hits.push({ kind: 'item', area: 'main', index: r.index, x: 0, y: lines.length - 1, w });
  }
  if (!items.length) lines[2] = ` ${dim(t('tui.view.noWidgets'))}`;
  const cur = items[mode.cursor];
  lines.push(cur ? dim(` ${truncate(widgetText(cur, 'description'), w - 2)}`) : '');
  return { lines, hits };
}

function subPanel(field: Field, mode: Extract<Mode, { kind: 'settings' }>, w: number, h: number): Modal {
  const sub = mode.sub!;
  const lines: string[] = [];
  const hits: Hit[] = [];
  if (sub.kind === 'list') {
    const entries = listEntries(field);
    const start = windowStart(entries.length, sub.cursor, h);
    for (let i = 0; i < h; i++) {
      const e = entries[start + i];
      if (!e) {
        lines.push('');
        continue;
      }
      const sw = field.kind === 'color' && e.value && !e.value.startsWith('\u0000') ? swatch(e.value) : '   ';
      const selected = start + i === sub.cursor;
      lines.push(selected ? inv(pad(` ${sw}${e.label}`, w)) : pad(` ${sw}${e.label}`, w));
      hits.push({ kind: 'item', area: 'sub', index: start + i, x: 0, y: i, w });
    }
    return { lines, hits };
  }
  const chars = [...sub.text];
  const avail = Math.max(8, w - 3);
  let from = 0;
  if (visibleWidth(sub.text) + 1 > avail) {
    from = Math.max(0, sub.pos - Math.floor(avail * 0.7));
    while (from < sub.pos && visibleWidth(chars.slice(from, sub.pos + 1).join('')) > avail - 1) from++;
  }
  const shown = chars.slice(from);
  const pos = sub.pos - from;
  const lead = from > 0 ? '…' : '';
  const before = lead + shown.slice(0, pos).join('');
  const at = shown[pos] ?? ' ';
  let after = shown.slice(pos + 1).join('');
  const room = avail - visibleWidth(before) - visibleWidth(at);
  if (visibleWidth(after) > room) after = `${truncate(after, Math.max(1, room))}`;
  const hint =
    field.kind === 'color'
      ? t('tui.view.colorHint')
      : field.kind === 'number'
        ? t('tui.view.numberHint')
        : (field.help ?? t('tui.view.textHint'));
  lines.push(
    bold(` ${field.label}`),
    ` ${before}${inv(at)}${after}`,
    '',
    dim(` ${hint}`),
    dim(` ${t('tui.view.editKeys')}`),
  );
  return { lines: lines.slice(0, h), hits };
}

function settingsModal(state: State, mode: Extract<Mode, { kind: 'settings' }>, w: number, h: number): Modal {
  const fields = settingsFields(state);
  const item = mode.scope === 'widget' ? selectedItem(state) : undefined;
  const title =
    mode.scope === 'global'
      ? t('tui.view.globalSettings')
      : t('tui.view.properties', { name: itemLabel(item ?? { id: '', type: '?' }) });
  const lines = [rule(title, w)];
  const listH = Math.max(1, h - 2);
  const field = fields[mode.cursor];
  const sideBySide = mode.sub !== null && w >= 76;
  const LW = sideBySide ? Math.min(46, w - 30) : w;
  const hits: Hit[] = [];
  const left: string[] = [];
  if (!mode.sub || sideBySide) {
    const start = windowStart(fields.length, mode.cursor, listH);
    // widen for long labels, keeping room for the value
    const longest = Math.max(0, ...fields.map((f) => visibleWidth(f.label)));
    const labelW = Math.max(Math.min(24, Math.floor(LW / 2)), Math.min(longest, LW - (sideBySide ? 11 : 23)));
    for (let i = 0; i < listH; i++) {
      const f = fields[start + i];
      if (!f) {
        left.push('');
        continue;
      }
      const selected = start + i === mode.cursor;
      const row = ` ${pad(f.label, labelW)} ${settingValue(f, state.config, LW - labelW - 3)}`;
      left.push(selected ? inv(pad(stripAnsi(row), LW)) : pad(row, LW));
      hits.push({ kind: 'item', area: 'main', index: start + i, x: 0, y: 1 + i, w: LW });
    }
  }
  let right: string[] = [];
  if (mode.sub && field) {
    const bar = visibleWidth('│') + 2;
    const panelW = sideBySide ? w - LW - bar : w;
    const panel = subPanel(field, mode, panelW, listH);
    right = panel.lines;
    const dx = sideBySide ? LW + bar : 0;
    for (const hit of panel.hits) if (hit.kind === 'item') hits.push({ ...hit, x: hit.x + dx, y: hit.y + 1 });
  }
  for (let i = 0; i < listH; i++) {
    if (sideBySide) lines.push(`${pad(left[i] ?? '', LW)} ${dim('│')} ${right[i] ?? ''}`);
    else lines.push(mode.sub ? (right[i] ?? '') : (left[i] ?? ''));
  }
  const help =
    field?.help ??
    (field?.kind === 'bool'
      ? t('tui.view.boolHelp')
      : field?.kind === 'select'
        ? t('tui.view.selectHelp')
        : '');
  lines.push(dim(` ${truncate(help, w - 2)}`));
  return { lines, hits };
}

const DEMO_TYPES = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'];
let themeLineCache = new Map<string, { at: number; line: string }>();

function themePreviewLine(state: State, id: string, width: number): string {
  const first = state.config.lines.find((l) => l.length > 0);
  const lines = first ?? DEMO_TYPES.map((type) => ({ id: type, type }));
  const key = `${language()}|${id}|${width}|${state.config.colorLevel}|${state.config.icons}|${JSON.stringify(lines)}`;
  const hit = themeLineCache.get(key);
  if (hit && Date.now() - hit.at < 3000) return hit.line;
  if (themeLineCache.size > 200) themeLineCache = new Map();
  let line = '';
  try {
    const demo: Config = { ...withTheme(state.config, id), lines: [lines] };
    const out = renderPreview(demo, 'sample', width + state.config.widthOffset);
    line = (resolveTheme(id).style === 'tui' && out.length >= 3 ? out[1] : out[0]) ?? '';
  } catch {
    line = dim(t('tui.view.previewUnavailable'));
  }
  themeLineCache.set(key, { at: Date.now(), line });
  return line;
}

function themesModal(state: State, mode: Extract<Mode, { kind: 'themes' }>, w: number, h: number): Modal {
  const items = themeItems(mode.filter);
  const current = state.config.theme;
  const lines = [rule(t('tui.view.themes'), w)];
  if (mode.naming) {
    const chars = [...mode.naming.text];
    const before = chars.slice(0, mode.naming.pos).join('');
    const at = chars[mode.naming.pos] ?? ' ';
    const after = chars.slice(mode.naming.pos + 1).join('');
    lines.push(` ${bold(t('tui.view.saveAsMine'))} ${dim(t('tui.view.themeIdRule'))}`);
    lines.push(` ${dim(t('tui.view.themeId'))} ${before}${inv(at)}${after}`);
    lines.push(dim(` ${t('tui.view.saveThemeHint')}`));
    while (lines.length < h) lines.push('');
    return { lines, hits: [] };
  }
  lines.push(` ${dim(t('tui.view.filter'))} ${mode.filter}${inv(' ')}`);
  const listH = Math.max(2, h - 2);
  const per = 2;
  const visible = Math.max(1, Math.floor(listH / per));
  const start = windowStart(items.length, mode.cursor, visible);
  const hits: Hit[] = [];
  const yours = t('insp.yours');
  for (let n = 0; n < visible; n++) {
    const th = items[start + n];
    if (!th) break;
    const selected = start + n === mode.cursor;
    const tags = `${th.style} · ${th.source === 'user' ? `${yours} · ` : ''}${themeDescription(th)}`;
    const head = ` ${th.id === current ? '●' : ' '} ${pad(th.name, 16)} ${truncate(tags, Math.max(0, w - 22))}`;
    lines.push(
      selected
        ? inv(pad(head, w))
        : `${pad(` ${th.id === current ? '●' : ' '} ${bold(th.name)}`, 20)} ${dim(truncate(tags, Math.max(0, w - 22)))}`,
    );
    lines.push(`   ${truncate(themePreviewLine(state, th.id, w - 6), w - 3)}\x1b[0m`);
    for (const dy of [0, 1])
      hits.push({ kind: 'item', area: 'main', index: start + n, x: 0, y: lines.length - 2 + dy, w });
  }
  if (!items.length) lines.push(` ${dim(t('tui.view.noThemes'))}`);
  while (lines.length < h - 1) lines.push('');
  const count = t('tui.view.themeCount', { count: items.length });
  lines.push(
    dim(` ${count} · ${truncate(t('tui.view.saveTip'), Math.min(w - 16, w - 4 - visibleWidth(count)))}`),
  );
  return { lines: lines.slice(0, h), hits };
}

function presetsModal(state: State, mode: Extract<Mode, { kind: 'presets' }>, w: number, h: number): Modal {
  const PRESETS = state.presets;
  const lines = [rule(t('tui.view.presets'), w)];
  const hits: Hit[] = [];
  const listH = Math.max(1, h - 1);
  const start = windowStart(PRESETS.length, mode.cursor, listH);
  for (let i = 0; i < listH; i++) {
    const p = PRESETS[start + i];
    if (!p) {
      lines.push('');
      continue;
    }
    const name = presetText(p, 'name');
    const desc = presetText(p, 'description');
    const row = ` ${pad(name, 16)} ${desc}`;
    const selected = start + i === mode.cursor;
    lines.push(
      selected ? inv(pad(row, w)) : `${pad(` ${name}`, 17)} ${dim(truncate(desc, Math.max(0, w - 18)))}`,
    );
    hits.push({ kind: 'item', area: 'main', index: start + i, x: 0, y: lines.length - 1, w });
  }
  return { lines, hits };
}

function centered(rows: string[], w: number, h: number, title: string): Modal {
  const lines = [rule(title, w)];
  const top = Math.max(0, Math.floor((h - 1 - rows.length) / 2));
  for (let i = 0; i < top; i++) lines.push('');
  for (const row of rows) {
    const r = truncate(row, w);
    lines.push(' '.repeat(Math.max(0, Math.floor((w - visibleWidth(r)) / 2))) + r);
  }
  return { lines, hits: [] };
}

const shown = (s: string) => sanitizeText(s).replace(/\s+/g, ' ');

export function installQuestion(plan?: TuiInstallPlan): string {
  if (!plan?.needsConfirm) return t('tui.confirm.installQuestion');
  return t('tui.replaceQuestion', {
    current: shown(plan.current ?? t('install.unset')),
    proposed: shown(plan.proposed),
  });
}

function confirmModal(state: State, mode: Extract<Mode, { kind: 'confirm' }>, w: number, h: number): Modal {
  const k = (key: string, id: MessageId) => `${bold(fg(key, 'brightYellow'))} ${t(id)}`;
  switch (mode.what) {
    case 'quit':
      return centered(
        [
          bold(t('tui.confirm.unsaved')),
          '',
          `${k('s', 'tui.confirm.saveQuit')}   ${k('d', 'tui.confirm.discard')}   ${k('Esc', 'tui.confirm.keepEditing')}`,
        ],
        w,
        h,
        t('tui.confirm.quit'),
      );
    case 'deleteLine':
      return centered(
        [
          bold(
            t('tui.confirm.deleteLine', {
              line: state.sel.line + 1,
              count: state.config.lines[state.sel.line]?.length ?? 0,
            }),
          ),
          '',
          `${k('y', 'tui.confirm.delete')}   ${k('n', 'tui.confirm.cancel')}`,
        ],
        w,
        h,
        t('tui.confirm.deleteLineTitle'),
      );
    case 'preset': {
      const preset = state.presets.find((p) => p.id === mode.preset);
      return centered(
        [
          bold(t('tui.confirm.replacePreset', { name: preset ? presetText(preset, 'name') : '' })),
          dim(t('tui.confirm.undoHint')),
          '',
          `${k('y', 'tui.confirm.replace')}   ${k('n', 'tui.confirm.cancel')}`,
        ],
        w,
        h,
        t('tui.confirm.applyPreset'),
      );
    }
    case 'install':
      return centered(
        [
          bold(truncate(installQuestion(mode.plan), Math.max(10, w - 4))),
          dim(t('tui.confirm.savedFirst')),
          '',
          `${k('y', 'tui.confirm.install')}   ${k('n', 'tui.confirm.cancel')}`,
        ],
        w,
        h,
        t('tui.confirm.installTitle'),
      );
  }
}

// a key name stays as typed; a [id] key is a word
type Key = string | [MessageId];
const keyText = (k: Key) => (typeof k === 'string' ? k : t(k[0]));

const HELP: [Key, MessageId][] = [
  ['← → ↑ ↓  h j k l', 'tui.help.select'],
  ['Shift+← →  <  >', 'tui.help.moveInLine'],
  ['Shift+↑ ↓  {  }', 'tui.help.moveToLine'],
  ['a  +', 'tui.help.add'],
  ['d  x  Delete', 'tui.help.remove'],
  ['e  Enter', 'tui.help.edit'],
  ['n', 'tui.help.newLine'],
  ['D', 'tui.help.deleteLine'],
  ['K  J', 'tui.help.moveLine'],
  ['g', 'tui.help.global'],
  ['t', 'tui.help.presets'],
  ['p', 'tui.help.preview'],
  ['u  Ctrl+Z', 'tui.help.undo'],
  ['U  Ctrl+Y', 'tui.help.redo'],
  ['s  Ctrl+S', 'tui.help.save'],
  ['i', 'tui.help.install'],
  ['q  Esc', 'tui.help.quit'],
  [['tui.key.mouse'], 'tui.help.mouse'],
];

function helpModal(w: number, h: number): Modal {
  const lines = [rule(t('tui.help.title'), w)];
  const keyW = Math.min(20, Math.floor(w / 3));
  const rows = HELP.map(([k, d]) => ` ${bold(pad(keyText(k), keyW))} ${dim(t(d))}`);
  const body = h - 1;
  if (w >= 100 && rows.length > body) {
    const half = Math.ceil(rows.length / 2);
    const cw = Math.floor(w / 2);
    for (let i = 0; i < half; i++) lines.push(pad(rows[i] ?? '', cw) + (rows[half + i] ?? ''));
  } else lines.push(...rows);
  return { lines: lines.slice(0, h), hits: [] };
}

const HINTS: Record<Mode['kind'], [Key, MessageId][]> = {
  normal: [
    ['←→↑↓', 'tui.hint.select'],
    ['S-arrows', 'tui.hint.move'],
    ['a', 'tui.hint.add'],
    ['e', 'tui.hint.edit'],
    ['d', 'tui.hint.delete'],
    ['s', 'tui.hint.save'],
    ['q', 'tui.hint.quit'],
    ['?', 'tui.hint.help'],
    ['n', 'tui.hint.newLine'],
    ['T', 'tui.hint.themes'],
    ['g', 'tui.hint.global'],
    ['t', 'tui.hint.presets'],
    ['u', 'tui.hint.undo'],
  ],
  picker: [
    [['tui.key.type'], 'tui.hint.filter'],
    ['↑↓', 'tui.hint.choose'],
    ['Enter', 'tui.hint.insert'],
    ['Esc', 'tui.hint.cancel'],
  ],
  settings: [
    ['↑↓', 'tui.hint.field'],
    ['Enter', 'tui.hint.edit'],
    ['←→', 'tui.hint.cycle'],
    ['Del', 'tui.hint.reset'],
    ['Esc', 'tui.hint.back'],
  ],
  themes: [
    [['tui.key.type'], 'tui.hint.filter'],
    ['↑↓', 'tui.hint.preview'],
    ['Enter', 'tui.hint.apply'],
    ['^S', 'tui.hint.saveMine'],
    ['Esc', 'tui.hint.revert'],
  ],
  presets: [
    ['↑↓', 'tui.hint.choose'],
    ['Enter', 'tui.hint.apply'],
    ['Esc', 'tui.hint.cancel'],
  ],
  confirm: [['Esc', 'tui.hint.cancel']],
  help: [[['tui.key.any'], 'tui.hint.close']],
};

const EDITING_HINTS: [Key, MessageId][] = [
  ['↑↓', 'tui.hint.choose'],
  ['Enter', 'tui.hint.apply'],
  ['Esc', 'tui.hint.back'],
];

function hintLine(state: State, cols: number): string {
  const editing = state.mode.kind === 'settings' && state.mode.sub !== null;
  const list = editing ? EDITING_HINTS : HINTS[state.mode.kind];
  let out = '';
  let width = 0;
  for (const [key, id] of list) {
    const k = keyText(key);
    const d = t(id);
    const w = visibleWidth(k) + visibleWidth(d) + 3;
    if (width + w > cols - 1) break;
    out += `${bold(k)} ${dim(d)}  `;
    width += w;
  }
  return ` ${out}`;
}

function tooSmall(cols: number, rows: number): Screen {
  const msg = [
    t('tui.view.tooSmall', { cols, rows }),
    t('tui.view.needsSize', { cols: MIN_COLS, rows: MIN_ROWS }),
    t('tui.view.quits'),
  ];
  const lines = Array.from({ length: rows }, () => '');
  const top = Math.max(0, Math.floor((rows - msg.length) / 2));
  msg.forEach((m, i) => {
    if (top + i < rows) lines[top + i] = truncate(m, cols);
  });
  return { lines, hits: [] };
}

function header(state: State, cols: number): string {
  const right = state.dirty ? ` ● ${t('tui.view.modified')} ` : ` ${t('tui.view.saved')} `;
  const left = ` ccinfobar  ${state.path}`;
  const text = pad(truncate(left, cols - visibleWidth(right)), cols - visibleWidth(right)) + right;
  return state.dirty ? `${ESC}1;7m${text}${ESC}0m` : inv(text);
}

let previewMemo: { key: unknown[]; lines: string[]; at: number } | null = null;

function cachedPreview(state: State, width: number): string[] {
  const config = previewConfig(state);
  const key = [config, state.preview, width];
  const fresh = state.preview === 'sample' || Date.now() - (previewMemo?.at ?? 0) < 2000;
  if (previewMemo && fresh && key.every((k, i) => previewMemo!.key[i] === k)) return previewMemo.lines;
  const lines = renderPreview(config, state.preview, width);
  previewMemo = { key, lines, at: Date.now() };
  return lines;
}

export function renderScreen(state: State, cols: number, rows: number): Screen {
  const prev = widthMode();
  const ambiguous = state.config.ambiguousWidth === 2 ? 2 : 1;
  if (prev.ambiguous === ambiguous) return drawScreen(state, cols, rows);
  setWidthMode({ ...prev, ambiguous });
  try {
    return drawScreen(state, cols, rows);
  } finally {
    setWidthMode(prev);
  }
}

function drawScreen(state: State, cols: number, rows: number): Screen {
  if (cols < MIN_COLS || rows < MIN_ROWS) return tooSmall(cols, rows);
  const body = rows - 3;
  const hits: Hit[] = [];
  let previewLines: string[];
  try {
    previewLines = cachedPreview(state, boxInner(cols) + state.config.widthOffset);
  } catch {
    previewLines = [dim(t('tui.view.previewUnavailable'))];
  }
  if (!previewLines.length) previewLines = [dim(t('tui.view.nothingToShow'))];
  const previewTitle = t(state.preview === 'sample' ? 'tui.view.previewSample' : 'tui.view.previewLast');
  const normal = state.mode.kind === 'normal';
  const out: string[] = [header(state, cols)];

  if (normal) {
    const ctxH = rows >= 24 ? 5 : 4;
    const avail = body - ctxH;
    const editor = editorRows(state, cols);
    const wantEd = 1 + editor.rows.length;
    const wantPrev = 2 + previewLines.length;
    let prevH = wantPrev;
    if (wantPrev + wantEd > avail) prevH = Math.max(3, Math.min(wantPrev, avail - wantEd));
    prevH = Math.min(prevH, Math.max(3, avail - 3));
    out.push(...box(previewTitle, previewLines.slice(0, prevH - 2), cols));
    const edH = avail - prevH;
    const edTop = out.length;
    const listH = edH - 1;
    const start = windowStart(editor.rows.length, editor.selRow, listH);
    out.push(rule(t('tui.view.lines', { count: state.config.lines.length }), cols));
    for (let i = 0; i < listH; i++) out.push(editor.rows[start + i]?.text ?? '');
    for (let r = start; r < Math.min(editor.rows.length, start + listH); r++) {
      hits.push(...shiftHits(editor.rows[r]!.hits, edTop + 1 - start));
    }
    out.push(...contextPanel(state, cols, ctxH));
  } else {
    const prevH = Math.min(2 + previewLines.length, Math.max(3, Math.floor(body / 3)));
    out.push(...box(previewTitle, previewLines.slice(0, prevH - 2), cols));
    const top = out.length;
    const h = body - prevH;
    const mode = state.mode;
    let modal: Modal;
    switch (mode.kind) {
      case 'picker':
        modal = pickerModal(state, mode, cols, h);
        break;
      case 'settings':
        modal = settingsModal(state, mode, cols, h);
        break;
      case 'presets':
        modal = presetsModal(state, mode, cols, h);
        break;
      case 'themes':
        modal = themesModal(state, mode, cols, h);
        break;
      case 'confirm':
        modal = confirmModal(state, mode, cols, h);
        break;
      default:
        modal = helpModal(cols, h);
    }
    for (let i = 0; i < h; i++) out.push(modal.lines[i] ?? '');
    hits.push(...shiftHits(modal.hits, top));
  }

  out.push(state.message ? ` ${fg(truncate(state.message, cols - 2), 'brightYellow')}` : '');
  out.push(hintLine(state, cols));
  const lines = out.slice(0, rows).map((l) => (visibleWidth(l) > cols ? truncate(l, cols) : l));
  while (lines.length < rows) lines.push('');
  return { lines, hits };
}
