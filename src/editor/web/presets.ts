import { ansiToHtml } from './ansi-html.js';
import { api } from './api.js';
import { clear, h, icon } from './dom.js';
import { isDirty, type PresetInfo, replaceAll, S } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const term = (lines: string[]) =>
  lines.length
    ? lines.map((l) => `<div class="term-line">${ansiToHtml(l) || '&nbsp;'}</div>`).join('')
    : '<div class="term-line term-muted">(empty)</div>';

async function saveCurrent(): Promise<boolean> {
  const name = h('input', { class: 'input', type: 'text', placeholder: 'My layout', maxLength: 64 });
  const desc = h('input', { class: 'input', type: 'text', placeholder: 'What it shows', maxLength: 200 });
  const idHint = h('div', { class: 'hint' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const upd = () => {
    const id = slug(name.value);
    const builtin = S.api.presets.some((p) => p.id === id && p.source === 'builtin');
    idHint.textContent = id
      ? `Saved as ${id}.json${builtin ? ' (replaces the built-in preset)' : ''}`
      : 'Letters, numbers, dot, dash';
  };
  name.addEventListener('input', upd);
  upd();
  const r = await modal<boolean>({
    title: 'Save as preset',
    body: [
      h(
        'p',
        { class: 'modal-text' },
        'Saves your lines, widgets, theme and settings so you can apply them again.',
      ),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Name'), name, idHint),
      h('div', { class: 'field' }, h('label', { class: 'field-label' }, 'Description'), desc),
      err,
    ],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close(false) }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            const id = slug(name.value);
            if (!ID_RE.test(id)) {
              err.textContent = 'Give the preset a name first';
              return;
            }
            try {
              const out = await api.savePreset(
                { id, name: name.value.trim() || id, description: desc.value.trim() },
                S.config,
              );
              S.api.presets = out.presets;
              toast(`Saved preset "${name.value.trim() || id}"`);
              close(true);
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        'Save preset',
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
        `Apply "${p.name}"?`,
        'This replaces your current layout and settings. You can undo it with Ctrl+Z.',
        'Apply preset',
      ))
    )
      return;
    replaceAll(structuredClone(p.config));
    toast(`Applied preset "${p.name}"`, 'info');
    close();
  }

  function render(close: (v?: unknown) => void) {
    clear(grid);
    for (const p of S.api.presets) {
      const card = h(
        'div',
        {
          class: 'theme-card',
          role: 'button',
          tabindex: 0,
          'data-preset': p.id,
          title: `Apply ${p.name}`,
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
          h('strong', null, p.name),
          h(
            'span',
            { class: 'theme-tag' },
            `${p.config.lines.length} ${p.config.lines.length === 1 ? 'line' : 'lines'}`,
          ),
          p.source === 'user' ? h('span', { class: 'theme-tag yours' }, 'yours') : null,
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
                    title: 'Delete preset',
                    'aria-label': `Delete ${p.name}`,
                    onClick: async (e: Event) => {
                      e.stopPropagation();
                      if (
                        !(await confirmDialog(
                          `Delete "${p.name}"?`,
                          'The preset file will be removed.',
                          'Delete',
                        ))
                      )
                        return;
                      try {
                        S.api.presets = (await api.deletePreset(p.id)).presets;
                        render(close);
                        toast('Preset deleted', 'info');
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
        p.description ? h('div', { class: 'theme-desc' }, p.description) : null,
        h('div', {
          class: 'theme-preview',
          innerHTML: previews.has(p.id)
            ? term(previews.get(p.id)!)
            : '<div class="term-line term-muted">&nbsp;</div>',
        }),
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
          const r = await api.preview({ ...p.config, widthOffset: 0 }, S.source, cols);
          if (v === version) previews.set(p.id, r.lines);
        } catch {}
      }),
    );
    if (v === version) render(close);
  }

  await modal({
    title: 'Presets',
    xl: true,
    body: [
      h(
        'div',
        { class: 'gallery-bar' },
        h('span', { class: 'panel-note' }, 'Click a preset to apply it. You can undo.'),
      ),
      grid,
    ],
    actions: (close) => {
      render(close);
      void loadPreviews(close);
      return [
        h('span', { class: 'hint footer-hint' }, `Your presets live in ${S.api.presetsDir}`),
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
          'Save current as preset',
        ),
        h('button', { class: 'btn primary', type: 'button', onClick: () => close() }, 'Done'),
      ];
    },
  });
  version++;
}
