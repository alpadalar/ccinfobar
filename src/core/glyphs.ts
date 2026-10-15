import type { Config, ResolvedGlyphMode } from './types.js';
import { NORMAL_WIDTH, type WidthMode } from './width.js';

export type { ResolvedGlyphMode };

export function resolveGlyphMode(
  config: Pick<Config, 'glyphMode'>,
  env: NodeJS.ProcessEnv,
): ResolvedGlyphMode {
  const m = config.glyphMode;
  if (m === 'auto') return /JetBrains/.test(env.TERMINAL_EMULATOR ?? '') ? 'jetbrains' : 'normal';
  return m ?? 'normal';
}

const JETBRAINS: WidthMode = { emoji: 1, ambiguous: 1 };

export function widthModeFor(mode: ResolvedGlyphMode, ambiguous: 1 | 2 | undefined): WidthMode {
  const a = ambiguous === 2 ? 2 : 1;
  if (mode === 'jetbrains') return a === 1 ? JETBRAINS : { emoji: 1, ambiguous: a };
  return a === 1 ? NORMAL_WIDTH : { emoji: 2, ambiguous: a };
}

// emoji-presentation glyphs with a one-column text form
export const NARROW: ReadonlyMap<string, string> = new Map([
  ['\u2705', '\u2714'],
  ['\u274C', '\u2718'],
  ['\u274E', '\u2718'],
  ['\u2753', '?'],
  ['\u2754', '?'],
  ['\u2755', '!'],
  ['\u2757', '!'],
  ['\u2795', '+'],
  ['\u2796', '-'],
  ['\u27A1', '\u2192'],
  ['\u23F3', '\u29D7'],
  ['\u231B', '\u29D7'],
  ['\u26A1', '\u21AF'],
  ['\u2B50', '\u2605'],
  ['\u{1F535}', '\u25CF'],
  ['\u{1F534}', '\u25CF'],
  ['\u{1F7E2}', '\u25CF'],
  ['\u{1F7E1}', '\u25CF'],
  ['\u{1F7E0}', '\u25CF'],
  ['\u26AA', '\u25CB'],
  ['\u26AB', '\u25CF'],
  ['\u{1F504}', '\u21BB'],
  ['\u{1F503}', '\u21BB'],
  ['\u{1F500}', '\u21C4'],
  ['\u{1F4C8}', '\u2197'],
  ['\u{1F4C9}', '\u2198'],
]);

// standalone only: ZWJ chains and keycaps keep theirs (WR-07)
const VS16 = /(?<!\u200D)(\p{Extended_Pictographic})\uFE0F(?![\u200D\u20E3])/gu;
const FULL = /[\uFF01-\uFF5E\u3000]/g;
const NARROW_RE = new RegExp([...NARROW.keys()].join('|'), 'gu');
const LINK = /\x1b\]8;[^\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const PUA = /[\uE000-\uF8FF\u{F0000}-\u{10FFFF}] ?/gu;

export function foldText(text: string, mode: ResolvedGlyphMode): string {
  if (mode !== 'single-width' && mode !== 'paste-safe') return text;
  return text
    .replace(VS16, '$1')
    .replace(FULL, (c) => (c === '\u3000' ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)))
    .replace(NARROW_RE, (c) => NARROW.get(c) ?? c);
}

export function stripLinks(text: string): string {
  return text.includes('\x1b]8;') ? text.replace(LINK, '') : text;
}

export function pasteSafeText(text: string): string {
  return stripLinks(text).replace(PUA, '');
}
