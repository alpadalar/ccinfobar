import { styleText, themeDescription } from '../../core/i18n/catalog-text.js';
import { t } from '../../core/i18n/index.js';
import { categoryText } from '../../core/i18n/widget-text.js';
import { ID_RE } from '../../core/ids.js';
import { ansiToHtml } from './ansi-html.js';
import { api, previewSource } from './api.js';
import { colorToCss, isValidColor } from './colors.js';
import { clear, h, icon } from './dom.js';
import { field, numberInput, segmented, textInput, toggle } from './inspector.js';
import { slug } from './presets.js';
import { S, type StyleId, type ThemeInfo } from './store.js';
import { modal, toast } from './ui.js';

type Swatch = string | { fg?: string; bg?: string };
type Mode = 'widget' | 'category' | 'cycle';

interface Colors {
  mode: Mode;
  fg: string;
  bg: string;
  on: string;
  muted: string;
  categories: Record<string, Swatch>;
  cycle: Swatch[];
}

const SLOTS = [
  'session',
  'context',
  'tokens',
  'cost',
  'limits',
  'gsd',
  'git',
  'workspace',
  'system',
  'custom',
  'charts',
  'agents',
  'fun',
];
const BLOCKY = new Set<StyleId>(['blocks', 'powerline', 'capsule']);
const MAX_STOPS = 8;

const fgOf = (s: Swatch | undefined) => (typeof s === 'object' ? s.fg : s);
const bgOf = (s: Swatch | undefined) => (typeof s === 'object' ? s.bg : undefined);

function colorsOf(th: ThemeInfo): Colors {
  return structuredClone(th.colors) as unknown as Colors;
}

// text colors become blocks and back
function restyle(c: Colors, blocky: boolean): Colors {
  const map = (s: Swatch): Swatch => {
    const fg = fgOf(s);
    const bg = bgOf(s);
    if (blocky) return bg || !fg ? s : { fg: c.on || 'black', bg: fg };
    return bg ? { fg: bg } : s;
  };
  return {
    ...c,
    categories: Object.fromEntries(Object.entries(c.categories ?? {}).map(([k, v]) => [k, map(v)])),
    cycle: (c.cycle ?? []).map(map),
  };
}

// dots for a theme's palette
export function paletteDots(th: ThemeInfo, max = 6): HTMLElement {
  const c = th.colors as unknown as Colors;
  const list: string[] = [];
  const add = (v: string | undefined) => {
    const css = colorToCss(v);
    if (css && !list.includes(css)) list.push(css);
  };
  if (c.mode === 'cycle') for (const s of c.cycle ?? []) add(bgOf(s) ?? fgOf(s));
  else if (c.mode === 'category')
    for (const k of SLOTS) add(bgOf(c.categories?.[k]) ?? fgOf(c.categories?.[k]));
  else for (const w of S.api.widgets.slice(0, 40)) add(w.color);
  return h(
    'span',
    { class: 'pal-dots', 'aria-hidden': 'true' },
    ...list.slice(0, max).map((css) => h('i', { style: `--c:${css}` })),
  );
}

export function themeChips(current: string, onPick: (t: ThemeInfo) => void): HTMLElement {
  const wrap = h('div', { class: 'pal-grid', role: 'listbox' });
  for (const th of S.api.themes) {
    if (th.style === 'tui') continue;
    wrap.append(
      h(
        'button',
        {
          type: 'button',
          class: `pal-chip${th.id === current ? ' on' : ''}`,
          role: 'option',
          'aria-selected': String(th.id === current),
          title: themeDescription(th),
          onClick: () => onPick(th),
        },
        paletteDots(th),
        h('span', { class: 'pal-name' }, th.name),
      ),
    );
  }
  return wrap;
}

function miniColor(value: string | undefined, onChange: (v: string | undefined) => void, label: string) {
  const css = colorToCss(value);
  const text = h('input', {
    class: 'input mono mini-color-text',
    type: 'text',
    value: value ?? '',
    placeholder: t('insp.none'),
    spellcheck: false,
    'aria-label': t('tb.colorAria', { label }),
  });
  const dot = h('i', { class: 'mini-color-dot', style: css ? `--c:${css}` : '' });
  const native = h('input', {
    class: 'color-native',
    type: 'color',
    value: css && /^#[0-9a-f]{6}$/i.test(css) ? css : '#888888',
    'aria-label': t('tb.pickColor', { label }),
  });
  const set = (v: string | undefined) => {
    const c = colorToCss(v);
    dot.style.setProperty('--c', c ?? 'transparent');
    dot.classList.toggle('none', !c);
    onChange(v);
  };
  dot.classList.toggle('none', !css);
  text.addEventListener('change', () => {
    const v = text.value.trim();
    if (!v) set(undefined);
    else if (isValidColor(v)) set(v);
    else text.value = value ?? '';
  });
  native.addEventListener('input', () => {
    text.value = native.value;
    set(native.value);
  });
  return h('label', { class: 'mini-color', title: label }, dot, native, text);
}

export interface BuilderOpts {
  from?: ThemeInfo;
  edit?: ThemeInfo;
  style?: StyleId;
}

export async function openThemeBuilder(opts: BuilderOpts = {}): Promise<string | null> {
  const fallback = S.api.themes.find((th) => th.id === 'classic')!;
  let base = opts.edit ?? opts.from ?? fallback;
  let style: StyleId = opts.style && opts.style !== 'tui' ? opts.style : base.style;
  let colors = colorsOf(base);
  if (BLOCKY.has(style) !== BLOCKY.has(base.style)) colors = restyle(colors, BLOCKY.has(style));
  let separator = base.separator;
  let padding = base.padding;
  let bold = base.bold;
  let gradient = [...(base.gradient ?? [])];
  let name = opts.edit?.name ?? '';
  let description = opts.edit?.description ?? '';

  const previewEl = h('div', { class: 'theme-preview builder-preview' });
  const form = h('div', { class: 'builder-form' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  let timer: number | undefined;
  let seq = 0;

  const draft = () => ({
    name: name.trim() || t('tb.defaultName'),
    description,
    style,
    separator,
    padding,
    bold,
    statusColors: base.statusColors,
    gradient: gradient.length ? [...gradient] : undefined,
    glyphs: style === base.style ? base.glyphs : undefined,
    colors,
  });

  const preview = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const n = ++seq;
      try {
        const { style: _s, separator: _sep, separatorColor: _c, padding: _p, glyphs: _g, ...cfg } = S.config;
        const r = await api.preview(cfg, previewSource(S), 110, draft());
        if (n !== seq) return;
        previewEl.innerHTML = r.lines
          .map((l) => `<div class="term-line">${ansiToHtml(l) || '&nbsp;'}</div>`)
          .join('');
      } catch (e) {
        previewEl.textContent = (e as Error).message;
      }
    }, 120);
  };

  const swatchRow = (
    label: string,
    sw: Swatch | undefined,
    set: (s: Swatch | undefined) => void,
    extra?: Node,
  ) => {
    const cur = { fg: fgOf(sw), bg: bgOf(sw) };
    const emit = () => {
      const s: { fg?: string; bg?: string } = {};
      if (cur.fg) s.fg = cur.fg;
      if (cur.bg) s.bg = cur.bg;
      set(s.fg || s.bg ? s : undefined);
      preview();
    };
    return h(
      'div',
      { class: 'swatch-row' },
      h('span', { class: 'swatch-label' }, label),
      miniColor(
        cur.fg,
        (v) => {
          cur.fg = v;
          emit();
        },
        t('tb.slotText', { label }),
      ),
      BLOCKY.has(style)
        ? miniColor(
            cur.bg,
            (v) => {
              cur.bg = v;
              emit();
            },
            t('tb.slotBackground', { label }),
          )
        : null,
      extra ?? null,
    );
  };

  const renderForm = () => {
    clear(form);
    const blocky = BLOCKY.has(style);
    const slots = h('div', { class: 'swatch-list' });
    if (blocky || colors.mode !== 'widget') {
      slots.append(
        h(
          'div',
          { class: 'swatch-row swatch-head' },
          h('span', null, ''),
          h('span', null, t('web.term.text')),
          blocky ? h('span', null, t('web.term.background')) : null,
        ),
      );
    }
    if (colors.mode === 'category') {
      for (const k of SLOTS) {
        const cat = S.api.categories.find((c) => c.id === k);
        slots.append(
          swatchRow(cat ? categoryText(cat.id, cat.name) : k, colors.categories[k], (s) => {
            if (s) colors.categories[k] = s;
            else delete colors.categories[k];
          }),
        );
      }
    } else if (colors.mode === 'cycle') {
      colors.cycle.forEach((sw, i) => {
        slots.append(
          swatchRow(
            t('tb.colorN', { n: i + 1 }),
            sw,
            (s) => {
              colors.cycle[i] = s ?? {};
            },
            h(
              'button',
              {
                class: 'icon-btn sm danger',
                type: 'button',
                title: t('tb.removeColor'),
                'aria-label': t('tb.removeColorN', { n: i + 1 }),
                onClick: () => {
                  colors.cycle.splice(i, 1);
                  renderForm();
                  preview();
                },
              },
              icon('trash', 14),
            ),
          ),
        );
      });
      slots.append(
        h(
          'button',
          {
            class: 'btn ghost sm',
            type: 'button',
            onClick: () => {
              colors.cycle.push(blocky ? { fg: 'black', bg: 'cyan' } : { fg: 'cyan' });
              renderForm();
              preview();
            },
          },
          icon('plus', 14),
          t('tb.addColor'),
        ),
      );
    } else {
      slots.append(h('div', { class: 'hint' }, t('tb.widgetColors')));
    }
    const general = h('div', { class: 'swatch-list' });
    if (blocky) {
      general.append(
        swatchRow(t('tb.textOnBlocks'), colors.on, (s) => {
          colors.on = fgOf(s) ?? 'black';
        }),
      );
    }
    general.append(
      swatchRow(t('insp.separator'), colors.muted, (s) => {
        colors.muted = fgOf(s) ?? 'brightBlack';
      }),
    );
    const stops = h('div', { class: 'swatch-list' });
    gradient.forEach((c, i) => {
      const remove = () => {
        gradient.splice(i, 1);
        renderForm();
        preview();
      };
      stops.append(
        h(
          'div',
          { class: 'swatch-row' },
          h('span', { class: 'swatch-label' }, t('tb.stopN', { n: i + 1 })),
          miniColor(
            c,
            (v) => {
              if (!v) remove();
              else {
                gradient[i] = v;
                preview();
              }
            },
            t('tb.gradientStopN', { n: i + 1 }),
          ),
          h('span', null),
          h(
            'button',
            {
              class: 'icon-btn sm danger',
              type: 'button',
              title: t('tb.removeStop'),
              'aria-label': t('tb.removeStopN', { n: i + 1 }),
              onClick: remove,
            },
            icon('trash', 14),
          ),
        ),
      );
    });
    if (gradient.length < MAX_STOPS) {
      stops.append(
        h(
          'button',
          {
            class: 'btn ghost sm',
            type: 'button',
            onClick: () => {
              gradient.push(gradient.at(-1) ?? 'green');
              renderForm();
              preview();
            },
          },
          icon('plus', 14),
          t('tb.addStop'),
        ),
      );
    }

    form.append(
      h(
        'div',
        { class: 'builder-cols' },
        field(
          t('tb.name'),
          textInput(
            name,
            (v) => {
              name = v;
              preview();
            },
            { placeholder: t('tb.defaultName') },
          ),
          opts.edit ? t('tb.file', { file: `${opts.edit.id}.json` }) : undefined,
        ),
        field(
          t('tb.description'),
          textInput(description, (v) => (description = v), { placeholder: t('tb.optional') }),
        ),
      ),
      ...(opts.edit
        ? []
        : [
            field(
              t('tb.startFrom'),
              themeChips(base.id, (th) => {
                base = th;
                style = th.style === 'tui' ? 'text' : th.style;
                colors = colorsOf(th);
                separator = th.separator;
                padding = th.padding;
                bold = th.bold;
                gradient = [...(th.gradient ?? [])];
                renderForm();
                preview();
              }),
            ),
          ]),
      field(
        t('insp.style'),
        segmented(
          S.api.styles
            .filter((s) => s.id !== 'tui')
            .map((s) => ({ value: s.id, label: styleText(s, 'name'), title: styleText(s, 'description') })),
          style,
          (v) => {
            const was = BLOCKY.has(style);
            style = v;
            if (was !== BLOCKY.has(style)) {
              colors = restyle(colors, BLOCKY.has(style));
              const own = S.api.themes.find((th) => th.style === style && th.id === base.id);
              separator = own?.separator ?? (BLOCKY.has(style) ? (style === 'powerline' ? '' : ' ') : ' │ ');
            }
            renderForm();
            preview();
          },
        ),
      ),
      field(
        t('tb.colors'),
        segmented(
          [
            { value: 'widget', label: t('tb.perWidget'), title: t('tb.perWidgetTitle') },
            { value: 'category', label: t('tb.perCategory'), title: t('tb.perCategoryTitle') },
            { value: 'cycle', label: t('tb.cycle'), title: t('tb.cycleTitle') },
          ] as const,
          colors.mode,
          (v) => {
            colors.mode = v;
            if (v === 'cycle' && !colors.cycle.length) {
              colors.cycle = blocky
                ? [
                    { fg: 'brightWhite', bg: 'blue' },
                    { fg: 'black', bg: 'cyan' },
                    { fg: 'black', bg: 'green' },
                  ]
                : [{ fg: 'blue' }, { fg: 'cyan' }, { fg: 'green' }];
            }
            renderForm();
            preview();
          },
        ),
      ),
      slots,
      general,
      field(t('tb.gradient'), stops, gradient.length ? t('tb.gradientHelp') : t('tb.gradientDefault')),
      h(
        'div',
        { class: 'builder-cols' },
        field(
          t('insp.separator'),
          textInput(
            separator,
            (v) => {
              separator = v;
              preview();
            },
            { class: 'input mono', placeholder: t('insp.none') },
          ),
        ),
        field(
          t('insp.padding'),
          numberInput(
            padding,
            (v) => {
              padding = Math.max(0, Math.min(4, v ?? 0));
              preview();
            },
            { min: 0, max: 4, step: 1 },
          ),
        ),
        field(
          t('insp.bold'),
          toggle(bold, (v) => {
            bold = v;
            preview();
          }),
          undefined,
          true,
        ),
      ),
    );
  };

  renderForm();
  preview();

  const result = await modal<string>({
    title: opts.edit ? t('themes.editName', { name: opts.edit.name }) : t('insp.newTheme'),
    wide: true,
    body: [previewEl, form, err],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, t('web.ui.cancel')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            const id = opts.edit?.id ?? slug(name);
            if (!ID_RE.test(id)) {
              err.textContent = t('tb.needName');
              return;
            }
            if (!opts.edit && S.api.themes.some((th) => th.id === id && th.source === 'user')) {
              err.textContent = t('tb.exists', { id });
              return;
            }
            try {
              const out = await api.saveTheme({ ...draft(), name: name.trim() || id, id });
              S.api.themes = out.themes;
              toast(t('tb.saved', { name: name.trim() || id }));
              close(id);
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        t('tb.save'),
      ),
    ],
  });
  clearTimeout(timer);
  return result ?? null;
}
