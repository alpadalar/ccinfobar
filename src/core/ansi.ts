import type { ColorLevel } from './types.js';

export type Level = 0 | 1 | 2 | 3;

export const NAMED_COLORS: Record<string, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  gray: 8,
  grey: 8,
  brightRed: 9,
  brightGreen: 10,
  brightYellow: 11,
  brightBlue: 12,
  brightMagenta: 13,
  brightCyan: 14,
  brightWhite: 15,
};

const BASIC_RGB: [number, number, number][] = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

export const RESET = '\x1b[0m';

export interface Style {
  fg?: string | undefined;
  bg?: string | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
  italic?: boolean | undefined;
}

type Parsed =
  | { kind: 'basic'; index: number }
  | { kind: '256'; index: number }
  | { kind: 'rgb'; rgb: [number, number, number] };

export function parseColor(value: string | undefined): Parsed | null {
  if (!value || value === 'default' || value === 'none') return null;
  const v = value.trim();
  if (v in NAMED_COLORS) return { kind: 'basic', index: NAMED_COLORS[v]! };
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v);
  if (hex && (v.startsWith('#') || hex[1]!.length === 6)) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = Number.parseInt(h, 16);
    return { kind: 'rgb', rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
  }
  const idx = /^(?:ansi256:)?(\d{1,3})$/.exec(v);
  if (idx) {
    const n = Number(idx[1]);
    if (n <= 255) return { kind: '256', index: n };
  }
  return null;
}

function rgbTo256([r, g, b]: [number, number, number]): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (c: number) => Math.round((c / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function index256ToRgb(n: number): [number, number, number] {
  if (n < 16) return BASIC_RGB[n]!;
  if (n >= 232) {
    const c = 8 + (n - 232) * 10;
    return [c, c, c];
  }
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return [steps[Math.floor(i / 36)]!, steps[Math.floor(i / 6) % 6]!, steps[i % 6]!];
}

function nearestBasic(rgb: [number, number, number]): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < BASIC_RGB.length; i++) {
    const [r, g, b] = BASIC_RGB[i]!;
    const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export function colorToRgb(value: string | undefined): [number, number, number] | null {
  const p = parseColor(value);
  if (!p) return null;
  if (p.kind === 'rgb') return p.rgb;
  return index256ToRgb(p.index);
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string | undefined, b: string | undefined): number | null {
  const ra = colorToRgb(a);
  const rb = colorToRgb(b);
  if (!ra || !rb) return null;
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function colorCode(value: string | undefined, level: Level, bg: boolean): string {
  const p = parseColor(value);
  if (!p || level === 0) return '';
  if (p.kind === 'basic' || level === 1) {
    const idx =
      p.kind === 'basic' ? p.index : nearestBasic(p.kind === 'rgb' ? p.rgb : index256ToRgb(p.index));
    const base = idx < 8 ? (bg ? 40 : 30) + idx : (bg ? 100 : 90) + idx - 8;
    return `\x1b[${base}m`;
  }
  if (p.kind === '256' || level === 2) {
    const n = p.kind === '256' ? p.index : rgbTo256(p.rgb);
    return `\x1b[${bg ? 48 : 38};5;${n}m`;
  }
  const [r, g, b] = p.rgb;
  return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
}

export function style(text: string, s: Style, level: Level): string {
  if (!text) return '';
  if (level === 0) return text;
  const open =
    (s.bold ? '\x1b[1m' : '') +
    (s.dim ? '\x1b[2m' : '') +
    (s.italic ? '\x1b[3m' : '') +
    colorCode(s.fg, level, false) +
    colorCode(s.bg, level, true);
  return open ? `${open}${text}${RESET}` : text;
}

export function detectLevel(setting: ColorLevel, env: NodeJS.ProcessEnv = process.env): Level {
  if (setting !== 'auto') return setting;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '' || force === 'true') return 1;
    const n = Number(force);
    if (n >= 0 && n <= 3) return n as Level;
  }
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 3;
  if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'iTerm.app') return 3;
  return 2;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// emoji-presentation symbols in the BMP
const WIDE_SYMBOLS: [number, number][] = [
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
];

function isWideSymbol(cp: number): boolean {
  if (cp < 0x231a || cp > 0x2b55) return false;
  for (const [lo, hi] of WIDE_SYMBOLS) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

function isWide(cp: number): boolean {
  return (
    isWideSymbol(cp) ||
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x20e3 ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0020 && cp <= 0xe007f)
  );
}

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function visibleWidth(text: string): number {
  let w = 0;
  for (const ch of stripAnsi(text)) w += charWidth(ch);
  return w;
}

export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (visibleWidth(text) <= max) return text;
  const target = max - visibleWidth(ellipsis);
  let out = '';
  let w = 0;
  let i = 0;
  let hadAnsi = false;
  while (i < text.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(text);
    if (m && m.index === i) {
      out += m[0];
      hadAnsi = true;
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const cw = charWidth(ch);
    if (w + cw > target) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + ellipsis + (hadAnsi ? RESET : '');
}

export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function sanitize(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f\x80-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

// colors carry over to each new line
export function splitAnsiLines(text: string): string[] {
  if (!text.includes('\n')) return [text];
  const out: string[] = [];
  let active = '';
  for (const seg of text.split('\n')) {
    let state = active;
    for (const m of seg.matchAll(/\x1b\[([0-9;]*)m/g)) {
      state = m[1] === '' || m[1] === '0' ? '' : state + m[0];
    }
    out.push(active + seg + (state ? RESET : ''));
    active = state;
  }
  return out;
}
