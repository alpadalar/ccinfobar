import {
  addLine,
  insertItem,
  keepLanguage,
  moveItem,
  moveLine,
  removeItem,
  removeLine,
  setLineAlign,
  uniqueId,
} from '../../core/edit.js';
import '../../core/i18n/lazy.js';
import { installBundled } from '../../core/i18n/bundled.js';
import { scenarioText } from '../../core/i18n/catalog-text.js';
import { type LanguageId, language, type MessageId, setLanguage, t } from '../../core/i18n/index.js';
import { pickUiLanguage } from '../../core/i18n/resolve.js';
import { categoryText, widgetText } from '../../core/i18n/widget-text.js';
import { titleWidgets } from '../../core/panel.js';
import type { Config } from '../../core/types.js';
import { ansiToHtml } from './ansi-html.js';
import { ApiError, api, previewSource, setToken } from './api.js';
import { openCatalog } from './catalog.js';
import { colorToCss } from './colors.js';
import { type DragSpec, type DropTarget, press } from './dnd.js';
import { clear, h, icon } from './dom.js';
import { applyStatic, browserLanguages } from './i18n-static.js';
import { initInspector, renderInspector } from './inspector.js';
import { installDialog } from './install-dialog.js';
import { openPresets } from './presets.js';
import { paletteMatches } from './search.js';
import { openSettings } from './settings.js';
import {
  commit,
  currentTheme,
  emit,
  type HiddenWhy,
  init,
  isDirty,
  markSaved,
  on,
  redo,
  replaceAll,
  S,
  select,
  setWidth,
  undo,
  type WidgetInfo,
} from './store.js';
import { chipMenu, copyStyle, paintOnto, pasteStyle, rememberStyles, setPainting } from './styles.js';
import { initTerminalPicker } from './terminal-picker.js';
import { openGallery } from './themes.js';
import { confirmDialog, modal, toast } from './ui.js';

installBundled();

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
  const name = info ? widgetText(info, 'name') : item.type;
  const sample = info ? widgetText(info, 'sample') : '';
  const description = info ? widgetText(info, 'description') : '';
  const label = t('web.app.chipLabel', { name, line: line + 1, position: index + 1 });
  const chip = h(
    'div',
    {
      class: `chip${item.id === S.selectedId ? ' selected' : ''}${item.merge ? ' merged' : ''}${S.config.lines[line]![index - 1]?.merge ? ' merged-in' : ''}${info ? '' : ' unknown'}`,
      tabindex: 0,
      role: 'button',
      'aria-pressed': String(item.id === S.selectedId),
      'aria-label': label + hiddenSuffix(S.hidden.get(item.id)),
      'data-label': label,
      'data-id': id,
      title: info ? (sample ? t('web.app.chipTitle', { description, sample }) : description) : item.type,
    },
    h('i', { class: 'dot', style: color ? `--c:${color}` : '' }),
    h('span', { class: 'chip-name' }, name),
    item.merge ? h('span', { class: 'chip-link', title: t('web.app.merged') }, icon('link', 12)) : null,
    hiddenBadge(S.hidden.get(item.id)),
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

const hiddenText = (why: HiddenWhy) => t(why === 'rule' ? 'vis.hiddenBadge' : 'vis.droppedBadge');
const hiddenSuffix = (why: HiddenWhy | undefined) => (why ? `, ${hiddenText(why)}` : '');

function hiddenBadge(why: HiddenWhy | undefined): HTMLElement | null {
  if (!why) return null;
  const short = t(why === 'rule' ? 'vis.hiddenShort' : 'vis.droppedShort');
  return h('span', { class: 'chip-hidden', title: hiddenText(why), 'data-why': why }, short);
}

function syncHidden(hidden: string[], dropped: string[]): void {
  const drop = new Set(dropped);
  const next = new Map(hidden.map((id): [string, HiddenWhy] => [id, drop.has(id) ? 'priority' : 'rule']));
  if (next.size === S.hidden.size && [...next].every(([id, why]) => S.hidden.get(id) === why)) return;
  S.hidden = next;
  for (const chip of document.querySelectorAll<HTMLElement>('.chip[data-id]')) {
    const badge = chip.querySelector<HTMLElement>('.chip-hidden');
    const why = next.get(chip.dataset.id ?? '');
    if (badge?.dataset.why === why) continue;
    chip.setAttribute('aria-label', (chip.dataset.label ?? '') + hiddenSuffix(why));
    badge?.remove();
    const fresh = hiddenBadge(why);
    if (fresh) chip.append(fresh);
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

const ALIGNED: Record<'left' | 'center' | 'right', MessageId> = {
  left: 'web.app.aligned.left',
  center: 'web.app.aligned.center',
  right: 'web.app.aligned.right',
};
const ALIGN: Record<'left' | 'center' | 'right', MessageId> = {
  left: 'web.app.align.left',
  center: 'web.app.align.center',
  right: 'web.app.align.right',
};

// pressing the active one goes back to the global alignment
function lineAlignButtons(li: number): HTMLElement | null {
  const items = S.config.lines[li] ?? [];
  if ((S.config.style ?? currentTheme()?.style) === 'tui') {
    const tui = S.config.tui ?? {};
    if (tui.breakpoints?.length) return null;
    const shown = titleWidgets(tui);
    if (items.length && items.every((i) => shown.has(i.id) || shown.has(i.type))) {
      return h('span', { class: 'line-note', title: t('web.app.inTitleHelp') }, t('web.app.inTitle'));
    }
  }
  const own = S.config.lineAlign?.[li] ?? null;
  const global = S.config.align ?? 'left';
  return h(
    'div',
    { class: 'line-align', role: 'group', 'aria-label': t('web.app.alignLine', { n: li + 1 }) },
    ...(['left', 'center', 'right'] as const).map((a) =>
      h(
        'button',
        {
          type: 'button',
          class: `icon-btn sm${own === a ? ' on' : !own && global === a ? ' inherit' : ''}`,
          title: t(own === a ? ALIGNED[a] : ALIGN[a]),
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
      h('div', { class: 'canvas-note' }, icon('info', 14), h('span', null, t('web.app.gridNote'))),
    );
  }
  lines.forEach((items, li) => {
    const grip = h(
      'div',
      { class: 'grip', title: t('web.app.dragLine'), 'aria-label': t('web.app.reorderLine', { n: li + 1 }) },
      icon('grip', 14),
    );
    grip.addEventListener('pointerdown', (e) =>
      press(e, { kind: 'row', line: li, label: t('web.app.line', { n: li + 1 }) }, { drop: handleDrop }),
    );
    const row = h(
      'div',
      { class: `line${li === S.selectedLine ? ' selected' : ''}`, 'data-line': String(li) },
      h(
        'div',
        { class: 'line-head' },
        grip,
        h('span', { class: 'line-title' }, t('web.app.line', { n: li + 1 })),
        h('span', { class: 'line-count' }, t('web.app.widgetCount', { count: items.length })),
        lineAlignButtons(li),
        h(
          'button',
          {
            class: 'icon-btn danger sm',
            type: 'button',
            title: t('web.app.deleteLine'),
            'aria-label': t('web.app.deleteLineN', { n: li + 1 }),
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
          : [h('div', { class: 'line-empty' }, t('web.app.lineEmpty'))]),
      ),
    );
    row.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.chip, .grip, button')) return;
      select(null, li);
    });
    canvas.append(row);
  });
  if (!lines.length) {
    canvas.append(h('div', { class: 'canvas-empty' }, t('web.app.noLines')));
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
  const q = S.search.trim();
  let shown = 0;
  for (const cat of S.api.categories) {
    if (cat.id === 'gsd' && !S.api.gsdInstalled) continue;
    const list = S.api.widgets.filter(
      (w) => !w.hidden && w.category === cat.id && paletteMatches(w, cat.id, cat.name, q),
    );
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
      h('span', { class: 'cat-name' }, categoryText(cat.id, cat.name)),
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
  if (!shown)
    host.append(h('div', { class: 'empty-state small' }, t('web.app.noMatch', { query: S.search })));
}

function paletteCard(w: WidgetInfo): HTMLElement {
  const color = colorToCss(w.color);
  const name = widgetText(w, 'name');
  const desc = widgetText(w, 'description');
  const sample = widgetText(w, 'sample');
  const card = h(
    'div',
    { class: 'card', title: desc, 'data-type': w.type },
    h('i', { class: 'dot', style: color ? `--c:${color}` : '' }),
    h(
      'div',
      { class: 'card-body' },
      h('div', { class: 'card-name' }, name),
      h('div', { class: 'card-desc' }, desc),
      sample ? h('div', { class: 'card-sample' }, sample) : null,
    ),
    h(
      'button',
      {
        class: 'add-btn',
        type: 'button',
        title: t('web.app.addToLine'),
        'aria-label': t('web.app.addNamed', { name }),
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
    press(e, { kind: 'palette', type: w.type, label: name, color }, { drop: handleDrop }),
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
    syncHidden(res.hidden ?? [], res.dropped ?? []);
    const term = $('term-lines');
    term.classList.remove('error');
    if (res.lines.length)
      term.innerHTML = res.lines
        .map((l) => `<div class="term-line">${ansiToHtml(l) || '&nbsp;'}</div>`)
        .join('');
    else term.replaceChildren(h('div', { class: 'term-line term-muted' }, t('web.app.noOutput')));
  } catch (err) {
    if (seq !== previewSeq) return;
    const term = $('term-lines');
    term.classList.add('error');
    term.replaceChildren(h('div', { class: 'term-line' }, (err as Error).message));
  }
}

function applyWidth(): void {
  $('term-screen').style.setProperty('--cols', String(S.width));
  $('width-value').textContent = t('web.app.cols', { n: S.width });
}

function renderChrome(): void {
  const dirty = isDirty();
  const d = $('dirty');
  d.classList.toggle('on', dirty);
  d.querySelector('span')!.textContent = dirty ? t('web.app.unsaved') : t('web.app.allSaved');
  $<HTMLButtonElement>('save').disabled = !dirty;
  $<HTMLButtonElement>('undo').disabled = !S.undo.length;
  $<HTMLButtonElement>('redo').disabled = !S.redo.length;
  document.title = `${dirty ? '● ' : ''}${t('web.app.docTitle')}`;
  $('theme-btn').querySelector('.theme-btn-label')!.textContent = currentTheme()?.name ?? t('insp.theme');
  const inst = S.api.claude.installed;
  const btn = $('install');
  btn.hidden = inst;
  btn.title = t('web.app.willWrite', { command: S.api.claude.defaultCommand });
  const status = $('claude-status');
  status.hidden = !inst;
  status.title = t('web.app.claudeRuns', { command: S.api.claude.statusLine?.command ?? '' });
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
    toast(S.api.claude.installed ? t('web.app.saved') : t('web.app.savedInstall'));
  } catch (err) {
    const issue = issueFrom(err);
    if (issue) {
      S.api.configIssue = issue;
      renderConfigBanner();
      toast(configBrokenText() ?? '', 'error');
      return;
    }
    toast(t('web.app.saveFailed', { error: (err as Error).message }), 'error');
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
    placeholder: t('web.app.importPlaceholder'),
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
    title: t('web.app.importTitle'),
    wide: true,
    body: [
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, t('web.app.fromFile')), file),
      area,
      err,
    ],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, t('web.ui.cancel')),
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
                throw new Error(t('web.app.importBad'));
              }
              const { config } = await api.normalize(parsed);
              // a pasted ccinfobar config brings its own language
              replaceAll('language' in parsed ? config : keepLanguage(config, S.config));
              close();
              toast(t('web.app.imported'));
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        t('web.app.import'),
      ),
    ],
  });
}

async function done(): Promise<void> {
  if (
    isDirty() &&
    !(await confirmDialog(t('web.app.discardTitle'), t('web.app.discardText'), t('web.app.discardConfirm')))
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
        h('h2', null, t('web.app.closed')),
        h('p', null, t('web.app.closedHelp')),
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

function renderScenarios(): void {
  const sel = $<HTMLSelectElement>('src-scenario');
  const value = sel.value;
  for (const o of [...sel.querySelectorAll<HTMLOptionElement>('option')]) if (o.value) o.remove();
  sel.append(
    ...S.api.scenarios.map((s) =>
      h('option', { value: s.id, title: scenarioText(s, 'description') }, scenarioText(s, 'label')),
    ),
  );
  sel.value = value;
}

function lastTitle(): void {
  $('src-last').title = S.api.hasLastPayload ? t('web.app.lastPayload') : t('web.app.noPayload');
}

let relabelPicker = () => {};

// config, then this machine's auto answer, then the browser
function uiLanguage(): LanguageId {
  return pickUiLanguage(S.config.language, S.api.language?.id, browserLanguages());
}

function syncLanguage(): boolean {
  const id = uiLanguage();
  if (id === language()) return false;
  setLanguage(id);
  applyStatic(document);
  renderScenarios();
  lastTitle();
  relabelPicker();
  renderConfigBanner();
  applyWidth();
  renderPalette();
  renderCanvas();
  renderInspector();
  renderChrome();
  return true;
}

function bootError(message: string): HTMLElement {
  const [before = '', after = ''] = t('web.static.bootHelp').split('{command}');
  const fill = (s: string) => s.split('{error}').join(message);
  return h(
    'div',
    { class: 'closed' },
    h('h2', null, t('web.static.bootTitle')),
    h('p', null, fill(before), h('code', null, 'ccinfobar edit'), fill(after)),
  );
}

function setupStatic(): void {
  for (const [id, name] of [
    ['undo', 'undo'],
    ['redo', 'redo'],
    ['save', 'save'],
    ['theme-btn', 'palette'],
    ['preset-btn', 'layers'],
    ['catalog-btn', 'grid'],
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
  $('catalog-btn').addEventListener('click', () => void openCatalog());
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
  slider.addEventListener('input', () => setWidth(Number(slider.value)));
  on('width', () => {
    slider.value = String(S.width);
    applyWidth();
    schedulePreview();
  });
  const sample = $<HTMLButtonElement>('src-sample');
  const last = $<HTMLButtonElement>('src-last');
  const scenario = $<HTMLSelectElement>('src-scenario');
  renderScenarios();
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
  lastTitle();
  setSource('sample');
  relabelPicker = initTerminalPicker($('term-picker'), S.api.terminal);
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
    setLanguage(pickUiLanguage(undefined, undefined, browserLanguages()));
    applyStatic(document);
    $('boot').replaceChildren(bootError((err as Error).message));
    return;
  }
  setLanguage(uiLanguage());
  applyStatic(document);
  $('boot').remove();
  renderConfigBanner();
  if (S.api.configError && !S.api.configIssue)
    toast(t('web.app.configProblem', { error: S.api.configError }), 'error');
  setupStatic();
  // undo, presets and import can change it too
  on('config', (o) => {
    if (syncLanguage()) return;
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
