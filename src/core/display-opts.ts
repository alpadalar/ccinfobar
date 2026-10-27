import type { Config, GlyphMode, OverflowMode, ThemeStyle, WidgetCategory } from './types.js';

// one copy for renderer, config and both editors (IN-04)
export const OVERFLOW_MODES: readonly OverflowMode[] = ['truncate', 'wrap', 'priority'];

export const GLYPH_MODES: readonly GlyphMode[] = [
  'normal',
  'single-width',
  'paste-safe',
  'jetbrains',
  'auto',
];

export const CATEGORY_PRIORITY: Partial<Record<WidgetCategory, number>> = {
  context: 70,
  limits: 70,
  session: 70,
  git: 50,
  workspace: 50,
  cost: 50,
  tokens: 50,
  gsd: 30,
  agents: 30,
  charts: 30,
  system: 30,
  custom: 30,
  fun: 30,
};

export function overflowOf(config: Pick<Config, 'overflow' | 'autoWrap'>): OverflowMode {
  return config.overflow ?? (config.autoWrap ? 'wrap' : 'truncate');
}

export function defaultPriority(category: WidgetCategory | undefined): number {
  return (category && CATEGORY_PRIORITY[category]) ?? 30;
}

export function needsWidth(config: Config, style: ThemeStyle): boolean {
  if (typeof config.maxWidth === 'number') return false;
  if (config.autoWrap === true || config.overflow !== undefined || style === 'tui') return true;
  if (config.align && config.align !== 'left') return true;
  if (config.lineAlign?.some((a) => a && a !== 'left')) return true;
  // implicit truncate reuses the last known width
  return config.lines.some((line) => line.some((i) => i.type === 'flex' || i.type === 'terminal-width'));
}
