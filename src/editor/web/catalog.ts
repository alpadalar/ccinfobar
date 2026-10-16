import '../../core/i18n/lazy.js';
import type { ShareState } from '../../catalog/model.js';
import {
  applyCatalogContent,
  clearColors,
  type EntryKind,
  hasOwnColors,
  keepLanguage,
} from '../../core/edit.js';
import { presetLabels } from '../../core/i18n/catalog-text.js';
import { type MessageId, t } from '../../core/i18n/index.js';
import type { Config } from '../../core/types.js';
import { api, previewSource } from './api.js';
import { clear, h } from './dom.js';
import { fitCols, previewBox } from './presets.js';
import { type CatalogEntryInfo, type CatalogState, isDirty, replaceAll, S } from './store.js';
import { askThemeColors } from './themes.js';
import { confirmDialog, modal, toast } from './ui.js';

export type CatalogTab = 'all' | 'user' | 'system';
type Section = 'user' | 'system';

export interface CatalogGroup {
  section: Section;
  kind: EntryKind;
  entries: CatalogEntryInfo[];
}

const TABS: readonly CatalogTab[] = ['all', 'user', 'system'];
const KINDS: readonly EntryKind[] = ['bundle', 'preset', 'theme'];
const GROUP: Record<EntryKind, MessageId> = {
  bundle: 'catalog.group.bundles',
  preset: 'catalog.group.presets',
  theme: 'catalog.group.themes',
};
const STATE: Record<ShareState, MessageId> = {
  local: 'catalog.share.local',
  pending: 'catalog.share.pending',
  published: 'catalog.share.published',
  outdated: 'catalog.share.outdated',
  'withdraw-pending': 'catalog.share.withdrawPending',
  withdrawn: 'catalog.share.withdrawn',
};
const BATCH = 100;

const sectionsOf = (tab: CatalogTab): Section[] => (tab === 'all' ? ['user', 'system'] : [tab]);

export function groupEntries(data: CatalogState, tab: CatalogTab): CatalogGroup[] {
  const out: CatalogGroup[] = [];
  for (const section of sectionsOf(tab)) {
    for (const kind of KINDS) {
      const entries = data[section].filter((e) => e.kind === kind);
      if (entries.length) out.push({ section, kind, entries });
    }
  }
  return out;
}

function themeBase(e: CatalogEntryInfo): string {
  const own = e.content.theme?.id;
  if (typeof own === 'string' && own) return own;
  const app = e.content.appearance?.theme;
  return typeof app === 'string' ? app : '';
}

// built-in layouts carry English labels
function localize(e: CatalogEntryInfo, config: Config): Config {
  return e.source === 'system' && e.kind !== 'theme' ? presetLabels(config) : config;
}

export async function applyEntry(e: CatalogEntryInfo, close: (v?: unknown) => void): Promise<void> {
  if (
    isDirty() &&
    !(await confirmDialog(
      t('catalog.applyTitle', { name: e.name }),
      t('catalog.applyText'),
      t('catalog.apply'),
    ))
  )
    return;
  let base = S.config;
  if (e.kind === 'theme' && hasOwnColors(base) && (await askThemeColors())) base = clearColors(base);
  let themeId: string | undefined;
  if (e.kind !== 'preset' && e.content.theme) {
    try {
      const r = await api.catalogInstallTheme(e.ref);
      S.api.themes = r.themes;
      themeId = r.theme?.id;
      if (r.theme?.renamed) toast(t('catalog.themeRenamed', { id: themeBase(e), newId: r.theme.id }), 'info');
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
  }
  replaceAll(keepLanguage(localize(e, applyCatalogContent(base, e.content, e.kind, themeId)), S.config));
  toast(t('catalog.applied', { name: e.name }), 'info');
  close();
}

function chip(e: CatalogEntryInfo): HTMLElement | null {
  if (!e.share) return null;
  const state = e.share.state;
  const version = state === 'published' ? (e.remote?.version ?? e.version) : e.version;
  return h('span', { class: `catalog-chip ${state}` }, t(STATE[state], { version }));
}

export async function openCatalog(): Promise<void> {
  let data: CatalogState;
  try {
    data = await api.catalog();
  } catch (err) {
    toast((err as Error).message, 'error');
    return;
  }
  const st = {
    tab: 'all' as CatalogTab,
    data,
    previews: new Map<string, string[]>(),
    version: 0,
    closed: false,
  };
  const asked = new Set<string>();
  let inflight = 0;
  const slots = new Map<string, HTMLElement>();
  const tabs = h('div', { class: 'tabs catalog-tabs', role: 'tablist', 'aria-label': t('catalog.title') });
  const status = h('span', { class: 'hint catalog-status', role: 'status' });
  const list = h('div', { class: 'catalog-list' });
  let close: (v?: unknown) => void = () => {};

  function pick(tab: CatalogTab) {
    if (tab === st.tab) return;
    st.tab = tab;
    renderTabs();
    renderList();
    void loadPreviews();
  }

  function renderTabs() {
    clear(tabs);
    for (const id of TABS) {
      const on = id === st.tab;
      tabs.append(
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: on ? 'on' : '',
            'aria-selected': String(on),
            tabindex: on ? 0 : -1,
            'data-tab': id,
            onClick: () => pick(id),
            onKeydown: (ev: KeyboardEvent) => {
              const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              ev.preventDefault();
              const next = TABS[(TABS.indexOf(id) + step + TABS.length) % TABS.length]!;
              pick(next);
              tabs.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
            },
          },
          t(`catalog.tab.${id}`),
        ),
      );
    }
  }

  function card(e: CatalogEntryInfo): HTMLElement {
    const slot = h('div', { class: 'catalog-preview' }, previewBox(st.previews.get(e.ref)));
    slots.set(e.ref, slot);
    const el = h(
      'div',
      {
        class: 'theme-card',
        role: 'button',
        tabindex: 0,
        'data-ref': e.ref,
        title: t('catalog.applyName', { name: e.name }),
        onClick: () => void applyEntry(e, close),
        onKeydown: (ev: KeyboardEvent) => {
          if (ev.target !== ev.currentTarget && ev.currentTarget) return;
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            void applyEntry(e, close);
          }
        },
      },
      h(
        'div',
        { class: 'theme-card-head' },
        h('strong', null, e.name),
        h('span', { class: 'theme-tag' }, t(`catalog.kind.${e.kind}`)),
        h('span', { class: 'catalog-version' }, t('catalog.version', { version: e.version })),
        e.author ? h('span', { class: 'catalog-author' }, t('catalog.by', { author: e.author })) : null,
        chip(e),
        e.source === 'legacy' ? h('span', { class: 'theme-tag' }, t('catalog.source.legacy')) : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'theme-actions' }),
      ),
      e.description ? h('div', { class: 'theme-desc' }, e.description) : null,
      slot,
    );
    el.addEventListener('pointerdown', (ev) => {
      if ((ev.target as HTMLElement).closest?.('button')) ev.stopPropagation();
    });
    return el;
  }

  function renderList() {
    clear(list);
    slots.clear();
    const groups = groupEntries(st.data, st.tab);
    for (const section of sectionsOf(st.tab)) {
      const own = groups.filter((g) => g.section === section);
      if (!own.length && section === 'system') continue;
      const box = h('section', { class: 'catalog-section', 'data-section': section });
      if (st.tab === 'all')
        box.append(h('h3', { class: 'catalog-section-head' }, t(`catalog.section.${section}`)));
      if (!own.length) box.append(h('div', { class: 'empty-state small' }, t('catalog.empty.user')));
      for (const g of own) {
        box.append(
          h('h4', { class: 'catalog-group-head' }, t(GROUP[g.kind])),
          h('div', { class: 'gallery-grid preset-grid' }, ...g.entries.map(card)),
        );
      }
      list.append(box);
    }
  }

  const visible = () => groupEntries(st.data, st.tab).flatMap((g) => g.entries.map((e) => e.ref));

  async function loadPreviews() {
    const v = ++st.version;
    await new Promise((r) => requestAnimationFrame(r));
    if (st.closed || v !== st.version) return;
    const refs = visible().filter((r) => !st.previews.has(r) && !asked.has(r));
    if (!refs.length) return;
    for (const r of refs) asked.add(r);
    const cols = fitCols(list);
    const batches: string[][] = [];
    for (let i = 0; i < refs.length; i += BATCH) batches.push(refs.slice(i, i + BATCH));
    await Promise.all(
      batches.map(async (batch) => {
        inflight++;
        status.textContent = t('catalog.loading');
        try {
          const r = await api.catalogPreviews(S.config, previewSource(S), cols, batch);
          for (const ref of batch) {
            const lines = r.previews[ref];
            if (!lines || st.closed) continue;
            st.previews.set(ref, lines);
            slots.get(ref)?.replaceChildren(previewBox(lines));
          }
        } catch {
          for (const ref of batch) asked.delete(ref);
        }
        if (!--inflight) status.textContent = '';
      }),
    );
  }

  await modal({
    title: t('catalog.title'),
    xl: true,
    body: [h('div', { class: 'gallery-bar catalog-bar' }, tabs, status), list],
    actions: (done) => {
      close = done;
      renderTabs();
      renderList();
      void loadPreviews();
      return [
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', type: 'button', onClick: () => done() }, t('web.settings.done')),
      ];
    },
  });
  st.closed = true;
  st.version++;
}
