import {
  type Clause,
  describeRuleError,
  formatClause,
  formatRule,
  parseRule,
  type RuleKey,
  ruleMetrics,
} from './conditions.js';
import {
  CATEGORY_PRIORITY,
  defaultPriority,
  GLYPH_MODES,
  OVERFLOW_MODES,
  overflowOf,
} from './display-opts.js';
import { APPEARANCE_KEYS, type EntryContent, type EntryKind, LAYOUT_KEYS } from './entry-keys.js';
import type { MessageId } from './i18n/index.js';
import { LANGUAGE_SETTINGS, type LanguageSetting } from './i18n/languages.js';
import { aliasesFor, aliasValue, OPTION_ALIASES } from './option-aliases.js';
import { normalizeProfileOverride, PROFILE_OVERRIDES_MAX } from './profiles.js';
import { normalizeThemeRotation } from './rotation.js';
import type {
  Align,
  BudgetConfig,
  Config,
  GlyphMode,
  OptionSpec,
  OptionValue,
  OverflowMode,
  ProfileOverride,
  ProfilesConfig,
  ProgressConfig,
  RotationDay,
  RotationEvery,
  ThemeRotation,
  WidgetItem,
} from './types.js';

export interface Position {
  line: number;
  index: number;
}

function clone(config: Config): Config {
  return { ...config, lines: config.lines.map((l) => l.map((i) => ({ ...i }))) };
}

export function uniqueId(config: Config, type: string): string {
  const ids = new Set(config.lines.flat().map((i) => i.id));
  let n = 1;
  while (ids.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

export function findItem(config: Config, id: string): (Position & { item: WidgetItem }) | null {
  for (let line = 0; line < config.lines.length; line++) {
    const index = config.lines[line]!.findIndex((i) => i.id === id);
    if (index >= 0) return { line, index, item: config.lines[line]![index]! };
  }
  return null;
}

export function insertItem(
  config: Config,
  item: Omit<WidgetItem, 'id'> & { id?: string },
  at: Position,
): Config {
  const next = clone(config);
  while (next.lines.length <= at.line) next.lines.push([]);
  const line = next.lines[at.line]!;
  const index = Math.max(0, Math.min(at.index, line.length));
  line.splice(index, 0, { ...item, id: item.id ?? uniqueId(next, item.type) });
  return next;
}

export function lineEnd(config: Config, line: number): Position {
  const at = Math.max(0, Math.min(line, config.lines.length - 1));
  return { line: at, index: config.lines[at]?.length ?? 0 };
}

export function takeItem(item: WidgetItem): Omit<WidgetItem, 'id'> {
  const { id: _, ...rest } = item;
  return JSON.parse(JSON.stringify(rest)) as Omit<WidgetItem, 'id'>;
}

// after the selected chip, else the end of the line
export function pasteTarget(config: Config, selectedId: string | null, line: number): Position {
  const found = selectedId ? findItem(config, selectedId) : null;
  return found ? { line: found.line, index: found.index + 1 } : lineEnd(config, line);
}

export function pasteItem(
  config: Config,
  snap: Omit<WidgetItem, 'id'>,
  at: Position,
): { config: Config; id: string } {
  const id = uniqueId(config, snap.type);
  return { config: insertItem(config, { ...snap, id }, at), id };
}

export function removeItem(config: Config, id: string): Config {
  const next = clone(config);
  next.lines = next.lines.map((l) => l.filter((i) => i.id !== id));
  return next;
}

export function moveItem(config: Config, id: string, to: Position): Config {
  const found = findItem(config, id);
  if (!found) return config;
  const next = clone(config);
  const [item] = next.lines[found.line]!.splice(found.index, 1);
  while (next.lines.length <= to.line) next.lines.push([]);
  let index = to.index;
  if (found.line === to.line && found.index < to.index) index--;
  const line = next.lines[to.line]!;
  line.splice(Math.max(0, Math.min(index, line.length)), 0, item!);
  return next;
}

export function updateItem(config: Config, id: string, patch: Partial<WidgetItem>): Config {
  const next = clone(config);
  next.lines = next.lines.map((l) =>
    l.map((i) => {
      if (i.id !== id) return i;
      const merged: WidgetItem = { ...i, ...patch, id: i.id };
      for (const k of Object.keys(merged) as (keyof WidgetItem)[]) {
        if (merged[k] === undefined) delete merged[k];
      }
      return merged;
    }),
  );
  return next;
}

export function setOption(
  config: Config,
  id: string,
  key: string,
  value: string | number | boolean | undefined,
): Config {
  const found = findItem(config, id);
  if (!found) return config;
  const options = { ...found.item.options };
  if (value === undefined) delete options[key];
  else options[key] = value;
  for (const a of aliasesFor(found.item.type, key)) delete options[a.key];
  return updateItem(config, id, { options });
}

export function optionValue(item: WidgetItem, key: string): OptionValue | undefined {
  return ((item.options && Object.hasOwn(item.options, key) ? item.options[key] : undefined) ??
    aliasValue(item.type, key, item.options)) as OptionValue | undefined;
}

export function optionShown(
  spec: OptionSpec,
  specs: OptionSpec[],
  options: WidgetItem['options'],
  type?: string,
): boolean {
  const w = spec.showWhen;
  if (!w) return true;
  const value =
    options?.[w.key] ??
    (type ? (aliasValue(type, w.key, options) as OptionValue | undefined) : undefined) ??
    specs.find((s) => s.key === w.key)?.default;
  return value !== undefined && w.values.includes(value);
}

const CONTEXT_TYPES = ['context-percentage', 'context-bar'];
const BASES: OptionValue[] = ['raw', 'usable', 'reserve'];

// legacy usable switch -> basis
export function upgradeOptions(config: Config): Config {
  const next = clone(config);
  next.lines = next.lines.map((l) =>
    l.map((i) => {
      if (!CONTEXT_TYPES.includes(i.type) || !i.options || !('usable' in i.options)) return i;
      const { usable, ...options } = i.options;
      if (!BASES.includes(options.basis as OptionValue) && (usable === true || usable === 'true')) {
        options.basis = 'usable';
      }
      return { ...i, options };
    }),
  );
  return next;
}

// keep per-line alignment next to its line
function withAligns(next: Config, edit: (aligns: (Align | null)[]) => void): Config {
  if (!next.lineAlign) return next;
  const aligns = Array.from(
    { length: Math.max(next.lineAlign.length, next.lines.length + 1) },
    (_, i) => next.lineAlign![i] ?? null,
  );
  edit(aligns);
  aligns.length = next.lines.length;
  while (aligns.length && aligns[aligns.length - 1] == null) aligns.pop();
  if (aligns.length) next.lineAlign = aligns.map((a) => a ?? null);
  else delete next.lineAlign;
  return next;
}

export function addLine(config: Config, at = config.lines.length): Config {
  const next = clone(config);
  next.lines.splice(at, 0, []);
  return withAligns(next, (a) => a.splice(at, 0, null));
}

export function removeLine(config: Config, line: number): Config {
  const next = clone(config);
  next.lines.splice(line, 1);
  return withAligns(next, (a) => a.splice(line, 1));
}

export function moveLine(config: Config, from: number, to: number): Config {
  if (from === to || from < 0 || from >= config.lines.length) return config;
  const next = clone(config);
  const [l] = next.lines.splice(from, 1);
  const at = Math.max(0, Math.min(to, next.lines.length));
  next.lines.splice(at, 0, l!);
  return withAligns(next, (a) => {
    const [x] = a.splice(from, 1);
    a.splice(at, 0, x ?? null);
  });
}

export function setLineAlign(config: Config, line: number, align: Align | null): Config {
  const next = clone(config);
  next.lineAlign ??= [];
  return withAligns(next, (a) => {
    a[line] = align;
  });
}

export type StyleGroup = 'colors' | 'text' | 'bars' | 'label';

export const STYLE_GROUPS: { id: StyleGroup; name: string }[] = [
  { id: 'colors', name: 'Colors' },
  { id: 'text', name: 'Bold, dim, italic' },
  { id: 'bars', name: 'Bar and graph options' },
  { id: 'label', name: 'Label switches' },
];

const GROUP_KEYS: Record<Exclude<StyleGroup, 'bars'>, (keyof WidgetItem)[]> = {
  colors: ['color', 'background'],
  text: ['bold', 'dim', 'italic'],
  label: ['raw', 'merge', 'hideEmpty'],
};

// options that change looks, not data
export const LOOK_OPTIONS = [
  'display',
  'style',
  'barColor',
  'width',
  'showPercent',
  'thresholdColors',
  'showPace',
  'points',
  'showValue',
  'fill',
];

export interface StyleSnapshot {
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  raw?: boolean;
  merge?: boolean;
  hideEmpty?: boolean;
  options?: Record<string, OptionValue>;
}

export function lookKeys(type: string): string[] {
  const own = Object.hasOwn(OPTION_ALIASES, type) ? OPTION_ALIASES[type]! : {};
  const aliasNames = new Set(Object.values(own).flatMap((l) => l.map((a) => a.key)));
  const keys = LOOK_OPTIONS.filter((k) => !aliasNames.has(k));
  for (const [canon, list] of Object.entries(own)) {
    if (!keys.includes(canon) && list.some((a) => LOOK_OPTIONS.includes(a.key))) keys.push(canon);
  }
  return keys;
}

export function takeStyle(item: WidgetItem): StyleSnapshot {
  const out: Record<string, unknown> = {};
  for (const keys of Object.values(GROUP_KEYS)) {
    for (const k of keys) if (item[k] !== undefined) out[k] = item[k];
  }
  const opts: Record<string, OptionValue> = {};
  for (const k of lookKeys(item.type)) {
    const v = optionValue(item, k);
    if (v !== undefined) opts[k] = v;
  }
  if (Object.keys(opts).length) out.options = opts;
  return out as StyleSnapshot;
}

function stable(v: unknown): string {
  if (!v || typeof v !== 'object') return JSON.stringify(v);
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${k}:${stable(o[k])}`)
    .join(',')}}`;
}

export function sameStyle(a: StyleSnapshot, b: StyleSnapshot): boolean {
  return stable(a) === stable(b);
}

// copies exactly: a missing key clears the target's override
export function applyStyle(
  config: Config,
  ids: string[],
  snap: StyleSnapshot,
  groups: StyleGroup[],
  supported: (type: string) => string[] = lookKeys,
): Config {
  let next = config;
  for (const id of ids) {
    const found = findItem(next, id);
    if (!found) continue;
    const patch: Record<string, unknown> = {};
    for (const g of groups) {
      if (g === 'bars') continue;
      for (const k of GROUP_KEYS[g]) patch[k] = (snap as Record<string, unknown>)[k];
    }
    if (groups.includes('bars')) {
      const options = { ...found.item.options };
      const type = found.item.type;
      const listed = supported(type);
      const allowed = new Set(listed);
      for (const k of lookKeys(type)) {
        const aliases = aliasesFor(type, k);
        if (!allowed.has(k) && !aliases.some((a) => allowed.has(a.key))) continue;
        const from = snap.options;
        const v = from?.[k] ?? aliases.map((a) => from?.[a.key]).find((x) => x !== undefined);
        for (const a of aliases) delete options[a.key];
        if (v === undefined) delete options[k];
        else options[k] = v;
      }
      patch.options = Object.keys(options).length ? options : undefined;
    }
    next = updateItem(next, id, patch as Partial<WidgetItem>);
  }
  return next;
}

export function hasOwnColors(config: Config): boolean {
  return config.lines.some((l) => l.some((i) => i.color !== undefined || i.background !== undefined));
}

export function clearColors(config: Config): Config {
  const ids = config.lines.flat().map((i) => i.id);
  return applyStyle(config, ids, {}, ['colors']);
}

export type StyleHistory = Record<string, StyleSnapshot[]>;

// previous looks per widget, newest first
export function recordStyles(history: StyleHistory, before: Config, after: Config, keep = 3): StyleHistory {
  const next: StyleHistory = { ...history };
  const old = new Map(before.lines.flat().map((i) => [i.id, i]));
  for (const item of after.lines.flat()) {
    const prev = old.get(item.id);
    if (!prev || prev.type !== item.type) continue;
    const was = takeStyle(prev);
    if (sameStyle(was, takeStyle(item))) continue;
    const list = (next[item.id] ?? []).filter((s) => !sameStyle(s, was));
    next[item.id] = [was, ...list].slice(0, keep);
  }
  return next;
}

// keeps the widgets in use first when the history passes max ids
export function boundStyles(history: StyleHistory, config: Config, max = 500): StyleHistory {
  const ids = Object.keys(history);
  if (ids.length <= max) return history;
  const used = config.lines.flat().map((i) => i.id);
  const first = [...new Set(used)].filter((id) => Object.hasOwn(history, id));
  const keep = [...first, ...ids.filter((id) => !first.includes(id))].slice(0, max);
  return Object.fromEntries(keep.map((id) => [id, history[id]!]));
}

export const REFRESH_SUGGEST = 5;

export function needsRefresh(
  config: Config,
  isTimeBased: (type: string) => boolean,
  extra: Iterable<string> = [],
): string[] {
  const out = new Set<string>();
  for (const line of config.lines) for (const it of line) if (isTimeBased(it.type)) out.add(it.type);
  for (const t of extra) if (isTimeBased(t)) out.add(t);
  return [...out].sort();
}

export type RefreshFeed = (config: Config) => string[];

export function refreshReasons(
  config: Config,
  isTimeBased: (type: string) => boolean,
  feeds: RefreshFeed[] = [],
  extra: Iterable<string> = [],
): { widgets: string[]; rules: string[] } {
  const rules = new Set<string>();
  for (const f of feeds) for (const r of f(config)) rules.add(r);
  return { widgets: needsRefresh(config, isTimeBased, extra), rules: [...rules].sort() };
}

export const timeRuleFeed: RefreshFeed = (config) => {
  const out = new Set<string>();
  for (const line of config.lines) {
    for (const it of line) {
      for (const m of ruleMetrics(it)) if (m.startsWith('time.')) out.add(it.id || it.type);
    }
  }
  return [...out];
};

// drops invalid or default values; removes an empty budget
export function setBudget(config: Config, key: keyof BudgetConfig, value: number | undefined): Config {
  const budget: BudgetConfig = { ...config.budget };
  const ok = typeof value === 'number' && Number.isFinite(value) && (key === 'warnAt' || value > 0);
  if (!ok) delete budget[key];
  else budget[key] = key === 'warnAt' ? Math.min(1, Math.max(0.05, value)) : value;
  if (budget.warnAt === 0.8) delete budget.warnAt;
  const next: Config = { ...config, budget };
  if (!Object.keys(budget).length) delete next.budget;
  return next;
}

// normalizes, drops defaults; removes an empty rotation
export function setThemeRotation(config: Config, rot: ThemeRotation | undefined): Config {
  const clean = normalizeThemeRotation(rot);
  if (clean?.every === 'day') delete clean.every;
  if (clean?.order === 'cycle') delete clean.order;
  const next: Config = { ...config };
  if (clean) next.themeRotation = clean;
  else delete next.themeRotation;
  return next;
}

export function rotationAddTheme(config: Config, id: string): Config {
  const rot = config.themeRotation ?? {};
  return setThemeRotation(config, { ...rot, themes: [...(rot.themes ?? []), id] });
}

export function rotationRemoveTheme(config: Config, id: string): Config {
  const rot = config.themeRotation ?? {};
  return setThemeRotation(config, { ...rot, themes: (rot.themes ?? []).filter((t) => t !== id) });
}

export function rotationMoveTheme(config: Config, id: string, delta: -1 | 1): Config {
  const themes = [...(config.themeRotation?.themes ?? [])];
  const i = themes.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= themes.length) return config;
  [themes[i], themes[j]] = [themes[j]!, themes[i]!];
  return setThemeRotation(config, { ...config.themeRotation, themes });
}

export function setRotationEvery(config: Config, every: RotationEvery | undefined): Config {
  const { every: _e, ...rot } = config.themeRotation ?? {};
  return setThemeRotation(config, every === undefined ? rot : { ...rot, every });
}

export function setRotationOrder(config: Config, order: ThemeRotation['order'] | undefined): Config {
  const { order: _o, ...rot } = config.themeRotation ?? {};
  return setThemeRotation(config, order === undefined ? rot : { ...rot, order });
}

export function setRotationWeekday(config: Config, day: RotationDay, id: string | undefined): Config {
  const weekdays = { ...config.themeRotation?.weekdays };
  if (id) weekdays[day] = id;
  else delete weekdays[day];
  return setThemeRotation(config, { ...config.themeRotation, weekdays });
}

export const PROGRESS_DEFAULTS: Required<ProgressConfig> = {
  enabled: false,
  source: 'context',
  scaleTo: 'full',
  warnAt: 50,
  errorAt: 80,
  channel: 'auto',
  tmuxPassthrough: false,
  terminals: 'allowlist',
};

export const PROGRESS_CHOICES = {
  source: ['context', 'usage5h'],
  scaleTo: ['full', 'autocompact'],
  channel: ['auto', 'hook', 'tty'],
  terminals: ['allowlist', 'always'],
} as const;

function progressValue(key: keyof ProgressConfig, v: unknown): unknown {
  if (key === 'enabled' || key === 'tmuxPassthrough') return typeof v === 'boolean' ? v : undefined;
  if (key === 'warnAt' || key === 'errorAt')
    return typeof v === 'number' && Number.isFinite(v)
      ? Math.min(100, Math.max(1, Math.round(v)))
      : undefined;
  return (PROGRESS_CHOICES[key] as readonly unknown[]).includes(v) ? v : undefined;
}

// sparse; once set it stays as { enabled: false } so the bar gets cleared (D-36)
export function setProgress(config: Config, patch: Partial<ProgressConfig>): Config {
  const merged: Record<string, unknown> = { ...config.progress, ...patch };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PROGRESS_DEFAULTS) as (keyof ProgressConfig)[]) {
    const v = progressValue(key, merged[key]);
    if (v !== undefined && v !== PROGRESS_DEFAULTS[key]) out[key] = v;
  }
  const next: Config = { ...config };
  if (Object.keys(out).length || config.progress)
    next.progress = { enabled: false, ...out } as ProgressConfig;
  else delete next.progress;
  return next;
}

export {
  CATEGORY_PRIORITY as DEFAULT_PRIORITY,
  defaultPriority,
  GLYPH_MODES as GLYPH_MODE_CHOICES,
  OVERFLOW_MODES as OVERFLOW_CHOICES,
  overflowOf as effectiveOverflow,
};

// autoWrap kept in step for older readers
export function setOverflow(config: Config, v: OverflowMode): Config {
  if (!OVERFLOW_MODES.includes(v)) return config;
  return { ...config, overflow: v, autoWrap: v === 'wrap' };
}

export function setGlyphMode(config: Config, v: GlyphMode | undefined): Config {
  const next: Config = { ...config };
  if (v === undefined || v === 'normal' || !GLYPH_MODES.includes(v)) delete next.glyphMode;
  else next.glyphMode = v;
  return next;
}

export function setLanguageSetting(config: Config, v: LanguageSetting | undefined): Config {
  const next: Config = { ...config };
  if (v === undefined || v === 'auto' || !LANGUAGE_SETTINGS.includes(v)) delete next.language;
  else next.language = v;
  return next;
}

export function keepLanguage(next: Config, current: Config): Config {
  const out: Config = { ...next };
  if (current.language && LANGUAGE_SETTINGS.includes(current.language)) out.language = current.language;
  else delete out.language;
  return out;
}

export {
  APPEARANCE_KEYS,
  type EntryContent,
  type EntryKind,
  LAYOUT_KEYS,
  PERSONAL_KEYS,
} from './entry-keys.js';

const REQUIRED = new Set<string>(['lines', 'theme', 'autoWrap', 'widthOffset']);

function replaceKeys(
  next: Record<string, unknown>,
  from: Partial<Config> | undefined,
  keys: readonly string[],
) {
  const src = (from ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    const v = Object.hasOwn(src, k) ? src[k] : undefined;
    if (v !== undefined) next[k] = structuredClone(v);
    else if (!REQUIRED.has(k)) delete next[k];
  }
}

export function applyCatalogContent(
  current: Config,
  content: EntryContent,
  kind: EntryKind,
  themeId?: string,
): Config {
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  if (kind !== 'theme') replaceKeys(next, content.layout, LAYOUT_KEYS);
  if (kind !== 'preset') {
    replaceKeys(next, content.appearance, APPEARANCE_KEYS);
    if (themeId) next.theme = themeId;
  }
  return next as unknown as Config;
}

export function setAmbiguousWidth(config: Config, v: 1 | 2 | undefined): Config {
  const next: Config = { ...config };
  if (v === 2) next.ambiguousWidth = 2;
  else delete next.ambiguousWidth;
  return next;
}

export function setPriority(config: Config, itemId: string, v: number | undefined): Config {
  const ok = typeof v === 'number' && Number.isFinite(v);
  return updateItem(config, itemId, { priority: ok ? Math.min(100, Math.max(0, Math.round(v))) : undefined });
}

function withProfiles(config: Config, profiles: ProfilesConfig): Config {
  if (!profiles.models?.length) delete profiles.models;
  const next: Config = { ...config, profiles };
  if (!Object.keys(profiles).length) delete next.profiles;
  return next;
}

export function setProfilesBuiltIn(config: Config, on: boolean): Config {
  const profiles: ProfilesConfig = { ...config.profiles };
  if (on) delete profiles.builtIn;
  else profiles.builtIn = false;
  return withProfiles(config, profiles);
}

export function addProfileOverride(config: Config, entry: ProfileOverride): Config {
  const models = config.profiles?.models ?? [];
  const clean = normalizeProfileOverride(entry);
  if (!clean || models.length >= PROFILE_OVERRIDES_MAX) return config;
  return withProfiles(config, { ...config.profiles, models: [...models, clean] });
}

// an invalid match keeps the old one; other invalid values are dropped
export function updateProfileOverride(
  config: Config,
  index: number,
  patch: Partial<ProfileOverride>,
): Config {
  const models = config.profiles?.models ?? [];
  const old = models[index];
  if (!old) return config;
  const merged: Record<string, unknown> = { ...old, ...patch };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const clean = normalizeProfileOverride(merged) ?? normalizeProfileOverride({ ...merged, match: old.match });
  if (!clean) return config;
  const list = models.slice();
  list[index] = clean;
  return withProfiles(config, { ...config.profiles, models: list });
}

// full replace, so dropped keys really drop
export function setProfileOverride(config: Config, index: number, entry: ProfileOverride): Config {
  const models = config.profiles?.models ?? [];
  const clean = normalizeProfileOverride(entry);
  if (!clean || !models[index]) return config;
  return withProfiles(config, {
    ...config.profiles,
    models: models.map((e, i) => (i === index ? clean : e)),
  });
}

export function removeProfileOverride(config: Config, index: number): Config {
  const models = config.profiles?.models ?? [];
  if (!models[index]) return config;
  return withProfiles(config, { ...config.profiles, models: models.filter((_, i) => i !== index) });
}

export function subagentFields(config: Config, all: readonly string[]): string[] {
  const cur = (config.subagentLine?.fields ?? []).filter((f) => all.includes(f));
  return cur.length ? cur : [...all];
}

type SubagentFieldId = NonNullable<NonNullable<Config['subagentLine']>['fields']>[number];

export function setSubagentFields(config: Config, fields: readonly string[], all: readonly string[]): Config {
  const list = fields.filter((f, i) => all.includes(f) && fields.indexOf(f) === i);
  const { subagentLine, ...rest } = config;
  const { fields: _, ...other } = subagentLine ?? {};
  const isDefault = !list.length || (list.length === all.length && list.every((f, i) => f === all[i]));
  if (isDefault) return Object.keys(other).length ? { ...rest, subagentLine: other } : rest;
  return { ...rest, subagentLine: { ...other, fields: list as SubagentFieldId[] } };
}

export function setSubagentField(config: Config, field: string, on: boolean, all: readonly string[]): Config {
  if (!all.includes(field)) return config;
  const cur = subagentFields(config, all);
  const has = cur.includes(field);
  if (on === has) return config;
  if (!on && cur.length === 1) return config;
  return setSubagentFields(config, on ? [...cur, field] : cur.filter((f) => f !== field), all);
}

export function moveSubagentField(
  config: Config,
  field: string,
  delta: number,
  all: readonly string[],
): Config {
  const cur = subagentFields(config, all);
  const from = cur.indexOf(field);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= cur.length) return config;
  const next = [...cur];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return setSubagentFields(config, next, all);
}

export interface Threshold {
  mode: 'show' | 'hide';
  at: number;
}

export interface RuleQuick {
  git: boolean;
  gsd: boolean;
  agents: boolean;
  context: Threshold | null;
  usage5h: Threshold | null;
  hideProviders: string[];
  hours: { from: number; to: number } | null;
}

export interface RuleQuickState {
  quick: RuleQuick;
  custom: Record<RuleKey, boolean>;
  invalid: Record<RuleKey, string | null>;
}

export type RulePresetId = 'none' | 'git' | 'gsd' | 'agents' | 'context70' | 'usage80';

export const RULE_PRESETS: readonly { id: RulePresetId; rule: string | null; label: MessageId }[] = [
  { id: 'none', rule: null, label: 'vis.preset.none' },
  { id: 'git', rule: 'git', label: 'vis.preset.git' },
  { id: 'gsd', rule: 'gsd', label: 'vis.preset.gsd' },
  { id: 'agents', rule: 'agents', label: 'vis.preset.agents' },
  { id: 'context70', rule: 'context.pct >= 70', label: 'vis.preset.context70' },
  { id: 'usage80', rule: 'usage.5h >= 80', label: 'vis.preset.usage80' },
];

const RULE_KEYS: RuleKey[] = ['showWhen', 'hideWhen'];
const FLAGS = ['git', 'gsd', 'agents'] as const;
const THRESHOLDS = [
  ['context', 'context.pct'],
  ['usage5h', 'usage.5h'],
] as const;

const noQuick = (): RuleQuick => ({
  git: false,
  gsd: false,
  agents: false,
  context: null,
  usage5h: null,
  hideProviders: [],
  hours: null,
});

const entries = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []);

// true when the clause was taken into q
function own(q: RuleQuick, key: RuleKey, c: Clause): boolean {
  if (c.length !== 1) return false;
  const x = c[0]!;
  const show = key === 'showWhen';
  if (x.kind === 'flag' && show && !x.negate) {
    const f = FLAGS.find((n) => n === x.metric);
    if (!f || q[f]) return false;
    q[f] = true;
    return true;
  }
  if (x.kind === 'cmp' && x.op === '>=' && x.band === undefined) {
    const th = THRESHOLDS.find(([, m]) => m === x.metric);
    if (!th || q[th[0]]) return false;
    q[th[0]] = { mode: show ? 'show' : 'hide', at: x.value };
    return true;
  }
  if (x.kind === 'range' && show && x.metric === 'time.hour' && !q.hours) {
    if (typeof x.from !== 'number' || typeof x.to !== 'number') return false;
    q.hours = { from: x.from, to: x.to };
    return true;
  }
  if (!show && x.metric === 'provider' && !q.hideProviders.length) {
    if (x.kind === 'list') q.hideProviders = [...x.values];
    else if (x.kind === 'str' && x.op === '==') q.hideProviders = [x.value];
    else return false;
    return true;
  }
  return false;
}

function readRules(item: WidgetItem): RuleQuickState & { kept: Record<RuleKey, string[]> } {
  const out = {
    quick: noQuick(),
    custom: { showWhen: false, hideWhen: false },
    invalid: { showWhen: null, hideWhen: null } as Record<RuleKey, string | null>,
    kept: { showWhen: [] as string[], hideWhen: [] as string[] },
  };
  for (const key of RULE_KEYS) {
    if (item[key] === undefined) continue;
    const r = parseRule(item[key]);
    if (!r.ok) {
      out.invalid[key] = describeRuleError(r.error);
      continue;
    }
    const raw = entries(item[key]);
    r.rule.forEach((c, i) => {
      if (own(out.quick, key, c)) return;
      out.custom[key] = true;
      out.kept[key].push(raw[i]!);
    });
  }
  return out;
}

export function ruleQuickState(item: WidgetItem): RuleQuickState {
  const { quick, custom, invalid } = readRules(item);
  return { quick, custom, invalid };
}

function ownedClauses(q: RuleQuick, key: RuleKey): string[] {
  const mode = key === 'showWhen' ? 'show' : 'hide';
  const out: Clause[] = [];
  if (mode === 'show')
    for (const f of FLAGS) if (q[f]) out.push([{ kind: 'flag', metric: f, negate: false }]);
  for (const [k, metric] of THRESHOLDS) {
    const th = q[k];
    if (th?.mode === mode) out.push([{ kind: 'cmp', metric, op: '>=', value: clampInt(th.at, 0, 100) }]);
  }
  if (mode === 'show' && q.hours) {
    const { from, to } = q.hours;
    out.push([{ kind: 'range', metric: 'time.hour', from: clampInt(from, 0, 23), to: clampInt(to, 0, 23) }]);
  }
  if (mode === 'hide' && q.hideProviders.length) {
    out.push([{ kind: 'list', metric: 'provider', values: q.hideProviders }]);
  }
  return out.map(formatClause);
}

const clampInt = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;

const ruleValue = (list: string[]): string | string[] | undefined =>
  list.length === 0 ? undefined : list.length === 1 ? list[0] : list;

export function setRuleQuick(config: Config, itemId: string, patch: Partial<RuleQuick>): Config {
  const found = findItem(config, itemId);
  if (!found) return config;
  const cur = readRules(found.item);
  const next: RuleQuick = { ...cur.quick, ...patch };
  const update: Partial<WidgetItem> = {};
  for (const key of RULE_KEYS) {
    const owned = ownedClauses(next, key);
    if (owned.join('\n') === ownedClauses(cur.quick, key).join('\n')) continue;
    if (cur.invalid[key] !== null) return config;
    const value = ruleValue([...owned, ...cur.kept[key]]);
    if (value !== undefined && !parseRule(value).ok) return config;
    update[key] = value;
  }
  return Object.keys(update).length ? updateItem(config, itemId, update) : config;
}

export function setItemRule(
  config: Config,
  itemId: string,
  key: RuleKey,
  text: string | string[] | undefined,
): { ok: true; config: Config } | { ok: false; error: string } {
  const empty = text === undefined || (typeof text === 'string' ? !text.trim() : !text.length);
  if (empty) return { ok: true, config: updateItem(config, itemId, { [key]: undefined }) };
  const r = parseRule(text);
  if (!r.ok) return { ok: false, error: describeRuleError(r.error) };
  return { ok: true, config: updateItem(config, itemId, { [key]: Array.isArray(text) ? [...text] : text }) };
}

// one line of text; ; separates entries that must all hold
export function ruleToText(rule: unknown): string {
  return entries(rule).join('; ');
}

export function ruleFromText(text: string): string | string[] | undefined {
  return ruleValue(
    text
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// null when showWhen is not exactly one preset
export function rulePreset(item: WidgetItem): RulePresetId | null {
  if (item.showWhen === undefined) return 'none';
  const r = parseRule(item.showWhen);
  if (!r.ok) return null;
  const f = formatRule(r.rule);
  return RULE_PRESETS.find((p) => p.rule !== null && p.rule === f)?.id ?? null;
}
