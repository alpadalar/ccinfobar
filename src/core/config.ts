import fs from 'node:fs';
import path from 'node:path';
import { configPath } from './paths.js';
import type {
  BoxChars,
  Config,
  GlyphOverrides,
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
    autoWrap: false,
    update: 'auto',
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
  const out: WidgetItem = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${raw.type}-${index}`,
    type: raw.type,
  };
  for (const key of ['color', 'background', 'label'] as const) {
    if (typeof raw[key] === 'string') out[key] = raw[key] as string;
  }
  for (const key of ['bold', 'dim', 'italic', 'raw', 'merge', 'hideEmpty'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key] as boolean;
  }
  if (isObject(raw.options)) {
    const opts: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(raw.options)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') opts[k] = v;
    }
    out.options = opts;
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
  if (raw.update === 'notify' || raw.update === 'auto' || raw.update === 'off') cfg.update = raw.update;
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

export interface LoadResult {
  config: Config;
  path: string;
  exists: boolean;
  error?: string;
}

export function loadConfig(file = configPath()): LoadResult {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { config: normalizeConfig(JSON.parse(text)), path: file, exists: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { config: defaultConfig(), path: file, exists: false };
    return { config: defaultConfig(), path: file, exists: true, error: e.message };
  }
}

export function saveConfig(config: Config, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { $schema: SCHEMA_URL, ...normalizeConfig(config) };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
