import type { Config } from '../../core/types.js';
import { ansiToHtml } from './ansi-html.js';
import { api } from './api.js';
import { clear, h, icon } from './dom.js';
import { commit, currentTheme, S, type StyleId, type ThemeInfo } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function withoutOverrides(config: Config): Config {
  const { style, separator, separatorColor, padding, glyphs, ...rest } = config;
  return rest;
}

export function applyTheme(id: string): void {
  commit({ ...withoutOverrides(S.config), theme: id });
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function setThemes(themes: ThemeInfo[]): void {
  S.api.themes = themes;
}

async function saveAs(): Promise<string | null> {
  const base = currentTheme();
  const name = h('input', {
    class: 'input',
    type: 'text',
    placeholder: 'My theme',
    spellcheck: false,
    maxLength: 64,
  });
  const desc = h('input', {
    class: 'input',
    type: 'text',
    placeholder: `Based on ${base?.name ?? 'Classic'}`,
  });
  const idHint = h('div', { class: 'hint' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const upd = () => {
    const id = slug(name.value);
    idHint.textContent = id
      ? `Saved as ${id}.json${S.api.themes.some((t) => t.id === id && t.source === 'builtin') ? ' (overrides the built-in theme)' : ''}`
      : 'Letters, numbers, dot, dash';
  };
  name.addEventListener('input', upd);
  upd();
  return (
    (await modal<string>({
      title: 'Save as my theme',
      body: [
        h(
          'p',
          { class: 'modal-text' },
          'Creates a theme from the current one including your style, separator and glyph overrides.',
        ),
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Name'), name, idHint),
        h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Description'), desc),
        err,
      ],
      actions: (close) => [
        h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onClick: async () => {
              const id = slug(name.value);
              if (!ID_RE.test(id)) {
                err.textContent = 'Give the theme a name first';
                return;
              }
              try {
                const r = await api.saveTheme(
                  { id, name: name.value.trim() || id, description: desc.value.trim() },
                  S.config,
                );
                setThemes(r.themes);
                applyTheme(id);
                toast(`Saved theme "${name.value.trim() || id}"`);
                close(id);
              } catch (e) {
                err.textContent = (e as Error).message;
              }
            },
          },
          'Save theme',
        ),
      ],
    })) ?? null
  );
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
    title: `Edit ${theme.name} (JSON)`,
    wide: true,
    body: [area, err],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            try {
              const parsed = JSON.parse(area.value) as unknown;
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('Expected a JSON object');
              }
              const out = await api.saveTheme({ ...(parsed as Record<string, unknown>), id });
              setThemes(out.themes);
              close(true);
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        'Save',
      ),
    ],
  });
  return r === true;
}

export async function openGallery(): Promise<void> {
  let filter: 'all' | StyleId = 'all';
  let previews: Record<string, string[]> = {};
  let liveLines: string[] = [];
  const grid = h('div', { class: 'gallery-grid' });
  const filters = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Filter by style' });
  const live = h('div', { class: 'gallery-live' });
  let version = 0;

  const term = (lines: string[]) =>
    lines.length
      ? lines.map((l) => `<div class="term-line">${ansiToHtml(l) || '&nbsp;'}</div>`).join('')
      : '<div class="term-line term-muted">(empty)</div>';

  async function refreshLive() {
    const v = ++version;
    try {
      const r = await api.preview(S.config, S.source, 110);
      if (v === version) {
        liveLines = r.lines;
        renderLive();
      }
    } catch {}
  }

  function renderLive() {
    const t = currentTheme();
    clear(live);
    live.append(
      h(
        'div',
        { class: 'gallery-live-head' },
        h('span', null, 'Your status line'),
        h('span', { class: 'theme-tag' }, t?.name ?? S.config.theme),
      ),
      h('div', { class: 'theme-preview', innerHTML: term(liveLines) }),
    );
  }

  function renderFilters() {
    clear(filters);
    const opts: { id: 'all' | StyleId; name: string }[] = [{ id: 'all', name: 'All' }, ...S.api.styles];
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
    const list = S.api.themes.filter((t) => filter === 'all' || t.style === filter);
    if (!list.length) grid.append(h('div', { class: 'empty-state small' }, 'No themes in this style yet'));
    for (const t of list) {
      const current = t.id === (S.config.theme || 'classic');
      const card = h(
        'div',
        {
          class: `theme-card${current ? ' current' : ''}`,
          role: 'button',
          tabindex: 0,
          'aria-pressed': String(current),
          'data-theme': t.id,
          title: `Apply ${t.name}`,
          onClick: () => {
            applyTheme(t.id);
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
          h('strong', null, t.name),
          h('span', { class: `theme-tag style-${t.style}` }, t.style),
          t.source === 'user' ? h('span', { class: 'theme-tag yours' }, 'yours') : null,
          current ? h('span', { class: 'theme-tag now' }, icon('check', 11), 'current') : null,
          h('span', { class: 'spacer' }),
          t.source === 'user'
            ? h(
                'span',
                { class: 'theme-actions' },
                h(
                  'button',
                  {
                    class: 'icon-btn sm',
                    type: 'button',
                    title: 'Edit JSON',
                    'aria-label': `Edit ${t.name} JSON`,
                    onClick: async (e: Event) => {
                      e.stopPropagation();
                      if (await editJson(t)) {
                        await loadPreviews();
                        toast('Theme updated');
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
                    title: 'Delete theme',
                    'aria-label': `Delete ${t.name}`,
                    onClick: async (e: Event) => {
                      e.stopPropagation();
                      if (
                        !(await confirmDialog(
                          `Delete "${t.name}"?`,
                          'The theme file will be removed.',
                          'Delete',
                        ))
                      )
                        return;
                      try {
                        setThemes((await api.deleteTheme(t.id)).themes);
                        renderGrid();
                        void refreshLive();
                        toast('Theme deleted', 'info');
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
        h('div', { class: 'theme-desc' }, t.description),
        h('div', {
          class: 'theme-preview',
          innerHTML: previews[t.id]
            ? term(previews[t.id]!)
            : '<div class="term-line term-muted">&nbsp;</div>',
        }),
      );
      card.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button')) e.stopPropagation();
      });
      grid.append(card);
    }
  }

  async function loadPreviews() {
    try {
      previews = (await api.themePreviews(S.config, S.source, 96)).previews;
    } catch (err) {
      toast(`Previews failed: ${(err as Error).message}`, 'error');
    }
    renderGrid();
  }

  renderFilters();
  renderGrid();
  renderLive();
  void loadPreviews();
  void refreshLive();

  await modal({
    title: 'Themes',
    xl: true,
    body: [
      live,
      h(
        'div',
        { class: 'gallery-bar' },
        filters,
        h(
          'span',
          { class: 'panel-note' },
          'Click a theme to apply it. Overrides are cleared and you can undo.',
        ),
      ),
      grid,
    ],
    actions: (close) => [
      h('span', { class: 'hint footer-hint' }, `Your themes live in ${S.api.themesDir}`),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onClick: async () => {
            if (await saveAs()) {
              renderFilters();
              await loadPreviews();
              void refreshLive();
            }
          },
        },
        'Save current as my theme',
      ),
      h('button', { class: 'btn primary', type: 'button', onClick: () => close() }, 'Done'),
    ],
  });
  version++;
}

export { saveAs };
