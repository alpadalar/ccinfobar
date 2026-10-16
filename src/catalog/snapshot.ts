import { normalizeConfig } from '../core/config.js';
import { resolveAppearance } from '../core/renderer.js';
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  parseThemeInput,
  resolveTheme,
  type ThemeInput,
  themeToInput,
} from '../core/themes.js';
import type { Config } from '../core/types.js';
import { type EntryContent, type EntryKind, LAYOUT_KEYS, pick, stripPersonal } from './model.js';

const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));

export function themeFromConfig(
  config: Config,
  id: string,
  meta: { name?: string; description?: string } = {},
): ThemeInput {
  const a = resolveAppearance(normalizeConfig(config));
  const base = themeToInput(a.theme, id, a.theme.id === id ? undefined : a.theme.id);
  const input = parseThemeInput({
    ...base,
    name: meta.name ?? base.name,
    description: meta.description ?? base.description,
    author: '',
    style: a.style,
    separator: a.separator,
    padding: a.padding,
    glyphs: a.glyphs,
    colors: { ...a.theme.colors, muted: a.separatorColor },
  });
  input.id = base.id;
  if (base.extends) input.extends = base.extends;
  return input;
}

export function hasAppearanceOverrides(config: Config): boolean {
  return (
    config.style !== undefined ||
    config.separator !== undefined ||
    config.separatorColor !== undefined ||
    config.padding !== undefined ||
    config.glyphs !== undefined
  );
}

function embeddedTheme(config: Config, id: string): ThemeInput {
  // the receiver applies its own charset fallback
  const { glyphMode: _glyphMode, ...rest } = config;
  const input = themeFromConfig({ ...rest, charset: 'nerd' }, id);
  delete input.extends;
  return input;
}

export function contentFromConfig(config: Config, kind: EntryKind): EntryContent {
  const out: EntryContent = {};
  if (kind !== 'theme') out.layout = stripPersonal(pick(config, LAYOUT_KEYS));
  if (kind === 'preset') return out;
  const id = config.theme || DEFAULT_THEME;
  out.appearance = { theme: id };
  const builtin = BUILTIN_IDS.has(id) && resolveTheme(id).source === 'builtin';
  if (!builtin || hasAppearanceOverrides(config)) out.theme = embeddedTheme(config, id);
  return out;
}
