import { type MessageId, type Params, t } from '../core/i18n/index.js';

export const MAX_TOML_CHARS = 1_048_576;
export const MAX_TOML_DEPTH = 32;

export type TomlErrorCode =
  | 'unterminated'
  | 'badEscape'
  | 'badNumber'
  | 'badDate'
  | 'duplicateKey'
  | 'expected'
  | 'unexpected'
  | 'control'
  | 'badKey'
  | 'reservedKey'
  | 'unsafeInteger'
  | 'toml11'
  | 'tooLarge'
  | 'tooDeep'
  | 'redefined'
  | 'inlineExtend'
  | 'arrayKind';

export class TomlError extends Error {
  constructor(
    readonly code: TomlErrorCode,
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
    this.name = 'TomlError';
  }
}

type Table = Record<string, unknown>;
type Kind = 'implicit' | 'header' | 'dotted' | 'inline' | 'aot-element';
interface Key {
  name: string;
  at: number;
}

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const V11 = {
  escE: ['toml.v11.escE', 'toml.v11.escEHint'],
  escX: ['toml.v11.escX', 'toml.v11.escXHint'],
  inlineNewline: ['toml.v11.inlineNewline', 'toml.v11.inlineNewlineHint'],
  inlineComma: ['toml.v11.inlineComma', 'toml.v11.inlineCommaHint'],
  noSeconds: ['toml.v11.noSeconds', 'toml.v11.noSecondsHint'],
} as const satisfies Record<string, readonly [MessageId, MessageId]>;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const DEC = /^[0-9_]+$/;
const RADIX: Record<string, [number, RegExp]> = {
  x: [16, /^[0-9A-Fa-f_]+$/],
  o: [8, /^[0-7_]+$/],
  b: [2, /^[01_]+$/],
};
const DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const OFFSET = /(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
const TIME = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/;
const SHORT_TIME = /^(\d{2}):(\d{2})$/;

const newTable = (): Table => Object.create(null) as Table;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isBare = (c: number) =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
const isControl = (c: number) => (c < 32 && c !== 9) || c === 127;
const isDelim = (c: number) =>
  Number.isNaN(c) ||
  c === 32 ||
  c === 9 ||
  c === 10 ||
  c === 13 ||
  c === 44 ||
  c === 93 ||
  c === 125 ||
  c === 35;

function printable(cp: number): boolean {
  return !(
    cp < 32 ||
    (cp >= 127 && cp <= 159) ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0xfeff
  );
}

const codePoint = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

function quote(s: string): string {
  const cps = Array.from(s);
  const shown = cps.slice(0, 64).map((ch) => {
    const cp = ch.codePointAt(0)!;
    return printable(cp) ? ch : codePoint(cp);
  });
  return `"${shown.join('')}${cps.length > 64 ? '…' : ''}"`;
}

function showChar(cp: number): string {
  return printable(cp) ? quote(String.fromCodePoint(cp)) : codePoint(cp);
}

function grouped(s: string, re: RegExp): boolean {
  return s.length > 0 && re.test(s) && s[0] !== '_' && s[s.length - 1] !== '_' && !s.includes('__');
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  return d <= days;
}

function where(s: string, offset: number): { line: number; col: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset; i++) {
    if (s.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, col: Array.from(s.slice(start, offset)).length + 1 };
}

class Parser {
  pos = 0;
  readonly meta = new WeakMap<object, Kind>();
  readonly aot = new WeakSet<unknown[]>();
  readonly n: number;

  constructor(readonly s: string) {
    this.n = s.length;
  }

  fail(at: number, code: TomlErrorCode, id: MessageId, params?: Params): never {
    const { line, col } = where(this.s, at);
    throw new TomlError(code, t(id, params), line, col);
  }

  fail11(at: number, which: keyof typeof V11): never {
    const [construct, hint] = V11[which];
    return this.fail(at, 'toml11', 'toml.toml11', { construct: t(construct), hint: t(hint) });
  }

  unexpected(at: number): never {
    return this.fail(at, 'unexpected', 'toml.unexpected', { char: showChar(this.s.codePointAt(at)!) });
  }

  code(): number {
    return this.s.charCodeAt(this.pos);
  }

  kind(v: unknown): Kind | undefined {
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? this.meta.get(v) : undefined;
  }

  document(): Table {
    const root = newTable();
    let table = root;
    let depth = 0;
    for (;;) {
      this.ws();
      if (this.pos >= this.n) return root;
      const c = this.code();
      if (c === 91) {
        [table, depth] = this.header(root);
        this.ws();
        const e = this.code();
        if (this.pos < this.n && e !== 35 && e !== 10 && e !== 13) this.unexpected(this.pos);
      } else if (c !== 35 && c !== 10 && c !== 13) {
        this.keyValue(table, depth, null);
        this.ws();
      }
      if (this.code() === 35) this.comment();
      this.eol();
    }
  }

  ws(): void {
    for (let c = this.code(); c === 32 || c === 9; c = this.code()) this.pos++;
  }

  comment(): void {
    this.pos++;
    while (this.pos < this.n) {
      const c = this.code();
      if (c === 10 || c === 13) return;
      if (isControl(c)) this.fail(this.pos, 'control', 'toml.control', { char: codePoint(c) });
      this.pos++;
    }
  }

  eol(): void {
    if (this.pos >= this.n) return;
    const c = this.code();
    if (c === 10) this.pos++;
    else if (c === 13 && this.s.charCodeAt(this.pos + 1) === 10) this.pos += 2;
    else if (c === 13) this.unexpected(this.pos);
    else this.fail(this.pos, 'expected', 'toml.expectedEnd');
  }

  header(root: Table): [Table, number] {
    const open = this.pos;
    const many = this.s.charCodeAt(open + 1) === 91;
    this.pos += many ? 2 : 1;
    this.ws();
    const keys = this.key();
    const close = many ? ']]' : ']';
    if (!this.s.startsWith(close, this.pos))
      this.fail(this.pos, 'expected', 'toml.expected', { expected: close });
    this.pos += close.length;
    const path = (i: number) => ({
      key: quote(
        keys
          .slice(0, i + 1)
          .map((k) => k.name)
          .join('.'),
      ),
    });
    const deeper = (d: number, k: Key) => {
      if (d > MAX_TOML_DEPTH) this.fail(k.at, 'tooDeep', 'toml.tooDeep', { max: MAX_TOML_DEPTH });
      return d;
    };
    let table = root;
    let depth = 0;
    const last = keys.length - 1;
    for (let i = 0; i < last; i++) {
      const k = keys[i]!;
      depth = deeper(depth + 1, k);
      if (!Object.hasOwn(table, k.name)) {
        const next = newTable();
        this.meta.set(next, 'implicit');
        table[k.name] = next;
        table = next;
        continue;
      }
      const v = table[k.name];
      if (Array.isArray(v) && this.aot.has(v)) {
        depth = deeper(depth + 1, k);
        table = v[v.length - 1] as Table;
        continue;
      }
      const kind = this.kind(v);
      if (kind === 'inline') this.fail(open, 'inlineExtend', 'toml.inlineExtend', path(i));
      if (kind === undefined) this.fail(open, 'duplicateKey', 'toml.duplicateKey', path(i));
      table = v as Table;
    }
    const k = keys[last]!;
    depth = deeper(depth + 1, k);
    const has = Object.hasOwn(table, k.name);
    const v = table[k.name];
    const kind = this.kind(v);
    if (many) {
      let list: unknown[];
      if (!has) {
        list = [];
        this.aot.add(list);
        table[k.name] = list;
      } else if (Array.isArray(v) && this.aot.has(v)) list = v;
      else if (Array.isArray(v) || kind !== undefined)
        return this.fail(open, 'arrayKind', 'toml.arrayKind', path(last));
      else return this.fail(open, 'duplicateKey', 'toml.duplicateKey', path(last));
      const el = newTable();
      this.meta.set(el, 'aot-element');
      list.push(el);
      return [el, deeper(depth + 1, k)];
    }
    if (!has) {
      const next = newTable();
      this.meta.set(next, 'header');
      table[k.name] = next;
      return [next, depth];
    }
    if (Array.isArray(v) && this.aot.has(v)) this.fail(open, 'arrayKind', 'toml.arrayKind', path(last));
    if (kind === 'implicit') {
      this.meta.set(v as Table, 'header');
      return [v as Table, depth];
    }
    if (kind === 'inline') this.fail(open, 'inlineExtend', 'toml.inlineExtend', path(last));
    if (kind === undefined) this.fail(open, 'duplicateKey', 'toml.duplicateKey', path(last));
    return this.fail(open, 'redefined', 'toml.redefined', path(last));
  }

  keyValue(table: Table, depth: number, scope: Table[] | null): void {
    const keys = this.key();
    this.ws();
    if (this.code() !== 61) this.fail(this.pos, 'expected', 'toml.expected', { expected: '=' });
    this.pos++;
    this.ws();
    let target = table;
    let d = depth;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (++d > MAX_TOML_DEPTH) this.fail(k.at, 'tooDeep', 'toml.tooDeep', { max: MAX_TOML_DEPTH });
      if (Object.hasOwn(target, k.name)) {
        const v = target[k.name];
        const kind = this.kind(v);
        if (kind === 'inline') this.fail(k.at, 'inlineExtend', 'toml.inlineExtend', { key: quote(k.name) });
        if (kind === undefined) this.fail(k.at, 'duplicateKey', 'toml.duplicateKey', { key: quote(k.name) });
        if (kind !== 'dotted') this.fail(k.at, 'redefined', 'toml.redefined', { key: quote(k.name) });
        target = v as Table;
      } else {
        const next = newTable();
        this.meta.set(next, 'dotted');
        scope?.push(next);
        target[k.name] = next;
        target = next;
      }
    }
    const last = keys[keys.length - 1]!;
    if (Object.hasOwn(target, last.name))
      this.fail(last.at, 'duplicateKey', 'toml.duplicateKey', { key: quote(last.name) });
    target[last.name] = this.value(d);
  }

  key(): Key[] {
    const out: Key[] = [];
    for (;;) {
      const at = this.pos;
      const c = this.code();
      let name: string;
      if (c === 34) name = this.basic();
      else if (c === 39) name = this.literal();
      else if (isBare(c)) {
        while (isBare(this.code())) this.pos++;
        name = this.s.slice(at, this.pos);
      } else return this.fail(at, 'badKey', 'toml.badKey');
      if (BLOCKED.has(name)) this.fail(at, 'reservedKey', 'toml.reservedKey', { key: quote(name) });
      out.push({ name, at });
      this.ws();
      if (this.code() !== 46) return out;
      this.pos++;
      this.ws();
    }
  }

  value(depth: number): unknown {
    const at = this.pos;
    const c = this.code();
    const s = this.s;
    if (c === 34) return s.startsWith('"""', at) ? this.multiline('"') : this.basic();
    if (c === 39) return s.startsWith("'''", at) ? this.multiline("'") : this.literal();
    if (c === 91) return this.array(depth + 1);
    if (c === 123) return this.inline(depth + 1);
    if (c === 116 || c === 102) {
      const tok = this.token();
      if (tok === 'true') return true;
      if (tok === 'false') return false;
      return this.unexpected(at);
    }
    if (isDigit(c) || c === 43 || c === 45 || c === 46 || c === 95 || c === 105 || c === 110) {
      let tok = this.token();
      if (/^\d{4}-\d{2}-\d{2}$/.test(tok) && this.code() === 32 && isDigit(s.charCodeAt(this.pos + 1))) {
        this.pos++;
        tok = `${tok} ${this.token()}`;
      }
      return /^\d{4}-|^\d{2}:/.test(tok) ? this.dateTime(tok, at) : this.number(tok, at);
    }
    if (at >= this.n || c === 10 || c === 13 || c === 35)
      return this.fail(at, 'expected', 'toml.expectedValue');
    return this.unexpected(at);
  }

  token(): string {
    const at = this.pos;
    while (!isDelim(this.code())) this.pos++;
    return this.s.slice(at, this.pos);
  }

  number(tok: string, at: number): number {
    const bad = () => this.fail(at, 'badNumber', 'toml.badNumber');
    const sign = tok[0] === '+' || tok[0] === '-' ? tok[0] : '';
    const body = tok.slice(sign.length);
    if (body === 'inf') return sign === '-' ? -Infinity : Infinity;
    if (body === 'nan') return Number.NaN;
    const radix = body[0] === '0' && body[1] ? RADIX[body[1]] : undefined;
    let value: number;
    if (radix) {
      const digits = body.slice(2);
      if (sign || !grouped(digits, radix[1])) bad();
      value = Number.parseInt(digits.replaceAll('_', ''), radix[0]);
    } else {
      const e = body.search(/[eE]/);
      const mant = e < 0 ? body : body.slice(0, e);
      const exp = e < 0 ? null : body.slice(e + 1);
      const dot = mant.indexOf('.');
      const int = dot < 0 ? mant : mant.slice(0, dot);
      const frac = dot < 0 ? null : mant.slice(dot + 1);
      if (!grouped(int, DEC) || (int.length > 1 && int[0] === '0')) bad();
      if (frac !== null && !grouped(frac, DEC)) bad();
      if (exp !== null && !grouped(exp.replace(/^[+-]/, ''), DEC)) bad();
      value = Number((sign + body).replaceAll('_', ''));
      if (frac !== null || exp !== null) return value;
    }
    if (!Number.isSafeInteger(value)) this.fail(at, 'unsafeInteger', 'toml.unsafeInteger');
    return value === 0 ? 0 : value;
  }

  dateTime(tok: string, at: number): string {
    const bad = () => this.fail(at, 'badDate', 'toml.badDate');
    const date = DATE.exec(tok);
    if (!date) {
      this.time(tok, at);
      return tok;
    }
    if (!validDate(Number(date[1]), Number(date[2]), Number(date[3]))) bad();
    if (tok.length === 10) return tok;
    const sep = tok[10];
    if (sep !== 'T' && sep !== 't' && sep !== ' ') bad();
    let rest = tok.slice(11);
    const off = OFFSET.exec(rest);
    if (off) {
      if (off[1] !== undefined && (Number(off[1]) > 23 || Number(off[2]) > 59)) bad();
      rest = rest.slice(0, off.index);
    }
    this.time(rest, at);
    return tok;
  }

  time(text: string, at: number): void {
    const m = TIME.exec(text);
    const short = m ? null : SHORT_TIME.exec(text);
    const parts = m ?? short;
    if (!parts || Number(parts[1]) > 23 || Number(parts[2]) > 59 || (m !== null && Number(m[3]) > 60))
      this.fail(at, 'badDate', 'toml.badDate');
    if (short) this.fail11(at, 'noSeconds');
  }

  escape(open: number, multi: boolean): string {
    const s = this.s;
    const at = this.pos;
    const e = s[at + 1];
    if (e === undefined) return this.fail(open, 'unterminated', 'toml.unterminated');
    const simple = ESCAPES[e];
    if (simple !== undefined) {
      this.pos += 2;
      return simple;
    }
    if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const hex = s.slice(at + 2, at + 2 + len);
      const cp = hex.length === len && /^[0-9A-Fa-f]+$/.test(hex) ? Number.parseInt(hex, 16) : -1;
      if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.badEscape(at);
      this.pos += 2 + len;
      return String.fromCodePoint(cp);
    }
    if (e === 'e') this.fail11(at, 'escE');
    if (e === 'x') this.fail11(at, 'escX');
    if (multi) {
      let j = at + 1;
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (s[j] === '\n' || (s[j] === '\r' && s[j + 1] === '\n')) {
        for (;;) {
          const c = s[j];
          if (c === ' ' || c === '\t' || c === '\n') j++;
          else if (c === '\r' && s[j + 1] === '\n') j += 2;
          else break;
        }
        this.pos = j;
        return '';
      }
    }
    return this.badEscape(at);
  }

  badEscape(at: number): never {
    const cp = this.s.codePointAt(at + 1)!;
    return this.fail(at, 'badEscape', 'toml.badEscape', { escape: quote(`\\${String.fromCodePoint(cp)}`) });
  }

  basic(): string {
    const open = this.pos++;
    let out = '';
    let from = this.pos;
    for (;;) {
      if (this.pos >= this.n) return this.fail(open, 'unterminated', 'toml.unterminated');
      const c = this.code();
      if (c === 34) {
        out += this.s.slice(from, this.pos++);
        return out;
      }
      if (c === 92) {
        out += this.s.slice(from, this.pos) + this.escape(open, false);
        from = this.pos;
      } else if (c === 10 || c === 13) return this.fail(open, 'unterminated', 'toml.unterminated');
      else if (isControl(c)) return this.fail(this.pos, 'control', 'toml.control', { char: codePoint(c) });
      else this.pos++;
    }
  }

  literal(): string {
    const open = this.pos++;
    for (;;) {
      if (this.pos >= this.n) return this.fail(open, 'unterminated', 'toml.unterminated');
      const c = this.code();
      if (c === 39) return this.s.slice(open + 1, this.pos++);
      if (c === 10 || c === 13) return this.fail(open, 'unterminated', 'toml.unterminated');
      if (isControl(c)) return this.fail(this.pos, 'control', 'toml.control', { char: codePoint(c) });
      this.pos++;
    }
  }

  multiline(q: '"' | "'"): string {
    const s = this.s;
    const open = this.pos;
    const quoteCode = q.charCodeAt(0);
    this.pos += 3;
    if (this.code() === 10) this.pos++;
    else if (this.code() === 13 && s.charCodeAt(this.pos + 1) === 10) this.pos += 2;
    let out = '';
    let from = this.pos;
    for (;;) {
      if (this.pos >= this.n) return this.fail(open, 'unterminated', 'toml.unterminated');
      const c = this.code();
      if (c === quoteCode) {
        let run = 1;
        while (s.charCodeAt(this.pos + run) === quoteCode) run++;
        if (run >= 3) {
          const extra = Math.min(run - 3, 2);
          out += s.slice(from, this.pos + extra);
          this.pos += 3 + extra;
          return out;
        }
        this.pos += run;
      } else if (c === 92 && q === '"') {
        out += s.slice(from, this.pos) + this.escape(open, true);
        from = this.pos;
      } else if (c === 13 && s.charCodeAt(this.pos + 1) === 10) {
        out += `${s.slice(from, this.pos)}\n`;
        this.pos += 2;
        from = this.pos;
      } else if (c !== 10 && isControl(c)) {
        return this.fail(this.pos, 'control', 'toml.control', { char: codePoint(c) });
      } else this.pos++;
    }
  }

  array(depth: number): unknown[] {
    if (depth > MAX_TOML_DEPTH) this.fail(this.pos, 'tooDeep', 'toml.tooDeep', { max: MAX_TOML_DEPTH });
    this.pos++;
    const out: unknown[] = [];
    for (;;) {
      this.arrayWs();
      if (this.code() === 93) break;
      out.push(this.value(depth));
      this.arrayWs();
      const c = this.code();
      if (c === 93) break;
      if (c !== 44) this.fail(this.pos, 'expected', 'toml.expectedSep', { close: ']' });
      this.pos++;
    }
    this.pos++;
    return out;
  }

  arrayWs(): void {
    for (;;) {
      this.ws();
      const c = this.code();
      if (c === 35) this.comment();
      else if (c === 10) this.pos++;
      else if (c === 13 && this.s.charCodeAt(this.pos + 1) === 10) this.pos += 2;
      else if (c === 13) this.unexpected(this.pos);
      else return;
    }
  }

  inline(depth: number): Table {
    if (depth > MAX_TOML_DEPTH) this.fail(this.pos, 'tooDeep', 'toml.tooDeep', { max: MAX_TOML_DEPTH });
    this.pos++;
    const table = newTable();
    const scope: Table[] = [table];
    this.inlineWs();
    if (this.code() !== 125) {
      for (;;) {
        this.keyValue(table, depth, scope);
        this.inlineWs();
        const c = this.code();
        if (c === 125) break;
        if (c !== 44) this.fail(this.pos, 'expected', 'toml.expectedSep', { close: '}' });
        const comma = this.pos++;
        this.inlineWs();
        if (this.code() === 125) this.fail11(comma, 'inlineComma');
      }
    }
    this.pos++;
    for (const tb of scope) this.meta.set(tb, 'inline');
    return table;
  }

  inlineWs(): void {
    this.ws();
    const c = this.code();
    if (c === 13 && this.s.charCodeAt(this.pos + 1) !== 10) this.unexpected(this.pos);
    if (c === 10 || c === 13 || c === 35) this.fail11(this.pos, 'inlineNewline');
  }
}

export function parseToml(text: string): Record<string, unknown> {
  if (text.length > MAX_TOML_CHARS) {
    throw new TomlError('tooLarge', t('toml.tooLarge'), 1, 1);
  }
  return new Parser(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).document();
}
