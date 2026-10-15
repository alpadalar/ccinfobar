import { t } from '../../core/i18n/index.js';
import { ansi256ToHex, BASIC } from './ansi-html.js';
import { h } from './dom.js';

export const COLOR_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

export function colorToCss(value: string | undefined | null): string | null {
  if (!value || value === 'default' || value === 'none') return null;
  const v = value.trim();
  const named = COLOR_NAMES.indexOf(v);
  if (named >= 0) return BASIC[named]!;
  if (v === 'gray' || v === 'grey') return BASIC[8]!;
  const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v);
  if (hex) return v;
  const idx = /^ansi256:(\d{1,3})$/i.exec(v) ?? /^(\d{1,3})$/.exec(v);
  if (idx && Number(idx[1]) <= 255) return ansi256ToHex(Number(idx[1]));
  return null;
}

export function isValidColor(value: string): boolean {
  return colorToCss(value) !== null;
}

function toHex6(css: string | null): string {
  if (!css) return '#888888';
  if (css.length === 4) return `#${[...css.slice(1)].map((c) => c + c).join('')}`;
  return css;
}

export interface ColorPickerOpts {
  value: string | undefined;
  fallback?: string | undefined;
  allowDefault?: boolean;
  onChange(value: string | undefined, live: boolean): void;
}

export function colorPicker(opts: ColorPickerOpts): HTMLElement {
  let current = opts.value;
  const swatches: HTMLButtonElement[] = [];
  const text = h('input', {
    class: 'input mono',
    type: 'text',
    placeholder: t('web.color.placeholder'),
    spellcheck: false,
    value: current && !COLOR_NAMES.includes(current) ? current : '',
    'aria-label': t('web.color.custom'),
  });
  const native = h('input', {
    class: 'color-native',
    type: 'color',
    value: toHex6(colorToCss(current) ?? colorToCss(opts.fallback)),
    'aria-label': t('web.color.pick'),
  });

  function sync() {
    for (const s of swatches) {
      const on = (s.dataset.value ?? '') === (current ?? '');
      s.classList.toggle('on', on);
      s.setAttribute('aria-pressed', String(on));
    }
    native.value = toHex6(colorToCss(current) ?? colorToCss(opts.fallback));
    const custom = current && !COLOR_NAMES.includes(current);
    text.value = custom ? current! : '';
    text.classList.remove('invalid');
  }

  function set(v: string | undefined, live = false) {
    current = v;
    sync();
    opts.onChange(v, live);
  }

  const grid = h('div', { class: 'swatches', role: 'group' });
  if (opts.allowDefault !== false) {
    const fb = colorToCss(opts.fallback);
    const b = h(
      'button',
      {
        class: 'swatch swatch-default',
        type: 'button',
        title: opts.fallback ? t('web.color.defaultValue', { color: opts.fallback }) : t('web.color.default'),
        'data-value': '',
        onClick: () => set(undefined),
        style: fb ? `--sw:${fb}` : '',
      },
      h('span', { class: 'swatch-slash' }),
    );
    swatches.push(b);
    grid.append(b);
  }
  COLOR_NAMES.forEach((name, i) => {
    const b = h('button', {
      class: 'swatch',
      type: 'button',
      title: name,
      'aria-label': name,
      'data-value': name,
      style: `--sw:${BASIC[i]}`,
      onClick: () => set(name),
    });
    swatches.push(b);
    grid.append(b);
  });

  native.addEventListener('input', () => set(native.value, true));
  native.addEventListener('change', () => set(native.value, false));
  text.addEventListener('change', () => {
    const v = text.value.trim();
    if (!v) return set(undefined);
    if (!isValidColor(v)) {
      text.classList.add('invalid');
      return;
    }
    set(/^\d+$/.test(v) ? `ansi256:${v}` : v);
  });

  sync();
  const fallbackCss = colorToCss(opts.fallback);
  return h(
    'div',
    { class: 'color-picker' },
    grid,
    h('div', { class: 'color-row' }, native, text),
    !current && opts.fallback
      ? h(
          'div',
          { class: 'hint' },
          t('web.color.usingDefault'),
          h('i', { class: 'dot', style: fallbackCss ? `--c:${fallbackCss}` : '' }),
          h('code', null, opts.fallback),
        )
      : null,
  );
}
