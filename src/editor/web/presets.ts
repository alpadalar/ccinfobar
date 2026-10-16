import { slug } from '../../catalog/model.js';
import { keepLanguage } from '../../core/edit.js';
import { presetLabels, presetText } from '../../core/i18n/catalog-text.js';
import { t } from '../../core/i18n/index.js';
import { ansiToHtml } from './ansi-html.js';
import { api, previewSource } from './api.js';
import { clear, h, icon } from './dom.js';
import { isDirty, type PresetInfo, replaceAll, S } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export { slug };

// escaped ansi html only; the empty note is a text node
export function previewBox(lines: string[] | undefined): HTMLElement {
  if (!lines)
    return h('div', { class: 'theme-preview', innerHTML: '<div class="term-line term-muted">&nbsp;</div>' });
  if (!lines.length) {
    return h(
      'div',
      { class: 'theme-preview' },
      h('div', { class: 'term-line term-muted' }, t('themes.empty')),
    );
  }
  return h('div', {
    class: 'theme-preview',
    innerHTML: lines.map((l) => `<div class="term-line">${ansiToHtml(l) || '&nbsp;'}</div>`).join(''),
  });
}

async function saveCurrent(): Promise<boolean> {
  const name = h('input', {
    class: 'input',
    type: 'text',
    placeholder: t('presets.namePlaceholder'),
    maxLength: 64,
  });
  const desc = h('input', {
    class: 'input',
    type: 'text',
    placeholder: t('presets.descPlaceholder'),
    maxLength: 200,
  });
  const idHint = h('div', { class: 'hint' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const upd = () => {
    const id = slug(name.value);
    const builtin = S.api.presets.some((p) => p.id === id && p.source === 'builtin');
    idHint.textContent = id
      ? t(builtin ? 'presets.savedAsBuiltin' : 'presets.savedAs', { file: `${id}.json` })
      : t('presets.idHint');
  };
  name.addEventListener('input', upd);
  upd();
  const r = await modal<boolean>({
    title: t('presets.saveTitle'),
    body: [
      h('p', { class: 'modal-text' }, t('presets.saveText')),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, t('tb.name')), name, idHint),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, t('tb.description')), desc),
      err,
    ],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, t('web.ui.cancel')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            const id = slug(name.value);
            if (!ID_RE.test(id)) {
              err.textContent = t('presets.needName');
              return;
            }
            try {
              const out = await api.savePreset(
                { id, name: name.value.trim() || id, description: desc.value.trim() },
                S.config,
              );
              S.api.presets = out.presets;
              toast(t('presets.saved', { name: name.value.trim() || id }));
              close(true);
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        t('presets.save'),
      ),
    ],
  });
  return r === true;
}

export async function openPresets(): Promise<void> {
  const grid = h('div', { class: 'gallery-grid preset-grid' });
  const previews = new Map<string, string[]>();
  let version = 0;

  async function apply(p: PresetInfo, close: (v?: unknown) => void) {
    if (
      isDirty() &&
      !(await confirmDialog(
        t('presets.applyTitle', { name: presetText(p, 'name') }),
        t('presets.applyText'),
        t('presets.apply'),
      ))
    )
      return;
    const config = structuredClone(p.config);
    replaceAll(keepLanguage(p.source === 'user' ? config : presetLabels(config), S.config));
    toast(t('presets.applied', { name: presetText(p, 'name') }), 'info');
    close();
  }

  function render(close: (v?: unknown) => void) {
    clear(grid);
    for (const p of S.api.presets) {
      const name = presetText(p, 'name');
      const description = presetText(p, 'description');
      const card = h(
        'div',
        {
          class: 'theme-card',
          role: 'button',
          tabindex: 0,
          'data-preset': p.id,
          title: t('presets.applyName', { name }),
          onClick: () => void apply(p, close),
          onKeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void apply(p, close);
            }
          },
        },
        h(
          'div',
          { class: 'theme-card-head' },
          h('strong', null, name),
          h('span', { class: 'theme-tag' }, t('presets.lines', { count: p.config.lines.length })),
          p.source === 'user' ? h('span', { class: 'theme-tag yours' }, t('insp.yours')) : null,
          h('span', { class: 'spacer' }),
          p.source === 'user'
            ? h(
                'span',
                { class: 'theme-actions' },
                h(
                  'button',
                  {
                    class: 'icon-btn sm danger',
                    type: 'button',
                    title: t('presets.deletePreset'),
                    'aria-label': t('presets.deleteName', { name }),
                    onClick: async (e: Event) => {
                      e.stopPropagation();
                      if (
                        !(await confirmDialog(
                          t('themes.deleteTitle', { name }),
                          t('presets.deleteText'),
                          t('themes.delete'),
                        ))
                      )
                        return;
                      try {
                        S.api.presets = (await api.deletePreset(p.id)).presets;
                        render(close);
                        toast(t('presets.deleted'), 'info');
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
        description ? h('div', { class: 'theme-desc' }, description) : null,
        previewBox(previews.get(p.id)),
      );
      card.addEventListener('pointerdown', (e) => {
        if ((e.target as HTMLElement).closest('button')) e.stopPropagation();
      });
      grid.append(card);
    }
  }

  // columns that fit a card preview
  function fitCols(): number {
    const box = grid.querySelector<HTMLElement>('.theme-preview');
    if (!box) return 96;
    const probe = h('span', { class: 'theme-preview cols-probe' }, '0'.repeat(50));
    document.body.append(probe);
    const ch = probe.getBoundingClientRect().width / 50;
    probe.remove();
    const cs = getComputedStyle(box);
    const inner = box.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
    return ch > 0 ? Math.max(40, Math.floor(inner / ch)) : 96;
  }

  async function loadPreviews(close: (v?: unknown) => void) {
    const v = ++version;
    await new Promise((r) => requestAnimationFrame(r));
    const cols = fitCols();
    await Promise.all(
      S.api.presets.map(async (p) => {
        try {
          const r = await api.preview(
            { ...keepLanguage(p.config, S.config), widthOffset: 0 },
            previewSource(S),
            cols,
          );
          if (v === version) previews.set(p.id, r.lines);
        } catch {}
      }),
    );
    if (v === version) render(close);
  }

  await modal({
    title: t('presets.title'),
    xl: true,
    body: [h('div', { class: 'gallery-bar' }, h('span', { class: 'panel-note' }, t('presets.note'))), grid],
    actions: (close) => {
      render(close);
      void loadPreviews(close);
      return [
        h('span', { class: 'hint footer-hint' }, t('presets.dir', { dir: S.api.presetsDir })),
        h('span', { class: 'spacer' }),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onClick: async () => {
              if (await saveCurrent()) await loadPreviews(close);
            },
          },
          t('presets.saveCurrent'),
        ),
        h('button', { class: 'btn primary', type: 'button', onClick: () => close() }, t('web.settings.done')),
      ];
    },
  });
  version++;
}
