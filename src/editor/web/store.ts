import type { ShareState } from '../../catalog/model.js';
import type { EntryContent, EntryKind, StyleGroup, StyleHistory, StyleSnapshot } from '../../core/edit.js';
import { COLS_MAX, COLS_MIN } from '../../core/entry-keys.js';
import { pickRotationTheme } from '../../core/rotation.js';
import type { Config, OptionSpec, WidgetCategory, WidgetItem } from '../../core/types.js';

export type HiddenWhy = 'rule' | 'priority';

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
  hidden?: boolean;
  timeBased?: boolean;
  hideWhenEmpty?: boolean;
}

export type StyleId = 'text' | 'blocks' | 'powerline' | 'capsule' | 'tui';

export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  style: StyleId;
  separator: string;
  padding: number;
  bold: boolean;
  statusColors: boolean;
  gradient?: string[];
  glyphs: { separator: string; thin: string; startCap: string; endCap: string };
  colors: Record<string, unknown>;
  source: 'builtin' | 'user';
}

export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'user';
  config: Config;
}

export interface ClaudeInfo {
  statusLine: { command?: string; refreshInterval?: number } | null;
  installed: boolean;
  defaultCommand: string;
  settingsFile: string;
}

export interface HooksInfo {
  installed: string[];
  available: boolean;
  reason?: string;
  reasonId?: string;
  reasonParams?: Record<string, unknown>;
  claudeCode?: string;
  events: string[];
  optional: string[];
  progress: string[];
}

export interface ConfigIssueInfo {
  line: number;
  column: number;
  message: string;
}

export interface ApiState {
  version: string;
  configPath: string;
  configError: string | null;
  configIssue: ConfigIssueInfo | null;
  config: Config;
  savedConfig: Config;
  widgets: WidgetInfo[];
  categories: { id: string; name: string }[];
  presets: PresetInfo[];
  presetsDir: string;
  styleHistory: StyleHistory;
  gsdInstalled: boolean;
  themes: ThemeInfo[];
  styles: { id: StyleId; name: string; description: string }[];
  themesDir: string;
  claude: ClaudeInfo;
  hooks: HooksInfo;
  hasLastPayload: boolean;
  scenarios: { id: string; label: string; description: string }[];
  terminal: import('./terminals.js').DetectedColors | null;
  language?: { id: string; source: string };
}

export interface CatalogEntryInfo {
  ref: string;
  source: 'user' | 'legacy' | 'system';
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  version: number;
  rev: number | null;
  share: { wanted: boolean; state: ShareState } | null;
  // review: the marketplace holds it for an admin
  remote: { id: string; version: number; review?: 'pending' } | null;
  // installed from the marketplace; never shared as the user's own
  origin?: { endpoint: string; id: string; version: number } | null;
  updatedAt: string | null;
  scenario: string | null;
  // the author's preview width
  cols?: number | null;
  content: EntryContent;
}

export interface CatalogState {
  system: CatalogEntryInfo[];
  user: CatalogEntryInfo[];
  profile: { author: string };
  endpoint: string | null;
  publishable: boolean;
  market?: MarketState;
}

export interface MarketState {
  endpoint: string | null;
  source: 'env' | 'set' | 'default' | 'off' | 'none';
  signedIn: boolean;
  handle: string | null;
}

export interface CatalogVersionInfo {
  version: number;
  at: string | null;
  note: string;
  restoredFrom: number | null;
  overwrittenAt: string | null;
  content: EntryContent;
}

export type CatalogResult = { ok: boolean; entry: CatalogEntryInfo; catalog: CatalogState };

export type PublishAction = 'publish' | 'version' | 'overwrite' | 'withdraw';

export interface PublishPlanInfo {
  endpoint: string;
  planHash: string;
  notice: string;
  code?: 'read-only' | null;
  submitUrl?: string;
  registration?: { handle: string; displayName: string } | null;
  plan: {
    id: string;
    rev: number;
    name: string;
    kind: EntryKind;
    action: PublishAction;
    remoteId: string | null;
    payload: unknown;
  }[];
  skipped: { id: string; reason: 'not-shared' | 'up-to-date' | 'withdrawn' }[];
}

export interface PublishResultInfo {
  id: string;
  ok: boolean;
  code: string | null;
  remoteId: string | null;
  version: number | null;
  errorId: string | null;
  errorParams?: { status?: number };
}

export interface MarketSummaryInfo {
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  publisher: string;
  version: number;
  updatedAt: string;
  hash: string;
  withdrawn?: boolean;
  cols?: number;
}

export interface MarketEntryInfo extends MarketSummaryInfo {
  versions: { version: number; at: string; note: string; hash: string }[];
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
  source: 'sample' | 'last' | 'scenario';
  scenario: string | null;
  width: number;
  api: ApiState;
  widgetMap: Map<string, WidgetInfo>;
  clip: { snap: StyleSnapshot; from: string; type: string } | null;
  itemClip: Omit<WidgetItem, 'id'> | null;
  groups: StyleGroup[];
  painting: boolean;
  hidden: ReadonlyMap<string, HiddenWhy>;
  stopped: boolean;
}

export interface CommitOpts {
  coalesce?: string;
  inspector?: boolean;
  select?: string | null;
}

type Topic = 'config' | 'selection' | 'ui' | 'preview' | 'width';
type Listener = (opts: CommitOpts) => void;

export let S: Store;
const listeners: Record<Topic, Set<Listener>> = {
  config: new Set(),
  selection: new Set(),
  ui: new Set(),
  preview: new Set(),
  width: new Set(),
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
    collapsed: new Set(api.categories.map((c) => c.id)),
    source: 'sample',
    scenario: null,
    width: savedWidth(),
    api: { ...api, configIssue: api.configIssue ?? null, scenarios: api.scenarios ?? [] },
    widgetMap: new Map(api.widgets.map((w) => [w.type, w])),
    clip: null,
    itemClip: null,
    groups: ['colors', 'text'],
    painting: false,
    hidden: new Map(),
    stopped: false,
  };
}

export function on(topic: Topic, fn: Listener): void {
  listeners[topic].add(fn);
}

export function emit(topic: Topic, opts: CommitOpts = {}): void {
  for (const fn of listeners[topic]) fn(opts);
}

export const WIDTH_KEY = 'ccinfobar.previewWidth';
export const DEFAULT_WIDTH = 130;

// preview width only, remembered in the browser
function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(n) && n >= COLS_MIN && n <= COLS_MAX) return n;
  } catch {}
  return DEFAULT_WIDTH;
}

// the slider and an applied entry share this path
export function setWidth(n: number): void {
  if (!Number.isFinite(n)) return;
  S.width = Math.max(COLS_MIN, Math.min(COLS_MAX, Math.round(n)));
  try {
    localStorage.setItem(WIDTH_KEY, String(S.width));
  } catch {}
  emit('width');
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

// already saved on disk: not undoable and not dirty
export function applySaved(fn: (c: Config) => Config): void {
  S.undo = S.undo.map(fn);
  S.redo = S.redo.map(fn);
  S.saved = JSON.stringify(fn(JSON.parse(S.saved) as Config));
  lastKey = null;
  apply(fn(S.config), {});
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

export function currentTheme(): ThemeInfo | undefined {
  const id = S.config.theme || 'classic';
  return S.api.themes.find((t) => t.id === id) ?? S.api.themes.find((t) => t.id === 'classic');
}

// the theme rotation shows right now, if any
export function rotatedTheme(): ThemeInfo | undefined {
  const rot = S.config.themeRotation;
  if (!rot) return undefined;
  const id = pickRotationTheme(rot, new Date(), (x) => S.api.themes.some((t) => t.id === x));
  return id ? S.api.themes.find((t) => t.id === id) : undefined;
}
