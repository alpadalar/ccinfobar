import {
  applyStyle,
  findItem,
  recordStyles,
  STYLE_GROUPS,
  type StyleGroup,
  type StyleSnapshot,
  sameStyle,
  takeStyle,
} from '../../core/edit.js';
import type { Config } from '../../core/types.js';
import { api } from './api.js';
import { colorToCss } from './colors.js';
import { h, icon } from './dom.js';
import { commit, emit, S } from './store.js';
import { toast } from './ui.js';

const supported = (type: string) => (S.widgetMap.get(type)?.options ?? []).map((o) => o.key);
const nameOf = (type: string) => S.widgetMap.get(type)?.name ?? type;

export function copyStyle(id: string | null = S.selectedId): void {
  const found = id ? findItem(S.config, id) : null;
  if (!found) return;
  S.clip = { snap: takeStyle(found.item), from: nameOf(found.item.type), type: found.item.type };
  toast(`Copied the style of ${S.clip.from}`, 'info');
  emit('selection');
}

export function pasteStyle(ids: string[], groups: StyleGroup[] = S.groups): void {
  if (!S.clip || !ids.length) return;
  if (!groups.length) {
    toast('Pick what to paste first', 'error');
    return;
  }
  commit(applyStyle(S.config, ids, S.clip.snap, groups, supported));
}

export function setPainting(on: boolean): void {
  if (on && !S.clip) copyStyle();
  if (on && !S.clip) return;
  S.painting = on;
  document.body.classList.toggle('painting', on);
  if (on) toast('Click widgets to paint the style. Esc to stop.', 'info');
  emit('selection');
}

export function paintOnto(id: string): void {
  pasteStyle([id]);
}

// swatch showing a look
export function styleSample(snap: StyleSnapshot, label = 'Aa'): HTMLElement {
  const fg = colorToCss(snap.color);
  const bg = colorToCss(snap.background);
  const css = [
    fg ? `color:${fg}` : '',
    bg ? `background:${bg}` : '',
    snap.bold ? 'font-weight:700' : '',
    snap.italic ? 'font-style:italic' : '',
    snap.dim ? 'opacity:.6' : '',
  ]
    .filter(Boolean)
    .join(';');
  return h('span', { class: 'style-sample', style: css }, label);
}

export function describeStyle(snap: StyleSnapshot): string {
  const parts = [
    snap.color ? `text ${snap.color}` : '',
    snap.background ? `background ${snap.background}` : '',
    ...(['bold', 'dim', 'italic'] as const).filter((k) => snap[k]),
    ...Object.entries(snap.options ?? {}).map(([k, v]) => `${k} ${v}`),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'theme defaults';
}

const QUICK: { label: string; groups: StyleGroup[] }[] = [
  { label: 'Colors', groups: ['colors'] },
  { label: 'Colors + text', groups: ['colors', 'text'] },
  { label: 'All', groups: ['colors', 'text', 'bars', 'label'] },
];

export function styleTools(id: string): HTMLElement {
  const btn = (
    label: string,
    title: string,
    iconName: string,
    onClick: () => void,
    on = false,
    disabled = false,
  ) =>
    h(
      'button',
      { class: `btn sm${on ? ' on' : ''}`, type: 'button', title, disabled, onClick },
      icon(iconName, 14),
      label,
    );
  const wrap = h(
    'div',
    { class: 'style-tools' },
    h(
      'div',
      { class: 'row-inline' },
      btn('Copy', 'Copy style (Ctrl+Alt+C)', 'copy', () => copyStyle(id)),
      btn('Paste', 'Paste style (Ctrl+Alt+V)', 'paste', () => pasteStyle([id]), false, !S.clip),
      btn(
        'Paint',
        'Click other widgets to give them this style (Esc to stop)',
        'brush',
        () => setPainting(!S.painting),
        S.painting,
      ),
    ),
  );
  if (!S.clip) return wrap;
  const same = (g: StyleGroup[]) => g.length === S.groups.length && g.every((x) => S.groups.includes(x));
  wrap.append(
    h(
      'div',
      { class: 'clip' },
      h('div', { class: 'clip-head' }, styleSample(S.clip.snap), h('span', null, `From ${S.clip.from}`)),
      h(
        'div',
        { class: 'clip-quick' },
        ...QUICK.map((q) =>
          h(
            'button',
            {
              type: 'button',
              class: `chip-toggle${same(q.groups) ? ' on' : ''}`,
              onClick: () => {
                S.groups = [...q.groups];
                emit('selection');
              },
            },
            q.label,
          ),
        ),
      ),
      h(
        'div',
        { class: 'clip-groups' },
        ...STYLE_GROUPS.map((g) =>
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: S.groups.includes(g.id),
              onChange: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                S.groups = on ? [...S.groups, g.id] : S.groups.filter((x) => x !== g.id);
                emit('selection');
              },
            }),
            g.name,
          ),
        ),
      ),
    ),
  );
  return wrap;
}

export function recentStyles(id: string): HTMLElement | null {
  const found = findItem(S.config, id);
  const list = (S.api.styleHistory[id] ?? []).filter((s) => !found || !sameStyle(s, takeStyle(found.item)));
  if (!list.length) return null;
  return h(
    'div',
    { class: 'recent-styles' },
    ...list.map((snap) =>
      h(
        'button',
        {
          type: 'button',
          class: 'recent-style',
          title: `Use this earlier style: ${describeStyle(snap)}`,
          onClick: () =>
            commit(applyStyle(S.config, [id], snap, ['colors', 'text', 'bars', 'label'], supported)),
        },
        styleSample(snap),
        h('span', null, describeStyle(snap)),
      ),
    ),
  );
}

export async function rememberStyles(before: Config, after: Config): Promise<void> {
  const next = recordStyles(S.api.styleHistory, before, after);
  if (JSON.stringify(next) === JSON.stringify(S.api.styleHistory)) return;
  S.api.styleHistory = next;
  try {
    await api.saveStyles(next);
  } catch {}
}

let menu: HTMLElement | null = null;

function closeMenu() {
  menu?.remove();
  menu = null;
  window.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('keydown', esc, true);
  window.removeEventListener('blur', closeMenu);
}

function outside(e: Event) {
  if (menu && !menu.contains(e.target as Node)) closeMenu();
}

function esc(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeMenu();
  }
}

export function chipMenu(e: MouseEvent, id: string, line: number): void {
  e.preventDefault();
  closeMenu();
  const lineIds = S.config.lines[line]?.map((i) => i.id) ?? [];
  const item = (label: string, run: () => void, disabled = false) =>
    h(
      'button',
      {
        type: 'button',
        class: 'menu-item',
        disabled,
        onClick: () => {
          closeMenu();
          run();
        },
      },
      label,
    );
  menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    item('Copy style', () => copyStyle(id)),
    item('Paste style', () => pasteStyle([id]), !S.clip),
    item('Paste style to whole line', () => pasteStyle(lineIds), !S.clip),
    item('Paint other widgets…', () => {
      copyStyle(id);
      setPainting(true);
    }),
    h('div', { class: 'menu-sep' }),
    item('Reset to theme look', () => commit(applyStyle(S.config, [id], {}, ['colors', 'text']))),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', esc, true);
  window.addEventListener('blur', closeMenu);
}
