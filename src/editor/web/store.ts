import type { Config, OptionSpec, WidgetCategory } from '../../core/types.js';

export interface WidgetInfo {
  type: string;
  name: string;
  category: WidgetCategory;
  description: string;
  label?: string;
  icon?: { nerd?: string; emoji?: string; text?: string };
  color: string;
  options: OptionSpec[];
  sample?: string;
}

export interface ThemeInfo {
  name: string;
  colors: { fg: string; bg: string }[];
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  config: Config;
}

export interface ClaudeInfo {
  statusLine: { command?: string; refreshInterval?: number } | null;
  installed: boolean;
  defaultCommand: string;
}

export interface ApiState {
  version: string;
  configPath: string;
  configError: string | null;
  config: Config;
  savedConfig: Config;
  widgets: WidgetInfo[];
  categories: { id: string; name: string }[];
  presets: PresetInfo[];
  themes: Record<string, ThemeInfo>;
  claude: ClaudeInfo;
  hasLastPayload: boolean;
}

export interface Store {
  config: Config;
  saved: string;
  undo: Config[];
  redo: Config[];
  selectedId: string | null;
  selectedLine: number;
  tab: 'widget' | 'global';
  search: string;
  collapsed: Set<string>;
  source: 'sample' | 'last';
  width: number;
  api: ApiState;
  widgetMap: Map<string, WidgetInfo>;
}

export interface CommitOpts {
  coalesce?: string;
  inspector?: boolean;
  select?: string | null;
}

type Topic = 'config' | 'selection' | 'ui' | 'preview';
type Listener = (opts: CommitOpts) => void;

export let S: Store;
const listeners: Record<Topic, Set<Listener>> = {
  config: new Set(),
  selection: new Set(),
  ui: new Set(),
  preview: new Set(),
};
let lastKey: string | null = null;
let lastAt = 0;

export function init(api: ApiState): void {
  S = {
    config: api.config,
    saved: JSON.stringify(api.savedConfig),
    undo: [],
    redo: [],
    selectedId: null,
    selectedLine: 0,
    tab: 'widget',
    search: '',
    collapsed: new Set(api.categories.filter((c) => c.id !== 'gsd' && c.id !== 'session').map((c) => c.id)),
    source: 'sample',
    width: 120,
    api,
    widgetMap: new Map(api.widgets.map((w) => [w.type, w])),
  };
}

export function on(topic: Topic, fn: Listener): void {
  listeners[topic].add(fn);
}

export function emit(topic: Topic, opts: CommitOpts = {}): void {
  for (const fn of listeners[topic]) fn(opts);
}

export function isDirty(): boolean {
  return JSON.stringify(S.config) !== S.saved;
}

export function markSaved(): void {
  S.saved = JSON.stringify(S.config);
  emit('ui');
}

export function commit(next: Config, opts: CommitOpts = {}): void {
  if (JSON.stringify(next) === JSON.stringify(S.config)) return;
  const now = Date.now();
  const coalesced = opts.coalesce !== undefined && opts.coalesce === lastKey && now - lastAt < 900;
  if (!coalesced) {
    S.undo.push(S.config);
    if (S.undo.length > 150) S.undo.shift();
  }
  lastKey = opts.coalesce ?? null;
  lastAt = now;
  S.redo = [];
  apply(next, opts);
}

function apply(next: Config, opts: CommitOpts): void {
  S.config = next;
  if (opts.select !== undefined) S.selectedId = opts.select;
  fixSelection();
  emit('config', opts);
  emit('preview');
  emit('ui');
}

export function fixSelection(): void {
  const lines = S.config.lines;
  if (S.selectedId && !lines.some((l) => l.some((i) => i.id === S.selectedId))) S.selectedId = null;
  S.selectedLine = Math.max(0, Math.min(S.selectedLine, lines.length - 1));
}

export function undo(): void {
  const prev = S.undo.pop();
  if (!prev) return;
  S.redo.push(S.config);
  lastKey = null;
  apply(prev, {});
}

export function redo(): void {
  const next = S.redo.pop();
  if (!next) return;
  S.undo.push(S.config);
  lastKey = null;
  apply(next, {});
}

export function select(id: string | null, line?: number): void {
  S.selectedId = id;
  if (line !== undefined) S.selectedLine = line;
  else if (id) {
    const idx = S.config.lines.findIndex((l) => l.some((i) => i.id === id));
    if (idx >= 0) S.selectedLine = idx;
  }
  if (id) S.tab = 'widget';
  emit('selection');
}

export function replaceAll(config: Config): void {
  commit(config, { select: null });
}
