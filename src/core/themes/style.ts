import type { ThemeStyle, WidgetCategory } from '../types.js';

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
  gradient?: string[];
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
  gradient?: string[];
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
