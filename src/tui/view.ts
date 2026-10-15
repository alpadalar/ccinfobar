import { parseColor, stripAnsi, style, truncate, visibleWidth } from '../core/ansi.js';
import { t } from '../core/i18n/index.js';
import { widgetText } from '../core/i18n/widget-text.js';
import { renderPreview } from '../core/preview.js';
import { sanitizeText } from '../core/sanitize.js';
import { resolveTheme } from '../core/themes.js';
import type { Config, WidgetItem } from '../core/types.js';
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

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w > width) return truncate(text, width);
  return text + ' '.repeat(width - w);
}

function rule(title: string, cols: number): string {
  const head = `── ${title} `;
  return (
    dim('──') +
    bold(` ${truncate(title, cols - 6)} `) +
    dim('─'.repeat(Math.max(0, cols - visibleWidth(head) - 1)))
  );
}

function box(title: string, content: string[], cols: number): string[] {
  const inner = cols - 4;
  const head = ` ${truncate(title, cols - 6)} `;
  const top = `┌─${head}${'─'.repeat(Math.max(0, cols - 3 - visibleWidth(head)))}┐`;
  return [
    dim(top),
    ...content.map((l) => `${dim('│')} ${pad(truncate(l, inner), inner)} ${dim('│')}`),
    dim(`└${'─'.repeat(cols - 2)}┘`),
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
    return { rows: [{ text: `    ${dim('No lines yet. Press n to create one.')}`, hits: [] }], selRow: 0 };
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
      text += dim('(empty line)');
      if (cur) selRow = rows.length;
      flush();
      return;
    }
    items.forEach((item, i) => {
      const label = `[${truncate(itemLabel(item), 28)}]`;
      const w = visibleWidth(label);
      if (x + 1 + w > cols - 1 && x > 4) {
        flush();
        text = '    ';
        x = 4;
        hits = [];
      }
      const dropHere = state.drag?.to?.line === l && state.drag.to.index === i;
      const selected = cur && i === state.sel.index;
      const dragged = state.drag?.from.line === l && state.drag.from.index === i;
      let chip: string;
      if (selected) chip = bold(inv(label));
      else if (dragged) chip = dim(under(label));
      else chip = fg(label, item.color ?? getWidget(item.type)?.color);
      if (selected) selRow = rows.length;
      text += (dropHere ? mark : ' ') + chip;
      hits.push({ kind: 'chip', line: l, index: i, x: x + 1, y: 0, w });
      x += 1 + w;
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

function summary(item: WidgetItem): string {
  const parts: string[] = [];
  if (item.color) parts.push(`color ${item.color}`);
  if (item.background) parts.push(`bg ${item.background}`);
  for (const f of ['bold', 'dim', 'italic', 'raw', 'merge'] as const) if (item[f]) parts.push(f);
  if (item.label !== undefined) parts.push(`label "${item.label}"`);
  for (const [k, v] of Object.entries(item.options ?? {})) parts.push(`${k}=${v}`);
  return parts.length ? parts.join('  ') : 'default style';
}

function contextPanel(state: State, cols: number, height: number): string[] {
  const out: string[] = [rule('Selected', cols)];
  const item = selectedItem(state);
  const body: string[] = [];
  if (state.drag) {
    body.push(bold('Dragging…'), dim('Release over a position to drop. Esc cancels.'));
  } else if (item) {
    const def = getWidget(item.type);
    body.push(
      `${bold(def ? widgetText(def, 'name') : item.type)} ${dim(`(${item.type}${def ? ` · ${categoryName(def.category)}` : ' · unknown widget'})`)}`,
      def ? widgetText(def, 'description') : dim('This widget type is not registered.'),
      summary(item),
      dim(`id ${item.id}`),
    );
  } else {
    body.push(dim('No widget selected.'), dim('Press a to add a widget, n for a new line, ? for help.'));
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
  const lines = [rule('Add widget', w), ` ${dim('Filter:')} ${mode.filter}${inv(' ')}`];
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
  if (!items.length) lines[2] = ` ${dim('No widgets match. Esc to cancel.')}`;
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
      ? '#rrggbb, ansi256:N or a color name'
      : field.kind === 'number'
        ? 'a number'
        : (field.help ?? 'text');
  lines.push(
    bold(` ${field.label}`),
    ` ${before}${inv(at)}${after}`,
    '',
    dim(` ${hint}`),
    dim(' Enter apply · Esc cancel'),
  );
  return { lines: lines.slice(0, h), hits };
}

function settingsModal(state: State, mode: Extract<Mode, { kind: 'settings' }>, w: number, h: number): Modal {
  const fields = settingsFields(state);
  const item = mode.scope === 'widget' ? selectedItem(state) : undefined;
  const title =
    mode.scope === 'global' ? 'Global settings' : `${itemLabel(item ?? { id: '', type: '?' })} · properties`;
  const lines = [rule(title, w)];
  const listH = Math.max(1, h - 2);
  const field = fields[mode.cursor];
  const sideBySide = mode.sub !== null && w >= 76;
  const LW = sideBySide ? Math.min(46, w - 30) : w;
  const hits: Hit[] = [];
  const left: string[] = [];
  if (!mode.sub || sideBySide) {
    const start = windowStart(fields.length, mode.cursor, listH);
    const labelW = Math.min(24, Math.floor(LW / 2));
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
    const panelW = sideBySide ? w - LW - 3 : w;
    const panel = subPanel(field, mode, panelW, listH);
    right = panel.lines;
    const dx = sideBySide ? LW + 3 : 0;
    for (const hit of panel.hits) if (hit.kind === 'item') hits.push({ ...hit, x: hit.x + dx, y: hit.y + 1 });
  }
  for (let i = 0; i < listH; i++) {
    if (sideBySide) lines.push(`${pad(left[i] ?? '', LW)} ${dim('│')} ${right[i] ?? ''}`);
    else lines.push(mode.sub ? (right[i] ?? '') : (left[i] ?? ''));
  }
  const help =
    field?.help ??
    (field?.kind === 'bool' ? 'Enter toggles' : field?.kind === 'select' ? 'Enter or ←/→ changes' : '');
  lines.push(dim(` ${truncate(help, w - 2)}`));
  return { lines, hits };
}

const DEMO_TYPES = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'];
let themeLineCache = new Map<string, { at: number; line: string }>();

function themePreviewLine(state: State, id: string, width: number): string {
  const first = state.config.lines.find((l) => l.length > 0);
  const lines = first ?? DEMO_TYPES.map((type) => ({ id: type, type }));
  const key = `${id}|${width}|${state.config.colorLevel}|${state.config.icons}|${JSON.stringify(lines)}`;
  const hit = themeLineCache.get(key);
  if (hit && Date.now() - hit.at < 3000) return hit.line;
  if (themeLineCache.size > 200) themeLineCache = new Map();
  let line = '';
  try {
    const demo: Config = { ...withTheme(state.config, id), lines: [lines] };
    const out = renderPreview(demo, 'sample', width + state.config.widthOffset);
    line = (resolveTheme(id).style === 'tui' && out.length >= 3 ? out[1] : out[0]) ?? '';
  } catch {
    line = dim('(preview unavailable)');
  }
  themeLineCache.set(key, { at: Date.now(), line });
  return line;
}

function themesModal(state: State, mode: Extract<Mode, { kind: 'themes' }>, w: number, h: number): Modal {
  const items = themeItems(mode.filter);
  const current = state.config.theme;
  const lines = [rule('Themes', w)];
  if (mode.naming) {
    const chars = [...mode.naming.text];
    const before = chars.slice(0, mode.naming.pos).join('');
    const at = chars[mode.naming.pos] ?? ' ';
    const after = chars.slice(mode.naming.pos + 1).join('');
    lines.push(` ${bold('Save as my theme')} ${dim('(letters, numbers, . - _)')}`);
    lines.push(` ${dim('Id:')} ${before}${inv(at)}${after}`);
    lines.push(
      dim(' Saves the current theme with your overrides, then switches to it. Enter save · Esc cancel'),
    );
    while (lines.length < h) lines.push('');
    return { lines, hits: [] };
  }
  lines.push(` ${dim('Filter:')} ${mode.filter}${inv(' ')}`);
  const listH = Math.max(2, h - 2);
  const per = 2;
  const visible = Math.max(1, Math.floor(listH / per));
  const start = windowStart(items.length, mode.cursor, visible);
  const hits: Hit[] = [];
  for (let n = 0; n < visible; n++) {
    const t = items[start + n];
    if (!t) break;
    const selected = start + n === mode.cursor;
    const tags = `${t.style} · ${t.source === 'user' ? 'yours · ' : ''}${t.description}`;
    const head = ` ${t.id === current ? '●' : ' '} ${pad(t.name, 16)} ${truncate(tags, Math.max(0, w - 22))}`;
    lines.push(
      selected
        ? inv(pad(head, w))
        : `${pad(` ${t.id === current ? '●' : ' '} ${bold(t.name)}`, 20)} ${dim(truncate(tags, Math.max(0, w - 22)))}`,
    );
    lines.push(`   ${truncate(themePreviewLine(state, t.id, w - 6), w - 3)}\x1b[0m`);
    for (const dy of [0, 1])
      hits.push({ kind: 'item', area: 'main', index: start + n, x: 0, y: lines.length - 2 + dy, w });
  }
  if (!items.length) lines.push(` ${dim('No themes match. Esc to cancel.')}`);
  while (lines.length < h - 1) lines.push('');
  lines.push(
    dim(` ${items.length} themes · ${truncate('Ctrl+S saves the current look as your own theme', w - 16)}`),
  );
  return { lines: lines.slice(0, h), hits };
}

function presetsModal(state: State, mode: Extract<Mode, { kind: 'presets' }>, w: number, h: number): Modal {
  const PRESETS = state.presets;
  const lines = [rule('Presets · replaces the current layout', w)];
  const hits: Hit[] = [];
  const listH = Math.max(1, h - 1);
  const start = windowStart(PRESETS.length, mode.cursor, listH);
  for (let i = 0; i < listH; i++) {
    const p = PRESETS[start + i];
    if (!p) {
      lines.push('');
      continue;
    }
    const row = ` ${pad(p.name, 16)} ${p.description}`;
    const selected = start + i === mode.cursor;
    lines.push(
      selected
        ? inv(pad(row, w))
        : `${pad(` ${p.name}`, 17)} ${dim(truncate(p.description, Math.max(0, w - 18)))}`,
    );
    hits.push({ kind: 'item', area: 'main', index: start + i, x: 0, y: lines.length - 1, w });
  }
  return { lines, hits };
}

function centered(rows: string[], w: number, h: number, title: string): Modal {
  const lines = [rule(title, w)];
  const top = Math.max(0, Math.floor((h - 1 - rows.length) / 2));
  for (let i = 0; i < top; i++) lines.push('');
  for (const r of rows) lines.push(' '.repeat(Math.max(0, Math.floor((w - visibleWidth(r)) / 2))) + r);
  return { lines, hits: [] };
}

const shown = (s: string) => sanitizeText(s).replace(/\s+/g, ' ');

export function installQuestion(plan?: TuiInstallPlan): string {
  if (!plan?.needsConfirm) return "Set Claude Code's statusLine to ccinfobar?";
  return t('tui.replaceQuestion', {
    current: shown(plan.current ?? t('install.unset')),
    proposed: shown(plan.proposed),
  });
}

function confirmModal(state: State, mode: Extract<Mode, { kind: 'confirm' }>, w: number, h: number): Modal {
  const k = (t: string) => bold(fg(t, 'brightYellow'));
  switch (mode.what) {
    case 'quit':
      return centered(
        [
          bold('You have unsaved changes.'),
          '',
          `${k('s')} save and quit   ${k('d')} discard   ${k('Esc')} keep editing`,
        ],
        w,
        h,
        'Quit',
      );
    case 'deleteLine':
      return centered(
        [
          bold(
            `Delete line ${state.sel.line + 1} with ${state.config.lines[state.sel.line]?.length ?? 0} widgets?`,
          ),
          '',
          `${k('y')} delete   ${k('n')} cancel`,
        ],
        w,
        h,
        'Delete line',
      );
    case 'preset': {
      const name = state.presets.find((p) => p.id === mode.preset)?.name ?? '';
      return centered(
        [
          bold(`Replace the current layout with "${name}"?`),
          dim('You can undo this with u.'),
          '',
          `${k('y')} replace   ${k('n')} cancel`,
        ],
        w,
        h,
        'Apply preset',
      );
    }
    case 'install':
      return centered(
        [
          bold(truncate(installQuestion(mode.plan), Math.max(10, w - 4))),
          dim('Unsaved changes are saved first.'),
          '',
          `${k('y')} install   ${k('n')} cancel`,
        ],
        w,
        h,
        'Install',
      );
  }
}

const HELP: [string, string][] = [
  ['← → ↑ ↓  h j k l', 'select widget / line'],
  ['Shift+← →  <  >', 'move widget in line'],
  ['Shift+↑ ↓  {  }', 'move widget to prev/next line'],
  ['a  +', 'add widget'],
  ['d  x  Delete', 'remove widget'],
  ['e  Enter', 'edit properties'],
  ['n', 'new line below'],
  ['D', 'delete line'],
  ['K  J', 'move line up / down'],
  ['g', 'global settings'],
  ['t', 'presets'],
  ['p', 'preview: sample / last session'],
  ['u  Ctrl+Z', 'undo'],
  ['U  Ctrl+Y', 'redo'],
  ['s  Ctrl+S', 'save'],
  ['i', 'install into Claude Code'],
  ['q  Esc', 'quit'],
  ['Mouse', 'click selects, drag moves, wheel scrolls lists'],
];

function helpModal(w: number, h: number): Modal {
  const lines = [rule('Keys · press any key to close', w)];
  const keyW = Math.min(20, Math.floor(w / 3));
  const rows = HELP.map(([k, d]) => ` ${bold(pad(k, keyW))} ${dim(d)}`);
  const body = h - 1;
  if (w >= 100 && rows.length > body) {
    const half = Math.ceil(rows.length / 2);
    const cw = Math.floor(w / 2);
    for (let i = 0; i < half; i++) lines.push(pad(rows[i] ?? '', cw) + (rows[half + i] ?? ''));
  } else lines.push(...rows);
  return { lines: lines.slice(0, h), hits: [] };
}

const HINTS: Record<Mode['kind'], [string, string][]> = {
  normal: [
    ['←→↑↓', 'select'],
    ['S-arrows', 'move'],
    ['a', 'add'],
    ['e', 'edit'],
    ['d', 'delete'],
    ['s', 'save'],
    ['q', 'quit'],
    ['?', 'help'],
    ['n', 'new line'],
    ['T', 'themes'],
    ['g', 'global'],
    ['t', 'presets'],
    ['u', 'undo'],
  ],
  picker: [
    ['type', 'filter'],
    ['↑↓', 'choose'],
    ['Enter', 'insert after selection'],
    ['Esc', 'cancel'],
  ],
  settings: [
    ['↑↓', 'field'],
    ['Enter', 'edit'],
    ['←→', 'cycle'],
    ['Del', 'reset'],
    ['Esc', 'back'],
  ],
  themes: [
    ['type', 'filter'],
    ['↑↓', 'preview'],
    ['Enter', 'apply'],
    ['^S', 'save as mine'],
    ['Esc', 'revert'],
  ],
  presets: [
    ['↑↓', 'choose'],
    ['Enter', 'apply'],
    ['Esc', 'cancel'],
  ],
  confirm: [['Esc', 'cancel']],
  help: [['any key', 'close']],
};

function hintLine(state: State, cols: number): string {
  const editing = state.mode.kind === 'settings' && state.mode.sub !== null;
  const list: [string, string][] = editing
    ? [
        ['↑↓', 'choose'],
        ['Enter', 'apply'],
        ['Esc', 'back'],
      ]
    : HINTS[state.mode.kind];
  let out = '';
  let width = 0;
  for (const [k, d] of list) {
    const piece = `${bold(k)} ${dim(d)}`;
    const w = visibleWidth(k) + visibleWidth(d) + 3;
    if (width + w > cols - 1) break;
    out += `${piece}  `;
    width += w;
  }
  return ` ${out}`;
}

function tooSmall(cols: number, rows: number): Screen {
  const msg = [
    `Terminal too small (${cols}x${rows}).`,
    `ccinfobar tui needs at least ${MIN_COLS}x${MIN_ROWS}.`,
    'q quits.',
  ];
  const lines = Array.from({ length: rows }, () => '');
  const top = Math.max(0, Math.floor((rows - msg.length) / 2));
  msg.forEach((m, i) => {
    if (top + i < rows) lines[top + i] = truncate(m, cols);
  });
  return { lines, hits: [] };
}

function header(state: State, cols: number): string {
  const right = state.dirty ? ' ● modified ' : ' saved ';
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
  if (cols < MIN_COLS || rows < MIN_ROWS) return tooSmall(cols, rows);
  const body = rows - 3;
  const hits: Hit[] = [];
  let previewLines: string[];
  try {
    previewLines = cachedPreview(state, cols - 4 + state.config.widthOffset);
  } catch {
    previewLines = [dim('(preview unavailable)')];
  }
  if (!previewLines.length) previewLines = [dim('(nothing to show)')];
  const previewTitle = `Preview · ${state.preview === 'sample' ? 'sample data' : 'last session'}`;
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
    out.push(
      rule(
        `Lines · ${state.config.lines.length} ${state.config.lines.length === 1 ? 'line' : 'lines'}`,
        cols,
      ),
    );
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
