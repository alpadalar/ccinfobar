import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './paths.js';
import type { ThemeStyle, WidgetCategory } from './types.js';

export type { ThemeStyle };
export type ColorMode = 'widget' | 'category' | 'cycle';
export type Swatch = string | { fg?: string; bg?: string };

export interface ThemeGlyphs {
  separator: string;
  thin: string;
  startCap: string;
  endCap: string;
}

export interface ThemeColors {
  mode: ColorMode;
  fg: string;
  bg: string;
  on: string;
  muted: string;
  categories: Partial<Record<WidgetCategory, Swatch>>;
  cycle: Swatch[];
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  author: string;
  style: ThemeStyle;
  separator: string;
  padding: number;
  bold: boolean;
  statusColors: boolean;
  glyphs: ThemeGlyphs;
  colors: ThemeColors;
  source: 'builtin' | 'user';
}

export interface ThemeInput {
  id?: string;
  name?: string;
  description?: string;
  author?: string;
  extends?: string;
  style?: ThemeStyle;
  separator?: string;
  padding?: number;
  bold?: boolean;
  statusColors?: boolean;
  glyphs?: Partial<ThemeGlyphs>;
  colors?: Partial<ThemeColors>;
}

export const STYLES: { id: ThemeStyle; name: string; description: string }[] = [
  { id: 'text', name: 'Text', description: 'Colored text on the terminal background' },
  { id: 'blocks', name: 'Blocks', description: 'Colored background blocks' },
  { id: 'powerline', name: 'Powerline', description: 'Blocks joined by arrows (Nerd Font)' },
  { id: 'capsule', name: 'Capsule', description: 'Rounded pills (Nerd Font)' },
  { id: 'tui', name: 'Panel', description: 'Bordered panel with an optional responsive grid' },
];

export const STYLE_GLYPHS: Record<ThemeStyle, ThemeGlyphs> = {
  text: { separator: '', thin: '', startCap: '', endCap: '' },
  blocks: { separator: '', thin: '', startCap: '', endCap: '' },
  powerline: { separator: '', thin: '', startCap: '', endCap: '' },
  capsule: { separator: '', thin: '', startCap: '', endCap: '' },
  tui: { separator: '', thin: '', startCap: '', endCap: '' },
};

export const STYLE_SEPARATOR: Record<ThemeStyle, string> = {
  text: ' │ ',
  blocks: ' ',
  powerline: '',
  capsule: ' ',
  tui: '  ',
};

const BASE: Theme = {
  id: 'classic',
  name: 'Classic',
  description: 'Each widget in its own color, thin bar separators',
  author: 'ccinfobar',
  style: 'text',
  separator: ' │ ',
  padding: 1,
  bold: false,
  statusColors: true,
  glyphs: STYLE_GLYPHS.text,
  colors: {
    mode: 'widget',
    fg: 'white',
    bg: 'brightBlack',
    on: 'black',
    muted: 'brightBlack',
    categories: {},
    cycle: [],
  },
  source: 'builtin',
};

const cats = (
  session: Swatch,
  context: Swatch,
  tokens: Swatch,
  cost: Swatch,
  limits: Swatch,
  gsd: Swatch,
  git: Swatch,
  workspace: Swatch,
  system: Swatch,
  custom: Swatch = session,
): Partial<Record<WidgetCategory, Swatch>> => ({
  session,
  context,
  tokens,
  cost,
  limits,
  gsd,
  git,
  workspace,
  system,
  custom,
  layout: system,
  charts: tokens,
  agents: session,
});

const BUILTIN: ThemeInput[] = [
  {},
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Quiet gray text, values in white, wide spacing',
    separator: '   ',
    statusColors: false,
    colors: { mode: 'cycle', cycle: ['white', 'brightBlack'], muted: 'brightBlack' },
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'No colors at all, dot separators',
    separator: ' · ',
    statusColors: false,
    colors: { mode: 'cycle', cycle: ['default'], muted: 'default' },
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Vivid truecolor text per category, bold',
    separator: ' ❯ ',
    bold: true,
    colors: {
      mode: 'category',
      muted: '#5c5f77',
      categories: cats(
        '#00e5ff',
        '#39ff14',
        '#b388ff',
        '#ffd600',
        '#ff9100',
        '#ff2bd6',
        '#ff4081',
        '#40c4ff',
        '#9e9e9e',
      ),
    },
  },
  {
    id: 'pastel',
    name: 'Pastel',
    description: 'Soft pastel text per category',
    separator: ' • ',
    colors: {
      mode: 'category',
      muted: '#6c7086',
      categories: cats(
        '#89dceb',
        '#a6e3a1',
        '#cba6f7',
        '#f9e2af',
        '#fab387',
        '#f5c2e7',
        '#f38ba8',
        '#89b4fa',
        '#9399b2',
      ),
    },
  },
  {
    id: 'amber',
    name: 'Amber',
    description: 'Retro amber terminal',
    separator: ' : ',
    statusColors: false,
    colors: { mode: 'cycle', cycle: ['#ffb000', '#ffcc66'], muted: '#7a5500' },
  },
  {
    id: 'matrix',
    name: 'Matrix',
    description: 'Green phosphor shades',
    separator: ' ▏',
    statusColors: false,
    colors: { mode: 'cycle', cycle: ['#00ff41', '#00c832', '#008f11'], muted: '#005f0b' },
  },
  {
    id: 'blocks',
    name: 'Blocks',
    description: 'Solid colored blocks per category',
    style: 'blocks',
    colors: {
      mode: 'category',
      on: 'black',
      categories: cats(
        'cyan',
        'green',
        'magenta',
        'yellow',
        'brightYellow',
        'brightMagenta',
        'blue',
        'brightCyan',
        'brightBlack',
        'white',
      ),
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Colored text on one dark slate background',
    style: 'blocks',
    separator: '',
    colors: {
      mode: 'category',
      bg: '#303446',
      categories: cats(
        { fg: '#99d1db' },
        { fg: '#a6d189' },
        { fg: '#ca9ee6' },
        { fg: '#e5c890' },
        { fg: '#ef9f76' },
        { fg: '#f4b8e4' },
        { fg: '#e78284' },
        { fg: '#8caaee' },
        { fg: '#a5adce' },
      ),
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    description: 'Dark text on light blocks, for light terminals',
    style: 'blocks',
    colors: {
      mode: 'cycle',
      on: '#2e3440',
      cycle: ['#e5e9f0', '#d8dee9'],
    },
  },
  {
    id: 'powerline',
    name: 'Powerline',
    description: 'Classic powerline arrows in the 16 terminal colors',
    style: 'powerline',
    colors: {
      mode: 'cycle',
      cycle: [
        { fg: 'brightWhite', bg: 'blue' },
        { fg: 'black', bg: 'cyan' },
        { fg: 'black', bg: 'green' },
        { fg: 'black', bg: 'yellow' },
        { fg: 'brightWhite', bg: 'magenta' },
        { fg: 'brightWhite', bg: 'brightBlack' },
      ],
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic blues, powerline',
    style: 'powerline',
    colors: {
      mode: 'cycle',
      cycle: [
        { fg: '#eceff4', bg: '#5e81ac' },
        { fg: '#2e3440', bg: '#88c0d0' },
        { fg: '#2e3440', bg: '#a3be8c' },
        { fg: '#2e3440', bg: '#ebcb8b' },
        { fg: '#eceff4', bg: '#b48ead' },
        { fg: '#eceff4', bg: '#4c566a' },
      ],
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Dracula palette, powerline',
    style: 'powerline',
    colors: {
      mode: 'cycle',
      cycle: [
        { fg: '#f8f8f2', bg: '#6272a4' },
        { fg: '#282a36', bg: '#8be9fd' },
        { fg: '#282a36', bg: '#50fa7b' },
        { fg: '#282a36', bg: '#f1fa8c' },
        { fg: '#282a36', bg: '#ff79c6' },
        { fg: '#282a36', bg: '#bd93f9' },
      ],
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'Warm retro groove, powerline',
    style: 'powerline',
    colors: {
      mode: 'cycle',
      cycle: [
        { fg: '#fbf1c7', bg: '#458588' },
        { fg: '#282828', bg: '#83a598' },
        { fg: '#282828', bg: '#b8bb26' },
        { fg: '#282828', bg: '#fabd2f' },
        { fg: '#fbf1c7', bg: '#b16286' },
        { fg: '#fbf1c7', bg: '#504945' },
      ],
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Neon city night, powerline',
    style: 'powerline',
    colors: {
      mode: 'cycle',
      cycle: [
        { fg: '#1a1b26', bg: '#7aa2f7' },
        { fg: '#1a1b26', bg: '#7dcfff' },
        { fg: '#1a1b26', bg: '#9ece6a' },
        { fg: '#1a1b26', bg: '#e0af68' },
        { fg: '#1a1b26', bg: '#bb9af7' },
        { fg: '#c0caf5', bg: '#414868' },
      ],
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    description: 'Solarized accents, powerline',
    style: 'powerline',
    colors: {
      mode: 'cycle',
      cycle: [
        { fg: '#fdf6e3', bg: '#268bd2' },
        { fg: '#fdf6e3', bg: '#2aa198' },
        { fg: '#fdf6e3', bg: '#859900' },
        { fg: '#002b36', bg: '#b58900' },
        { fg: '#fdf6e3', bg: '#6c71c4' },
        { fg: '#93a1a1', bg: '#073642' },
      ],
    },
  },
  {
    id: 'monochrome',
    name: 'Monochrome',
    description: 'Shades of gray, powerline',
    style: 'powerline',
    colors: {
      mode: 'cycle',
      cycle: [
        { fg: '#ffffff', bg: '#3a3a3a' },
        { fg: '#ffffff', bg: '#4e4e4e' },
        { fg: '#ffffff', bg: '#626262' },
      ],
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'Dark grays with a rust directory, from claude-powerline',
    style: 'powerline',
    colors: {
      mode: 'category',
      categories: cats(
        { fg: '#ffffff', bg: '#2d2d2d' },
        { fg: '#cbd5e0', bg: '#4a5568' },
        { fg: '#d1d5db', bg: '#374151' },
        { fg: '#00ffff', bg: '#202020' },
        { fg: '#87ceeb', bg: '#2a2a2a' },
        { fg: '#b0a8e0', bg: '#2a2a4a' },
        { fg: '#ffffff', bg: '#404040' },
        { fg: '#ffffff', bg: '#8b4513' },
        { fg: '#90ee90', bg: '#2f4f2f' },
        { fg: '#d0a0d0', bg: '#2d2d3d' },
      ),
    },
  },
  {
    id: 'light',
    name: 'Light',
    description: 'Bright segments for light terminals, from claude-powerline',
    style: 'powerline',
    colors: {
      mode: 'category',
      categories: cats(
        { fg: '#000000', bg: '#87ceeb' },
        { fg: '#ffffff', bg: '#718096' },
        { fg: '#ffffff', bg: '#6b7280' },
        { fg: '#ffffff', bg: '#da70d6' },
        { fg: '#ffffff', bg: '#6366f1' },
        { fg: '#ffffff', bg: '#7c3aed' },
        { fg: '#ffffff', bg: '#4fb3d9' },
        { fg: '#ffffff', bg: '#ff6b47' },
        { fg: '#ffffff', bg: '#32cd32' },
        { fg: '#ffffff', bg: '#d45dbf' },
      ),
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Muted pine and rose tones, from claude-powerline',
    style: 'powerline',
    colors: {
      mode: 'category',
      categories: cats(
        { fg: '#ebbcba', bg: '#191724' },
        { fg: '#e0def4', bg: '#393552' },
        { fg: '#e0def4', bg: '#524f67' },
        { fg: '#f6c177', bg: '#26233a' },
        { fg: '#eb6f92', bg: '#2a273f' },
        { fg: '#c4a7e7', bg: '#2a273f' },
        { fg: '#9ccfd8', bg: '#1f1d2e' },
        { fg: '#c4a7e7', bg: '#26233a' },
        { fg: '#908caa', bg: '#26233a' },
        { fg: '#eb6f92', bg: '#21202e' },
      ),
    },
  },
  {
    id: 'panel',
    name: 'Panel',
    description: 'Rounded box panel with category colors',
    style: 'tui',
    separator: '  ',
    colors: {
      mode: 'category',
      muted: '#5c6370',
      categories: cats(
        '#61afef',
        '#98c379',
        '#c678dd',
        '#e5c07b',
        '#d19a66',
        '#f2b36b',
        '#e06c75',
        '#56b6c2',
        '#abb2bf',
      ),
    },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    description: 'Mocha pastels in rounded capsules',
    style: 'capsule',
    colors: {
      mode: 'category',
      on: '#1e1e2e',
      categories: cats(
        '#89dceb',
        '#a6e3a1',
        '#cba6f7',
        '#f9e2af',
        '#fab387',
        '#f5c2e7',
        '#f38ba8',
        '#89b4fa',
        { fg: '#cdd6f4', bg: '#45475a' },
      ),
    },
  },
  {
    id: 'bubblegum',
    name: 'Bubblegum',
    description: 'Bright capsules in the 16 terminal colors',
    style: 'capsule',
    colors: {
      mode: 'category',
      on: 'black',
      categories: cats(
        'brightCyan',
        'brightGreen',
        'brightMagenta',
        'brightYellow',
        'yellow',
        'magenta',
        'brightRed',
        'brightBlue',
        'white',
      ),
    },
  },
];

const STYLE_IDS = new Set<string>(STYLES.map((s) => s.id));
const MODES = new Set(['widget', 'category', 'cycle']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

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
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${input.id}.json`);
  const { id: _id, ...body } = input;
  const data = {
    $schema: 'https://raw.githubusercontent.com/alpadalar/ccinfobar/main/schema/theme.schema.json',
    ...body,
  };
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
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
