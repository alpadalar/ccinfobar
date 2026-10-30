import {
  applyStyle,
  boundStyles,
  findItem,
  recordStyles,
  STYLE_GROUPS,
  type StyleGroup,
  type StyleSnapshot,
  sameStyle,
  takeStyle,
} from '../../core/edit.js';
import { styleGroupName } from '../../core/i18n/catalog-text.js';
import { type MessageId, t } from '../../core/i18n/index.js';
import { widgetText } from '../../core/i18n/widget-text.js';
import type { Config } from '../../core/types.js';
import { api } from './api.js';
import { colorToCss } from './colors.js';
import { h, icon } from './dom.js';
import { commit, emit, S } from './store.js';
import { toast } from './ui.js';

const supported = (type: string) => (S.widgetMap.get(type)?.options ?? []).map((o) => o.key);
const nameOf = (type: string) => {
  const def = S.widgetMap.get(type);
  return def ? widgetText(def, 'name') : type;
};

export function copyStyle(id: string | null = S.selectedId): void {
  const found = id ? findItem(S.config, id) : null;
  if (!found) return;
  S.clip = { snap: takeStyle(found.item), from: nameOf(found.item.type), type: found.item.type };
  toast(t('styles.copied', { name: S.clip.from }), 'info');
  emit('selection');
}

export function pasteStyle(ids: string[], groups: StyleGroup[] = S.groups): void {
  if (!S.clip || !ids.length) return;
  if (!groups.length) {
    toast(t('styles.pickGroups'), 'error');
    return;
  }
  commit(applyStyle(S.config, ids, S.clip.snap, groups, supported));
}

export function setPainting(on: boolean): void {
  if (on && !S.clip) copyStyle();
  if (on && !S.clip) return;
  S.painting = on;
  document.body.classList.toggle('painting', on);
  if (on) toast(t('styles.painting'), 'info');
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
    snap.color ? t('styles.descText', { color: snap.color }) : '',
    snap.background ? t('styles.descBackground', { color: snap.background }) : '',
    ...(['bold', 'dim', 'italic'] as const).filter((k) => snap[k]).map((k) => t(`styles.${k}`)),
    ...Object.entries(snap.options ?? {}).map(([k, v]) => `${k} ${v}`),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : t('styles.themeDefaults');
}

const QUICK: { label: MessageId; groups: StyleGroup[] }[] = [
  { label: 'styles.quickColors', groups: ['colors'] },
  { label: 'styles.quickColorsText', groups: ['colors', 'text'] },
  { label: 'styles.quickAll', groups: ['colors', 'text', 'bars', 'label'] },
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
      btn(t('styles.copy'), t('styles.copyTitle'), 'copy', () => copyStyle(id)),
      btn(t('styles.paste'), t('styles.pasteTitle'), 'paste', () => pasteStyle([id]), false, !S.clip),
      btn(t('styles.paint'), t('styles.paintTitle'), 'brush', () => setPainting(!S.painting), S.painting),
    ),
  );
  if (!S.clip) return wrap;
  const same = (g: StyleGroup[]) => g.length === S.groups.length && g.every((x) => S.groups.includes(x));
  wrap.append(
    h(
      'div',
      { class: 'clip' },
      h(
        'div',
        { class: 'clip-head' },
        styleSample(S.clip.snap),
        h('span', null, t('styles.from', { name: nameOf(S.clip.type) })),
      ),
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
            t(q.label),
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
            styleGroupName(g),
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
          title: t('styles.useEarlier', { style: describeStyle(snap) }),
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
  const prev = S.api.styleHistory;
  const next = boundStyles(recordStyles(prev, before, after), after);
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  S.api.styleHistory = next;
  try {
    await api.saveStyles(next);
  } catch {
    if (S.api.styleHistory === next) S.api.styleHistory = prev;
    toast(t('styles.saveFailed'), 'error');
  }
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
    item(t('styles.menuCopy'), () => copyStyle(id)),
    item(t('styles.menuPaste'), () => pasteStyle([id]), !S.clip),
    item(t('styles.menuPasteLine'), () => pasteStyle(lineIds), !S.clip),
    item(t('styles.menuPaint'), () => {
      copyStyle(id);
      setPainting(true);
    }),
    h('div', { class: 'menu-sep' }),
    item(t('styles.menuReset'), () => commit(applyStyle(S.config, [id], {}, ['colors', 'text']))),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  window.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', esc, true);
  window.addEventListener('blur', closeMenu);
}
