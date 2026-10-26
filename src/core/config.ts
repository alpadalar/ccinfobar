import fs from 'node:fs';
import { writeAtomic } from '../data/store.js';
import { GLYPH_MODES, OVERFLOW_MODES } from './display-opts.js';
import { normalizeHeaderSpec, parseHeaderSpec, parseUrlTemplate } from './http-spec.js';
import { t } from './i18n/index.js';
import { asciiLower, LANGUAGE_SETTINGS } from './i18n/languages.js';
import { locateJsonError, locateKey } from './json-locate.js';
import { configPath } from './paths.js';
import { normalizeProfileOverride, PROFILE_OVERRIDES_MAX } from './profiles.js';
import { normalizeThemeRotation } from './rotation.js';
import { sanitizeText } from './sanitize.js';
import type {
  Align,
  BoxChars,
  Config,
  GlyphOverrides,
  ProgressConfig,
  ThemeStyle,
  TuiBreakpoint,
  TuiConfig,
  TuiTemplate,
  WidgetItem,
} from './types.js';

export const SCHEMA_URL =
  'https://raw.githubusercontent.com/alpadalar/ccinfobar/main/schema/config.schema.json';

let counter = 0;
export function newId(type = 'w'): string {
  counter = (counter + 1) % 1296;
  return `${type}-${Date.now().toString(36).slice(-4)}${counter.toString(36).padStart(2, '0')}`;
}

function item(type: string, extra: Partial<WidgetItem> = {}): WidgetItem {
  return { id: `${type}-1`, type, ...extra };
}

const STYLE_IDS = ['text', 'blocks', 'powerline', 'capsule', 'tui'];
const LEGACY_THEMES: Record<string, string> = { default: 'powerline' };

export function defaultConfig(): Config {
  return {
    $schema: SCHEMA_URL,
    version: 1,
    lines: [
      [
        item('model'),
        item('effort'),
        item('cwd'),
        item('git-branch'),
        item('git-changes'),
        item('context-bar'),
      ],
      [
        item('gsd-milestone'),
        item('gsd-milestone-progress'),
        item('gsd-phase'),
        item('gsd-plans'),
        item('gsd-next'),
      ],
      [item('session-cost'), item('five-hour-usage'), item('five-hour-reset'), item('weekly-usage')],
    ],
    theme: 'classic',
    charset: 'auto',
    autoWrap: true,
    update: 'auto',
    usageApi: true,
    colorLevel: 'auto',
    icons: 'text',
    maxWidth: 'auto',
    widthOffset: 10,
    savePayload: true,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeItem(raw: unknown, index: number): WidgetItem | null {
  if (!isObject(raw) || typeof raw.type !== 'string' || !raw.type) return null;
  const type = raw.type;
  const out: WidgetItem = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${type}-${index}`,
    type,
  };
  for (const key of ['color', 'background', 'label'] as const) {
    if (typeof raw[key] === 'string') out[key] = raw[key] as string;
  }
  for (const key of ['bold', 'dim', 'italic', 'raw', 'merge', 'hideEmpty'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  }
  for (const key of ['showWhen', 'hideWhen'] as const) {
    const v = raw[key];
    if (typeof v === 'string') out[key] = v;
    else if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === 'string');
      if (list.length) out[key] = list;
    }
  }
  if (typeof raw.priority === 'number' && Number.isFinite(raw.priority)) {
    out.priority = Math.min(100, Math.max(0, Math.round(raw.priority)));
  }
  if (isObject(raw.options)) {
    const opts: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.options)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') opts[k] = v;
    }
    out.options = type === 'http' ? normalizeHttpOptions(opts) : opts;
  }
  return out;
}

const toNum = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
};

const HTTP_RANGES: Record<string, [number, number]> = {
  interval: [30, Number.MAX_SAFE_INTEGER],
  timeout: [1000, 15_000],
  decimals: [-1, 10],
  maxLength: [1, 200],
};

// drops only what the worker would refuse, so the rest of the item survives
export function normalizeHttpOptions(
  opts: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  if ('url' in out && (typeof out.url !== 'string' || !parseUrlTemplate(out.url).ok)) delete out.url;
  if ('headers' in out) {
    const valid = typeof out.headers === 'string' ? parseHeaderSpec(out.headers).headers : [];
    if (valid.length) out.headers = normalizeHeaderSpec(valid);
    else delete out.headers;
  }
  if ('path' in out) {
    if (typeof out.path === 'string') out.path = out.path.slice(0, 256);
    else delete out.path;
  }
  for (const [k, [min, max]] of Object.entries(HTTP_RANGES)) {
    if (!(k in out)) continue;
    const n = toNum(out[k]);
    if (n === undefined) delete out[k];
    else out[k] = Math.min(max, Math.max(min, n));
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown, min = 0): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : undefined;
}

function compact<T extends object>(o: T): T | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(out).length ? out : undefined;
}

const BOX_KEYS = [
  'topLeft',
  'topRight',
  'bottomLeft',
  'bottomRight',
  'horizontal',
  'vertical',
  'teeLeft',
  'teeRight',
] as const;
const ALIGNS = ['left', 'center', 'right'];

export function normalizeTui(raw: unknown): TuiConfig | undefined {
  if (!isObject(raw)) return undefined;
  const t: TuiConfig = {};
  if (typeof raw.box === 'string') t.box = raw.box;
  else if (isObject(raw.box)) {
    const box: Partial<BoxChars> = {};
    for (const k of BOX_KEYS) if (typeof raw.box[k] === 'string') box[k] = raw.box[k] as string;
    t.box = box;
  }
  if (typeof raw.fitContent === 'boolean') t.fitContent = raw.fitContent;
  if (typeof raw.dividers === 'boolean') t.dividers = raw.dividers;
  const minWidth = num(raw.minWidth, 10);
  if (minWidth !== undefined) t.minWidth = minWidth;
  const maxWidth = num(raw.maxWidth, 10);
  if (maxWidth !== undefined) t.maxWidth = maxWidth;
  const padding = num(raw.padding);
  if (padding !== undefined) t.padding = Math.min(8, padding);
  if (typeof raw.columnGap === 'string') t.columnGap = raw.columnGap;
  if (typeof raw.divider === 'string') t.divider = raw.divider;
  if (typeof raw.borderColor === 'string' && raw.borderColor) t.borderColor = raw.borderColor.slice(0, 32);
  if (isObject(raw.title)) {
    const title = compact({
      left: str(raw.title.left),
      right: raw.title.right === false ? (false as const) : str(raw.title.right),
    });
    if (title) t.title = title;
  }
  if (isObject(raw.footer)) {
    const footer = compact({ left: str(raw.footer.left), right: str(raw.footer.right) });
    if (footer) t.footer = footer;
  }
  if (isObject(raw.templates)) {
    const templates: Record<string, TuiTemplate> = {};
    for (const [k, v] of Object.entries(raw.templates)) {
      if (!isObject(v) || !Array.isArray(v.items)) continue;
      templates[k] = {
        items: v.items.filter((x): x is string => typeof x === 'string'),
        ...(num(v.gap) !== undefined ? { gap: num(v.gap) } : {}),
        ...(v.justify === 'between' || v.justify === 'start' ? { justify: v.justify } : {}),
      };
    }
    t.templates = templates;
  }
  if (Array.isArray(raw.breakpoints)) {
    t.breakpoints = raw.breakpoints
      .filter((b): b is Record<string, unknown> => isObject(b) && Array.isArray(b.areas))
      .map((b) => {
        const bp: TuiBreakpoint = {
          minWidth: num(b.minWidth) ?? 0,
          areas: (b.areas as unknown[]).filter((x): x is string => typeof x === 'string'),
        };
        if (Array.isArray(b.columns)) bp.columns = b.columns.map((c) => String(c));
        if (Array.isArray(b.align)) {
          bp.align = b.align.map((a) =>
            ALIGNS.includes(a as string) ? a : 'left',
          ) as TuiBreakpoint['align'];
        }
        return bp;
      });
  }
  return t;
}

const usd = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

export function normalizeBudget(raw: unknown): Config['budget'] | undefined {
  if (!isObject(raw)) return undefined;
  const warnAt =
    typeof raw.warnAt === 'number' && Number.isFinite(raw.warnAt)
      ? Math.min(1, Math.max(0.05, raw.warnAt))
      : undefined;
  return compact({ daily: usd(raw.daily), session: usd(raw.session), warnAt });
}

const oneOf = <T>(v: unknown, list: readonly T[]): T | undefined =>
  list.includes(v as T) ? (v as T) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const pct = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(1, Math.round(v))) : undefined;

export function normalizeProgress(raw: unknown): ProgressConfig | undefined {
  if (!isObject(raw)) return undefined;
  return compact({
    enabled: bool(raw.enabled),
    source: oneOf(raw.source, ['context', 'usage5h'] as const),
    scaleTo: oneOf(raw.scaleTo, ['full', 'autocompact'] as const),
    warnAt: pct(raw.warnAt),
    errorAt: pct(raw.errorAt),
    channel: oneOf(raw.channel, ['auto', 'hook', 'tty'] as const),
    tmuxPassthrough: bool(raw.tmuxPassthrough),
    terminals: oneOf(raw.terminals, ['allowlist', 'always'] as const),
  });
}

export { GLYPH_MODES };

export function normalizeProfiles(raw: unknown): Config['profiles'] | undefined {
  if (!isObject(raw)) return undefined;
  const models = Array.isArray(raw.models)
    ? raw.models
        .map(normalizeProfileOverride)
        .filter((o) => o !== null)
        .slice(0, PROFILE_OVERRIDES_MAX)
    : [];
  return compact({
    builtIn: typeof raw.builtIn === 'boolean' ? raw.builtIn : undefined,
    models: models.length ? models : undefined,
  });
}

const isAlign = (v: unknown): v is Align => v === 'left' || v === 'center' || v === 'right';

export function normalizeConfig(raw: unknown): Config {
  const base = defaultConfig();
  if (!isObject(raw)) return base;
  const cfg: Config = { ...base };
  if (Array.isArray(raw.lines)) {
    const seen = new Set<string>();
    cfg.lines = raw.lines.filter(Array.isArray).map((line) =>
      (line as unknown[])
        .map((it, i) => normalizeItem(it, i))
        .filter((it): it is WidgetItem => it !== null)
        .map((it) => {
          let id = it.id;
          let n = 2;
          while (seen.has(id)) id = `${it.id}-${n++}`;
          seen.add(id);
          return { ...it, id };
        }),
    );
  }
  if (typeof raw.separator === 'string') cfg.separator = raw.separator;
  if (typeof raw.separatorColor === 'string') cfg.separatorColor = raw.separatorColor;
  if (typeof raw.padding === 'number' && raw.padding >= 0) cfg.padding = Math.min(4, Math.floor(raw.padding));
  if (raw.colorLevel === 'auto' || [0, 1, 2, 3].includes(raw.colorLevel as number)) {
    cfg.colorLevel = raw.colorLevel as Config['colorLevel'];
  }
  if (['nerd', 'emoji', 'text', 'none'].includes(raw.icons as string))
    cfg.icons = raw.icons as Config['icons'];
  if (raw.maxWidth === 'auto' || (typeof raw.maxWidth === 'number' && raw.maxWidth > 0)) {
    cfg.maxWidth = raw.maxWidth as Config['maxWidth'];
  }
  if (typeof raw.widthOffset === 'number') cfg.widthOffset = Math.max(0, Math.floor(raw.widthOffset));
  if (typeof raw.savePayload === 'boolean') cfg.savePayload = raw.savePayload;
  if (typeof raw.theme === 'string' && raw.theme) cfg.theme = raw.theme;
  if (['auto', 'nerd', 'unicode', 'text'].includes(raw.charset as string))
    cfg.charset = raw.charset as Config['charset'];
  if (typeof raw.autoWrap === 'boolean') cfg.autoWrap = raw.autoWrap;
  const overflow = oneOf(raw.overflow, OVERFLOW_MODES);
  if (overflow) cfg.overflow = overflow;
  const glyphMode = oneOf(raw.glyphMode, GLYPH_MODES);
  if (glyphMode) cfg.glyphMode = glyphMode;
  if (raw.ambiguousWidth === 1 || raw.ambiguousWidth === 2) cfg.ambiguousWidth = raw.ambiguousWidth;
  const language = oneOf(
    typeof raw.language === 'string' ? asciiLower(raw.language) : raw.language,
    LANGUAGE_SETTINGS,
  );
  if (language) cfg.language = language;
  if (isAlign(raw.align) && raw.align !== 'left') cfg.align = raw.align;
  if (Array.isArray(raw.lineAlign)) {
    const list = raw.lineAlign.slice(0, cfg.lines.length).map((a) => (isAlign(a) ? a : null));
    while (list.length && list[list.length - 1] === null) list.pop();
    if (list.length) cfg.lineAlign = list;
  }
  if (raw.update === 'notify' || raw.update === 'auto' || raw.update === 'off') cfg.update = raw.update;
  if (typeof raw.usageApi === 'boolean') cfg.usageApi = raw.usageApi;
  if (raw.gsdAutoLine === true) cfg.gsdAutoLine = true;
  if (raw.gitHardening === false) cfg.gitHardening = false;
  if (typeof raw.loadingText === 'string') cfg.loadingText = sanitizeText(raw.loadingText).slice(0, 40);
  const budget = normalizeBudget(raw.budget);
  if (budget) cfg.budget = budget;
  const profiles = normalizeProfiles(raw.profiles);
  if (profiles) cfg.profiles = profiles;
  const rotation = normalizeThemeRotation(raw.themeRotation);
  if (rotation) cfg.themeRotation = rotation;
  const progress = normalizeProgress(raw.progress);
  if (progress) cfg.progress = progress;
  const tui = normalizeTui(raw.tui);
  if (tui) cfg.tui = tui;
  if (typeof raw.style === 'string' && STYLE_IDS.includes(raw.style)) cfg.style = raw.style as ThemeStyle;
  if (isObject(raw.glyphs)) {
    const g: GlyphOverrides = {};
    for (const k of ['separator', 'thin', 'startCap', 'endCap'] as const) {
      if (typeof raw.glyphs[k] === 'string') g[k] = raw.glyphs[k] as string;
    }
    if (Object.keys(g).length) cfg.glyphs = g;
  }
  if (isObject(raw.powerline) && raw.theme === undefined) {
    const p = raw.powerline;
    if (p.enabled === true) {
      cfg.style = 'powerline';
      if (typeof p.theme === 'string') cfg.theme = LEGACY_THEMES[p.theme] ?? p.theme;
    }
  }
  return cfg;
}

export interface ConfigIssue {
  kind: 'parse' | 'structure';
  line: number;
  column: number;
  message: string;
}

export interface LoadResult {
  config: Config;
  path: string;
  exists: boolean;
  error?: string;
  issue?: ConfigIssue;
}

export class ConfigBrokenError extends Error {
  constructor(
    readonly file: string,
    readonly issue: ConfigIssue,
  ) {
    super(t('config.refuseBroken', { file }));
    this.name = 'ConfigBrokenError';
  }
}

export function inspectConfigText(text: string): { raw: unknown; issue: ConfigIssue | null } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    const at = locateJsonError(body);
    const issue: ConfigIssue = at
      ? { kind: 'parse', line: at.line, column: at.column, message: at.message }
      : { kind: 'parse', line: 1, column: 1, message: t('json.unexpectedEnd') };
    return { raw: undefined, issue };
  }
  if (!isObject(raw)) {
    return { raw, issue: { kind: 'structure', line: 1, column: 1, message: t('config.notObject') } };
  }
  if (raw.lines !== undefined && !Array.isArray(raw.lines)) {
    const at = locateKey(body, 'lines') ?? { line: 1, column: 1 };
    return {
      raw,
      issue: { kind: 'structure', line: at.line, column: at.column, message: t('config.linesNotArray') },
    };
  }
  return { raw, issue: null };
}

export function loadConfig(file = configPath(), fallback: () => Config = defaultConfig): LoadResult {
  try {
    const { raw, issue } = inspectConfigText(fs.readFileSync(file, 'utf8'));
    if (issue) return { config: defaultConfig(), path: file, exists: true, error: issue.message, issue };
    return { config: normalizeConfig(raw), path: file, exists: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { config: fallback(), path: file, exists: false };
    return { config: defaultConfig(), path: file, exists: true, error: e.message };
  }
}

export function saveConfig(
  config: Config,
  file = configPath(),
  opts: { overwriteBroken?: boolean } = {},
): void {
  if (!opts.overwriteBroken) {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {}
    const issue = existing === null ? null : inspectConfigText(existing).issue;
    if (issue) throw new ConfigBrokenError(file, issue);
  }
  const data = { $schema: SCHEMA_URL, ...normalizeConfig(config) };
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { class: 'settings' });
}
