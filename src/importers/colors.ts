const C16 = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

const HUD_NAMES = new Set(['red', 'green', 'yellow', 'magenta', 'cyan', 'brightBlue', 'brightMagenta']);

export interface StyleFields {
  color?: string;
  background?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
}

const byte = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 256;

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

export function ansiColor(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (Number.isInteger(o.c16) && (o.c16 as number) >= 0 && (o.c16 as number) < 16)
    return C16[o.c16 as number];
  if (byte(o.c256)) return `ansi256:${o.c256}`;
  if (byte(o.r) && byte(o.g) && byte(o.b)) return `#${hex2(o.r)}${hex2(o.g)}${hex2(o.b)}`;
  return undefined;
}

function hexColor(s: string, short: boolean): string | undefined {
  const m = (short ? /^#([0-9a-f]{3}|[0-9a-f]{6})$/i : /^#([0-9a-f]{6})$/i).exec(s);
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
}

function starshipColor(name: string): string | undefined {
  const s = name.toLowerCase();
  if (/^\d{1,3}$/.test(s)) return Number(s) < 256 ? `ansi256:${Number(s)}` : undefined;
  if (s.startsWith('#')) return hexColor(s, true);
  const bright = s.startsWith('bright-');
  const base = bright ? s.slice(7) : s;
  const named = base === 'purple' ? 'magenta' : base;
  const i = C16.indexOf(named);
  if (i < 0 || i > 7) return undefined;
  return C16[bright ? i + 8 : i];
}

export function starshipStyle(
  s: string,
  palette?: Record<string, string>,
): StyleFields & { unknown: string[] } {
  const out: StyleFields & { unknown: string[] } = { unknown: [] };
  for (const token of (typeof s === 'string' ? s : '').split(/\s+/)) {
    if (!token) continue;
    const low = token.toLowerCase();
    if (low === 'bold') out.bold = true;
    else if (low === 'italic') out.italic = true;
    else if (low === 'dimmed') out.dim = true;
    else {
      const bg = low.startsWith('bg:');
      const name = bg || low.startsWith('fg:') ? low.slice(3) : low;
      // one level, as Starship does
      const value = palette && Object.hasOwn(palette, name) ? palette[name] : undefined;
      const color = starshipColor(typeof value === 'string' ? value : name);
      if (!color) out.unknown.push(token);
      else if (bg) out.background = color;
      else out.color = color;
    }
  }
  return out;
}

export function hudColor(v: unknown): StyleFields | undefined {
  if (v === 'dim') return { dim: true };
  if (typeof v === 'string' && HUD_NAMES.has(v)) return { color: v };
  if (byte(v)) return { color: `ansi256:${v}` };
  const hex = typeof v === 'string' ? hexColor(v, false) : undefined;
  return hex ? { color: hex } : undefined;
}

export function namedColor(v: unknown): string | undefined {
  const m = typeof v === 'string' ? /^(bright[-_]?)?([a-z]+)$/.exec(v.toLowerCase()) : null;
  if (!m) return undefined;
  const base = m[2] === 'purple' ? 'magenta' : m[2]!;
  if (!m[1] && (base === 'gray' || base === 'grey')) return 'brightBlack';
  const i = C16.indexOf(base);
  if (i < 0 || i > 7) return undefined;
  return C16[m[1] ? i + 8 : i];
}

export function rgbColor(v: unknown): string | undefined {
  if (byte(v)) return `ansi256:${v}`;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s.startsWith('#')) return hexColor(s, true);
  if (/^\d{1,3}$/.test(s)) return byte(Number(s)) ? `ansi256:${Number(s)}` : undefined;
  const parts = s.split(',').map((p) => p.trim());
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const [r, g, b] = parts.map(Number) as [number, number, number];
  return byte(r) && byte(g) && byte(b) ? `#${hex2(r)}${hex2(g)}${hex2(b)}` : undefined;
}
