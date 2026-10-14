import type { Align, Config, OptionSpec, OptionValue, WidgetItem } from './types.js';

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
  return updateItem(config, id, { options });
}

export function optionShown(spec: OptionSpec, specs: OptionSpec[], options: WidgetItem['options']): boolean {
  const w = spec.showWhen;
  if (!w) return true;
  const value = options?.[w.key] ?? specs.find((s) => s.key === w.key)?.default;
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

export function takeStyle(item: WidgetItem): StyleSnapshot {
  const out: Record<string, unknown> = {};
  for (const keys of Object.values(GROUP_KEYS)) {
    for (const k of keys) if (item[k] !== undefined) out[k] = item[k];
  }
  const opts: Record<string, OptionValue> = {};
  for (const k of LOOK_OPTIONS) if (item.options?.[k] !== undefined) opts[k] = item.options[k]!;
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
  supported: (type: string) => string[] = () => LOOK_OPTIONS,
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
      const allowed = new Set(supported(found.item.type));
      for (const k of LOOK_OPTIONS) {
        if (!allowed.has(k)) continue;
        if (snap.options?.[k] === undefined) delete options[k];
        else options[k] = snap.options[k]!;
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
