import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../data/store.js';
import { parseColor } from './ansi.js';
import { configDir } from './paths.js';
import { BASE, BUILTIN } from './themes/builtin.js';
import {
  type ColorMode,
  STYLE_GLYPHS,
  STYLE_SEPARATOR,
  STYLES,
  type Swatch,
  type Theme,
  type ThemeColors,
  type ThemeGlyphs,
  type ThemeInput,
} from './themes/style.js';
import type { ThemeStyle, WidgetCategory } from './types.js';

export type { ColorMode, Swatch, Theme, ThemeColors, ThemeGlyphs, ThemeInput, ThemeStyle };
export { STYLE_GLYPHS, STYLE_SEPARATOR, STYLES };

const STYLE_IDS = new Set<string>(STYLES.map((s) => s.id));
const MODES = new Set(['widget', 'category', 'cycle']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_STOPS = 8;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function swatch(v: unknown): Swatch | undefined {
  if (typeof v === 'string') return v;
  if (!isObject(v)) return undefined;
  const out: { fg?: string; bg?: string } = {};
  if (typeof v.fg === 'string') out.fg = v.fg;
  if (typeof v.bg === 'string') out.bg = v.bg;
  return out.fg || out.bg ? out : undefined;
}

export function parseThemeInput(raw: unknown): ThemeInput {
  if (!isObject(raw)) return {};
  const t: ThemeInput = {};
  for (const k of ['id', 'name', 'description', 'author', 'extends', 'separator'] as const) {
    const v = str(raw[k]);
    if (v !== undefined) t[k] = v;
  }
  if (typeof raw.style === 'string' && STYLE_IDS.has(raw.style)) t.style = raw.style as ThemeStyle;
  if (typeof raw.padding === 'number' && raw.padding >= 0) t.padding = Math.min(4, Math.floor(raw.padding));
  if (typeof raw.bold === 'boolean') t.bold = raw.bold;
  if (typeof raw.statusColors === 'boolean') t.statusColors = raw.statusColors;
  if (Array.isArray(raw.gradient)) {
    const stops = raw.gradient
      .filter((v): v is string => typeof v === 'string' && parseColor(v) !== null)
      .slice(0, MAX_STOPS);
    if (stops.length) t.gradient = stops;
  }
  if (isObject(raw.glyphs)) {
    const g: Partial<ThemeGlyphs> = {};
    for (const k of ['separator', 'thin', 'startCap', 'endCap'] as const) {
      const v = str(raw.glyphs[k]);
      if (v !== undefined) g[k] = v;
    }
    t.glyphs = g;
  }
  if (isObject(raw.colors)) {
    const c = raw.colors;
    const colors: Partial<ThemeColors> = {};
    if (typeof c.mode === 'string' && MODES.has(c.mode)) colors.mode = c.mode as ColorMode;
    for (const k of ['fg', 'bg', 'on', 'muted'] as const) {
      const v = str(c[k]);
      if (v !== undefined) colors[k] = v;
    }
    if (isObject(c.categories)) {
      const out: Partial<Record<WidgetCategory, Swatch>> = {};
      for (const [k, v] of Object.entries(c.categories)) {
        const s = swatch(v);
        if (s) out[k as WidgetCategory] = s;
      }
      colors.categories = out;
    }
    if (Array.isArray(c.cycle))
      colors.cycle = c.cycle.map(swatch).filter((s): s is Swatch => s !== undefined);
    t.colors = colors;
  }
  return t;
}

function merge(base: Theme, input: ThemeInput, source: Theme['source']): Theme {
  const style = input.style ?? base.style;
  const styleChanged = style !== base.style;
  const gradient = input.gradient ?? base.gradient;
  return {
    id: input.id ?? base.id,
    name: input.name ?? input.id ?? base.name,
    description: input.description ?? base.description,
    author: input.author ?? (source === 'user' ? '' : base.author),
    style,
    separator: input.separator ?? (styleChanged ? STYLE_SEPARATOR[style] : base.separator),
    padding: input.padding ?? base.padding,
    bold: input.bold ?? base.bold,
    statusColors: input.statusColors ?? base.statusColors,
    ...(gradient ? { gradient: [...gradient] } : {}),
    glyphs: { ...(styleChanged ? STYLE_GLYPHS[style] : base.glyphs), ...input.glyphs },
    colors: {
      ...base.colors,
      ...input.colors,
      categories: { ...base.colors.categories, ...input.colors?.categories },
      cycle: input.colors?.cycle ?? base.colors.cycle,
    },
    source,
  };
}

const builtins = new Map<string, Theme>();
for (const input of BUILTIN) {
  const theme = merge(BASE, input, 'builtin');
  builtins.set(theme.id, theme);
}

export const BUILTIN_THEMES: Theme[] = [...builtins.values()];
export const DEFAULT_THEME = 'classic';

export function themesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'themes');
}

function readUserInput(id: string, dir: string): ThemeInput | null {
  if (!ID_RE.test(id)) return null;
  try {
    const input = parseThemeInput(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')));
    return { ...input, id };
  } catch {
    return null;
  }
}

export function resolveTheme(id: string | undefined, dir = themesDir(), depth = 0): Theme {
  const want = id || DEFAULT_THEME;
  const user = depth < 8 ? readUserInput(want, dir) : null;
  if (user) {
    const parentId = user.extends ?? (builtins.has(want) ? want : DEFAULT_THEME);
    const parent = parentId === want ? (builtins.get(want) ?? BASE) : resolveTheme(parentId, dir, depth + 1);
    return merge(parent, user, 'user');
  }
  return builtins.get(want) ?? BASE;
}

export function resolveThemeInput(input: ThemeInput, dir = themesDir()): Theme {
  return merge(resolveTheme(input.extends ?? DEFAULT_THEME, dir), input, 'user');
}

export function listThemes(dir = themesDir()): Theme[] {
  const out = new Map(builtins);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {}
  for (const f of files.sort()) {
    const id = f.slice(0, -5);
    if (ID_RE.test(id)) out.set(id, resolveTheme(id, dir));
  }
  return [...out.values()];
}

export function themeToInput(theme: Theme, id: string, extendsId?: string): ThemeInput {
  const { source: _source, ...rest } = theme;
  return {
    ...rest,
    id,
    name: id === theme.id ? theme.name : id,
    ...(extendsId ? { extends: extendsId } : {}),
  };
}

export function saveUserTheme(input: ThemeInput, dir = themesDir()): string {
  if (!input.id || !ID_RE.test(input.id))
    throw new Error('Theme id must be letters, numbers, dot, dash or underscore');
  const file = path.join(dir, `${input.id}.json`);
  const { id: _id, ...body } = input;
  const data = {
    $schema: 'https://raw.githubusercontent.com/alpadalar/ccinfobar/main/schema/theme.schema.json',
    ...body,
  };
  writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { class: 'settings' });
  return file;
}

export function deleteUserTheme(id: string, dir = themesDir()): boolean {
  if (!ID_RE.test(id)) return false;
  try {
    fs.unlinkSync(path.join(dir, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
