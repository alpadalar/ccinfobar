import { AMBIGUOUS, JOIN, WIDE, ZERO } from './eaw-table.js';

export interface WidthMode {
  emoji: 1 | 2;
  ambiguous: 1 | 2;
}

export const NORMAL_WIDTH: WidthMode = { emoji: 2, ambiguous: 1 };

let current: WidthMode = NORMAL_WIDTH;

export function setWidthMode(m: WidthMode): WidthMode {
  const prev = current;
  current = m;
  return prev;
}

export function widthMode(): WidthMode {
  return current;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_AT = new RegExp(ANSI_RE.source, 'y');
const OSC8_RE = /^\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)/;
const LINK_CLOSE = '\u001b]8;;\u001b\\';
const RESET = '\x1b[0m';

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function inRanges(t: readonly number[], cp: number): boolean {
  if (cp < t[0]! || cp > t[t.length - 1]!) return false;
  let lo = 0;
  let hi = (t.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < t[2 * mid]!) hi = mid - 1;
    else if (cp > t[2 * mid + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

const isPua = (cp: number) => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;

export function cpWidth(cp: number, m: WidthMode = current): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0xa1) return 1;
  if (inRanges(ZERO, cp)) return 0;
  if (inRanges(WIDE, cp)) return 2;
  return m.ambiguous === 2 && !isPua(cp) && inRanges(AMBIGUOUS, cp) ? 2 : 1;
}

let rgi: RegExp | null | undefined;
const EP = /^\p{Extended_Pictographic}/u;
let seg: Intl.Segmenter | undefined;

function isRgi(g: string): boolean {
  if (rgi === undefined) {
    // es2022 target and older browsers lack the v flag
    try {
      // biome-ignore lint/complexity/useRegexLiterals: tsc rejects the v flag below es2024
      rgi = new RegExp('^\\p{RGI_Emoji}$', 'v');
    } catch {
      rgi = null;
    }
  }
  return rgi ? rgi.test(g) : false;
}

// one code point as its own cluster
function soloWidth(cp: number, m: WidthMode): number {
  const w = cpWidth(cp, m);
  if (cp < 0x231a || (w === 2 ? m.emoji === 2 : cp < 0x1f000)) return w;
  return isRgi(String.fromCodePoint(cp)) ? m.emoji : w;
}

export function graphemeWidth(g: string, m: WidthMode = current): number {
  const first = g.codePointAt(0);
  if (first === undefined) return 0;
  if (g.length === (first > 0xffff ? 2 : 1)) return soloWidth(first, m);
  if (isRgi(g) || (g.includes('\u{FE0F}') && EP.test(g))) return m.emoji;
  for (const ch of g) {
    const w = cpWidth(ch.codePointAt(0)!, m);
    if (w) return w;
  }
  return 0;
}

function asciiLimit(m: WidthMode): number {
  return m.ambiguous === 2 ? 0xa1 : 0x300;
}

// tier 1 and 2 sum, or -1 when a joining code point needs the segmenter
function tableWidth(s: string, m: WidthMode): number {
  const lim = asciiLimit(m);
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < lim) {
      w += c < 32 || (c >= 0x7f && c < 0xa0) || c === 0xad ? 0 : 1;
      continue;
    }
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++;
    if (inRanges(JOIN, cp)) return -1;
    w += soloWidth(cp, m);
  }
  return w;
}

export function widthTier(s: string, m: WidthMode = current): 1 | 2 | 3 {
  const lim = asciiLimit(m);
  let i = 0;
  while (i < s.length && s.charCodeAt(i) < lim) i++;
  if (i === s.length) return 1;
  return tableWidth(s, m) < 0 ? 3 : 2;
}

function segmenter(): Intl.Segmenter {
  seg ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return seg;
}

export function textWidth(s: string, m: WidthMode = current): number {
  const w = tableWidth(s, m);
  if (w >= 0) return w;
  let sum = 0;
  for (const { segment } of segmenter().segment(s)) sum += graphemeWidth(segment, m);
  return sum;
}

// one argument only, callers pass it to map()
export function visibleWidth(text: string): number {
  return visibleWidthIn(text, current);
}

export function visibleWidthIn(text: string, m: WidthMode): number {
  return textWidth(text.includes('\x1b') ? stripAnsi(text) : text, m);
}

export function charWidth(ch: string, m: WidthMode = current): number {
  return cpWidth(ch.codePointAt(0) ?? 0, m);
}

export function truncate(text: string, max: number, ellipsis = '…', m: WidthMode = current): string {
  if (max <= 0) return '';
  const plain = text.includes('\x1b') ? stripAnsi(text) : text;
  if (textWidth(plain, m) <= max) return text;
  const target = max - visibleWidthIn(ellipsis, m);
  const clusters =
    widthTier(plain, m) === 3 ? Array.from(segmenter().segment(plain), (s) => s.segment) : null;
  let next = 0;
  let out = '';
  let w = 0;
  let i = 0;
  let hadAnsi = false;
  let linkOpen = false;
  const skipEscape = (): boolean => {
    ANSI_AT.lastIndex = i;
    const esc = ANSI_AT.exec(text);
    if (!esc) return false;
    hadAnsi = true;
    const link = OSC8_RE.exec(esc[0]);
    if (link) linkOpen = link[1] !== '';
    i += esc[0].length;
    return true;
  };
  while (i < text.length) {
    const start = i;
    if (skipEscape()) {
      out += text.slice(start, i);
      continue;
    }
    let g: string;
    let gw: number;
    if (clusters) {
      g = clusters[next++] ?? '';
      if (!g) break;
      gw = graphemeWidth(g, m);
    } else {
      const cp = text.codePointAt(i)!;
      g = String.fromCodePoint(cp);
      gw = soloWidth(cp, m);
    }
    if (w + gw > target) break;
    // copy the cluster, keeping escapes inside it
    let left = g.length;
    let pending = '';
    while (left > 0 && i < text.length) {
      const at = i;
      if (skipEscape()) {
        pending += text.slice(at, i);
        continue;
      }
      pending += text[i]!;
      i++;
      left--;
    }
    out += pending;
    w += gw;
  }
  return out + ellipsis + (linkOpen ? LINK_CLOSE : '') + (hadAnsi ? RESET : '');
}
