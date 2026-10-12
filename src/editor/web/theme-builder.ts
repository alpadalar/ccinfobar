import { ansiToHtml } from './ansi-html.js';
import { api } from './api.js';
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

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
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
];
const BLOCKY = new Set<StyleId>(['blocks', 'powerline', 'capsule']);

const fgOf = (s: Swatch | undefined) => (typeof s === 'object' ? s.fg : s);
const bgOf = (s: Swatch | undefined) => (typeof s === 'object' ? s.bg : undefined);

function colorsOf(t: ThemeInfo): Colors {
  return structuredClone(t.colors) as unknown as Colors;
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
export function paletteDots(t: ThemeInfo, max = 6): HTMLElement {
  const c = t.colors as unknown as Colors;
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
  for (const t of S.api.themes) {
    if (t.style === 'tui') continue;
    wrap.append(
      h(
        'button',
        {
          type: 'button',
          class: `pal-chip${t.id === current ? ' on' : ''}`,
          role: 'option',
          'aria-selected': String(t.id === current),
          title: t.description,
          onClick: () => onPick(t),
        },
        paletteDots(t),
        h('span', { class: 'pal-name' }, t.name),
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
    placeholder: 'none',
    spellcheck: false,
    'aria-label': `${label} color`,
  });
  const dot = h('i', { class: 'mini-color-dot', style: css ? `--c:${css}` : '' });
  const native = h('input', {
    class: 'color-native',
    type: 'color',
    value: css && /^#[0-9a-f]{6}$/i.test(css) ? css : '#888888',
    'aria-label': `Pick ${label} color`,
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
  const fallback = S.api.themes.find((t) => t.id === 'classic')!;
  let base = opts.edit ?? opts.from ?? fallback;
  let style: StyleId = opts.style && opts.style !== 'tui' ? opts.style : base.style;
  let colors = colorsOf(base);
  if (BLOCKY.has(style) !== BLOCKY.has(base.style)) colors = restyle(colors, BLOCKY.has(style));
  let separator = base.separator;
  let padding = base.padding;
  let bold = base.bold;
  let name = opts.edit?.name ?? '';
  let description = opts.edit?.description ?? '';

  const previewEl = h('div', { class: 'theme-preview builder-preview' });
  const form = h('div', { class: 'builder-form' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  let timer: number | undefined;
  let seq = 0;

  const draft = () => ({
    name: name.trim() || 'My theme',
    description,
    style,
    separator,
    padding,
    bold,
    statusColors: base.statusColors,
    glyphs: style === base.style ? base.glyphs : undefined,
    colors,
  });

  const preview = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const n = ++seq;
      try {
        const { style: _s, separator: _sep, separatorColor: _c, padding: _p, glyphs: _g, ...cfg } = S.config;
        const r = await api.preview(cfg, S.source, 110, draft());
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
        `${label} text`,
      ),
      BLOCKY.has(style)
        ? miniColor(
            cur.bg,
            (v) => {
              cur.bg = v;
              emit();
            },
            `${label} background`,
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
          h('span', null, 'Text'),
          blocky ? h('span', null, 'Background') : null,
        ),
      );
    }
    if (colors.mode === 'category') {
      for (const k of SLOTS) {
        const cat = S.api.categories.find((c) => c.id === k);
        slots.append(
          swatchRow(cat?.name ?? k, colors.categories[k], (s) => {
            if (s) colors.categories[k] = s;
            else delete colors.categories[k];
          }),
        );
      }
    } else if (colors.mode === 'cycle') {
      colors.cycle.forEach((sw, i) => {
        slots.append(
          swatchRow(
            `Color ${i + 1}`,
            sw,
            (s) => {
              colors.cycle[i] = s ?? {};
            },
            h(
              'button',
              {
                class: 'icon-btn sm danger',
                type: 'button',
                title: 'Remove color',
                'aria-label': `Remove color ${i + 1}`,
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
          'Add color',
        ),
      );
    } else {
      slots.append(h('div', { class: 'hint' }, 'Each widget keeps its own color.'));
    }
    const general = h('div', { class: 'swatch-list' });
    if (blocky) {
      general.append(
        swatchRow('Text on blocks', colors.on, (s) => {
          colors.on = fgOf(s) ?? 'black';
        }),
      );
    }
    general.append(
      swatchRow('Separator', colors.muted, (s) => {
        colors.muted = fgOf(s) ?? 'brightBlack';
      }),
    );

    form.append(
      h(
        'div',
        { class: 'builder-cols' },
        field(
          'Name',
          textInput(
            name,
            (v) => {
              name = v;
              preview();
            },
            { placeholder: 'My theme' },
          ),
          opts.edit ? `File: ${opts.edit.id}.json` : undefined,
        ),
        field(
          'Description',
          textInput(description, (v) => (description = v), { placeholder: 'Optional' }),
        ),
      ),
      ...(opts.edit
        ? []
        : [
            field(
              'Start from',
              themeChips(base.id, (t) => {
                base = t;
                style = t.style === 'tui' ? 'text' : t.style;
                colors = colorsOf(t);
                separator = t.separator;
                padding = t.padding;
                bold = t.bold;
                renderForm();
                preview();
              }),
            ),
          ]),
      field(
        'Style',
        segmented(
          S.api.styles
            .filter((s) => s.id !== 'tui')
            .map((s) => ({ value: s.id, label: s.name, title: s.description })),
          style,
          (v) => {
            const was = BLOCKY.has(style);
            style = v;
            if (was !== BLOCKY.has(style)) {
              colors = restyle(colors, BLOCKY.has(style));
              const own = S.api.themes.find((t) => t.style === style && t.id === base.id);
              separator = own?.separator ?? (BLOCKY.has(style) ? (style === 'powerline' ? '' : ' ') : ' │ ');
            }
            renderForm();
            preview();
          },
        ),
      ),
      field(
        'Colors',
        segmented(
          [
            { value: 'widget', label: 'Per widget', title: 'Every widget keeps its own color' },
            { value: 'category', label: 'Per category', title: 'One color per widget category' },
            { value: 'cycle', label: 'Cycle', title: 'Colors repeat in order along the line' },
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
      h(
        'div',
        { class: 'builder-cols' },
        field(
          'Separator',
          textInput(
            separator,
            (v) => {
              separator = v;
              preview();
            },
            { class: 'input mono', placeholder: 'none' },
          ),
        ),
        field(
          'Padding',
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
          'Bold',
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
    title: opts.edit ? `Edit ${opts.edit.name}` : 'New theme',
    wide: true,
    body: [previewEl, form, err],
    actions: (close) => [
      h('button', { class: 'btn', type: 'button', onClick: () => close() }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onClick: async () => {
            const id = opts.edit?.id ?? slug(name);
            if (!ID_RE.test(id)) {
              err.textContent = 'Give the theme a name first';
              return;
            }
            if (!opts.edit && S.api.themes.some((t) => t.id === id && t.source === 'user')) {
              err.textContent = `You already have a theme called ${id}`;
              return;
            }
            try {
              const out = await api.saveTheme({ ...draft(), name: name.trim() || id, id });
              S.api.themes = out.themes;
              toast(`Saved theme "${name.trim() || id}"`);
              close(id);
            } catch (e) {
              err.textContent = (e as Error).message;
            }
          },
        },
        'Save theme',
      ),
    ],
  });
  clearTimeout(timer);
  return result ?? null;
}
