import type { ThemeInput } from './themes/style.js';
import type { Config } from './types.js';

export type EntryKind = 'preset' | 'theme' | 'bundle';

export interface EntryContent {
  layout?: Partial<Config>;
  appearance?: Partial<Config>;
  theme?: ThemeInput;
}

export const LAYOUT_KEYS = [
  'lines',
  'align',
  'lineAlign',
  'overflow',
  'autoWrap',
  'widthOffset',
  'tui',
] as const satisfies readonly (keyof Config)[];

export const APPEARANCE_KEYS = [
  'theme',
  'style',
  'separator',
  'separatorColor',
  'padding',
  'glyphs',
] as const satisfies readonly (keyof Config)[];

export const PERSONAL_KEYS = [
  'charset',
  'icons',
  'colorLevel',
  'maxWidth',
  'glyphMode',
  'ambiguousWidth',
  'update',
  'usageApi',
  'savePayload',
  'gitHardening',
  'gsdAutoLine',
  'loadingText',
  'budget',
  'profiles',
  'themeRotation',
  'progress',
  'language',
  'version',
  '$schema',
] as const satisfies readonly (keyof Config)[];

// the author's preview width
export const COLS_MIN = 40;
export const COLS_MAX = 400;

// a theme looks the same at any width
export const takesCols = (kind: EntryKind): boolean => kind !== 'theme';

export function parseCols(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= COLS_MIN && v <= COLS_MAX ? v : undefined;
}
