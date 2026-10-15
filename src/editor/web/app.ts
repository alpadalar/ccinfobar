import {
  addLine,
  insertItem,
  moveItem,
  moveLine,
  removeItem,
  removeLine,
  setLineAlign,
  uniqueId,
} from '../../core/edit.js';
import { t } from '../../core/i18n/index.js';
import { titleWidgets } from '../../core/panel.js';
import type { Config } from '../../core/types.js';
import { ansiToHtml, escapeHtml } from './ansi-html.js';
import { ApiError, api, previewSource, setToken } from './api.js';
import { colorToCss } from './colors.js';
import { type DragSpec, type DropTarget, press } from './dnd.js';
import { clear, h, icon } from './dom.js';
import { initInspector, renderInspector } from './inspector.js';
import { installDialog } from './install-dialog.js';
import { openPresets } from './presets.js';
import { openSettings } from './settings.js';
import {
  commit,
  currentTheme,
  emit,
  init,
  isDirty,
  markSaved,
  on,
  redo,
  replaceAll,
  S,
  select,
  undo,
  WIDTH_KEY,
  type WidgetInfo,
} from './store.js';
import { chipMenu, copyStyle, paintOnto, pasteStyle, rememberStyles, setPainting } from './styles.js';
import { initTerminalPicker } from './terminal-picker.js';
import { openGallery } from './themes.js';
import { confirmDialog, modal, toast } from './ui.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let pendingFocus: string | null = null;

function widgetColor(type: string, color?: string): string | null {
  return colorToCss(color ?? S.widgetMap.get(type)?.color);
}

function addWidget(type: string, line: number, index: number): void {
  const id = uniqueId(S.config, type);
  commit(insertItem(S.config, { type }, { line, index }));
  pendingFocus = null;
  select(id, Math.min(line, S.config.lines.length - 1));
}

function handleDrop(spec: DragSpec, target: DropTarget): void {
  if (spec.kind === 'palette') {
    if (target.kind === 'slot') addWidget(spec.type, target.line, target.index);
    else if (target.kind === 'newline') {
      commit(addLine(S.config));
      addWidget(spec.type, S.config.lines.length - 1, 0);
    }
    return;
  }
  if (spec.kind === 'chip') {
    if (target.kind === 'trash') {
      commit(removeItem(S.config, spec.id), { select: null });
    } else if (target.kind === 'slot') {
      commit(moveItem(S.config, spec.id, { line: target.line, index: target.index }));
      select(spec.id);
    } else if (target.kind === 'newline') {
      commit(moveItem(addLine(S.config), spec.id, { line: S.config.lines.length, index: 0 }));
      select(spec.id);
    }
    return;
  }
  if (target.kind === 'rowslot') {
    const to = target.slot > spec.line ? target.slot - 1 : target.slot;
    commit(moveLine(S.config, spec.line, to));
    select(null, to);
  }
}

function renderChip(id: string, line: number, index: number): HTMLElement {
  const item = S.config.lines[line]![index]!;
  const info = S.widgetMap.get(item.type);
  const color = widgetColor(item.type, item.color);
  const name = info?.name ?? item.type;
  const chip = h(
    'div',
    {
      class: `chip${item.id === S.selectedId ? ' selected' : ''}${item.merge ? ' merged' : ''}${S.config.lines[line]![index - 1]?.merge ? ' merged-in' : ''}${info ? '' : ' unknown'}`,
      tabindex: 0,
      role: 'button',
      'aria-pressed': String(item.id === S.selectedId),
      'aria-label': `${name}, line ${line + 1}, position ${index + 1}${S.hidden.has(item.id) ? HIDDEN_SUFFIX() : ''}`,
      'data-id': id,
      title: info ? `${info.description}${info.sample ? `\nSample: ${info.sample}` : ''}` : item.type,
    },
    h('i', { class: 'dot', style: color ? `--c:${color}` : '' }),
    h('span', { class: 'chip-name' }, name),
    item.merge ? h('span', { class: 'chip-link', title: 'Merged with next' }, icon('link', 12)) : null,
    S.hidden.has(item.id) ? hiddenBadge() : null,
  );
  chip.addEventListener('pointerdown', (e) =>
    press(
      e,
      { kind: 'chip', id, label: name, color },
      { click: () => (S.painting ? paintOnto(id) : select(id, line)), drop: handleDrop },
    ),
  );
  chip.addEventListener('contextmenu', (e) => chipMenu(e, id, line));
  chip.addEventListener('keydown', (e) => chipKey(e, id));
  return chip;
}

const HIDDEN_SUFFIX = () => `, ${t('vis.hiddenBadge')}`;

function hiddenBadge(): HTMLElement {
  return h('span', { class: 'chip-hidden', title: t('vis.hiddenBadge') }, t('vis.hiddenShort'));
}

function syncHidden(next: string[]): void {
  const set = new Set(next);
  if (set.size === S.hidden.size && next.every((id) => S.hidden.has(id))) return;
  S.hidden = set;
  for (const chip of document.querySelectorAll<HTMLElement>('.chip[data-id]')) {
    const badge = chip.querySelector('.chip-hidden');
    const on = set.has(chip.dataset.id ?? '');
    if (on === !!badge) continue;
    const label = (chip.getAttribute('aria-label') ?? '').replace(HIDDEN_SUFFIX(), '');
    chip.setAttribute('aria-label', on ? label + HIDDEN_SUFFIX() : label);
    if (on) chip.append(hiddenBadge());
    else badge?.remove();
  }
}

function chipKey(e: KeyboardEvent, id: string): void {
  const lines = S.config.lines;
  const line = lines.findIndex((l) => l.some((i) => i.id === id));
  if (line < 0) return;
  const index = lines[line]!.findIndex((i) => i.id === id);
  const len = lines[line]!.length;
  if (e.altKey && e.key.startsWith('Arrow')) {
    e.preventDefault();
    pendingFocus = id;
    if (e.key === 'ArrowLeft' && index > 0) commit(moveItem(S.config, id, { line, index: index - 1 }));
    else if (e.key === 'ArrowRight' && index < len - 1)
      commit(moveItem(S.config, id, { line, index: index + 2 }));
    else if (e.key === 'ArrowUp' && line > 0)
      commit(moveItem(S.config, id, { line: line - 1, index: Math.min(index, lines[line - 1]!.length) }));
    else if (e.key === 'ArrowDown' && line < lines.length - 1)
      commit(moveItem(S.config, id, { line: line + 1, index: Math.min(index, lines[line + 1]!.length) }));
    select(id);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    select(id, line);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const chips = [...document.querySelectorAll<HTMLElement>(`#canvas .line[data-line="${line}"] .chip`)];
    chips[index + (e.key === 'ArrowLeft' ? -1 : 1)]?.focus();
    e.preventDefault();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const other = line + (e.key === 'ArrowUp' ? -1 : 1);
    const chips = document.querySelectorAll<HTMLElement>(`#canvas .line[data-line="${other}"] .chip`);
    (chips[Math.min(index, chips.length - 1)] ?? null)?.focus();
    e.preventDefault();
  }
}

function removeSelected(): void {
  const id = S.selectedId;
  if (!id) return;
  const lines = S.config.lines;
  const line = lines.findIndex((l) => l.some((i) => i.id === id));
  const row = lines[line] ?? [];
  const idx = row.findIndex((i) => i.id === id);
  const neighbor = row[idx + 1] ?? row[idx - 1];
  commit(removeItem(S.config, id), { select: neighbor?.id ?? null });
  if (neighbor) {
    pendingFocus = neighbor.id;
    renderCanvas();
  }
}

// pressing the active one goes back to the global alignment
function lineAlignButtons(li: number): HTMLElement | null {
  const items = S.config.lines[li] ?? [];
  if ((S.config.style ?? currentTheme()?.style) === 'tui') {
    const tui = S.config.tui ?? {};
    if (tui.breakpoints?.length) return null;
    const shown = titleWidgets(tui);
    if (items.length && items.every((i) => shown.has(i.id) || shown.has(i.type))) {
      return h(
        'span',
        { class: 'line-note', title: 'These widgets are drawn in the panel border' },
        'In panel title',
      );
    }
  }
  const own = S.config.lineAlign?.[li] ?? null;
  const global = S.config.align ?? 'left';
  return h(
    'div',
    { class: 'line-align', role: 'group', 'aria-label': `Align line ${li + 1}` },
    ...(['left', 'center', 'right'] as const).map((a) =>
      h(
        'button',
        {
          type: 'button',
          class: `icon-btn sm${own === a ? ' on' : !own && global === a ? ' inherit' : ''}`,
          title: own === a ? `Aligned ${a}. Click to follow the global alignment` : `Align this line ${a}`,
          'aria-pressed': String(own === a),
          onClick: (e: Event) => {
            e.stopPropagation();
            commit(setLineAlign(S.config, li, own === a ? null : a));
          },
        },
        icon(`align-${a}`, 14),
      ),
    ),
  );
}

function renderCanvas(): void {
  const canvas = $('canvas');
  clear(canvas);
  const lines = S.config.lines;
  const effStyle = S.config.style ?? currentTheme()?.style;
  if (effStyle === 'tui' && S.config.tui?.breakpoints?.length) {
    canvas.append(
      h(
        'div',
        { class: 'canvas-note' },
        icon('info', 14),
        h(
          'span',
          null,
          'Panel grid areas control where widgets sit. Lines still decide which widgets render.',
        ),
      ),
    );
  }
  lines.forEach((items, li) => {
    const grip = h(
      'div',
      { class: 'grip', title: 'Drag to reorder line', 'aria-label': `Reorder line ${li + 1}` },
      icon('grip', 14),
    );
    grip.addEventListener('pointerdown', (e) =>
      press(e, { kind: 'row', line: li, label: `Line ${li + 1}` }, { drop: handleDrop }),
    );
    const row = h(
      'div',
      { class: `line${li === S.selectedLine ? ' selected' : ''}`, 'data-line': String(li) },
      h(
        'div',
        { class: 'line-head' },
        grip,
        h('span', { class: 'line-title' }, `Line ${li + 1}`),
        h('span', { class: 'line-count' }, items.length === 1 ? '1 widget' : `${items.length} widgets`),
        lineAlignButtons(li),
        h(
          'button',
          {
            class: 'icon-btn danger sm',
            type: 'button',
            title: 'Delete line',
            'aria-label': `Delete line ${li + 1}`,
            onClick: (e: Event) => {
              e.stopPropagation();
              commit(removeLine(S.config, li));
            },
          },
          icon('trash', 14),
        ),
      ),
      h(
        'div',
        { class: 'line-items' },
        ...(items.length
          ? items.map((it, i) => renderChip(it.id, li, i))
          : [h('div', { class: 'line-empty' }, 'Drag widgets here, or press + in the palette')]),
      ),
    );
    row.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.chip, .grip, button')) return;
      select(null, li);
    });
    canvas.append(row);
  });
  if (!lines.length) {
    canvas.append(h('div', { class: 'canvas-empty' }, 'No lines yet. Add one to get started.'));
  }
  if (pendingFocus) {
    const el = canvas.querySelector<HTMLElement>(`.chip[data-id="${CSS.escape(pendingFocus)}"]`);
    el?.focus();
    pendingFocus = null;
  }
}

function renderPalette(): void {
  const host = $('palette-list');
  clear(host);
  const q = S.search.trim().toLowerCase();
  const matches = (w: WidgetInfo, catName: string) =>
    !q ||
    w.name.toLowerCase().includes(q) ||
    w.type.toLowerCase().includes(q) ||
    w.description.toLowerCase().includes(q) ||
    catName.toLowerCase().includes(q);
  let shown = 0;
  for (const cat of S.api.categories) {
    if (cat.id === 'gsd' && !S.api.gsdInstalled) continue;
    const list = S.api.widgets.filter((w) => !w.hidden && w.category === cat.id && matches(w, cat.name));
    if (!list.length) continue;
    shown += list.length;
    const open = q ? true : !S.collapsed.has(cat.id);
    const head = h(
      'button',
      {
        type: 'button',
        class: 'cat-head',
        'aria-expanded': String(open),
        onClick: () => {
          if (S.collapsed.has(cat.id)) S.collapsed.delete(cat.id);
          else S.collapsed.add(cat.id);
          renderPalette();
        },
      },
      h('span', { class: `chev${open ? ' open' : ''}` }, icon('chevron', 14)),
      h('span', { class: 'cat-name' }, cat.name),
      h('span', { class: 'cat-count' }, String(list.length)),
    );
    const section = h('section', { class: `cat${open ? ' open' : ''}` }, head);
    if (open) {
      const cards = h('div', { class: 'cards' });
      for (const w of list) cards.append(paletteCard(w));
      section.append(cards);
    }
    host.append(section);
  }
  if (!shown) host.append(h('div', { class: 'empty-state small' }, `No widgets match "${S.search}"`));
}

function paletteCard(w: WidgetInfo): HTMLElement {
  const color = colorToCss(w.color);
  const card = h(
    'div',
    { class: 'card', title: w.description, 'data-type': w.type },
    h('i', { class: 'dot', style: color ? `--c:${color}` : '' }),
    h(
      'div',
      { class: 'card-body' },
      h('div', { class: 'card-name' }, w.name),
      h('div', { class: 'card-desc' }, w.description),
      w.sample ? h('div', { class: 'card-sample' }, w.sample) : null,
    ),
    h(
      'button',
      {
        class: 'add-btn',
        type: 'button',
        title: 'Add to selected line',
        'aria-label': `Add ${w.name} to selected line`,
        onPointerdown: (e: Event) => e.stopPropagation(),
        onClick: () => {
          const line = Math.max(0, Math.min(S.selectedLine, S.config.lines.length - 1));
          addWidget(w.type, line, S.config.lines[line]?.length ?? 0);
        },
      },
      icon('plus', 14),
    ),
  );
  card.addEventListener('pointerdown', (e) =>
    press(e, { kind: 'palette', type: w.type, label: w.name, color }, { drop: handleDrop }),
  );
  return card;
}

let previewTimer: number | undefined;
let previewSeq = 0;

function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(runPreview, 120);
}

async function runPreview(): Promise<void> {
  const seq = ++previewSeq;
  try {
    const res = await api.preview(S.config, previewSource(S), S.width);
    if (seq !== previewSeq) return;
    syncHidden(res.hidden ?? []);
    const term = $('term-lines');
    term.classList.remove('error');
    term.innerHTML = res.lines.length
      ? res.lines.map((l) => `<div class="term-line">${ansiToHtml(l) || '&nbsp;'}</div>`).join('')
      : '<div class="term-line term-muted">(no output)</div>';
  } catch (err) {
    if (seq !== previewSeq) return;
    const term = $('term-lines');
    term.classList.add('error');
    term.innerHTML = `<div class="term-line">${escapeHtml((err as Error).message)}</div>`;
  }
}

function applyWidth(): void {
  $('term-screen').style.setProperty('--cols', String(S.width));
  $('width-value').textContent = `${S.width} cols`;
}

function renderChrome(): void {
  const dirty = isDirty();
  const d = $('dirty');
  d.classList.toggle('on', dirty);
  d.querySelector('span')!.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
  $<HTMLButtonElement>('save').disabled = !dirty;
  $<HTMLButtonElement>('undo').disabled = !S.undo.length;
  $<HTMLButtonElement>('redo').disabled = !S.redo.length;
  document.title = `${dirty ? '● ' : ''}ccinfobar editor`;
  $('theme-btn').querySelector('.theme-btn-label')!.textContent = currentTheme()?.name ?? 'Theme';
  const inst = S.api.claude.installed;
  const btn = $('install');
  btn.hidden = inst;
  btn.title = `Will write: ${S.api.claude.defaultCommand}`;
  const status = $('claude-status');
  status.hidden = !inst;
  status.title = `Claude Code runs: ${S.api.claude.statusLine?.command ?? ''}\nSaved changes show up on its next refresh. Settings: Global tab.`;
}

function configBrokenText(): string | null {
  const i = S.api.configIssue;
  return i ? t('editor.configBroken', { line: i.line, column: i.column, message: i.message }) : null;
}

function renderConfigBanner(): void {
  const app = $('app');
  document.getElementById('config-banner')?.remove();
  const text = configBrokenText();
  app.classList.toggle('has-banner', text !== null);
  if (!text) return;
  app.prepend(
    h(
      'div',
      { id: 'config-banner', class: 'config-banner', role: 'alert' },
      icon('alert', 16),
      h('span', null, text),
    ),
  );
}

function issueFrom(err: unknown): { line: number; column: number; message: string } | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.data) return null;
  const { line, column, message } = err.data;
  if (typeof line !== 'number' || typeof column !== 'number' || typeof message !== 'string') return null;
  return { line, column, message };
}

async function save(): Promise<void> {
  const blocked = configBrokenText();
  if (blocked) {
    toast(blocked, 'error');
    return;
  }
  try {
    const before = JSON.parse(S.saved) as Config;
    await api.save(S.config);
    void rememberStyles(before, S.config);
    markSaved();
    toast(
      S.api.claude.installed
        ? 'Saved. Claude Code shows it on its next refresh.'
        : 'Saved. Install in Claude Code to see it there.',
    );
  } catch (err) {
    const issue = issueFrom(err);
    if (issue) {
      S.api.configIssue = issue;
      renderConfigBanner();
      toast(configBrokenText() ?? '', 'error');
      return;
    }
    toast(`Save failed: ${(err as Error).message}`, 'error');
  }
}

function exportJson(): void {
  const blob = new Blob([`${JSON.stringify(S.config, null, 2)}\n`], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'ccinfobar-config.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(): Promise<void> {
  const area = h('textarea', {
    class: 'input mono import-area',
    placeholder: 'Paste a ccinfobar config JSON here',
    rows: 12,
    spellcheck: false,
  });
  const file = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'file-input',
    onChange: async () => {
      const f = file.files?.[0];
      if (f) area.value = await f.text();
    },
  });
  const err = h('div', { class: 'form-error', role: 'alert' });
  await modal({
    title: 'Import config',
    wide: true,
    body: [h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'From file'), file), area, err],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            try {
              const parsed = JSON.parse(area.value) as unknown;
              if (
                typeof parsed !== 'object' ||
                parsed === null ||
                !Array.isArray((parsed as { lines?: unknown }).lines)
              ) {
                throw new Error('Expected an object with a "lines" array');
              }
              const { config } = await api.normalize(parsed);
              replaceAll(config);
              close();
              toast('Config imported. Undo with Ctrl+Z');
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        'Import',
      ),
    ],
  });
}

async function done(): Promise<void> {
  if (
    isDirty() &&
    !(await confirmDialog(
      'Discard unsaved changes?',
      'Closing the editor now will lose your unsaved changes.',
      'Close without saving',
    ))
  ) {
    return;
  }
  window.removeEventListener('beforeunload', onUnload);
  try {
    await api.shutdown();
  } catch {}
  document.body.append(
    h(
      'div',
      { class: 'overlay solid' },
      h(
        'div',
        { class: 'closed' },
        icon('check', 28),
        h('h2', null, 'Editor closed'),
        h('p', null, 'You can close this tab. Run ccinfobar edit to open it again.'),
      ),
    ),
  );
}

function onUnload(e: BeforeUnloadEvent): void {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
}

function inTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'range', 'color', 'file'].includes((el as HTMLInputElement).type);
}

function onKeydown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (document.querySelector('.overlay')) return;
  if (e.key === 'Escape' && S.painting) {
    setPainting(false);
    return;
  }
  if (mod && e.altKey && !inTextField(e.target) && (e.code === 'KeyC' || e.code === 'KeyV')) {
    e.preventDefault();
    if (e.code === 'KeyC') copyStyle();
    else if (S.selectedId) pasteStyle([S.selectedId]);
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
  } else if (mod && e.key.toLowerCase() === 'z' && !inTextField(e.target)) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && e.key.toLowerCase() === 'y' && !inTextField(e.target)) {
    e.preventDefault();
    redo();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !inTextField(e.target)) {
    if (S.selectedId) {
      e.preventDefault();
      removeSelected();
    }
  }
}

function setupStatic(): void {
  for (const [id, name] of [
    ['undo', 'undo'],
    ['redo', 'redo'],
    ['save', 'save'],
    ['theme-btn', 'palette'],
    ['preset-btn', 'layers'],
    ['settings-btn', 'gear'],
    ['import', 'upload'],
    ['export', 'download'],
    ['trash', 'trash'],
    ['add-line', 'plus'],
    ['search-icon', 'search'],
  ] as const) {
    $(id).prepend(icon(name, 16));
  }
  $('version').textContent = `v${S.api.version}`;
  $('config-path').textContent = S.api.configPath;
  $('theme-btn').addEventListener('click', () => void openGallery());
  $('preset-btn').addEventListener('click', () => void openPresets());
  $('settings-btn').addEventListener('click', () => void openSettings());
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('save').addEventListener('click', () => void save());
  $('import').addEventListener('click', () => void importJson());
  $('export').addEventListener('click', exportJson);
  $('install').addEventListener('click', () => void installDialog());
  $('done').addEventListener('click', () => void done());
  $('add-line').addEventListener('click', () => {
    commit(addLine(S.config));
    select(null, S.config.lines.length - 1);
  });
  const search = $<HTMLInputElement>('search');
  search.addEventListener('input', () => {
    S.search = search.value;
    renderPalette();
  });
  const slider = $<HTMLInputElement>('width');
  slider.value = String(S.width);
  slider.addEventListener('input', () => {
    S.width = Number(slider.value);
    try {
      localStorage.setItem(WIDTH_KEY, String(S.width));
    } catch {}
    applyWidth();
    schedulePreview();
  });
  const sample = $<HTMLButtonElement>('src-sample');
  const last = $<HTMLButtonElement>('src-last');
  const scenario = $<HTMLSelectElement>('src-scenario');
  scenario.append(...S.api.scenarios.map((s) => h('option', { value: s.id, title: s.description }, s.label)));
  const setSource = (s: 'sample' | 'last' | 'scenario') => {
    S.source = s;
    S.scenario = s === 'scenario' ? scenario.value : null;
    if (s !== 'scenario') scenario.value = '';
    sample.classList.toggle('on', s === 'sample');
    last.classList.toggle('on', s === 'last');
    sample.setAttribute('aria-pressed', String(s === 'sample'));
    last.setAttribute('aria-pressed', String(s === 'last'));
    schedulePreview();
  };
  sample.addEventListener('click', () => setSource('sample'));
  last.addEventListener('click', () => setSource('last'));
  scenario.addEventListener('change', () => setSource(scenario.value ? 'scenario' : 'sample'));
  last.disabled = !S.api.hasLastPayload;
  last.title = S.api.hasLastPayload
    ? 'Use the last payload Claude Code sent'
    : 'No session payload recorded yet';
  setSource('sample');
  initTerminalPicker($('term-picker'), S.api.terminal);
  initInspector();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onUnload);
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token = params.get('t') ?? sessionStorage.getItem('ccinfobar-token') ?? '';
  if (params.has('t')) {
    sessionStorage.setItem('ccinfobar-token', token);
    history.replaceState(null, '', location.pathname);
  }
  setToken(token);
  try {
    init(await api.state());
  } catch (err) {
    $('boot').innerHTML =
      `<div class="closed"><h2>Cannot reach the editor</h2><p>${escapeHtml((err as Error).message)}. Reopen the URL printed by <code>ccinfobar edit</code>.</p></div>`;
    return;
  }
  $('boot').remove();
  renderConfigBanner();
  if (S.api.configError && !S.api.configIssue) toast(`Config problem: ${S.api.configError}`, 'error');
  setupStatic();
  on('config', (o) => {
    renderCanvas();
    if (o.inspector !== false) renderInspector();
  });
  on('selection', () => {
    renderCanvas();
    renderInspector();
  });
  on('ui', renderChrome);
  on('preview', schedulePreview);
  applyWidth();
  renderPalette();
  renderCanvas();
  renderInspector();
  renderChrome();
  schedulePreview();
  emit('ui');
}

void boot();
