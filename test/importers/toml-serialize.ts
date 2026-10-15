export type Style = 'headers' | 'dotted' | 'inline' | 'mixed';
type Rnd = () => number;
type Obj = Record<string, unknown>;

const isTable = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTableArray = (v: unknown): v is Obj[] => Array.isArray(v) && v.length > 0 && v.every(isTable);
const LITERAL = /^[^\u0000-\u0008\u000a-\u001f\u007f']*$/;
const ML_LITERAL = /^[^\u0000-\u0008\u000b-\u001f\u007f']*$/;

function escapeChar(ch: string, multi: boolean): string {
  switch (ch) {
    case '\\':
      return '\\\\';
    case '"':
      return '\\"';
    case '\b':
      return '\\b';
    case '\t':
      return '\\t';
    case '\n':
      return multi ? '\n' : '\\n';
    case '\f':
      return '\\f';
    case '\r':
      return '\\r';
  }
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || cp === 0x7f) return `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  return ch;
}

const basic = (s: string) => `"${Array.from(s, (ch) => escapeChar(ch, false)).join('')}"`;
const mlBasic = (s: string) => `"""\n${Array.from(s, (ch) => escapeChar(ch, true)).join('')}"""`;
const pick = <T>(rnd: Rnd, xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

class Writer {
  constructor(
    readonly style: Style,
    readonly rnd: Rnd,
  ) {}

  chance(p: number): boolean {
    return this.style === 'mixed' && this.rnd() < p;
  }

  key(k: string): string {
    if (/^[A-Za-z0-9_-]+$/.test(k) && !this.chance(0.2)) return k;
    if (LITERAL.test(k) && this.chance(0.5)) return `'${k}'`;
    return basic(k);
  }

  path(keys: string[]): string {
    return keys.join(this.chance(0.3) ? ' . ' : '.');
  }

  str(s: string): string {
    switch (this.style) {
      case 'headers':
        return s.includes('\n') ? mlBasic(s) : basic(s);
      case 'dotted':
        return LITERAL.test(s) ? `'${s}'` : basic(s);
      case 'inline':
        return basic(s);
      case 'mixed': {
        const forms = [basic(s), mlBasic(s)];
        if (LITERAL.test(s)) forms.push(`'${s}'`);
        if (ML_LITERAL.test(s)) forms.push(`'''\n${s}'''`);
        return pick(this.rnd, forms);
      }
    }
  }

  num(n: number): string {
    if (Number.isNaN(n)) return pick(this.rnd, ['nan', '+nan', '-nan']);
    if (n === Infinity) return this.chance(0.5) ? '+inf' : 'inf';
    if (n === -Infinity) return '-inf';
    if (Number.isSafeInteger(n)) {
      if (n >= 0 && this.chance(0.3)) {
        const [prefix, radix] = pick(this.rnd, [['0x', 16] as const, ['0o', 8] as const, ['0b', 2] as const]);
        return `${prefix}${n.toString(radix)}`;
      }
      if (this.chance(0.3)) return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
      return n > 0 && this.chance(0.2) ? `+${n}` : String(n);
    }
    if (this.chance(0.3)) return n.toExponential();
    const s = String(n);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  }

  value(v: unknown): string {
    if (typeof v === 'string') return this.str(v);
    if (typeof v === 'number') return this.num(v);
    if (typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      const items = v.map((x) => this.value(x));
      if (items.length > 0 && this.chance(0.3)) return `[\n  ${items.join(',\n  ')}, # end\n]`;
      return `[${items.join(', ')}]`;
    }
    const lines: string[] = [];
    this.entries(v as Obj, [], lines, this.style !== 'inline');
    return lines.length === 0 ? '{}' : `{ ${lines.join(', ')} }`;
  }

  dotted(): boolean {
    return this.style === 'dotted' || this.chance(0.5);
  }

  entries(obj: Obj, prefix: string[], out: string[], flatten: boolean): void {
    for (const [k, v] of Object.entries(obj)) {
      const keys = [...prefix, this.key(k)];
      if (flatten && isTable(v) && Object.keys(v).length > 0 && this.dotted())
        this.entries(v, keys, out, true);
      else out.push(`${this.path(keys)} = ${this.value(v)}`);
    }
  }

  section(obj: Obj, path: string[], out: string[], header: string | null): void {
    const lines: string[] = [];
    const subs: [string, Obj | Obj[]][] = [];
    const headers = this.style === 'headers' || this.style === 'mixed';
    for (const [k, v] of Object.entries(obj)) {
      if (headers && (isTable(v) || isTableArray(v)) && (this.style === 'headers' || this.rnd() < 0.5)) {
        subs.push([this.key(k), v]);
        continue;
      }
      this.entries({ [k]: v }, [], lines, this.style === 'dotted' || this.style === 'mixed');
    }
    const implicit = header?.startsWith('[[') === false && lines.length === 0 && subs.length > 0;
    if (header !== null && !(implicit && this.rnd() < 0.5))
      out.push(this.chance(0.2) ? `  ${header}` : header);
    for (const line of lines) {
      if (this.chance(0.1)) out.push(pick(this.rnd, ['', '# comment', '\t']));
      out.push(this.chance(0.2) ? `${line} # note` : line);
    }
    for (const [k, v] of subs) {
      const p = [...path, k];
      if (Array.isArray(v)) for (const el of v) this.section(el, p, out, `[[${this.path(p)}]]`);
      else this.section(v, p, out, `[${this.path(p)}]`);
    }
  }
}

export function serialize(value: Record<string, unknown>, style: Style, rnd: () => number): string {
  const w = new Writer(style, rnd);
  const out: string[] = [];
  w.section(value, [], out, null);
  return out.join(w.chance(0.2) ? '\r\n' : '\n');
}
