import { parseColor } from '../core/ansi.js';
import { setOption, updateItem } from '../core/edit.js';
import { THEMES } from '../core/themes.js';
import type { Config, OptionChoice, OptionValue, WidgetDef, WidgetItem } from '../core/types.js';

export type FieldKind = 'bool' | 'text' | 'number' | 'select' | 'color';

export type Parsed = { ok: true; value: OptionValue | undefined } | { ok: false; error: string };

export interface Field {
  id: string;
  label: string;
  kind: FieldKind;
  help?: string;
  choices?: OptionChoice[];
  fallback?: OptionValue;
  resettable: boolean;
  get(config: Config): OptionValue | undefined;
  set(config: Config, value: OptionValue | undefined): Config;
  parse(text: string): Parsed;
}

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

export const CUSTOM = '\u0000custom';

export interface ListEntry {
  value: string | undefined;
  label: string;
}

export function listEntries(field: Field): ListEntry[] {
  if (field.kind === 'color') {
    return [
      { value: undefined, label: 'default' },
      ...COLOR_NAMES.map((c) => ({ value: c, label: c })),
      { value: CUSTOM, label: 'custom…' },
    ];
  }
  return (field.choices ?? []).map((c) => ({ value: c.value, label: c.label }));
}

export function listCursorFor(field: Field, config: Config): number {
  const entries = listEntries(field);
  const cur = field.get(config) ?? field.fallback;
  const at = entries.findIndex((e) => e.value !== CUSTOM && e.value === (cur === undefined ? undefined : String(cur)));
  if (at >= 0) return at;
  if (field.kind === 'color' && cur !== undefined && cur !== '') return entries.length - 1;
  return 0;
}

const parseText = (text: string): Parsed => ({ ok: true, value: text });

const parseColorText = (text: string): Parsed => {
  const t = text.trim();
  if (!t || t === 'default') return { ok: true, value: undefined };
  if (!parseColor(t)) return { ok: false, error: 'Use a color name, #rrggbb or ansi256:N' };
  return { ok: true, value: t };
};

const parseNumberText = (text: string): Parsed => {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n)) return { ok: false, error: 'Enter a number' };
  return { ok: true, value: n };
};

function baseField(
  key: 'color' | 'background' | 'bold' | 'dim' | 'italic' | 'label' | 'raw' | 'merge',
  itemId: string,
): Field {
  const get = (config: Config) => {
    for (const line of config.lines) {
      const it = line.find((i) => i.id === itemId);
      if (it) return it[key];
    }
    return undefined;
  };
  const set = (config: Config, value: OptionValue | undefined) =>
    updateItem(config, itemId, { [key]: value } as Partial<WidgetItem>);
  switch (key) {
    case 'color':
    case 'background':
      return {
        id: key,
        label: key === 'color' ? 'Color' : 'Background',
        kind: 'color',
        resettable: true,
        get,
        set,
        parse: parseColorText,
      };
    case 'label':
      return {
        id: key,
        label: 'Label',
        kind: 'text',
        help: 'Replaces the widget label text',
        resettable: true,
        get,
        set,
        parse: (t) => ({ ok: true, value: t === '' ? undefined : t }),
      };
    default:
      return {
        id: key,
        label: { bold: 'Bold', dim: 'Dim', italic: 'Italic', raw: 'Raw (no label)', merge: 'Merge with previous' }[
          key
        ],
        kind: 'bool',
        resettable: true,
        get,
        set,
        parse: parseText,
      };
  }
}

function optionField(spec: NonNullable<WidgetDef['options']>[number], itemId: string): Field {
  const field: Field = {
    id: `option:${spec.key}`,
    label: spec.label,
    kind: spec.kind,
    fallback: spec.default,
    resettable: true,
    get: (config) => {
      for (const line of config.lines) {
        const it = line.find((i) => i.id === itemId);
        if (it) return it.options?.[spec.key];
      }
      return undefined;
    },
    set: (config, value) => setOption(config, itemId, spec.key, value),
    parse: spec.kind === 'number' ? parseNumberText : parseText,
  };
  if (spec.help) field.help = spec.help;
  if (spec.choices) field.choices = spec.choices;
  return field;
}

export function widgetFields(def: WidgetDef | undefined, itemId: string): Field[] {
  const base = (['color', 'background', 'bold', 'dim', 'italic', 'label', 'raw', 'merge'] as const).map((k) =>
    baseField(k, itemId),
  );
  return [...base, ...(def?.options ?? []).map((o) => optionField(o, itemId))];
}

function globalField(
  id: string,
  label: string,
  kind: FieldKind,
  get: Field['get'],
  set: (config: Config, value: OptionValue) => Config,
  extra: Partial<Field> = {},
): Field {
  return {
    id,
    label,
    kind,
    resettable: false,
    get,
    set: (config, value) => (value === undefined ? config : set(config, value)),
    parse: kind === 'number' ? parseNumberText : kind === 'color' ? parseColorText : parseText,
    ...extra,
  };
}

const choices = (values: string[]): OptionChoice[] => values.map((v) => ({ value: v, label: v }));

export function globalFields(): Field[] {
  const pl = (patch: Partial<Config['powerline']>) => (config: Config) => ({
    ...config,
    powerline: { ...config.powerline, ...patch },
  });
  return [
    globalField('separator', 'Separator', 'text', (c) => c.separator, (c, v) => ({ ...c, separator: String(v) })),
    globalField(
      'separatorColor',
      'Separator color',
      'color',
      (c) => c.separatorColor,
      (c, v) => ({ ...c, separatorColor: String(v) }),
      {
        resettable: true,
        set: (c, v) => ({ ...c, separatorColor: v === undefined ? '' : String(v) }),
      },
    ),
    globalField(
      'padding',
      'Padding',
      'number',
      (c) => c.padding,
      (c, v) => ({ ...c, padding: Math.max(0, Math.min(4, Math.floor(Number(v)))) }),
    ),
    globalField(
      'icons',
      'Icons',
      'select',
      (c) => c.icons,
      (c, v) => ({ ...c, icons: String(v) as Config['icons'] }),
      { choices: choices(['nerd', 'emoji', 'text', 'none']) },
    ),
    globalField(
      'colorLevel',
      'Color level',
      'select',
      (c) => String(c.colorLevel),
      (c, v) => ({ ...c, colorLevel: (v === 'auto' ? 'auto' : Number(v)) as Config['colorLevel'] }),
      {
        choices: [
          { value: 'auto', label: 'auto' },
          { value: '0', label: '0 (none)' },
          { value: '1', label: '1 (16 colors)' },
          { value: '2', label: '2 (256 colors)' },
          { value: '3', label: '3 (truecolor)' },
        ],
      },
    ),
    globalField(
      'maxWidth',
      'Max width',
      'text',
      (c) => c.maxWidth,
      (c, v) => {
        const n = Number(v);
        return { ...c, maxWidth: n > 0 ? Math.floor(n) : 'auto' };
      },
      {
        help: "'auto' or a column count",
        parse: (t) => {
          const s = t.trim().toLowerCase();
          if (s === 'auto' || s === '') return { ok: true, value: 'auto' };
          const n = Number(s);
          return Number.isFinite(n) && n > 0 ? { ok: true, value: Math.floor(n) } : { ok: false, error: "Enter 'auto' or a positive number" };
        },
      },
    ),
    globalField(
      'widthOffset',
      'Width offset',
      'number',
      (c) => c.widthOffset,
      (c, v) => ({ ...c, widthOffset: Math.max(0, Math.floor(Number(v))) }),
    ),
    globalField('powerline.enabled', 'Powerline', 'bool', (c) => c.powerline.enabled, (c, v) => pl({ enabled: Boolean(v) })(c)),
    globalField(
      'powerline.theme',
      'Powerline theme',
      'select',
      (c) => c.powerline.theme,
      (c, v) => pl({ theme: String(v) })(c),
      { choices: Object.entries(THEMES).map(([value, t]) => ({ value, label: t.name })) },
    ),
    globalField('powerline.separator', 'Powerline separator', 'text', (c) => c.powerline.separator, (c, v) =>
      pl({ separator: String(v) })(c),
    ),
    globalField('powerline.startCap', 'Powerline start cap', 'text', (c) => c.powerline.startCap, (c, v) =>
      pl({ startCap: String(v) })(c),
    ),
    globalField('powerline.endCap', 'Powerline end cap', 'text', (c) => c.powerline.endCap, (c, v) =>
      pl({ endCap: String(v) })(c),
    ),
    globalField('savePayload', 'Save last payload', 'bool', (c) => c.savePayload, (c, v) => ({
      ...c,
      savePayload: Boolean(v),
    }), { help: 'Lets the preview use your last real session data' }),
  ];
}

const STYLE_FLAGS = ['bold', 'dim', 'italic', 'raw', 'merge'];

export function toggled(field: Field, config: Config): OptionValue | undefined {
  const cur = field.get(config);
  if (STYLE_FLAGS.includes(field.id)) return cur === true ? undefined : true;
  return !(cur ?? field.fallback ?? false);
}

export function cycled(field: Field, config: Config, delta: 1 | -1): OptionValue | undefined {
  if (field.kind === 'bool') return toggled(field, config);
  if (field.kind === 'number') {
    const cur = Number(field.get(config) ?? field.fallback ?? 0);
    return (Number.isFinite(cur) ? cur : 0) + delta;
  }
  if (field.kind === 'select') {
    const list = field.choices ?? [];
    if (!list.length) return undefined;
    const cur = String(field.get(config) ?? field.fallback ?? '');
    const at = list.findIndex((c) => c.value === cur);
    return list[(at + delta + list.length * 2) % list.length]!.value;
  }
  return undefined;
}

export function displayValue(field: Field, config: Config): { text: string; isDefault: boolean } {
  const raw = field.get(config);
  const value = raw ?? field.fallback;
  const isDefault = raw === undefined || (field.kind === 'color' && raw === '');
  if (value === undefined || value === '') {
    if (field.kind === 'bool') return { text: 'off', isDefault: true };
    return { text: field.kind === 'color' ? 'default' : '—', isDefault: true };
  }
  if (field.kind === 'bool') return { text: value ? 'on' : 'off', isDefault };
  if (field.kind === 'select') {
    const c = field.choices?.find((x) => x.value === String(value));
    return { text: c?.label ?? String(value), isDefault };
  }
  return { text: String(value), isDefault };
}

export function editText(field: Field, config: Config): string {
  const v = field.get(config);
  return v === undefined ? '' : String(v);
}
