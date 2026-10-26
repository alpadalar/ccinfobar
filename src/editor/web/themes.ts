import { clearColors, hasOwnColors } from '../../core/edit.js';
import { styleText, themeDescription } from '../../core/i18n/catalog-text.js';
import { t } from '../../core/i18n/index.js';
import type { Config } from '../../core/types.js';
import { api, previewSource } from './api.js';
import { clear, h, icon } from './dom.js';
import { previewBox } from './presets.js';
import { commit, currentTheme, rotatedTheme, S, type StyleId, type ThemeInfo } from './store.js';
import { openThemeBuilder } from './theme-builder.js';
import { confirmDialog, modal, toast } from './ui.js';

export function withoutOverrides(config: Config): Config {
  const { style, separator, separatorColor, padding, glyphs, ...rest } = config;
  return rest;
}

export function applyTheme(id: string, useThemeColors = false): void {
  const base = withoutOverrides(S.config);
  commit({ ...(useThemeColors ? clearColors(base) : base), theme: id });
}

// widget colors win over any theme; offer to drop them
export async function askThemeColors(): Promise<boolean> {
  if (!hasOwnColors(S.config)) return false;
  return confirmDialog(
    t('themes.useColorsTitle'),
    t('themes.useColorsText'),
    t('themes.useColors'),
    t('themes.keepColors'),
  );
}

function setThemes(themes: ThemeInfo[]): void {
  S.api.themes = themes;
}

async function editJson(theme: ThemeInfo): Promise<boolean> {
  const { source, ...rest } = theme;
  const { id, ...body } = rest;
  const area = h('textarea', {
    class: 'input mono import-area',
    rows: 18,
    spellcheck: false,
    value: JSON.stringify(body, null, 2),
  });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const r = await modal<boolean>({
    title: t('themes.editJsonTitle', { name: theme.name }),
    wide: true,
    body: [area, err],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, t('web.ui.cancel')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            try {
              const parsed = JSON.parse(area.value) as unknown;
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error(t('themes.expectedObject'));
              }
              const out = await api.saveTheme({ ...(parsed as Record<string, unknown>), id });
              setThemes(out.themes);
              close(true);
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        t('themes.save'),
      ),
    ],
  });
  return r === true;
}

export async function openGallery(): Promise<void> {
  let filter: 'all' | StyleId = 'all';
  let useThemeColors: boolean | null = null;
  let previews: Record<string, string[]> = {};
  let liveLines: string[] = [];
  const grid = h('div', { class: 'gallery-grid' });
  const filters = h('div', { class: 'segmented', role: 'group', 'aria-label': t('themes.filter') });
  const live = h('div', { class: 'gallery-live' });
  let version = 0;

  async function refreshLive() {
    const v = ++version;
    try {
      const r = await api.preview(S.config, previewSource(S), 110);
      if (v === version) {
        liveLines = r.lines;
        renderLive();
      }
    } catch {}
  }

  function renderLive() {
    const rotated = rotatedTheme();
    const th = rotated ?? currentTheme();
    clear(live);
    live.append(
      h(
        'div',
        { class: 'gallery-live-head' },
        h('span', null, t('themes.yourLine')),
        h('span', { class: 'theme-tag' }, th?.name ?? S.config.theme),
        S.config.themeRotation ? h('span', { class: 'theme-tag now' }, t('web.rotation.rotating')) : null,
      ),
      previewBox(liveLines),
    );
  }

  function renderFilters() {
    clear(filters);
    const opts: { id: 'all' | StyleId; name: string }[] = [
      { id: 'all', name: t('themes.all') },
      ...S.api.styles.map((st) => ({ id: st.id, name: styleText(st, 'name') })),
    ];
    for (const o of opts) {
      filters.append(
        h(
          'button',
          {
            type: 'button',
            class: o.id === filter ? 'on' : '',
            'aria-pressed': String(o.id === filter),
            onClick: () => {
              filter = o.id;
              renderFilters();
              renderGrid();
            },
          },
          o.name,
        ),
      );
    }
  }

  function renderGrid() {
    clear(grid);
    const list = S.api.themes.filter((th) => filter === 'all' || th.style === filter);
    if (!list.length) grid.append(h('div', { class: 'empty-state small' }, t('themes.noThemes')));
    for (const th of list) {
      const current = th.id === (S.config.theme || 'classic');
      const card = h(
        'div',
        {
          class: `theme-card${current ? ' current' : ''}`,
          role: 'button',
          tabindex: 0,
          'aria-pressed': String(current),
          'data-theme': th.id,
          title: t('themes.apply', { name: th.name }),
          onClick: async () => {
            if (useThemeColors === null && hasOwnColors(S.config)) useThemeColors = await askThemeColors();
            applyTheme(th.id, useThemeColors ?? false);
            renderGrid();
            void refreshLive();
          },
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              (e.currentTarget as HTMLElement).click();
            }
          },
        },
        h(
          'div',
          { class: 'theme-card-head' },
          h('strong', null, th.name),
          h('span', { class: `theme-tag style-${th.style}` }, th.style),
          th.source === 'user' ? h('span', { class: 'theme-tag yours' }, t('insp.yours')) : null,
          current ? h('span', { class: 'theme-tag now' }, icon('check', 11), t('themes.current')) : null,
          h('span', { class: 'spacer' }),
          th.source === 'user'
            ? h(
                'span',
                { class: 'theme-actions' },
                h(
                  'button',
                  {
                    class: 'icon-btn sm',
                    type: 'button',
                    title: t('themes.editTheme'),
                    'aria-label': t('themes.editName', { name: th.name }),
                    onClick: async (e: Event) => {
                      e.stopPropagation();
                      if (await openThemeBuilder({ edit: th })) {
                        await loadPreviews();
                        void refreshLive();
                      }
                    },
                  },
                  icon('palette', 14),
                ),
                h(
                  'button',
                  {
                    class: 'icon-btn sm',
                    type: 'button',
                    title: t('themes.editJson'),
                    'aria-label': t('themes.editJsonName', { name: th.name }),
                    onClick: async (e: Event) => {
                      e.stopPropagation();
                      if (await editJson(th)) {
                        await loadPreviews();
                        toast(t('themes.updated'));
                      }
                    },
                  },
                  icon('terminal', 14),
                ),
                h(
                  'button',
                  {
                    class: 'icon-btn sm danger',
                    type: 'button',
                    title: t('themes.deleteTheme'),
                    'aria-label': t('themes.deleteName', { name: th.name }),
                    onClick: async (e: Event) => {
                      e.stopPropagation();
                      if (
                        !(await confirmDialog(
                          t('themes.deleteTitle', { name: th.name }),
                          t('themes.deleteText'),
                          t('themes.delete'),
                        ))
                      )
                        return;
                      try {
                        setThemes((await api.deleteTheme(th.id)).themes);
                        renderGrid();
                        void refreshLive();
                        toast(t('themes.deleted'), 'info');
                      } catch (err) {
                        toast((err as Error).message, 'error');
                      }
                    },
                  },
                  icon('trash', 14),
                ),
              )
            : null,
        ),
        h('div', { class: 'theme-desc' }, themeDescription(th)),
        previewBox(previews[th.id]),
      );
      card.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button')) e.stopPropagation();
      });
      grid.append(card);
    }
  }

  async function loadPreviews() {
    try {
      previews = (await api.themePreviews(S.config, previewSource(S), 96)).previews;
    } catch (err) {
      toast(t('themes.previewsFailed', { error: (err as Error).message }), 'error');
    }
    renderGrid();
  }

  renderFilters();
  renderGrid();
  renderLive();
  void loadPreviews();
  void refreshLive();

  await modal({
    title: t('themes.title'),
    xl: true,
    body: [
      live,
      h('div', { class: 'gallery-bar' }, filters, h('span', { class: 'panel-note' }, t('themes.note'))),
      grid,
    ],
    actions: (close) => [
      h('span', { class: 'hint footer-hint' }, t('themes.dir', { dir: S.api.themesDir })),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            const id = await openThemeBuilder({ from: currentTheme(), style: S.config.style });
            if (id) {
              applyTheme(id, await askThemeColors());
              renderFilters();
              await loadPreviews();
              void refreshLive();
            }
          },
        },
        t('insp.newTheme'),
      ),
      h('button', { class: 'btn primary', type: 'button', onClick: () => close() }, t('web.settings.done')),
    ],
  });
  version++;
}
