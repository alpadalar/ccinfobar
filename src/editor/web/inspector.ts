import { removeItem, setOption, updateItem } from '../../core/edit.js';
import type { Config, OptionSpec, OptionValue, WidgetItem } from '../../core/types.js';
import { colorPicker, colorToCss } from './colors.js';
import { type Child, clear, h, icon } from './dom.js';
import { commit, emit, S, type WidgetInfo } from './store.js';

const SEPARATORS = [' │ ', ' | ', ' • ', ' · ', ' / ', '  ', ' › '];
const PL_SEPARATORS = ['', '', '', '', '', '', ''];
const PL_START = ['', '', '', '', ''];
const PL_END = ['', '', '', '', ''];

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

export function toggle(
  checked: boolean,
  onChange: (v: boolean) => void,
  label?: string,
): HTMLElement {
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

function styleToggle(
  label: string,
  title: string,
  on: boolean,
  onChange: (v: boolean) => void,
): HTMLElement {
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

function glyphChoices(
  values: string[],
  current: string,
  onPick: (v: string) => void,
): HTMLElement {
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
        v || 'none',
      ),
    );
  }
  return wrap;
}

function textInput(
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

function numberInput(
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
        numberInput(
          Number(value),
          (v) => set(v === null ? undefined : same(v), `${item.id}:${spec.key}`),
          { step: 'any' },
        ),
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
      h(
        'div',
        { class: 'insp-title' },
        h('h3', null, info?.name ?? item.type),
        h('code', null, item.type),
      ),
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
      'Appearance',
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
    section(
      'Label',
      field(
        'Label override',
        textInput(
          item.label ?? '',
          (v) => patch({ label: v === '' ? undefined : v }, `${item.id}:label`),
          { placeholder: info?.label ? `Default: ${info.label}` : 'Default label', disabled: !!item.raw },
        ),
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
    ),
  );

  if (info?.options.length) {
    root.append(section('Options', ...info.options.map((o) => optionControl(item, o))));
  }
  return root;
}

function globalTab(): HTMLElement {
  const c = S.config;
  const set = (p: Partial<Config>, coalesce?: string) =>
    commit({ ...S.config, ...p }, coalesce ? { coalesce, inspector: false } : {});
  const setPl = (p: Partial<Config['powerline']>, coalesce?: string) =>
    commit(
      { ...S.config, powerline: { ...S.config.powerline, ...p } },
      coalesce ? { coalesce, inspector: false } : {},
    );
  const section = (title: string, ...body: Child[]) =>
    h('section', { class: 'section' }, h('h4', null, title), ...body);

  const sepInput = textInput(c.separator, (v) => set({ separator: v }, 'sep'), {
    class: 'input mono',
  });
  const sepChoices = h('div', { class: 'glyphs' });
  for (const s of SEPARATORS) {
    sepChoices.append(
      h(
        'button',
        {
          type: 'button',
          class: `glyph${s === c.separator ? ' on' : ''}`,
          onClick: () => set({ separator: s }),
          title: JSON.stringify(s),
        },
        h('span', { class: 'glyph-sp' }, s.replace(/ /g, ' ') || 'none'),
      ),
    );
  }

  const maxAuto = c.maxWidth === 'auto';
  const themes = h('div', { class: 'themes' });
  for (const [id, t] of Object.entries(S.api.themes)) {
    themes.append(
      h(
        'button',
        {
          type: 'button',
          class: `theme${id === c.powerline.theme ? ' on' : ''}`,
          'aria-pressed': String(id === c.powerline.theme),
          onClick: () => setPl({ theme: id }),
        },
        h(
          'span',
          { class: 'theme-swatches' },
          ...t.colors.map((col) => h('i', { style: `background:${colorToCss(col.bg) ?? '#666'}` })),
        ),
        h('span', { class: 'theme-name' }, t.name),
      ),
    );
  }

  const root = h('div', { class: 'pane' });
  root.append(
    section(
      'Layout',
      field('Separator', sepInput, undefined),
      sepChoices,
      field(
        'Separator color',
        colorPicker({
          value: c.separatorColor,
          allowDefault: false,
          onChange: (v, live) =>
            set({ separatorColor: v ?? 'brightBlack' }, live ? 'sepcolor' : undefined),
        }),
      ),
      field(
        'Padding',
        numberInput(c.padding, (v) => v !== null && set({ padding: Math.max(0, Math.min(4, v)) }, 'pad'), {
          min: 0,
          max: 4,
          step: 1,
        }),
        'Spaces around each widget (0 to 4).',
      ),
    ),
    section(
      'Rendering',
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
      field(
        'Save last payload',
        toggle(c.savePayload, (v) => set({ savePayload: v })),
        'Lets the preview use your real last session.',
        true,
      ),
    ),
    section(
      'Powerline',
      field(
        'Enabled',
        toggle(c.powerline.enabled, (v) => setPl({ enabled: v })),
        'Needs a Nerd Font in your terminal.',
        true,
      ),
      ...(c.powerline.enabled
        ? [
            field('Theme', themes),
            field('Separator', glyphChoices(PL_SEPARATORS, c.powerline.separator, (v) => setPl({ separator: v }))),
            textInput(c.powerline.separator, (v) => setPl({ separator: v }, 'plsep'), {
              class: 'input mono',
              placeholder: 'Custom separator',
              'aria-label': 'Custom powerline separator',
            }),
            field('Start cap', glyphChoices(PL_START, c.powerline.startCap, (v) => setPl({ startCap: v }))),
            textInput(c.powerline.startCap, (v) => setPl({ startCap: v }, 'plstart'), {
              class: 'input mono',
              placeholder: 'Custom start cap',
              'aria-label': 'Custom start cap',
            }),
            field('End cap', glyphChoices(PL_END, c.powerline.endCap, (v) => setPl({ endCap: v }))),
            textInput(c.powerline.endCap, (v) => setPl({ endCap: v }, 'plend'), {
              class: 'input mono',
              placeholder: 'Custom end cap',
              'aria-label': 'Custom end cap',
            }),
          ]
        : []),
    ),
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

