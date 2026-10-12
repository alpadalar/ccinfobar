import { parseColor } from '../core/ansi.js';
import { normalizeTui } from '../core/config.js';
import { setOption, updateItem } from '../core/edit.js';
import { BOX_PRESETS } from '../core/panel.js';
import { resolveAppearance } from '../core/renderer.js';
import { resolveTheme, STYLES } from '../core/themes.js';
import type { Config, OptionChoice, OptionValue, TuiConfig, WidgetDef, WidgetItem } from '../core/types.js';

export type FieldKind = 'bool' | 'text' | 'number' | 'select' | 'color' | 'theme';

export type Parsed = { ok: true; value: OptionValue | undefined } | { ok: false; error: string };

export interface Field {
  id: string;
  label: string;
  kind: FieldKind;
  help?: string;
  choices?: OptionChoice[];
  fallback?: OptionValue;
  defaultEntry?: string;
  effective?(config: Config): OptionValue | undefined;
  editValue?(config: Config): string;
  range?: [number, number];
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
  const list: ListEntry[] = (field.choices ?? []).map((c) => ({ value: c.value, label: c.label }));
  return field.defaultEntry ? [{ value: undefined, label: field.defaultEntry }, ...list] : list;
}

export function listCursorFor(field: Field, config: Config): number {
  const entries = listEntries(field);
  const cur = field.defaultEntry ? field.get(config) : (field.get(config) ?? field.fallback);
  const at = entries.findIndex(
    (e) => e.value !== CUSTOM && e.value === (cur === undefined ? undefined : String(cur)),
  );
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
        label: {
          bold: 'Bold',
          dim: 'Dim',
          italic: 'Italic',
          raw: 'Raw (no label)',
          merge: 'Merge with previous',
        }[key],
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
    kind: spec.kind === 'boolean' ? 'bool' : spec.kind,
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

function withKey<K extends 'style' | 'separator' | 'separatorColor' | 'padding'>(
  config: Config,
  key: K,
  value: Config[K] | undefined,
): Config {
  const next = { ...config };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

type GlyphKey = 'separator' | 'thin' | 'startCap' | 'endCap';

function glyphField(key: GlyphKey, label: string): Field {
  return overrideField({
    id: `glyphs.${key}`,
    label,
    kind: 'text',
    get: (c) => c.glyphs?.[key],
    effective: (c) => resolveAppearance(c).glyphs[key],
    set: (c, v) => {
      const glyphs = { ...c.glyphs };
      if (v === undefined) delete glyphs[key];
      else glyphs[key] = String(v);
      const next = { ...c };
      if (Object.keys(glyphs).length) next.glyphs = glyphs;
      else delete next.glyphs;
      return next;
    },
  });
}

function overrideField(
  spec: Pick<Field, 'id' | 'label' | 'kind' | 'get' | 'set' | 'effective'> & Partial<Field>,
): Field {
  return {
    resettable: true,
    help: 'Del resets to the theme value',
    parse: spec.kind === 'number' ? parseNumberText : spec.kind === 'color' ? parseColorText : parseText,
    ...spec,
  };
}

type TuiKey = 'box' | 'fitContent' | 'minWidth' | 'maxWidth' | 'padding' | 'dividers';

function setTui(config: Config, patch: (t: TuiConfig) => void): Config {
  const tui: TuiConfig = { ...config.tui };
  patch(tui);
  for (const k of ['title', 'footer'] as const) {
    if (tui[k] && !Object.keys(tui[k]!).length) delete tui[k];
  }
  const next = { ...config };
  if (Object.keys(tui).length) next.tui = tui;
  else delete next.tui;
  return next;
}

function tuiField(key: TuiKey, label: string, kind: FieldKind, extra: Partial<Field> = {}): Field {
  return overrideField({
    id: `tui.${key}`,
    label,
    kind,
    get: (c) => {
      const v = c.tui?.[key];
      return typeof v === 'object' ? 'custom' : v;
    },
    set: (c, v) =>
      setTui(c, (t) => {
        if (v === undefined) delete t[key];
        else (t as Record<string, unknown>)[key] = v;
      }),
    ...extra,
  });
}

const rangeParser =
  (min: number, max: number): Field['parse'] =>
  (text) => {
    const n = Number(text.trim());
    if (!text.trim() || !Number.isInteger(n) || n < min || n > max) {
      return { ok: false, error: `Enter a whole number from ${min} to ${max}` };
    }
    return { ok: true, value: n };
  };

function sideField(
  group: 'title' | 'footer',
  side: 'left' | 'right',
  label: string,
  fallback?: string,
): Field {
  const hideable = group === 'title' && side === 'right';
  const f = overrideField({
    id: `tui.${group}.${side}`,
    label,
    kind: 'text',
    get: (c) => {
      const v = c.tui?.[group]?.[side];
      return v === false ? 'off' : v;
    },
    set: (c, v) =>
      setTui(c, (t) => {
        const cur: Record<string, unknown> = { ...t[group] };
        if (v === undefined) delete cur[side];
        else cur[side] = hideable && v === 'off' ? false : String(v);
        (t as Record<string, unknown>)[group] = cur;
      }),
    help: hideable
      ? "Text with {widgets}; type 'off' to hide. Del resets"
      : 'Text with {widget} placeholders. Del resets',
  });
  if (fallback !== undefined) f.fallback = fallback;
  return f;
}

function gridField(): Field {
  const sample = '[{"minWidth":0,"areas":["model cwd","git-branch"]}]';
  return overrideField({
    id: 'tui.breakpoints',
    label: 'Grid layout',
    kind: 'text',
    help: `JSON array of breakpoints, e.g. ${sample}. Del removes`,
    get: (c) => {
      const n = c.tui?.breakpoints?.length ?? 0;
      return n ? `${n} breakpoint${n === 1 ? '' : 's'}` : undefined;
    },
    editValue: (c) => (c.tui?.breakpoints?.length ? JSON.stringify(c.tui.breakpoints) : ''),
    set: (c, v) =>
      setTui(c, (t) => {
        if (v === undefined || v === '') delete t.breakpoints;
        else t.breakpoints = normalizeTui({ breakpoints: JSON.parse(String(v)) })?.breakpoints ?? [];
      }),
    parse: (text) => {
      const t = text.trim();
      if (!t) return { ok: true, value: undefined };
      let raw: unknown;
      try {
        raw = JSON.parse(t);
      } catch (err) {
        return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
      }
      if (!Array.isArray(raw)) return { ok: false, error: 'Expected a JSON array of breakpoints' };
      const bps = normalizeTui({ breakpoints: raw })?.breakpoints ?? [];
      if (!bps.length || bps.length !== raw.length) {
        return { ok: false, error: 'Each breakpoint needs "areas": ["row of widget ids", ...]' };
      }
      return { ok: true, value: JSON.stringify(raw) };
    },
  });
}

export function panelFields(): Field[] {
  return [
    tuiField('box', 'Panel: box', 'select', {
      defaultEntry: 'theme default',
      choices: Object.keys(BOX_PRESETS).map((value) => ({ value, label: value })),
      effective: () => 'rounded',
    }),
    tuiField('fitContent', 'Panel: fit content', 'bool', { fallback: false }),
    tuiField('minWidth', 'Panel: min width', 'number', {
      fallback: 32,
      parse: rangeParser(10, 500),
      range: [10, 500],
    }),
    tuiField('maxWidth', 'Panel: max width', 'number', { parse: rangeParser(10, 500), range: [10, 500] }),
    tuiField('padding', 'Panel: padding', 'number', { fallback: 1, parse: rangeParser(0, 8), range: [0, 8] }),
    tuiField('dividers', 'Panel: dividers', 'bool', { fallback: true }),
    sideField('title', 'left', 'Panel: title left', '{model}'),
    sideField('title', 'right', 'Panel: title right', 'ccinfobar'),
    sideField('footer', 'left', 'Panel: footer left'),
    sideField('footer', 'right', 'Panel: footer right'),
    gridField(),
  ];
}

export function globalFields(config?: Config): Field[] {
  const panel = config && resolveAppearance(config).style === 'tui' ? panelFields() : [];
  const all = baseGlobalFields();
  all.splice(2, 0, ...panel);
  return all;
}

function baseGlobalFields(): Field[] {
  return [
    {
      id: 'theme',
      label: 'Theme',
      kind: 'theme',
      help: 'Enter opens the theme picker',
      resettable: false,
      get: (c) => c.theme,
      set: (c) => c,
      effective: (c) => resolveTheme(c.theme).name,
      parse: parseText,
    },
    overrideField({
      id: 'style',
      label: 'Style',
      kind: 'select',
      defaultEntry: 'theme default',
      choices: STYLES.map((x) => ({ value: x.id, label: x.name })),
      get: (c) => c.style,
      effective: (c) => resolveAppearance(c).style,
      set: (c, v) => withKey(c, 'style', v as Config['style']),
    }),
    overrideField({
      id: 'separator',
      label: 'Separator',
      kind: 'text',
      get: (c) => c.separator,
      effective: (c) => resolveAppearance(c).separator,
      set: (c, v) => withKey(c, 'separator', v === undefined ? undefined : String(v)),
    }),
    overrideField({
      id: 'separatorColor',
      label: 'Separator color',
      kind: 'color',
      get: (c) => c.separatorColor,
      effective: (c) => resolveAppearance(c).separatorColor,
      set: (c, v) => withKey(c, 'separatorColor', v === undefined ? undefined : String(v)),
    }),
    overrideField({
      id: 'padding',
      label: 'Padding',
      kind: 'number',
      get: (c) => c.padding,
      effective: (c) => resolveAppearance(c).padding,
      set: (c, v) =>
        withKey(c, 'padding', v === undefined ? undefined : Math.max(0, Math.min(4, Math.floor(Number(v))))),
    }),
    glyphField('separator', 'Glyph: separator'),
    glyphField('thin', 'Glyph: thin separator'),
    glyphField('startCap', 'Glyph: start cap'),
    glyphField('endCap', 'Glyph: end cap'),
    globalField(
      'charset',
      'Charset',
      'select',
      (c) => c.charset,
      (c, v) => ({
        ...c,
        charset: v === 'nerd' || v === 'unicode' || v === 'text' ? v : 'auto',
      }),
      {
        choices: choices(['auto', 'nerd', 'unicode', 'text']),
        help: 'auto: Nerd Font glyphs except in Apple Terminal · unicode: no Nerd Font needed · text: ASCII only',
      },
    ),
    globalField(
      'autoWrap',
      'Auto wrap',
      'bool',
      (c) => c.autoWrap,
      (c, v) => ({ ...c, autoWrap: Boolean(v) }),
      { help: 'Wrap widgets onto extra rows when the line is too wide' },
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
          return Number.isFinite(n) && n > 0
            ? { ok: true, value: Math.floor(n) }
            : { ok: false, error: "Enter 'auto' or a positive number" };
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
    globalField(
      'savePayload',
      'Save last payload',
      'bool',
      (c) => c.savePayload,
      (c, v) => ({ ...c, savePayload: Boolean(v) }),
      { help: 'Lets the preview use your last real session data' },
    ),
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
    const cur = Number(field.get(config) ?? field.effective?.(config) ?? field.fallback ?? 0);
    const next = (Number.isFinite(cur) ? cur : 0) + delta;
    return field.range ? Math.max(field.range[0], Math.min(field.range[1], next)) : next;
  }
  if (field.kind === 'select') {
    const list = field.choices ?? [];
    if (!list.length) return undefined;
    const cur = String(field.get(config) ?? field.effective?.(config) ?? field.fallback ?? '');
    const at = list.findIndex((c) => c.value === cur);
    return list[(at + delta + list.length * 2) % list.length]!.value;
  }
  return undefined;
}

export function displayValue(field: Field, config: Config): { text: string; isDefault: boolean } {
  const raw = field.get(config);
  const value =
    field.kind === 'theme' ? field.effective?.(config) : (raw ?? field.effective?.(config) ?? field.fallback);
  const isDefault = field.kind !== 'theme' && (raw === undefined || (field.kind === 'color' && raw === ''));
  if (value === undefined || value === '') {
    if (field.kind === 'bool') return { text: 'off', isDefault: true };
    return { text: field.kind === 'color' ? 'default' : '—', isDefault: true };
  }
  if (field.kind === 'bool') return { text: value ? 'on' : 'off', isDefault };
  if (field.kind === 'select') {
    const c = field.choices?.find((x) => x.value === String(value));
    const label = c?.label ?? String(value);
    return { text: isDefault && field.effective ? `${label}  (theme)` : label, isDefault };
  }
  const text = String(value);
  return { text: isDefault && field.effective ? `${text}  (theme)` : text, isDefault };
}

export function editText(field: Field, config: Config): string {
  if (field.editValue) return field.editValue(config);
  const v = field.get(config);
  return v === undefined ? '' : String(v);
}
