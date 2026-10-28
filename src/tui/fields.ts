import { parseColor } from '../core/ansi.js';
import { BREW_UPGRADE } from '../core/brew.js';
import { describeRuleError, type RuleKey, validateRule } from '../core/conditions.js';
import { normalizeTui } from '../core/config.js';
import {
  defaultPriority,
  effectiveOverflow,
  findItem,
  GLYPH_MODE_CHOICES,
  OVERFLOW_CHOICES,
  optionShown,
  PROGRESS_CHOICES,
  PROGRESS_DEFAULTS,
  RULE_PRESETS,
  ruleFromText,
  rulePreset,
  ruleToText,
  setAmbiguousWidth,
  setBudget,
  setGlyphMode,
  setItemRule,
  setLanguageSetting,
  setOption,
  setOverflow,
  setPriority,
  setProfilesBuiltIn,
  setProgress,
  setRotationEvery,
  setRotationOrder,
  setThemeRotation,
  updateItem,
} from '../core/edit.js';
import { styleText } from '../core/i18n/catalog-text.js';
import { type LanguageId, type LanguageSetting, type MessageId, t } from '../core/i18n/index.js';
import { LANGUAGES, nativeName } from '../core/i18n/languages.js';
import { choiceLabel, optionHelp, optionLabel } from '../core/i18n/widget-text.js';
import { BOX_PRESETS } from '../core/panel.js';
import { resolveAppearance } from '../core/renderer.js';
import { formatWeekdays, parseEvery, parseWeekdays } from '../core/rotation.js';
import { sanitizeText } from '../core/sanitize.js';
import { activeThemeId, resolveTheme, STYLES, themeExists } from '../core/themes.js';
import type {
  Config,
  GlyphMode,
  OptionChoice,
  OptionValue,
  OverflowMode,
  ProgressConfig,
  TuiConfig,
  WidgetDef,
  WidgetItem,
} from '../core/types.js';

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
  locked?(config: Config): boolean;
  disabled?(config: Config): string | undefined;
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
      { value: undefined, label: t('tui.value.default') },
      ...COLOR_NAMES.map((c) => ({ value: c, label: c })),
      { value: CUSTOM, label: t('tui.value.custom') },
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
  const s = text.trim();
  if (!s || s === 'default' || s === t('tui.value.default')) return { ok: true, value: undefined };
  if (!parseColor(s)) return { ok: false, error: t('tui.parse.color') };
  return { ok: true, value: s };
};

const parseNumberText = (text: string): Parsed => {
  const n = Number(text.trim());
  if (!text.trim() || !Number.isFinite(n)) return { ok: false, error: t('tui.parse.number') };
  return { ok: true, value: n };
};

const BASE_LABELS = {
  bold: 'tui.field.bold',
  dim: 'tui.field.dim',
  italic: 'tui.field.italic',
  raw: 'tui.field.raw',
  merge: 'tui.field.merge',
  hideEmpty: 'tui.field.hideEmpty',
} as const satisfies Record<string, MessageId>;

function baseField(
  key: 'color' | 'background' | 'bold' | 'dim' | 'italic' | 'label' | 'raw' | 'merge' | 'hideEmpty',
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
        label: key === 'color' ? t('tui.field.color') : t('tui.field.background'),
        kind: 'color',
        resettable: true,
        get,
        set,
        parse: parseColorText,
      };
    case 'label':
      return {
        id: key,
        label: t('tui.field.label'),
        kind: 'text',
        help: t('tui.field.labelHelp'),
        resettable: true,
        get,
        set,
        parse: (v) => ({ ok: true, value: v === '' ? undefined : v }),
      };
    default:
      return {
        id: key,
        label: t(BASE_LABELS[key]),
        kind: 'bool',
        resettable: true,
        get,
        set,
        parse: parseText,
      };
  }
}

function optionField(def: WidgetDef, spec: NonNullable<WidgetDef['options']>[number], itemId: string): Field {
  const field: Field = {
    id: `option:${spec.key}`,
    label: optionLabel(def, spec),
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
  const help = optionHelp(def, spec);
  if (help) field.help = help;
  if (spec.choices)
    field.choices = spec.choices.map((c) => ({ value: c.value, label: choiceLabel(def, spec, c) }));
  return field;
}

export function widgetFields(def: WidgetDef | undefined, itemId: string, config?: Config): Field[] {
  const base = (
    ['color', 'background', 'bold', 'dim', 'italic', 'label', 'raw', 'merge', 'hideEmpty'] as const
  ).map((k) => baseField(k, itemId));
  if (def?.hideWhenEmpty) for (const f of base) if (f.id === 'hideEmpty') f.fallback = true;
  const specs = def?.options ?? [];
  const options = config?.lines.flat().find((i) => i.id === itemId)?.options;
  const shown = specs.filter((o) => optionShown(o, specs, options));
  const priority = def?.category === 'layout' ? [] : [priorityField(itemId, defaultPriority(def?.category))];
  return [
    ...base,
    ...visibilityFields(itemId, config),
    ...priority,
    ...(def ? shown.map((o) => optionField(def, o, itemId)) : []),
  ];
}

export function priorityField(itemId: string, fallback: number): Field {
  return {
    id: 'priority',
    label: t('opt.priority'),
    kind: 'number',
    help: t('tui.field.priorityHelp', { help: t('opt.priorityHelp'), n: fallback }),
    fallback,
    range: [0, 100],
    resettable: true,
    get: (c) => findItem(c, itemId)?.item.priority,
    set: (c, v) => setPriority(c, itemId, v === undefined ? undefined : Number(v)),
    parse: (text) => (text.trim() ? rangeParser(0, 100)(text) : { ok: true, value: undefined }),
  };
}

const CUSTOM_RULE = 'custom';
const visLabel = (id: 'vis.preset' | 'vis.showWhen' | 'vis.hideWhen') => `${t('vis.section')}: ${t(id)}`;

function presetField(itemId: string, config?: Config): Field {
  const preset = (c: Config) => {
    const it = findItem(c, itemId)?.item;
    return it ? (rulePreset(it) ?? CUSTOM_RULE) : undefined;
  };
  const list: OptionChoice[] = RULE_PRESETS.map((p) => ({ value: p.id, label: t(p.label) }));
  if (config && preset(config) === CUSTOM_RULE) list.push({ value: CUSTOM_RULE, label: t('vis.custom') });
  return {
    id: 'vis.preset',
    label: visLabel('vis.preset'),
    kind: 'select',
    help: t('vis.presetHelp'),
    choices: list,
    fallback: 'none',
    resettable: true,
    locked: (c) => preset(c) === CUSTOM_RULE,
    get: (c) => {
      const p = preset(c);
      return p === 'none' ? undefined : p;
    },
    set: (c, v) => {
      if (preset(c) === CUSTOM_RULE) return c;
      const rule = RULE_PRESETS.find((p) => p.id === v)?.rule ?? undefined;
      const r = setItemRule(c, itemId, 'showWhen', rule);
      return r.ok ? r.config : c;
    },
    parse: parseText,
  };
}

function ruleField(key: RuleKey, itemId: string, config?: Config): Field {
  const raw = (c: Config) => findItem(c, itemId)?.item[key];
  const stored = config ? raw(config) : undefined;
  const bad = stored === undefined ? null : validateRule(stored);
  const help = t('vis.help');
  return {
    id: `vis.${key}`,
    label: visLabel(`vis.${key}`),
    kind: 'text',
    help: bad ? `${t('vis.ignored', { problem: sanitizeText(describeRuleError(bad)) })} · ${help}` : help,
    resettable: true,
    get: (c) => {
      const v = raw(c);
      return v === undefined ? undefined : sanitizeText(ruleToText(v));
    },
    set: (c, v) => {
      const r = setItemRule(c, itemId, key, v === undefined ? undefined : ruleFromText(String(v)));
      return r.ok ? r.config : c;
    },
    parse: (text) => {
      const rule = ruleFromText(text);
      if (rule === undefined) return { ok: true, value: undefined };
      const e = validateRule(rule);
      return e ? { ok: false, error: describeRuleError(e) } : { ok: true, value: text.trim() };
    },
  };
}

export function visibilityFields(itemId: string, config?: Config): Field[] {
  return [
    presetField(itemId, config),
    ruleField('showWhen', itemId, config),
    ruleField('hideWhen', itemId, config),
  ];
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
    help: t('tui.field.resetToTheme'),
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
      return { ok: false, error: t('tui.parse.range', { min, max }) };
    }
    return { ok: true, value: n };
  };

const parseUsd: Field['parse'] = (text) => {
  const s = text.trim().replace(/^\$/, '');
  if (!s) return { ok: true, value: undefined };
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? { ok: true, value: n } : { ok: false, error: t('tui.parse.amount') };
};

function budgetField(id: string, key: 'daily' | 'session', label: string): Field {
  return {
    id,
    label,
    kind: 'number',
    resettable: true,
    help: t('tui.field.budgetHelp'),
    get: (c) => c.budget?.[key],
    set: (c, v) => setBudget(c, key, v === undefined ? undefined : Number(v)),
    parse: parseUsd,
  };
}

function budgetFields(): Field[] {
  return [
    budgetField('budget.daily', 'daily', t('tui.field.budgetDaily')),
    budgetField('budget.session', 'session', t('tui.field.budgetSession')),
    {
      id: 'budget.warnAt',
      label: t('tui.field.budgetWarnAt'),
      kind: 'number',
      resettable: true,
      fallback: 80,
      range: [5, 100],
      help: t('tui.field.budgetWarnAtHelp', { n: 80 }),
      get: (c) => (c.budget?.warnAt === undefined ? undefined : Math.round(c.budget.warnAt * 100)),
      set: (c, v) => setBudget(c, 'warnAt', v === undefined ? undefined : Number(v) / 100),
      parse: rangeParser(5, 100),
    },
  ];
}

type ProgressChoiceKey = keyof typeof PROGRESS_CHOICES;

function progressSelect(key: ProgressChoiceKey, help: string): Field {
  return globalField(
    `progress.${key}`,
    t(`prog.${key}`),
    'select',
    (c) => c.progress?.[key],
    (c, v) => setProgress(c, { [key]: v } as Partial<ProgressConfig>),
    {
      fallback: PROGRESS_DEFAULTS[key],
      choices: PROGRESS_CHOICES[key].map((v) => ({ value: v, label: t(`prog.${key}.${v}` as MessageId) })),
      help,
    },
  );
}

function progressLevel(key: 'warnAt' | 'errorAt'): Field {
  return {
    id: `progress.${key}`,
    label: t(`prog.${key}`),
    kind: 'number',
    resettable: true,
    fallback: PROGRESS_DEFAULTS[key],
    range: [1, 100],
    help: t('tui.field.levelHelp', { help: t('prog.levelHelp'), n: PROGRESS_DEFAULTS[key] }),
    get: (c) => c.progress?.[key],
    set: (c, v) => setProgress(c, { [key]: v === undefined ? undefined : Number(v) }),
    parse: rangeParser(1, 100),
  };
}

function progressFields(): Field[] {
  return [
    globalField(
      'progress.enabled',
      t('prog.tuiToggle'),
      'bool',
      (c) => c.progress?.enabled === true,
      (c, v) => setProgress(c, { enabled: Boolean(v) }),
      { help: t('prog.tuiHelp') },
    ),
    progressSelect('source', t('prog.sourceHelp')),
    progressSelect('scaleTo', t('prog.scaleHelp')),
    progressLevel('warnAt'),
    progressLevel('errorAt'),
    progressSelect('channel', t('prog.tuiChannelHelp')),
    progressSelect('terminals', t('prog.terminalsHelp')),
    globalField(
      'progress.tmuxPassthrough',
      t('prog.tmux'),
      'bool',
      (c) => c.progress?.tmuxPassthrough === true,
      (c, v) => setProgress(c, { tmuxPassthrough: Boolean(v) }),
      { help: t('prog.tmuxHelp') },
    ),
  ];
}

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
    help: hideable ? t('tui.panel.titleRightHelp') : t('tui.panel.sideHelp'),
  });
  if (fallback !== undefined) f.fallback = fallback;
  return f;
}

function gridField(): Field {
  const sample = '[{"minWidth":0,"areas":["model cwd","git-branch"]}]';
  return overrideField({
    id: 'tui.breakpoints',
    label: t('tui.panel.grid'),
    kind: 'text',
    help: t('tui.panel.gridHelp', { sample }),
    get: (c) => {
      const n = c.tui?.breakpoints?.length ?? 0;
      return n ? t('tui.panel.breakpoints', { count: n }) : undefined;
    },
    editValue: (c) => (c.tui?.breakpoints?.length ? JSON.stringify(c.tui.breakpoints) : ''),
    set: (c, v) =>
      setTui(c, (t) => {
        if (v === undefined || v === '') delete t.breakpoints;
        else t.breakpoints = normalizeTui({ breakpoints: JSON.parse(String(v)) })?.breakpoints ?? [];
      }),
    parse: (text) => {
      const s = text.trim();
      if (!s) return { ok: true, value: undefined };
      let raw: unknown;
      try {
        raw = JSON.parse(s);
      } catch (err) {
        return { ok: false, error: t('tui.parse.json', { message: (err as Error).message }) };
      }
      if (!Array.isArray(raw)) return { ok: false, error: t('tui.parse.breakpointArray') };
      const bps = normalizeTui({ breakpoints: raw })?.breakpoints ?? [];
      if (!bps.length || bps.length !== raw.length) {
        return { ok: false, error: t('tui.parse.breakpointAreas') };
      }
      return { ok: true, value: JSON.stringify(raw) };
    },
  });
}

export function panelFields(): Field[] {
  return [
    tuiField('box', t('tui.panel.box'), 'select', {
      defaultEntry: t('tui.field.themeDefault'),
      choices: Object.keys(BOX_PRESETS).map((value) => ({ value, label: value })),
      effective: () => 'rounded',
    }),
    tuiField('fitContent', t('tui.panel.fitContent'), 'bool', { fallback: false }),
    tuiField('minWidth', t('tui.panel.minWidth'), 'number', {
      fallback: 32,
      parse: rangeParser(10, 500),
      range: [10, 500],
    }),
    tuiField('maxWidth', t('tui.panel.maxWidth'), 'number', {
      parse: rangeParser(10, 500),
      range: [10, 500],
    }),
    tuiField('padding', t('tui.panel.padding'), 'number', {
      fallback: 1,
      parse: rangeParser(0, 8),
      range: [0, 8],
    }),
    tuiField('dividers', t('tui.panel.dividers'), 'bool', { fallback: true }),
    sideField('title', 'left', t('tui.panel.titleLeft'), '{model}'),
    sideField('title', 'right', t('tui.panel.titleRight'), 'ccinfobar'),
    sideField('footer', 'left', t('tui.panel.footerLeft')),
    sideField('footer', 'right', t('tui.panel.footerRight')),
    gridField(),
  ];
}

export function globalFields(config?: Config, autoLanguage?: LanguageId, brew = false): Field[] {
  const panel = config && resolveAppearance(config).style === 'tui' ? panelFields() : [];
  const all = baseGlobalFields(autoLanguage, brew);
  all.splice(all.findIndex((f) => f.id === 'style') + 1, 0, ...panel);
  return all;
}

function languageField(autoLanguage?: LanguageId): Field {
  return globalField(
    'language',
    t('tui.field.language'),
    'select',
    (c) => c.language ?? 'auto',
    (c, v) => setLanguageSetting(c, v as LanguageSetting),
    {
      choices: [
        { value: 'auto', label: t('tui.field.languageAuto', { name: nativeName(autoLanguage ?? 'en') }) },
        ...LANGUAGES.map((l) => ({ value: l.id, label: l.name })),
      ],
      help: t('tui.field.languageHelp'),
    },
  );
}

const splitIds = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

function rotationFields(): Field[] {
  return [
    {
      id: 'rotation.themes',
      label: t('tui.field.rotationThemes'),
      kind: 'text',
      resettable: true,
      help: t('tui.field.rotationThemesHelp'),
      get: (c) => c.themeRotation?.themes?.join(', '),
      set: (c, v) =>
        setThemeRotation(c, { ...c.themeRotation, themes: v === undefined ? [] : splitIds(String(v)) }),
      parse: (text) => {
        const ids = splitIds(text);
        const bad = ids.find((id) => !themeExists(id));
        if (bad !== undefined)
          return { ok: false, error: t('tui.parse.rotationTheme', { id: sanitizeText(bad) }) };
        return { ok: true, value: ids.length ? ids.join(', ') : undefined };
      },
    },
    {
      id: 'rotation.every',
      label: t('tui.field.rotationEvery'),
      kind: 'text',
      resettable: true,
      help: t('tui.field.rotationEveryHelp'),
      disabled: (c) => (c.themeRotation ? undefined : t('tui.field.rotationAddFirst')),
      get: (c) => c.themeRotation?.every,
      effective: (c) => (c.themeRotation ? (c.themeRotation.every ?? 'day') : undefined),
      set: (c, v) => setRotationEvery(c, v === undefined ? undefined : (parseEvery(String(v)) ?? undefined)),
      parse: (text) => {
        if (!text.trim()) return { ok: true, value: undefined };
        const every = parseEvery(text);
        return every === null
          ? { ok: false, error: t('tui.parse.rotationEvery') }
          : { ok: true, value: every };
      },
    },
    {
      id: 'rotation.order',
      label: t('tui.field.rotationOrder'),
      kind: 'select',
      resettable: true,
      defaultEntry: t('tui.field.rotationCycle'),
      disabled: (c) => (c.themeRotation ? undefined : t('tui.field.rotationAddFirst')),
      choices: [{ value: 'shuffle', label: t('tui.field.rotationShuffle') }],
      get: (c) => c.themeRotation?.order,
      set: (c, v) => setRotationOrder(c, v === 'shuffle' ? 'shuffle' : undefined),
      parse: parseText,
    },
    {
      id: 'rotation.weekdays',
      label: t('tui.field.rotationWeekdays'),
      kind: 'text',
      resettable: true,
      help: t('tui.field.rotationWeekdaysHelp'),
      get: (c) => formatWeekdays(c.themeRotation?.weekdays) || undefined,
      set: (c, v) => {
        const p = v === undefined ? null : parseWeekdays(String(v));
        return setThemeRotation(c, { ...c.themeRotation, weekdays: p?.ok ? p.map : {} });
      },
      parse: (text) => {
        const p = parseWeekdays(text);
        if (!p.ok)
          return { ok: false, error: t('tui.parse.rotationWeekdays', { value: sanitizeText(p.bad) }) };
        const bad = Object.values(p.map).find((id) => !themeExists(id));
        if (bad !== undefined)
          return { ok: false, error: t('tui.parse.rotationTheme', { id: sanitizeText(bad) }) };
        const out = formatWeekdays(p.map);
        return { ok: true, value: out || undefined };
      },
    },
  ];
}

function baseGlobalFields(autoLanguage?: LanguageId, brew = false): Field[] {
  return [
    {
      id: 'theme',
      label: t('tui.field.theme'),
      kind: 'theme',
      help: t('tui.field.themeHelp'),
      resettable: false,
      get: (c) => c.theme,
      set: (c) => c,
      effective: (c) =>
        c.themeRotation
          ? `${resolveTheme(activeThemeId(c)).name} ${t('tui.field.rotating')}`
          : resolveTheme(c.theme).name,
      parse: parseText,
    },
    overrideField({
      id: 'style',
      label: t('tui.field.style'),
      kind: 'select',
      defaultEntry: t('tui.field.themeDefault'),
      choices: STYLES.map((x) => ({ value: x.id, label: styleText(x, 'name') })),
      get: (c) => c.style,
      effective: (c) => resolveAppearance(c).style,
      set: (c, v) => withKey(c, 'style', v as Config['style']),
    }),
    overrideField({
      id: 'separator',
      label: t('tui.field.separator'),
      kind: 'text',
      get: (c) => c.separator,
      effective: (c) => resolveAppearance(c).separator,
      set: (c, v) => withKey(c, 'separator', v === undefined ? undefined : String(v)),
    }),
    overrideField({
      id: 'separatorColor',
      label: t('tui.field.separatorColor'),
      kind: 'color',
      get: (c) => c.separatorColor,
      effective: (c) => resolveAppearance(c).separatorColor,
      set: (c, v) => withKey(c, 'separatorColor', v === undefined ? undefined : String(v)),
    }),
    overrideField({
      id: 'padding',
      label: t('tui.field.padding'),
      kind: 'number',
      get: (c) => c.padding,
      effective: (c) => resolveAppearance(c).padding,
      set: (c, v) =>
        withKey(c, 'padding', v === undefined ? undefined : Math.max(0, Math.min(4, Math.floor(Number(v))))),
    }),
    glyphField('separator', t('tui.field.glyphSeparator')),
    glyphField('thin', t('tui.field.glyphThin')),
    glyphField('startCap', t('tui.field.glyphStartCap')),
    glyphField('endCap', t('tui.field.glyphEndCap')),
    ...rotationFields(),
    globalField(
      'loadingText',
      t('tui.field.loadingText'),
      'text',
      (c) => c.loadingText ?? t('loading.default'),
      (c, v) => {
        const { loadingText: _, ...rest } = c;
        const text = String(v).slice(0, 40);
        return text === t('loading.default') ? rest : { ...rest, loadingText: text };
      },
      { help: t('tui.field.loadingTextHelp') },
    ),
    globalField(
      'update',
      t('tui.field.updates'),
      'select',
      (c) => c.update,
      (c, v) => ({ ...c, update: v === 'notify' || v === 'off' ? v : 'auto' }),
      {
        choices: choices(['auto', 'notify', 'off']),
        help: brew ? t('tui.field.updatesHelpBrew', { command: BREW_UPGRADE }) : t('tui.field.updatesHelp'),
      },
    ),
    globalField(
      'charset',
      t('tui.field.charset'),
      'select',
      (c) => c.charset,
      (c, v) => ({
        ...c,
        charset: v === 'nerd' || v === 'unicode' || v === 'text' ? v : 'auto',
      }),
      {
        choices: choices(['auto', 'nerd', 'unicode', 'text']),
        help: t('tui.field.charsetHelp'),
      },
    ),
    globalField(
      'usageApi',
      t('tui.field.usageApi'),
      'bool',
      (c) => c.usageApi,
      (c, v) => ({ ...c, usageApi: Boolean(v) }),
      { help: t('tui.field.usageApiHelp') },
    ),
    globalField(
      'gitHardening',
      t('tui.field.gitHardening'),
      'bool',
      (c) => c.gitHardening !== false,
      (c, v) => ({ ...c, gitHardening: v ? undefined : false }),
      { help: t('tui.field.gitHardeningHelp') },
    ),
    globalField(
      'commandBudgetMs',
      t('tui.field.commandBudgetMs'),
      'number',
      (c) => c.commandBudgetMs,
      (c, v) => ({ ...c, commandBudgetMs: Math.min(60000, Math.max(100, Math.floor(Number(v)))) }),
      { help: t('tui.field.commandBudgetMsHelp') },
    ),
    globalField(
      'overflow',
      t('opt.overflow'),
      'select',
      (c) => effectiveOverflow(c),
      (c, v) => setOverflow(c, v as OverflowMode),
      {
        choices: OVERFLOW_CHOICES.map((v) => ({ value: v, label: t(`opt.overflow.${v}`) })),
        help: t('opt.overflowHelp'),
      },
    ),
    globalField(
      'glyphMode',
      t('opt.glyphMode'),
      'select',
      (c) => c.glyphMode ?? 'normal',
      (c, v) => setGlyphMode(c, v as GlyphMode),
      {
        choices: GLYPH_MODE_CHOICES.map((v) => ({ value: v, label: t(`opt.glyphMode.${v}`) })),
        help: t('opt.glyphModeHelp'),
      },
    ),
    languageField(autoLanguage),
    globalField(
      'ambiguousWidth',
      t('opt.ambiguousWidth'),
      'select',
      (c) => String(c.ambiguousWidth ?? 1),
      (c, v) => setAmbiguousWidth(c, v === '2' || v === 2 ? 2 : 1),
      { choices: choices(['1', '2']), help: t('opt.ambiguousWidthHelp') },
    ),
    globalField(
      'icons',
      t('tui.field.icons'),
      'select',
      (c) => c.icons,
      (c, v) => ({ ...c, icons: String(v) as Config['icons'] }),
      { choices: choices(['nerd', 'emoji', 'text', 'none']) },
    ),
    globalField(
      'colorLevel',
      t('tui.field.colorLevel'),
      'select',
      (c) => String(c.colorLevel),
      (c, v) => ({ ...c, colorLevel: (v === 'auto' ? 'auto' : Number(v)) as Config['colorLevel'] }),
      {
        choices: [
          { value: 'auto', label: 'auto' },
          { value: '0', label: t('tui.field.colorLevel.0') },
          { value: '1', label: t('tui.field.colorLevel.1') },
          { value: '2', label: t('tui.field.colorLevel.2') },
          { value: '3', label: t('tui.field.colorLevel.3') },
        ],
      },
    ),
    globalField(
      'maxWidth',
      t('tui.field.maxWidth'),
      'text',
      (c) => c.maxWidth,
      (c, v) => {
        const n = Number(v);
        return { ...c, maxWidth: n > 0 ? Math.floor(n) : 'auto' };
      },
      {
        help: t('tui.field.maxWidthHelp'),
        parse: (text) => {
          const s = text.trim().toLowerCase();
          if (s === 'auto' || s === '') return { ok: true, value: 'auto' };
          const n = Number(s);
          return Number.isFinite(n) && n > 0
            ? { ok: true, value: Math.floor(n) }
            : { ok: false, error: t('tui.parse.maxWidth') };
        },
      },
    ),
    globalField(
      'widthOffset',
      t('tui.field.widthOffset'),
      'number',
      (c) => c.widthOffset,
      (c, v) => ({ ...c, widthOffset: Math.max(0, Math.floor(Number(v))) }),
    ),
    globalField(
      'savePayload',
      t('tui.field.savePayload'),
      'bool',
      (c) => c.savePayload,
      (c, v) => ({ ...c, savePayload: Boolean(v) }),
      { help: t('tui.field.savePayloadHelp') },
    ),
    ...budgetFields(),
    ...progressFields(),
    globalField(
      'profiles.builtIn',
      t('tui.field.profilesBuiltIn'),
      'bool',
      (c) => c.profiles?.builtIn !== false,
      (c, v) => setProfilesBuiltIn(c, Boolean(v)),
      {
        help: t('tui.field.profilesBuiltInHelp'),
      },
    ),
  ];
}

const STYLE_FLAGS = ['bold', 'dim', 'italic', 'raw', 'merge', 'hideEmpty'];

export function toggled(field: Field, config: Config): OptionValue | undefined {
  const cur = field.get(config);
  if (STYLE_FLAGS.includes(field.id)) {
    const next = !(cur ?? field.fallback ?? false);
    return next === (field.fallback ?? false) ? undefined : next;
  }
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
    if (field.locked?.(config)) return field.get(config);
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
    if (field.kind === 'bool') return { text: t('tui.value.off'), isDefault: true };
    return { text: field.kind === 'color' ? t('tui.value.default') : '—', isDefault: true };
  }
  if (field.kind === 'bool') return { text: value ? t('tui.value.on') : t('tui.value.off'), isDefault };
  if (field.kind === 'select') {
    const c = field.choices?.find((x) => x.value === String(value));
    const label = c?.label ?? String(value);
    return { text: isDefault && field.effective ? t('tui.value.theme', { value: label }) : label, isDefault };
  }
  const text = String(value);
  return { text: isDefault && field.effective ? t('tui.value.theme', { value: text }) : text, isDefault };
}

export function editText(field: Field, config: Config): string {
  if (field.editValue) return field.editValue(config);
  const v = field.get(config);
  return v === undefined ? '' : String(v);
}
