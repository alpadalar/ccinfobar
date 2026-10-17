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
import {
  dropTargets,
  type ImportTarget,
  importTargets,
  kindText,
  MAX_TARGET_CHARS,
  visibleTarget,
} from '../../importers/confirm.js';
import { api, previewSource } from './api.js';
import { deleteEntryDialog, historyDialog, saveCurrentDialog, toggleShare } from './catalog-dialogs.js';
import { marketplaceSection, publishDialog } from './catalog-market.js';
import { clear, h, icon } from './dom.js';
import { previewBox } from './presets.js';
import { type CatalogEntryInfo, type CatalogState, isDirty, replaceAll, S } from './store.js';
import { askThemeColors } from './themes.js';
import { confirmDialog, modal, toast } from './ui.js';

export type CatalogTab = 'all' | 'user' | 'system' | 'market';
type Section = 'user' | 'system';

export interface CatalogGroup {
  section: Section;
  kind: EntryKind;
  entries: CatalogEntryInfo[];
}

const TABS: readonly CatalogTab[] = ['all', 'user', 'system'];
// the marketplace tab needs an endpoint
const tabsOf = (data: CatalogState): readonly CatalogTab[] => (data.publishable ? [...TABS, 'market'] : TABS);
const WAITING: ReadonlySet<ShareState> = new Set(['pending', 'outdated', 'withdraw-pending']);
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
const GAP = 6;

// previews are asked at full size; cards clip them
function previewCols(root: HTMLElement): number {
  const probe = h('span', { class: 'theme-preview cols-probe' }, '0'.repeat(50));
  document.body.append(probe);
  const ch = probe.getBoundingClientRect().width / 50;
  probe.remove();
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const cols = Math.floor((Math.min(root.clientWidth, 56 * rem) - 1.4 * rem) / ch);
  return ch > 0 && Number.isFinite(cols) ? Math.min(120, Math.max(40, cols)) : 96;
}

function sourceText(e: CatalogEntryInfo): string {
  if (e.source === 'legacy')
    return t(e.kind === 'theme' ? 'catalog.source.themeFile' : 'catalog.source.presetFile');
  return t(e.source === 'user' ? 'catalog.section.user' : 'catalog.section.system');
}

const sectionsOf = (tab: CatalogTab): Section[] =>
  tab === 'all' ? ['user', 'system'] : tab === 'market' ? [] : [tab];

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

const reviewable = (x: ImportTarget) => [...x.target].length <= MAX_TARGET_CHARS;

// as catalog apply in a terminal: every target in full, invisible characters
// named, overlong ones dropped unseen; dropping is the focused default
async function consent(e: CatalogEntryInfo, targets: ImportTarget[]): Promise<'keep' | 'drop' | null> {
  const short = targets.filter(reviewable);
  let drop: HTMLElement | null = null;
  const row = (x: ImportTarget) =>
    reviewable(x)
      ? h(
          'li',
          null,
          h('span', { class: 'theme-tag' }, kindText(x.kind)),
          h('code', { class: 'catalog-consent-target' }, visibleTarget(x.target)),
        )
      : h(
          'li',
          { class: 'catalog-consent-long' },
          t('import.targetLong', { kind: kindText(x.kind), count: [...x.target].length }).trim(),
        );
  const shown = modal<'keep' | 'drop'>({
    title: t('catalog.consent.title', { name: e.name }),
    wide: true,
    body: [
      h('p', { class: 'modal-text' }, t('catalog.consent.text')),
      h('ul', { class: 'catalog-targets catalog-consent' }, ...targets.map(row)),
    ],
    actions: (done) => {
      drop = h(
        'button',
        { class: 'btn primary', type: 'button', onClick: () => done('drop') },
        t('catalog.consent.drop'),
      );
      return [
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onClick: () => done() }, t('web.ui.cancel')),
        short.length
          ? h(
              'button',
              { class: 'btn', type: 'button', onClick: () => done('keep') },
              t('catalog.consent.keep'),
            )
          : null,
        drop,
      ];
    },
  });
  (drop as HTMLElement | null)?.focus();
  return (await shown) ?? null;
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
  let content = e.content;
  let dropped = 0;
  // saved and pre-catalog entries go through consent; built-in ones are known
  if (e.source !== 'system' && e.kind !== 'theme' && content.layout) {
    const targets = importTargets(content.layout);
    if (targets.length) {
      const choice = await consent(e, targets);
      if (!choice) return;
      // overlong targets are never kept
      const gone = choice === 'drop' ? targets : targets.filter((x) => !reviewable(x));
      if (gone.length) {
        content = { ...content, layout: dropTargets(content.layout, gone) };
        dropped = gone.length;
      }
    }
  }
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
  replaceAll(keepLanguage(localize(e, applyCatalogContent(base, content, e.kind, themeId)), S.config));
  toast(
    dropped
      ? t('catalog.consent.dropped', { name: e.name, count: dropped })
      : t('catalog.applied', { name: e.name }),
    'info',
  );
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
  const detailSlots = new Map<string, HTMLElement>();
  const cards = new Map<string, HTMLElement>();
  let peek: HTMLElement | null = null;
  const tabs = h('div', { class: 'tabs catalog-tabs', role: 'tablist', 'aria-label': t('catalog.title') });
  const status = h('span', { class: 'hint catalog-status', role: 'status' });
  const list = h('div', { class: 'catalog-list' });
  let market: HTMLElement | null = null;
  let close: (v?: unknown) => void = () => {};

  function hidePeek() {
    peek?.classList.remove('on');
  }

  function showPeek(e: CatalogEntryInfo, anchor: HTMLElement) {
    const lines = st.previews.get(e.ref);
    if (!lines || st.closed) return;
    if (!peek) {
      peek = h('div', { class: 'catalog-peek', 'aria-hidden': 'true' });
      document.body.append(peek);
    }
    peek.replaceChildren(previewBox(lines));
    peek.style.left = '0px';
    peek.style.top = '0px';
    const at = anchor.getBoundingClientRect();
    const own = peek.getBoundingClientRect();
    const below = at.top + at.height + GAP;
    const top =
      below + own.height <= window.innerHeight - GAP ? below : Math.max(GAP, at.top - GAP - own.height);
    const left = Math.max(8, Math.min(at.left, window.innerWidth - own.width - 8));
    peek.style.left = `${left}px`;
    peek.style.top = `${top}px`;
    peek.classList.add('on');
  }

  // runs before the dialog's own Escape
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || !peek?.classList.contains('on')) return;
    ev.stopPropagation();
    ev.preventDefault();
    hidePeek();
  };

  function pick(tab: CatalogTab) {
    if (tab === st.tab) return;
    st.tab = tab;
    renderTabs();
    renderList();
    void loadPreviews();
  }

  function renderTabs() {
    clear(tabs);
    const all = tabsOf(st.data);
    for (const id of all) {
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
              const next = all[(all.indexOf(id) + step + all.length) % all.length]!;
              pick(next);
              tabs.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
            },
          },
          t(`catalog.tab.${id}`),
        ),
      );
    }
  }

  // re-render from the server's list; changed entries get new previews
  function update(next: CatalogState, focus?: string) {
    const old = new Map(st.data.user.map((e) => [e.ref, JSON.stringify(e.content)]));
    for (const e of next.user) {
      if (old.has(e.ref) && old.get(e.ref) !== JSON.stringify(e.content)) {
        st.previews.delete(e.ref);
        asked.delete(e.ref);
      }
    }
    st.data = next;
    renderList();
    void loadPreviews();
    if (focus) cards.get(focus)?.focus();
  }

  async function act(e: CatalogEntryInfo, run: (e: CatalogEntryInfo) => Promise<CatalogState | null>) {
    hidePeek();
    const next = await run(e);
    if (next && !st.closed) update(next, e.ref);
  }

  function actionButton(cls: string, glyph: string, title: string, label: string, onClick: () => void) {
    return h(
      'button',
      {
        class: `icon-btn sm${cls}`,
        type: 'button',
        title,
        'aria-label': label,
        onClick: (ev: Event) => {
          ev.stopPropagation();
          hidePeek();
          onClick();
        },
      },
      icon(glyph, 14),
    );
  }

  function actions(e: CatalogEntryInfo): HTMLElement {
    const name = e.name;
    const box = h(
      'span',
      { class: 'theme-actions' },
      actionButton(' apply', 'check', t('catalog.apply'), t('catalog.applyName', { name }), () =>
        applyEntry(e, close),
      ),
    );
    if (e.source === 'system') return box;
    const shared = e.share?.wanted ?? false;
    box.append(
      actionButton('', 'clock', t('catalog.action.history'), t('catalog.action.historyName', { name }), () =>
        act(e, historyDialog),
      ),
      shared
        ? actionButton(
            '',
            'upload-off',
            t('catalog.action.unshare'),
            t('catalog.action.unshareName', { name }),
            () => act(e, toggleShare),
          )
        : actionButton('', 'upload', t('catalog.action.share'), t('catalog.action.shareName', { name }), () =>
            act(e, toggleShare),
          ),
      actionButton(
        ' danger',
        'trash',
        t('catalog.action.delete'),
        t('catalog.action.deleteName', { name }),
        () => act(e, deleteEntryDialog),
      ),
    );
    return box;
  }

  function openDetails(e: CatalogEntryInfo) {
    hidePeek();
    const name = e.name;
    const preview = h(
      'div',
      { class: 'catalog-detail-preview', role: 'group', 'aria-label': t('catalog.details.preview') },
      previewBox(st.previews.get(e.ref)),
    );
    detailSlots.set(e.ref, preview);
    let closeBtn: HTMLElement | null = null;
    const shown = modal({
      title: name,
      wide: true,
      body: [
        h(
          'div',
          { class: 'catalog-meta' },
          h('span', { class: 'theme-tag' }, t(`catalog.kind.${e.kind}`)),
          h('span', { class: 'catalog-version' }, t('catalog.version', { version: e.version })),
          h('span', { class: 'theme-tag' }, sourceText(e)),
          e.author ? h('span', { class: 'catalog-author' }, t('catalog.by', { author: e.author })) : null,
          chip(e),
        ),
        e.description ? h('p', { class: 'theme-desc catalog-detail-desc' }, e.description) : null,
        preview,
      ],
      actions: (done) => {
        const run = (fn: (e: CatalogEntryInfo) => Promise<CatalogState | null>) => () => {
          done();
          void act(e, fn);
        };
        const text = (label: string, onClick: () => void) =>
          h('button', { class: 'btn', type: 'button', onClick }, label);
        const shared = e.share?.wanted ?? false;
        closeBtn = text(t('web.ui.close'), () => done());
        return [
          ...(e.source === 'system'
            ? []
            : [
                text(t('catalog.action.history'), run(historyDialog)),
                text(t(shared ? 'catalog.action.unshare' : 'catalog.action.share'), run(toggleShare)),
                text(t('catalog.action.delete'), run(deleteEntryDialog)),
              ]),
          h('span', { class: 'spacer' }),
          closeBtn,
          h(
            'button',
            {
              class: 'btn primary',
              type: 'button',
              onClick: () => {
                done();
                void applyEntry(e, close);
              },
            },
            t('catalog.apply'),
          ),
        ];
      },
    });
    // a space keyup must not apply
    (closeBtn as HTMLElement | null)?.focus();
    void shown.then(() => {
      if (detailSlots.get(e.ref) === preview) detailSlots.delete(e.ref);
    });
  }

  function card(e: CatalogEntryInfo): HTMLElement {
    const slot = h('div', { class: 'catalog-preview catalog-thumb' }, previewBox(st.previews.get(e.ref)));
    slots.set(e.ref, slot);
    slot.addEventListener('pointerenter', (ev) => {
      if (ev.pointerType === 'mouse' || ev.pointerType === 'pen') showPeek(e, slot);
    });
    slot.addEventListener('pointerleave', hidePeek);
    const own = (ev: Event) => ev.target === ev.currentTarget || !ev.currentTarget;
    let armed = false;
    const el = h(
      'div',
      {
        class: 'theme-card catalog-card',
        role: 'button',
        tabindex: 0,
        'data-ref': e.ref,
        'aria-haspopup': 'dialog',
        title: t('catalog.detailsName', { name: e.name }),
        onClick: (ev: Event) => {
          if ((ev.target as HTMLElement | null)?.closest?.('button')) return;
          openDetails(e);
        },
        onKeydown: (ev: KeyboardEvent) => {
          if (!own(ev)) return;
          if (ev.key === 'Enter') {
            ev.preventDefault();
            openDetails(e);
          } else if (ev.key === ' ') {
            ev.preventDefault();
            armed = true;
          }
        },
        // like a native button, space acts on release
        onKeyup: (ev: KeyboardEvent) => {
          if (!own(ev) || ev.key !== ' ' || !armed) return;
          armed = false;
          ev.preventDefault();
          openDetails(e);
        },
        onFocus: () => {
          if (el.matches?.(':focus-visible')) showPeek(e, slot);
        },
        onBlur: () => {
          armed = false;
          hidePeek();
        },
      },
      h(
        'div',
        { class: 'theme-card-head' },
        h('strong', null, e.name),
        h('span', { class: 'spacer' }),
        actions(e),
      ),
      h(
        'div',
        { class: 'catalog-meta' },
        h('span', { class: 'theme-tag' }, t(`catalog.kind.${e.kind}`)),
        h('span', { class: 'catalog-version' }, t('catalog.version', { version: e.version })),
        e.author ? h('span', { class: 'catalog-author' }, t('catalog.by', { author: e.author })) : null,
        chip(e),
        e.source === 'legacy' ? h('span', { class: 'theme-tag' }, sourceText(e)) : null,
      ),
      e.description ? h('div', { class: 'theme-desc' }, e.description) : null,
      slot,
    );
    el.addEventListener('pointerdown', (ev) => {
      if ((ev.target as HTMLElement).closest?.('button')) ev.stopPropagation();
    });
    cards.set(e.ref, el);
    return el;
  }

  function renderList() {
    hidePeek();
    clear(list);
    slots.clear();
    cards.clear();
    if (st.tab === 'market') {
      market ??= marketplaceSection(st.data);
      if (market) list.append(market);
      return;
    }
    if (
      st.tab !== 'system' &&
      !st.data.publishable &&
      st.data.user.some((e) => e.share && WAITING.has(e.share.state))
    )
      list.append(h('p', { class: 'hint catalog-hint' }, t('catalog.noEndpointHint')));
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
    const cols = previewCols(list);
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
            detailSlots.get(ref)?.replaceChildren(previewBox(lines));
          }
        } catch {
          for (const ref of batch) asked.delete(ref);
        }
        if (!--inflight) status.textContent = '';
      }),
    );
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', hidePeek, true);
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
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              const next = await saveCurrentDialog(st.data);
              if (next && !st.closed) update(next);
            },
          },
          t('catalog.saveCurrent'),
        ),
        st.data.publishable
          ? h(
              'button',
              {
                class: 'btn',
                type: 'button',
                title: t('catalog.publish.title'),
                onClick: async () => {
                  const next = await publishDialog(st.data);
                  if (!next || st.closed) return;
                  market = null;
                  update(next);
                },
              },
              t('catalog.publish.open'),
            )
          : null,
        h('button', { class: 'btn primary', type: 'button', onClick: () => done() }, t('web.settings.done')),
      ];
    },
  });
  st.closed = true;
  st.version++;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', hidePeek, true);
  (peek as HTMLElement | null)?.remove();
}
