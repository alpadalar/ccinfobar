import { resolveTheme, type ThemeInput, themeToInput } from '../core/themes.js';
import type { Config } from '../core/types.js';

export function themeInputFromConfig(config: Config, id: string): ThemeInput {
  const base = resolveTheme(config.theme);
  const input = themeToInput(base, id, base.id === id ? undefined : base.id);
  if (config.style) input.style = config.style;
  if (config.separator !== undefined) input.separator = config.separator;
  if (config.padding !== undefined) input.padding = config.padding;
  if (config.separatorColor !== undefined) input.colors = { ...input.colors, muted: config.separatorColor };
  if (config.glyphs) input.glyphs = { ...input.glyphs, ...config.glyphs };
  return input;
}
