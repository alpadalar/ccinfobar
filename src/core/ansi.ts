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

export { charWidth, stripAnsi, truncate, visibleWidth } from './width.js';

export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function sanitize(text: string): string {
  return text.replace(
    /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f\x80-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    '',
  );
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
