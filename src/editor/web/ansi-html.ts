export const BASIC = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
];

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

export function basicVar(n: number): string {
  return `var(--ansi-${n}, ${BASIC[n]})`;
}

export function ansi256ToHex(n: number): string {
  if (n < 16) return BASIC[n]!;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgb(v, v, v);
  }
  const i = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return rgb(level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6));
}

function rgb(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function blank(): Style {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };
}

function applySgr(style: Style, params: number[]): void {
  if (!params.length) params = [0];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) Object.assign(style, blank());
    else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 4) style.underline = true;
    else if (p === 7) style.inverse = true;
    else if (p === 9) style.strike = true;
    else if (p === 22) {
      style.bold = false;
      style.dim = false;
    } else if (p === 23) style.italic = false;
    else if (p === 24) style.underline = false;
    else if (p === 27) style.inverse = false;
    else if (p === 29) style.strike = false;
    else if (p >= 30 && p <= 37) style.fg = basicVar(p - 30);
    else if (p === 39) style.fg = null;
    else if (p >= 40 && p <= 47) style.bg = basicVar(p - 40);
    else if (p === 49) style.bg = null;
    else if (p >= 90 && p <= 97) style.fg = basicVar(p - 90 + 8);
    else if (p >= 100 && p <= 107) style.bg = basicVar(p - 100 + 8);
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      let color: string | null = null;
      if (mode === 5) {
        const n = params[i + 2];
        if (n !== undefined && n >= 0 && n <= 255) color = n < 16 ? basicVar(n) : ansi256ToHex(n);
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]];
        if (r !== undefined && g !== undefined && b !== undefined) color = rgb(r, g, b);
        i += 4;
      }
      if (color) {
        if (p === 38) style.fg = color;
        else style.bg = color;
      }
    }
  }
}

function css(style: Style): string {
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) [fg, bg] = [bg ?? 'var(--term-bg)', fg ?? 'var(--term-fg)'];
  const out: string[] = [];
  if (fg) out.push(`color:${fg}`);
  if (bg) out.push(`background:${bg}`);
  if (style.bold) out.push('font-weight:700');
  if (style.dim) out.push('opacity:.6');
  if (style.italic) out.push('font-style:italic');
  const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean);
  if (deco.length) out.push(`text-decoration:${deco.join(' ')}`);
  return out.join(';');
}

function safeHref(url: string): string | null {
  return /^(https?:|file:|mailto:)/i.test(url) ? url : null;
}

const TOKEN =
  /\x1b\[([0-9;:]*)m|\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-ln-z]/g;

const GLYPHS = new Set(['\ue0b0', '\ue0b1', '\ue0b2', '\ue0b3', '\ue0b4', '\ue0b6']);
const GLYPH_SPLIT = /([\ue0b0-\ue0b4\ue0b6])/u;

// symbols from fallback fonts keep one terminal cell
const SYMBOL = /[\u2190-\u21ff\u2300-\u23ff\u25a0-\u25ff\u2600-\u27bf\u2b00-\u2bff]/g;

function cells(text: string): string {
  return escapeHtml(text).replace(SYMBOL, (c) => `<span class="cell">${c}</span>`);
}

export function ansiToHtml(input: string): string {
  const style = blank();
  let href: string | null = null;
  let out = '';
  let last = 0;

  const emit = (text: string) => {
    if (!text) return;
    const s = css(style);
    let html = '';
    for (const part of text.split(GLYPH_SPLIT)) {
      if (!part) continue;
      if (GLYPHS.has(part)) {
        const code = part.codePointAt(0)!.toString(16);
        const fg = style.inverse ? style.bg : style.fg;
        const bg = style.inverse ? style.fg : style.bg;
        const vars = [fg ? `--pl:${fg}` : '', bg ? `background:${bg}` : ''].filter(Boolean).join(';');
        html += `<span class="pl pl-${code}"${vars ? ` style="${vars}"` : ''}>\u00a0</span>`;
      } else {
        const body = cells(part);
        html += s ? `<span style="${s}">${body}</span>` : body;
      }
    }
    if (href) html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
    out += html;
  };

  for (const m of input.matchAll(TOKEN)) {
    emit(input.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      applySgr(style, m[1] === '' ? [] : m[1].split(/[;:]/).map((x) => (x === '' ? 0 : Number(x))));
    } else if (m[2] !== undefined) {
      href = m[2] ? safeHref(m[2]) : null;
    }
  }
  emit(input.slice(last));
  return out;
}
