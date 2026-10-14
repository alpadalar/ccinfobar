import { clearColors, optionShown, removeItem, setOption, updateItem } from '../../core/edit.js';
import type { Config, OptionSpec, OptionValue, WidgetItem } from '../../core/types.js';
import { GLYPHS } from './ansi-html.js';
import { colorPicker, colorToCss } from './colors.js';
import { type Child, clear, h, icon } from './dom.js';
import { panelSection } from './panel-inspector.js';
import { commit, currentTheme, emit, S, type StyleId, type WidgetInfo } from './store.js';
import { recentStyles, styleTools } from './styles.js';
import { openThemeBuilder, themeChips } from './theme-builder.js';
import { applyTheme, askThemeColors, openGallery } from './themes.js';

const SEPARATORS = [' │ ', ' | ', ' • ', ' · ', ' / ', '  ', ' › '];
const PL_SEPARATORS = ['', '', '', '', '', '', ''];
const PL_START = ['\ue0b6', '\ue0b2', '\ue0ba', '\ue0be', ''];
const PL_END = ['\ue0b0', '\ue0b4', '\ue0b8', '\ue0bc', ''];
const PL_THIN = ['\ue0b1', '\ue0b3', '\u2502', '\u2503', '|', ''];

let counter = 0;
const uid = () => `f${++counter}`;

export function field(label: string, control: Child, help?: string, inline = false): HTMLElement {
  const id = uid();
  if (control instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName) && !control.id) {
    control.id = id;
  }
  return h(
    'div',
    { class: `field${inline ? ' inline' : ''}` },
    h('label', { class: 'field-label', htmlFor: id }, label),
    control,
    help ? h('div', { class: 'hint' }, help) : null,
  );
}

export function toggle(checked: boolean, onChange: (v: boolean) => void, label?: string): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    class: 'switch-input',
    checked,
    onChange: () => onChange(input.checked),
  });
  return h(
    'label',
    { class: 'switch' },
    input,
    h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })),
    label ? h('span', { class: 'switch-label' }, label) : null,
  );
}

export function segmented<T extends string | number>(
  options: { value: T; label: string; title?: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = h('div', { class: 'segmented', role: 'group' });
  for (const o of options) {
    wrap.append(
      h(
        'button',
        {
          type: 'button',
          class: o.value === value ? 'on' : '',
          title: o.title,
          'aria-pressed': String(o.value === value),
          onClick: () => onChange(o.value),
        },
        o.label,
      ),
    );
  }
  return wrap;
}

function styleToggle(label: string, title: string, on: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: `style-btn style-${label.toLowerCase()}${on ? ' on' : ''}`,
      title,
      'aria-pressed': String(on),
      onClick: () => onChange(!on),
    },
    label,
  );
}

function glyphChoices(values: string[], current: string, onPick: (v: string) => void): HTMLElement {
  const wrap = h('div', { class: 'glyphs' });
  for (const v of values) {
    wrap.append(
      h(
        'button',
        {
          type: 'button',
          class: `glyph${v === current ? ' on' : ''}`,
          title: v ? `U+${v.codePointAt(0)!.toString(16).toUpperCase()}` : 'none',
          onClick: () => onPick(v),
        },
        GLYPHS.has(v) ? h('span', { class: `pl pl-${v.codePointAt(0)!.toString(16)}` }) : v || 'none',
      ),
    );
  }
  return wrap;
}

// private-use glyphs have no browser font
const showGlyph = (v: string) =>
  /[\ue000-\uf8ff]/u.test(v) ? `U+${v.codePointAt(0)!.toString(16).toUpperCase()}` : v;

export function textInput(
  value: string,
  onInput: (v: string) => void,
  attrs: Record<string, unknown> = {},
): HTMLInputElement {
  const input = h('input', {
    class: 'input',
    type: 'text',
    value,
    spellcheck: false,
    autocomplete: 'off',
    onInput: () => onInput(input.value),
    ...attrs,
  });
  return input;
}

export function numberInput(
  value: number | '',
  onInput: (v: number | null) => void,
  attrs: Record<string, unknown> = {},
): HTMLInputElement {
  const input = h('input', {
    class: 'input num',
    type: 'number',
    value: String(value),
    onInput: () => onInput(input.value === '' ? null : Number(input.value)),
    ...attrs,
  });
  return input;
}

function optionControl(item: WidgetItem, spec: OptionSpec): HTMLElement {
  const stored = item.options?.[spec.key];
  const value: OptionValue = stored ?? spec.default;
  const set = (v: OptionValue | undefined, coalesce?: string) =>
    commit(setOption(S.config, item.id, spec.key, v), {
      ...(coalesce ? { coalesce, inspector: false } : {}),
    });
  const same = (v: OptionValue) => (v === spec.default ? undefined : v);
  switch (spec.kind) {
    case 'boolean':
      return field(
        spec.label,
        toggle(Boolean(value), (v) => set(same(v))),
        spec.help,
        true,
      );
    case 'select': {
      const sel = h(
        'select',
        { class: 'input', onChange: () => set(same(sel.value)), value: String(value) },
        ...(spec.choices ?? []).map((c) => h('option', { value: c.value }, c.label)),
      );
      return field(spec.label, sel, spec.help);
    }
    case 'number':
      return field(
        spec.label,
        numberInput(Number(value), (v) => set(v === null ? undefined : same(v), `${item.id}:${spec.key}`), {
          step: 'any',
        }),
        spec.help,
      );
    default:
      return field(
        spec.label,
        textInput(String(value), (v) => set(same(v), `${item.id}:${spec.key}`)),
        spec.help,
      );
  }
}

function widgetTab(): HTMLElement {
  const root = h('div', { class: 'pane' });
  const id = S.selectedId;
  const found = id ? S.config.lines.flat().find((i) => i.id === id) : undefined;
  if (!found) {
    root.append(
      h(
        'div',
        { class: 'empty-state' },
        icon('info', 22),
        h('strong', null, 'No widget selected'),
        h('p', null, 'Click a widget in the canvas to style it and tweak its options.'),
      ),
    );
    return root;
  }
  const item = found;
  const info: WidgetInfo | undefined = S.widgetMap.get(item.type);
  const patch = (p: Partial<WidgetItem>, coalesce?: string) =>
    commit(updateItem(S.config, item.id, p), coalesce ? { coalesce, inspector: false } : {});
  const defColor = info?.color;

  root.append(
    h(
      'div',
      { class: 'insp-head' },
      h('i', {
        class: 'dot big',
        style: `--c:${colorToCss(item.color ?? defColor) ?? 'var(--muted)'}`,
      }),
      h('div', { class: 'insp-title' }, h('h3', null, info?.name ?? item.type), h('code', null, item.type)),
      h(
        'button',
        {
          class: 'icon-btn danger',
          type: 'button',
          title: 'Remove widget (Delete)',
          onClick: () => commit(removeItem(S.config, item.id), { select: null }),
        },
        icon('trash'),
      ),
    ),
    h('p', { class: 'insp-desc' }, info?.description ?? 'Unknown widget type. It is kept as-is.'),
  );

  const section = (title: string, ...body: Child[]) =>
    h('section', { class: 'section' }, h('h4', null, title), ...body);

  root.append(
    section(
      'Label',
      field(
        'Label override',
        textInput(item.label ?? '', (v) => patch({ label: v === '' ? undefined : v }, `${item.id}:label`), {
          placeholder: info?.label ? `Default: ${info.label}` : 'Default label',
          disabled: !!item.raw,
        }),
        'Leave empty to use the default label.',
      ),
      field(
        'Hide label',
        toggle(!!item.raw, (v) => patch({ raw: v || undefined })),
        'Shows only the value.',
        true,
      ),
      field(
        'Merge with next',
        toggle(!!item.merge, (v) => patch({ merge: v || undefined })),
        'Joins this widget to the next one without a separator.',
        true,
      ),
      field(
        'Hide when no data',
        toggle(!!item.hideEmpty, (v) => patch({ hideEmpty: v || undefined })),
        'Off: shows the label and — when there is nothing to show. On: hides the widget.',
        true,
      ),
    ),
  );

  if (info?.options.length) {
    const shown = info.options.filter((o) => optionShown(o, info.options, item.options));
    root.append(section('Options', ...shown.map((o) => optionControl(item, o))));
  }
  const recent = recentStyles(item.id);
  root.append(
    section(
      'Appearance',
      styleTools(item.id),
      ...(recent ? [field('Earlier styles', recent, 'Kept when you save; click one to bring it back.')] : []),
      field(
        'Text color',
        colorPicker({
          value: item.color,
          fallback: defColor,
          onChange: (v, live) => patch({ color: v }, live ? `${item.id}:color` : undefined),
        }),
      ),
      field(
        'Background',
        colorPicker({
          value: item.background,
          onChange: (v, live) => patch({ background: v }, live ? `${item.id}:bg` : undefined),
        }),
      ),
      field(
        'Style',
        h(
          'div',
          { class: 'style-row' },
          styleToggle('Bold', 'Bold', !!item.bold, (v) => patch({ bold: v || undefined })),
          styleToggle('Dim', 'Dim', !!item.dim, (v) => patch({ dim: v || undefined })),
          styleToggle('Italic', 'Italic', !!item.italic, (v) => patch({ italic: v || undefined })),
        ),
      ),
    ),
  );
  return root;
}

type Overrides = 'style' | 'separator' | 'separatorColor' | 'padding' | 'glyphs' | 'align';

function setOverride(key: Overrides, value: unknown, coalesce?: string): void {
  const next = { ...S.config } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  commit(next as unknown as Config, coalesce ? { coalesce, inspector: false } : {});
}

type GlyphKey = 'separator' | 'thin' | 'startCap' | 'endCap';

function setGlyph(key: GlyphKey, value: string | undefined, coalesce?: string): void {
  const glyphs = { ...S.config.glyphs };
  if (value === undefined) delete glyphs[key];
  else glyphs[key] = value;
  setOverride('glyphs', Object.keys(glyphs).length ? glyphs : undefined, coalesce);
}

export function resetLink(show: boolean, onClick: () => void): HTMLElement | null {
  return show
    ? h(
        'button',
        {
          class: 'reset-link',
          type: 'button',
          title: 'Remove the override and use the theme value',
          onClick,
        },
        'Reset to theme',
      )
    : null;
}

export function fieldWithReset(
  label: string,
  control: Child,
  reset: HTMLElement | null,
  help?: string,
): HTMLElement {
  const f = field(label, control, help);
  if (reset) f.querySelector('.field-label')!.after(reset);
  f.classList.add('has-reset');
  return f;
}

function glyphField(label: string, key: GlyphKey, choices: string[], themeValue: string): HTMLElement {
  const override = S.config.glyphs?.[key];
  const input = textInput(override ?? '', (v) => setGlyph(key, v, `glyph:${key}`), {
    class: 'input mono',
    placeholder: themeValue ? `Theme: ${showGlyph(themeValue)}` : 'Theme: none',
    'aria-label': `${label} glyph`,
  });
  return fieldWithReset(
    label,
    h(
      'div',
      { class: 'stack' },
      glyphChoices(choices, override ?? themeValue, (v) => setGlyph(key, v)),
      input,
    ),
    resetLink(override !== undefined, () => setGlyph(key, undefined)),
  );
}

function globalTab(): HTMLElement {
  const c = S.config;
  const theme = currentTheme();
  const style = (c.style ?? theme?.style ?? 'text') as StyleId;
  const set = (p: Partial<Config>, coalesce?: string) =>
    commit({ ...S.config, ...p }, coalesce ? { coalesce, inspector: false } : {});
  const section = (title: string, ...body: Child[]) =>
    h('section', { class: 'section' }, h('h4', null, title), ...body);

  // the panel separates cells with tui.columnGap
  const panel = style === 'tui';
  const sepValue = panel ? c.tui?.columnGap : c.separator;
  const setSep = (v: string | undefined, coalesce?: string) => {
    if (!panel) return setOverride('separator', v, coalesce);
    const tui = { ...(S.config.tui ?? {}) };
    if (v === undefined) delete tui.columnGap;
    else tui.columnGap = v;
    commit({ ...S.config, tui }, coalesce ? { coalesce, inspector: false } : {});
  };
  const sepInput = textInput(sepValue ?? '', (v) => setSep(v, 'sep'), {
    class: 'input mono',
    placeholder: `Theme: ${JSON.stringify(theme?.separator ?? ' │ ')}`,
  });
  const sepChoices = h('div', { class: 'glyphs' });
  for (const sp of SEPARATORS) {
    sepChoices.append(
      h(
        'button',
        {
          type: 'button',
          class: `glyph${sp === sepValue ? ' on' : ''}`,
          onClick: () => setSep(sp),
          title: JSON.stringify(sp),
        },
        h('span', { class: 'glyph-sp' }, sp.replace(/ /g, ' ') || 'none'),
      ),
    );
  }

  const maxAuto = c.maxWidth === 'auto';
  const mutedFallback = theme?.colors.muted;
  const root = h('div', { class: 'pane' });
  root.append(
    section(
      'Rendering',
      field(
        'Alignment',
        segmented(
          [
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Center' },
            { value: 'right', label: 'Right' },
          ] as const,
          c.align ?? 'left',
          (v) => setOverride('align', v === 'left' ? undefined : v),
        ),
        style === 'tui'
          ? 'Where the panel sits when it is narrower than the terminal. Lines can override it with the buttons next to them.'
          : 'Where the lines sit in the terminal. Each line can override it with the buttons next to it.',
      ),
      field(
        'Icons',
        segmented(
          [
            { value: 'nerd', label: 'Nerd', title: 'Nerd Font glyphs' },
            { value: 'emoji', label: 'Emoji' },
            { value: 'text', label: 'Text' },
            { value: 'none', label: 'None' },
          ] as const,
          c.icons,
          (v) => set({ icons: v }),
        ),
      ),
      field(
        'Charset',
        segmented(
          [
            { value: 'auto', label: 'Auto', title: 'Nerd Font glyphs, except in Apple Terminal' },
            {
              value: 'nerd',
              label: 'Nerd Font',
              title: 'Powerline arrows, capsule caps and Nerd Font icons',
            },
            { value: 'unicode', label: 'Unicode', title: 'Standard characters only, no Nerd Font needed' },
            { value: 'text', label: 'ASCII', title: 'Plain ASCII characters only' },
          ] as const,
          c.charset,
          (v) => set({ charset: v }),
        ),
      ),
      field(
        'Auto wrap',
        toggle(c.autoWrap, (v) => set({ autoWrap: v })),
        'Wrap widgets onto extra lines instead of truncating.',
        true,
      ),
      field(
        'Color level',
        segmented(
          [
            { value: 'auto', label: 'Auto' },
            { value: 0, label: '0', title: 'No colors' },
            { value: 1, label: '1', title: '16 colors' },
            { value: 2, label: '2', title: '256 colors' },
            { value: 3, label: '3', title: 'True color' },
          ] as const,
          c.colorLevel as string | number,
          (v) => set({ colorLevel: v as Config['colorLevel'] }),
        ),
        'The preview shows true color when set to auto.',
      ),
      field(
        'Max width',
        h(
          'div',
          { class: 'row-inline' },
          segmented(
            [
              { value: 'auto', label: 'Auto' },
              { value: 'fixed', label: 'Fixed' },
            ],
            maxAuto ? 'auto' : 'fixed',
            (v) => set({ maxWidth: v === 'auto' ? 'auto' : 120 }),
          ),
          maxAuto
            ? null
            : numberInput(c.maxWidth as number, (v) => v && v > 0 && set({ maxWidth: v }, 'maxw'), {
                min: 20,
                max: 500,
              }),
        ),
      ),
      field(
        'Width offset',
        numberInput(c.widthOffset, (v) => v !== null && set({ widthOffset: Math.max(0, v) }, 'woff'), {
          min: 0,
          step: 1,
        }),
        'Columns reserved at the right edge.',
      ),
    ),
    section(
      'Theme',
      h(
        'div',
        { class: 'theme-current' },
        h(
          'div',
          { class: 'theme-current-info' },
          h('strong', null, theme?.name ?? c.theme),
          h('span', { class: `theme-tag style-${style}` }, style),
          theme?.source === 'user' ? h('span', { class: 'theme-tag yours' }, 'yours') : null,
        ),
        h('div', { class: 'hint' }, theme?.description ?? 'Unknown theme, using Classic'),
        h(
          'div',
          { class: 'row-inline' },
          h('button', { class: 'btn', type: 'button', onClick: () => void openGallery() }, 'Change theme'),
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onClick: async () => {
                const id = await openThemeBuilder({ from: theme, style: c.style });
                if (id) applyTheme(id, await askThemeColors());
              },
            },
            'New theme',
          ),
        ),
      ),
    ),
    section(
      'Style',
      fieldWithReset(
        'Style',
        segmented(
          S.api.styles.map((st) => ({ value: st.id, label: st.name, title: st.description })),
          style,
          (v) => setOverride('style', v === theme?.style ? undefined : v),
        ),
        resetLink(c.style !== undefined, () => setOverride('style', undefined)),
        'Powerline and Capsule need a Nerd Font.',
      ),
      ...(style === 'tui'
        ? []
        : [
            field(
              'Colors from',
              themeChips(c.theme || 'classic', async (t) => {
                const base = (await askThemeColors()) ? clearColors(S.config) : S.config;
                commit({ ...base, theme: t.id, style: style === t.style ? undefined : style });
              }),
              'Keeps your style and takes the colors of another theme.',
            ),
          ]),
      fieldWithReset(
        'Separator',
        h('div', { class: 'stack' }, sepChoices, sepInput),
        resetLink(sepValue !== undefined, () => setSep(undefined)),
      ),
      fieldWithReset(
        'Separator color',
        colorPicker({
          value: c.separatorColor,
          fallback: typeof mutedFallback === 'string' ? mutedFallback : undefined,
          onChange: (v, live) => setOverride('separatorColor', v, live ? 'sepcolor' : undefined),
        }),
        resetLink(c.separatorColor !== undefined, () => setOverride('separatorColor', undefined)),
      ),
      fieldWithReset(
        'Padding',
        numberInput(
          c.padding ?? '',
          (v) => setOverride('padding', v === null ? undefined : Math.max(0, Math.min(4, v)), 'pad'),
          { min: 0, max: 4, step: 1, placeholder: String(theme?.padding ?? 1) },
        ),
        resetLink(c.padding !== undefined, () => setOverride('padding', undefined)),
        'Spaces around each widget (0 to 4).',
      ),
    ),
    ...(style === 'tui' ? [panelSection()] : []),
    // only powerline and capsule draw glyphs
    ...(style === 'powerline' || style === 'capsule'
      ? [
          section(
            'Glyphs',
            ...(style === 'powerline'
              ? [
                  glyphField('Separator', 'separator', PL_SEPARATORS, theme?.glyphs.separator ?? ''),
                  glyphField('Thin separator', 'thin', PL_THIN, theme?.glyphs.thin ?? ''),
                ]
              : []),
            glyphField('Start cap', 'startCap', PL_START, theme?.glyphs.startCap ?? ''),
            glyphField('End cap', 'endCap', PL_END, theme?.glyphs.endCap ?? ''),
          ),
        ]
      : []),
  );
  return root;
}

export function renderInspector(): void {
  const host = document.getElementById('inspector-body')!;
  const scroll = host.scrollTop;
  clear(host);
  host.append(S.tab === 'widget' ? widgetTab() : globalTab());
  host.scrollTop = scroll;
  for (const b of document.querySelectorAll<HTMLElement>('#inspector-tabs button')) {
    const on = b.dataset.tab === S.tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
}

export function initInspector(): void {
  for (const b of document.querySelectorAll<HTMLElement>('#inspector-tabs button')) {
    b.addEventListener('click', () => {
      S.tab = b.dataset.tab as 'widget' | 'global';
      emit('selection');
    });
  }
}
