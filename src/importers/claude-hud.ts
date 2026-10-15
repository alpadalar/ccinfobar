import { type MessageId, t } from '../core/i18n/index.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config, OptionValue, WidgetItem } from '../core/types.js';
import { hudColor } from './colors.js';
import type { ImportNote, ImportResult } from './index.js';

const TOOL = 'claude-hud';

const LANGUAGES = ['en', 'zh', 'zh-Hans', 'zh-Hant', 'zh-TW'];
const ELEMENTS = [
  'project',
  'addedDirs',
  'context',
  'usage',
  'promptCache',
  'cacheHitRate',
  'memory',
  'environment',
  'tools',
  'skills',
  'mcp',
  'agents',
  'todos',
  'sessionTime',
  'sessionTokens',
];
const SEGMENTS = [
  'model',
  'project',
  'advisor',
  'sessionName',
  'version',
  'extra',
  'duration',
  'cost',
  'speed',
  'auth',
];
const ACTIVITY = ['tools', 'skills', 'mcp', 'agents', 'todos'];
const COLOR_NAMES = ['dim', 'red', 'green', 'yellow', 'magenta', 'cyan', 'brightBlue', 'brightMagenta'];
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 8;

// claude-hud DEFAULT_CONFIG
export const HUD_DEFAULTS = {
  language: 'en' as string,
  lineLayout: 'expanded' as string,
  showSeparators: false,
  pathLevels: 1 as number | string,
  maxWidth: null as number | null,
  forceMaxWidth: false,
  elementOrder: ELEMENTS.filter((e) => e !== 'sessionTokens'),
  projectLineOrder: [] as string[],
  gitStatus: {
    enabled: true,
    showDirty: true,
    showAheadBehind: false,
    showFileStats: false,
    showWorktree: false,
    branchOverflow: 'truncate',
    pushWarningThreshold: 0,
    pushCriticalThreshold: 0,
  },
  jjStatus: { enabled: false, showDirty: true, showConflicts: true },
  display: {
    showModel: true,
    showProject: true,
    showAddedDirs: true,
    addedDirsLayout: 'inline',
    showContextBar: true,
    contextValue: 'percent',
    showConfigCounts: false,
    showCost: false,
    showRoutedCost: false,
    showDailyCost: false,
    showWeeklyCost: false,
    showDuration: false,
    showSpeed: false,
    showTokenBreakdown: true,
    showUsage: true,
    usageValue: 'percent',
    usageBarEnabled: true,
    showResetLabel: true,
    usageCompact: false,
    showModelScopedUsage: true,
    usagePace: false,
    showTools: false,
    showSkills: false,
    showMcp: false,
    toolNameMaxLength: 0,
    toolsMaxVisible: 4,
    skillsMaxVisible: 4,
    showAgents: false,
    showTodos: false,
    showSessionName: false,
    showAuth: false,
    showAuthUser: false,
    authUserLength: 8,
    showClaudeCodeVersion: false,
    showEffortLevel: false,
    effortFormat: 'full',
    showMemoryUsage: false,
    showPromptCache: false,
    showCacheHitRate: false,
    showSessionTokens: false,
    showOutputStyle: false,
    showSessionStartDate: false,
    showLastResponseAt: false,
    showCompactions: false,
    mergeGroups: [['context', 'usage']] as string[][],
    rightAlign: [] as string[],
    contextWarningThreshold: 70,
    contextCriticalThreshold: 85,
    usageThreshold: 0,
    sevenDayThreshold: 80,
    environmentThreshold: 0,
    externalUsagePath: '',
    externalUsageWritePath: '',
    externalUsageFreshnessMs: 300000,
    modelFormat: 'full',
    modelOverride: '',
    modelSource: 'stdin',
    showProvider: false,
    providerName: '',
    customLine: '',
    customLinePosition: 'last',
    timeFormat: 'relative',
    hourCycle: 'auto',
    showClockSeconds: false,
    showAdvisor: false,
    advisorOverride: '',
    autoCompactWindow: null as number | null,
  },
  colors: {
    context: 'green' as string | number,
    usage: 'brightBlue' as string | number,
    warning: 'yellow' as string | number,
    usageWarning: 'brightMagenta' as string | number,
    critical: 'red' as string | number,
    model: 'cyan' as string | number,
    project: 'yellow' as string | number,
    git: 'magenta' as string | number,
    gitBranch: 'cyan' as string | number,
    label: 'dim' as string | number,
    custom: 208 as string | number,
    barFilled: '█',
    barEmpty: '░',
  },
};

export type HudConfig = typeof HUD_DEFAULTS;

type Raw = Record<string, unknown>;
type Rule = (value: unknown, fallback: unknown) => unknown;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const oneOf =
  (allowed: readonly unknown[]): Rule =>
  (v, f) =>
    allowed.includes(v) ? v : f;
const clamp =
  (min: number, max: number): Rule =>
  (v, f) =>
    isNum(v) ? Math.max(min, Math.min(max, v)) : f;
const floor0: Rule = (v, f) => (isNum(v) ? Math.max(0, Math.floor(v)) : f);
const count: Rule = (v, f) => (Number.isInteger(v) && (v as number) >= 0 ? v : f);
const text =
  (max: number): Rule =>
  (v, f) =>
    typeof v === 'string' ? sanitizeText(v).slice(0, max) : f;
const names =
  (known: readonly unknown[], nonEmpty: boolean): Rule =>
  (v, f) => {
    if (!Array.isArray(v)) return f;
    const kept = [...new Set(v.filter((x) => known.includes(x)))];
    return kept.length > 0 || !nonEmpty ? kept : f;
  };
const groups: Rule = (v, f) => {
  if (!Array.isArray(v)) return f;
  if (v.length === 0) return [];
  const used = new Set<unknown>();
  const out: unknown[][] = [];
  for (const g of v) {
    if (!Array.isArray(g)) continue;
    const members = [...new Set(g.filter((x) => ELEMENTS.includes(x as string) && !used.has(x)))];
    if (members.length < 2) continue;
    for (const m of members) used.add(m);
    out.push(members);
  }
  return out.length > 0 ? out : f;
};
const color: Rule = (v, f) =>
  COLOR_NAMES.includes(v as string) ||
  (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255) ||
  (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v))
    ? v
    : f;
const barChar: Rule = (v, f) =>
  typeof v === 'string' && [...v].length === 1 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}]/u.test(v) ? v : f;
const usagePath: Rule = (v) => (typeof v === 'string' ? v.trim() : '');

// claude-hud normalize RULES; booleans need none
const RULES: Record<string, Rule> = {
  language: oneOf(LANGUAGES),
  lineLayout: oneOf(['compact', 'expanded']),
  pathLevels: oneOf([1, 2, 3, 'full']),
  maxWidth: (v) => (isNum(v) && v > 0 ? Math.min(Math.floor(v), 1000) : null),
  elementOrder: names(ELEMENTS, true),
  projectLineOrder: names(SEGMENTS, false),
  'gitStatus.branchOverflow': oneOf(['truncate', 'wrap']),
  'gitStatus.pushWarningThreshold': floor0,
  'gitStatus.pushCriticalThreshold': floor0,
  'display.addedDirsLayout': oneOf(['inline', 'line']),
  'display.contextValue': oneOf(['percent', 'tokens', 'remaining', 'both']),
  'display.usageValue': oneOf(['percent', 'remaining']),
  'display.toolNameMaxLength': count,
  'display.toolsMaxVisible': count,
  'display.skillsMaxVisible': count,
  'display.authUserLength': count,
  'display.effortFormat': oneOf(['full', 'symbol', 'text']),
  'display.mergeGroups': groups,
  'display.rightAlign': names(ELEMENTS, false),
  'display.contextWarningThreshold': clamp(0, 100),
  'display.contextCriticalThreshold': clamp(0, 100),
  'display.usageThreshold': clamp(0, 100),
  'display.sevenDayThreshold': clamp(0, 100),
  'display.environmentThreshold': clamp(0, 100),
  'display.externalUsagePath': usagePath,
  'display.externalUsageWritePath': usagePath,
  'display.externalUsageFreshnessMs': floor0,
  'display.modelFormat': oneOf(['full', 'compact', 'short']),
  'display.modelOverride': text(80),
  'display.modelSource': oneOf(['auto', 'stdin', 'transcript']),
  'display.providerName': text(40),
  'display.customLine': text(80),
  'display.customLinePosition': oneOf(['first', 'last']),
  'display.timeFormat': oneOf(['relative', 'absolute', 'both', 'elapsed', 'elapsedAndAbsolute']),
  'display.hourCycle': oneOf(['auto', 'h11', 'h12', 'h23', 'h24']),
  'display.advisorOverride': text(80),
  'display.autoCompactWindow': (v) => (Number.isInteger(v) && (v as number) > 0 ? v : null),
  'colors.barFilled': barChar,
  'colors.barEmpty': barChar,
  'colors.*': color,
};

function walk(defaults: Raw, input: unknown, prefix = ''): Raw {
  const source = isObj(input) ? input : {};
  const out: Raw = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const keyPath = prefix + key;
    const rule = RULES[keyPath] ?? RULES[`${prefix}*`];
    const value = Object.hasOwn(source, key) ? source[key] : undefined;
    if (rule) out[key] = rule(value, fallback);
    else if (isObj(fallback)) out[key] = walk(fallback, value, `${keyPath}.`);
    else out[key] = typeof fallback === 'boolean' && typeof value === 'boolean' ? value : fallback;
  }
  return out;
}

// v0.0.x wrote layout: "default" | "separators"
function migrateLayout(c: Raw): Raw {
  if (!('layout' in c) || 'lineLayout' in c) return c;
  const { layout, ...rest } = c;
  if (typeof layout === 'string')
    return { ...rest, lineLayout: 'compact', showSeparators: layout === 'separators' };
  if (!isObj(layout)) return rest;
  const out: Raw = { ...rest };
  if (typeof layout.lineLayout === 'string') out.lineLayout = layout.lineLayout;
  if (typeof layout.showSeparators === 'boolean') out.showSeparators = layout.showSeparators;
  if (typeof layout.pathLevels === 'number' || layout.pathLevels === 'full')
    out.pathLevels = layout.pathLevels;
  return out;
}

export function normalizeHud(raw: unknown): HudConfig {
  return walk(
    structuredClone(HUD_DEFAULTS) as unknown as Raw,
    migrateLayout(isObj(raw) ? raw : {}),
  ) as HudConfig;
}

// objects merge, arrays and scalars replace
export function mergeHud(base: unknown, over: unknown, depth = 0): Raw {
  const out: Raw = Object.create(null);
  for (const src of [base, over]) {
    if (!isObj(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (UNSAFE.has(k)) continue;
      if (!isObj(v)) out[k] = v;
      else if (depth < MAX_DEPTH) out[k] = mergeHud(out[k], v, depth + 1);
    }
  }
  return out;
}

const unquote = (s: string) => s.replace(/"([^"]*)"|'([^']*)'/g, '$1$2');

// first --extra-cmd wins, also inside a quoted bash -c script
export function parseExtraCmd(command: string, depth = 0): string | null {
  const raw = [...command.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g)].map((m) => m[0]);
  for (let i = 0; i < raw.length; i++) {
    const a = unquote(raw[i]!);
    if (a === '--extra-cmd') return (raw[i + 1] && unquote(raw[i + 1]!)) || null;
    if (a.startsWith('--extra-cmd=')) return a.slice(12) || null;
    if (depth < 2 && /["']/.test(raw[i]!) && a.includes('--extra-cmd')) return parseExtraCmd(a, depth + 1);
  }
  return null;
}

export const TARGETS: readonly string[] = [
  'model',
  'effort',
  'provider',
  'text',
  'cwd',
  'git-branch',
  'git-status',
  'git-ahead-behind',
  'git-changes',
  'git-worktree',
  'session-name',
  'claude-version',
  'command',
  'session-duration',
  'session-cost',
  'cost-today',
  'cost-week',
  'output-speed',
  'context-bar',
  'context-percentage',
  'context-length',
  'tokens-input',
  'tokens-cached',
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'weekly-model-usage',
  'cache-timer',
  'cache-hit-rate',
  'memory',
  'env-counts',
  'output-style',
  'tool-activity',
  'skills',
  'agents',
  'todo-list',
  'tokens-total',
  'compactions',
];

type Opts = Record<string, OptionValue>;

interface Part {
  key: string | null;
  items: WidgetItem[];
}

class Builder {
  notes: ImportNote[] = [];
  private used = new Set<string>();
  constructor(readonly cfg: HudConfig) {}

  item(slot: string, type: string, options?: Opts, paint?: unknown): WidgetItem {
    let id = `hud-${slot}-${type}`;
    for (let n = 2; this.used.has(id); n++) id = `hud-${slot}-${type}-${n}`;
    this.used.add(id);
    const it: WidgetItem = { id, type };
    if (options && Object.keys(options).length) it.options = options;
    const style = paint === undefined ? undefined : hudColor(paint);
    if (style?.color) it.color = style.color;
    if (style?.dim) it.dim = true;
    return it;
  }

  note(kind: ImportNote['kind'], id: MessageId, params: Record<string, string | number> = {}): void {
    this.notes.push({ kind, text: t(id, { tool: TOOL, ...params }) });
  }

  approx(name: string, widget: string): void {
    this.note('approx', 'import.note.hudApprox', { name, widget });
  }
}

function modelItems(b: Builder): WidgetItem[] {
  const d = b.cfg.display;
  const c = b.cfg.colors;
  if (!d.showModel) return [];
  const out = [
    d.modelOverride
      ? b.item('model', 'text', { text: d.modelOverride }, c.model)
      : b.item('model', 'model', undefined, c.model),
  ];
  if (d.showEffortLevel) out.push(b.item('model', 'effort', undefined, c.model));
  if (d.showProvider) out.push(b.item('model', 'provider', { showFirstParty: true }, c.model));
  return out;
}

function projectItems(b: Builder): WidgetItem[] {
  const { display: d, colors: c, gitStatus: g, pathLevels } = b.cfg;
  const out: WidgetItem[] = [];
  if (d.showProject) {
    const opts: Opts =
      pathLevels === 'full'
        ? { style: 'full' }
        : pathLevels === 1
          ? { style: 'basename' }
          : { style: 'segments', segments: pathLevels };
    out.push(b.item('project', 'cwd', opts, c.project));
  }
  if (b.cfg.jjStatus.enabled) b.note('drop', 'import.note.noSegment', { name: 'jjStatus' });
  if (!g.enabled) return out;
  out.push(b.item('project', 'git-branch', undefined, c.gitBranch));
  if (g.showDirty) out.push(b.item('project', 'git-status', { counts: false }, c.gitBranch));
  if (g.showAheadBehind) {
    out.push(b.item('project', 'git-ahead-behind', undefined, c.gitBranch));
    for (const name of ['pushWarningThreshold', 'pushCriticalThreshold'] as const) {
      if (g[name] > 0) {
        b.note('drop', 'import.note.hudNoThreshold', { name, value: g[name], widget: 'git-ahead-behind' });
      }
    }
  }
  if (g.showFileStats) out.push(b.item('project', 'git-changes'));
  if (g.showWorktree) out.push(b.item('project', 'git-worktree', undefined, c.git));
  return out;
}

function contextItems(b: Builder): WidgetItem[] {
  const d = b.cfg.display;
  const mode = d.contextValue;
  const out: WidgetItem[] = [];
  if (d.showContextBar) {
    out.push(
      b.item('context', 'context-bar', mode === 'percent' || mode === 'both' ? {} : { showPercent: false }),
    );
  }
  if (mode === 'remaining') out.push(b.item('context', 'context-percentage', { mode: 'remaining' }));
  else if (!d.showContextBar && mode !== 'tokens') out.push(b.item('context', 'context-percentage'));
  if (mode === 'tokens' || mode === 'both') out.push(b.item('context', 'context-length'));
  const warn = d.contextWarningThreshold;
  const critical = d.contextCriticalThreshold;
  if (warn !== 50 || critical !== 80)
    b.note('approx', 'import.note.hudContextThresholds', { warn, critical });
  return out;
}

function breakdownItems(b: Builder): WidgetItem[] {
  const d = b.cfg.display;
  if (!d.showTokenBreakdown) return [];
  b.note('approx', 'import.note.hudBreakdown', { value: d.contextCriticalThreshold });
  const label = b.cfg.colors.label;
  return [
    b.item('context', 'tokens-input', undefined, label),
    b.item('context', 'tokens-cached', undefined, label),
  ];
}

function usageItems(b: Builder): WidgetItem[] {
  const d = b.cfg.display;
  if (!d.showUsage) return [];
  const bar: Opts = d.usageBarEnabled ? { display: 'bar' } : {};
  const out = [
    b.item('usage', 'five-hour-usage', bar),
    b.item('usage', 'five-hour-reset'),
    b.item('usage', 'weekly-usage', bar),
    b.item('usage', 'weekly-reset'),
  ];
  if (d.showModelScopedUsage) {
    out.push(b.item('usage', 'weekly-model-usage', bar));
    b.approx('showModelScopedUsage', 'weekly-model-usage');
  }
  if (d.usageValue === 'remaining') b.approx('usageValue', 'five-hour-usage, weekly-usage');
  if (d.usageThreshold > 0) {
    b.note('approx', 'import.note.hudShownAlways', {
      name: 'usageThreshold',
      value: d.usageThreshold,
      widget: 'five-hour-usage',
    });
  }
  if (d.sevenDayThreshold > 0) {
    b.note('approx', 'import.note.hudShownAlways', {
      name: 'sevenDayThreshold',
      value: d.sevenDayThreshold,
      widget: 'weekly-usage',
    });
  }
  return out;
}

function configCounts(b: Builder): WidgetItem[] {
  const d = b.cfg.display;
  if (!d.showConfigCounts) return [];
  if (d.environmentThreshold > 0) {
    b.note('approx', 'import.note.hudShownAlways', {
      name: 'environmentThreshold',
      value: d.environmentThreshold,
      widget: 'env-counts',
    });
  }
  return [b.item('environment', 'env-counts', { showAgentsMd: false, mcpHealth: true }, b.cfg.colors.label)];
}

function sessionTime(b: Builder): WidgetItem[] {
  const d = b.cfg.display;
  if (!d.showSessionStartDate && !d.showLastResponseAt) return [];
  b.approx('sessionTime', 'session-duration');
  return [b.item('sessionTime', 'session-duration', undefined, b.cfg.colors.label)];
}

function segmentItems(b: Builder, key: string, extraCmd: string | null): WidgetItem[] {
  const d = b.cfg.display;
  const label = b.cfg.colors.label;
  const one = (show: boolean, type: string, options?: Opts) =>
    show ? [b.item(key, type, options, label)] : [];
  switch (key) {
    case 'model':
      return modelItems(b);
    case 'project':
      return projectItems(b);
    case 'advisor':
      if (d.showAdvisor) b.note('drop', 'import.note.noSegment', { name: 'advisor' });
      return [];
    case 'sessionName':
      return one(d.showSessionName, 'session-name');
    case 'version':
      return one(d.showClaudeCodeVersion, 'claude-version');
    case 'extra':
      return extraCmd ? [b.item('extra', 'command', { command: extraCmd, timeout: 3000 }, label)] : [];
    case 'duration':
      return one(d.showDuration, 'session-duration');
    case 'cost':
      return [
        ...one(d.showCost, 'session-cost'),
        ...one(d.showDailyCost, 'cost-today'),
        ...one(d.showWeeklyCost, 'cost-week'),
      ];
    case 'speed':
      return one(d.showSpeed, 'output-speed');
    case 'auth':
      if ((!d.showAuth && !d.showAuthUser) || d.showProvider) return [];
      b.approx('auth', 'provider');
      return [b.item('auth', 'provider', { showFirstParty: true }, label)];
    default:
      return [];
  }
}

function customItems(b: Builder, position: string): WidgetItem[] {
  const d = b.cfg.display;
  if (!d.customLine || d.customLinePosition !== position) return [];
  return [b.item('custom', 'text', { text: d.customLine }, b.cfg.colors.custom)];
}

// claude-hud orderParts: unkeyed parts keep their slots
function orderParts(parts: Part[], order: readonly string[]): WidgetItem[] {
  const shown = parts.filter((p) => p.items.length > 0);
  const slots: number[] = [];
  const byKey = new Map<string, WidgetItem[][]>();
  shown.forEach((p, i) => {
    if (p.key === null) return;
    slots.push(i);
    byKey.set(p.key, [...(byKey.get(p.key) ?? []), p.items]);
  });
  const moved: WidgetItem[][] = [];
  for (const key of order) {
    moved.push(...(byKey.get(key) ?? []));
    byKey.delete(key);
  }
  for (const rest of byKey.values()) moved.push(...rest);
  const out = shown.map((p) => p.items);
  slots.forEach((slot, i) => {
    out[slot] = moved[i]!;
  });
  return out.flat();
}

function keyed(b: Builder, keys: readonly string[], extraCmd: string | null): Part[] {
  return keys.map((key) => ({ key, items: segmentItems(b, key, extraCmd) }));
}

function projectLine(b: Builder, extraCmd: string | null): WidgetItem[] {
  return orderParts(
    [
      { key: null, items: customItems(b, 'first') },
      ...keyed(b, SEGMENTS, extraCmd),
      { key: null, items: customItems(b, 'last') },
    ],
    b.cfg.projectLineOrder,
  );
}

function elementItems(b: Builder, element: string, extraCmd: string | null): WidgetItem[] {
  const d = b.cfg.display;
  const label = b.cfg.colors.label;
  switch (element) {
    case 'project':
      return projectLine(b, extraCmd);
    case 'context':
      return [...contextItems(b), ...breakdownItems(b)];
    case 'usage':
      return usageItems(b);
    case 'promptCache':
      return d.showPromptCache ? [b.item(element, 'cache-timer')] : [];
    case 'cacheHitRate':
      return d.showCacheHitRate ? [b.item(element, 'cache-hit-rate')] : [];
    case 'memory':
      return d.showMemoryUsage ? [b.item(element, 'memory')] : [];
    case 'environment':
      return [
        ...configCounts(b),
        ...(d.showOutputStyle ? [b.item(element, 'output-style', undefined, label)] : []),
      ];
    case 'tools':
      return d.showTools
        ? [
            b.item(element, 'tool-activity', {
              scope: 'session',
              ...(d.toolsMaxVisible ? { maxTools: d.toolsMaxVisible } : {}),
            }),
          ]
        : [];
    case 'skills':
      return d.showSkills
        ? [
            b.item(element, 'skills', {
              mode: 'list',
              ...(d.skillsMaxVisible ? { limit: d.skillsMaxVisible } : {}),
            }),
          ]
        : [];
    case 'mcp':
      if (!d.showMcp) return [];
      b.approx('mcp', 'env-counts');
      return [
        b.item(element, 'env-counts', {
          showClaudeMd: false,
          showAgentsMd: false,
          showRules: false,
          showHooks: false,
          mcpHealth: true,
        }),
      ];
    case 'agents':
      return d.showAgents ? [b.item(element, 'agents')] : [];
    case 'todos':
      return d.showTodos ? [b.item(element, 'todo-list', { display: 'current' })] : [];
    case 'sessionTime':
      return sessionTime(b);
    case 'sessionTokens':
      return d.showSessionTokens ? [b.item(element, 'tokens-total', undefined, label)] : [];
    default:
      return [];
  }
}

function separatorLine(b: Builder): WidgetItem[] {
  b.approx('showSeparators', 'text');
  const it = b.item('separator', 'text', { text: '─'.repeat(40) });
  it.dim = true;
  return [it];
}

interface Row {
  items: WidgetItem[];
  activity: boolean;
}

function expandedLines(b: Builder, extraCmd: string | null): WidgetItem[][] {
  const { elementOrder: order, display: d } = b.cfg;
  const groupOf = new Map<string, Set<string>>();
  for (const g of d.mergeGroups) {
    const members = new Set(g);
    for (const e of g) if (!groupOf.has(e)) groupOf.set(e, members);
  }
  if (d.showAddedDirs) {
    const inline = d.addedDirsLayout === 'inline';
    if (order.includes(inline ? 'project' : 'addedDirs')) {
      b.note('drop', 'import.note.noSegment', { name: 'addedDirs' });
    }
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < order.length; i++) {
    const element = order[i]!;
    if (seen.has(element)) continue;
    const group = groupOf.get(element);
    const run: string[] = [];
    for (let j = i; group && j < order.length && group.has(order[j]!) && !seen.has(order[j]!); j++) {
      run.push(order[j]!);
    }
    const members = run.length > 1 ? run : [element];
    i += members.length - 1;
    for (const m of members) seen.add(m);
    const items = members.flatMap((m) => elementItems(b, m, extraCmd));
    if (items.length) rows.push({ items, activity: members.some((m) => ACTIVITY.includes(m)) });
  }
  const lines = rows.map((r) => r.items);
  if (!order.includes('sessionTokens')) {
    const tokens = elementItems(b, 'sessionTokens', null);
    if (tokens.length) lines.push(tokens);
  }
  if (d.showCompactions) lines.push([b.item('compactions', 'compactions', undefined, b.cfg.colors.label)]);
  const firstActivity = rows.findIndex((r) => r.activity);
  if (b.cfg.showSeparators && firstActivity > 0) lines.splice(firstActivity, 0, separatorLine(b));
  return lines;
}

function compactLines(b: Builder, extraCmd: string | null): WidgetItem[][] {
  const d = b.cfg.display;
  const label = b.cfg.colors.label;
  const free = (items: WidgetItem[]): Part => ({ key: null, items });
  const session = orderParts(
    [
      free(customItems(b, 'first')),
      { key: 'model', items: [...modelItems(b), ...contextItems(b)] },
      ...keyed(b, ['project', 'sessionName', 'version'], extraCmd),
      free(configCounts(b)),
      free(usageItems(b)),
      free(d.showSessionTokens ? [b.item('sessionTokens', 'tokens-total', undefined, label)] : []),
      free(d.showCompactions ? [b.item('compactions', 'compactions', undefined, label)] : []),
      ...keyed(b, ['advisor', 'duration'], extraCmd),
      free(sessionTime(b)),
      free(d.showPromptCache ? [b.item('promptCache', 'cache-timer')] : []),
      free(d.showCacheHitRate ? [b.item('cacheHitRate', 'cache-hit-rate')] : []),
      ...keyed(b, ['cost', 'speed', 'extra', 'auth'], extraCmd),
      free(customItems(b, 'last')),
    ],
    b.cfg.projectLineOrder,
  );
  session.push(...breakdownItems(b));
  const activity = ACTIVITY.map((e) => elementItems(b, e, null)).filter((l) => l.length > 0);
  const lines = [session];
  if (b.cfg.showSeparators && activity.length) lines.push(separatorLine(b));
  return [...lines, ...activity].filter((l) => l.length > 0);
}

export function importClaudeHud(
  cfg: HudConfig,
  opts: { extraCmd?: string | null; extraAllowed?: boolean; defaulted?: boolean } = {},
): ImportResult {
  const b = new Builder(cfg);
  if (opts.defaulted) b.note('info', 'import.note.defaultLayout');
  const extraCmd = opts.extraCmd || null;
  if (extraCmd && !opts.extraAllowed) b.note('info', 'import.note.hudExtraCmd');
  if (cfg.language !== 'en') b.note('drop', 'import.note.hudLanguage', { name: sanitizeText(cfg.language) });
  for (const name of ['externalUsagePath', 'externalUsageWritePath'] as const) {
    if (cfg.display[name]) b.note('drop', 'import.note.hudExternalUsage', { name });
  }
  const compact = cfg.lineLayout === 'compact';
  const lines = compact ? compactLines(b, extraCmd) : expandedLines(b, extraCmd);
  const config: Partial<Config> = { lines, separator: compact ? ' | ' : ' │ ' };
  if (cfg.maxWidth !== null) config.maxWidth = cfg.maxWidth;
  const seen = new Set<string>();
  const notes = b.notes.filter((n) => !seen.has(`${n.kind}:${n.text}`) && !!seen.add(`${n.kind}:${n.text}`));
  return { config, notes, source: 'claude-hud' };
}
