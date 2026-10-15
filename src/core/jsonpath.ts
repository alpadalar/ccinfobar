export type PathSeg = { k: 'name'; v: string } | { k: 'index'; v: number };

export type ParsedPath = { ok: true; segs: PathSeg[] } | { ok: false; error: string };

const MAX_LENGTH = 256;
const MAX_SEGMENTS = 32;
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  '/': '/',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

class Fail {
  constructor(readonly error: string) {}
}

function show(src: string, i: number): string {
  if (i >= src.length) return 'end';
  const cp = src.codePointAt(i)!;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff))
    return `'\\u${cp.toString(16).padStart(4, '0')}'`;
  return `'${String.fromCodePoint(cp)}'`;
}

const unexpected = (src: string, i: number, hint?: string): Fail =>
  new Fail(`unexpected ${show(src, i)} at ${i}${hint ? `; ${hint}` : ''}`);

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

// code units consumed by a name-first char at i, 0 when none
function nameFirst(src: string, i: number): number {
  const c = src.charCodeAt(i);
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f) return 1;
  if ((c >= 0x80 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xffff)) return 1;
  if (isHigh(c) && isLow(src.charCodeAt(i + 1))) return 2;
  return 0;
}

const nameChar = (src: string, i: number): number => (isDigit(src.charCodeAt(i)) ? 1 : nameFirst(src, i));

function checkName(name: string): string {
  if (BLOCKED.has(name)) throw new Fail(`segment '${name}' is not allowed`);
  return name;
}

function skipSpaces(src: string, i: number): number {
  while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') i++;
  return i;
}

function shorthand(src: string, start: number): [string, number] {
  if (src[start] === '*')
    throw new Fail(`wildcard '*' at ${start} is not supported; the widget shows one value`);
  let i = start;
  let n = nameFirst(src, i);
  if (!n) throw unexpected(src, i, i >= src.length ? 'expected a name' : undefined);
  while (n) {
    i += n;
    n = nameChar(src, i);
  }
  if (i < src.length && src[i] !== '.' && src[i] !== '[') {
    let end = i;
    while (end < src.length && src[end] !== '.' && src[end] !== '[') end++;
    const word = src.slice(start, end);
    const quotable = !/['\\?@*()\u0000-\u001f\u007f-\u009f\ud800-\udfff]/.test(word);
    throw unexpected(src, i, quotable ? `use ['${word}']` : undefined);
  }
  return [src.slice(start, i), i];
}

function quoted(src: string, start: number): [string, number] {
  const quote = src[start];
  let out = '';
  let i = start + 1;
  for (;;) {
    if (i >= src.length) throw unexpected(src, i, 'unterminated string');
    const ch = src[i]!;
    const c = ch.charCodeAt(0);
    if (ch === quote) return [out, i + 1];
    if (c < 0x20) throw unexpected(src, i);
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const e = src[i + 1];
    if (e === undefined) throw unexpected(src, i + 1, 'unterminated string');
    if (e === 'u') {
      const hex = src.slice(i + 2, i + 6);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Fail(`bad escape '\\u' at ${i}`);
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }
    const mapped = ESCAPES[e];
    if (mapped === undefined) throw new Fail(`bad escape at ${i}`);
    out += mapped;
    i += 2;
  }
}

function index(src: string, start: number): [number, number] {
  let i = start;
  if (src[i] === '-') i++;
  const digits = i;
  while (isDigit(src.charCodeAt(i))) i++;
  const text = src.slice(digits, i);
  if (!text) throw unexpected(src, i, 'expected a digit');
  if (text.length > 1 && text[0] === '0') throw new Fail(`leading zero in index at ${digits}`);
  if (text === '0' && digits > start) throw new Fail(`'-0' at ${start} is not a valid index`);
  const n = Number(src.slice(start, i));
  if (!Number.isSafeInteger(n)) throw new Fail(`index at ${start} is out of range`);
  return [n, i];
}

function bracket(src: string, open: number): [PathSeg, number] {
  let i = skipSpaces(src, open + 1);
  const ch = src[i];
  let seg: PathSeg;
  if (ch === "'" || ch === '"') {
    const [name, next] = quoted(src, i);
    seg = { k: 'name', v: checkName(name) };
    i = next;
  } else if (ch === '-' || isDigit(src.charCodeAt(i))) {
    const [n, next] = index(src, i);
    seg = { k: 'index', v: n };
    i = next;
  } else if (ch === '*') {
    throw new Fail(`wildcard '*' at ${i} is not supported; the widget shows one value`);
  } else if (ch === '?') {
    throw unexpected(src, i, 'filters are not supported');
  } else if (ch === ':') {
    throw unexpected(src, i, 'slices are not supported');
  } else {
    throw unexpected(src, i, i >= src.length ? `unterminated '[' at ${open}` : undefined);
  }
  i = skipSpaces(src, i);
  if (src[i] === ']') return [seg, i + 1];
  if (src[i] === ':') throw unexpected(src, i, 'slices are not supported');
  if (src[i] === ',') throw unexpected(src, i, 'only one selector per bracket');
  throw unexpected(src, i, i >= src.length ? `unterminated '[' at ${open}` : "expected ']'");
}

export function parsePath(src: string): ParsedPath {
  if (typeof src !== 'string') return { ok: false, error: 'path must be text' };
  if (src.length > MAX_LENGTH) return { ok: false, error: `path longer than ${MAX_LENGTH} characters` };
  try {
    if (src[0] !== '$') throw unexpected(src, 0, "paths start with '$'");
    const segs: PathSeg[] = [];
    let i = 1;
    while (i < src.length) {
      let seg: PathSeg;
      if (src[i] === '.') {
        if (src[i + 1] === '.') throw new Fail(`recursive descent '..' at ${i} is not supported`);
        const [name, next] = shorthand(src, i + 1);
        seg = { k: 'name', v: checkName(name) };
        i = next;
      } else if (src[i] === '[') {
        [seg, i] = bracket(src, i);
      } else {
        throw unexpected(src, i, "expected '.' or '['");
      }
      segs.push(seg);
      if (segs.length > MAX_SEGMENTS) return { ok: false, error: `more than ${MAX_SEGMENTS} segments` };
    }
    return { ok: true, segs };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.error };
    throw e;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function evaluatePath(
  root: unknown,
  segs: readonly PathSeg[],
): { found: true; value: unknown } | { found: false } {
  let node = root;
  for (const seg of segs) {
    if (seg.k === 'index') {
      if (!Array.isArray(node)) return { found: false };
      const i = seg.v < 0 ? node.length + seg.v : seg.v;
      if (!Number.isInteger(i) || i < 0 || i >= node.length) return { found: false };
      node = node[i];
    } else {
      if (!isObj(node) || BLOCKED.has(seg.v) || !Object.hasOwn(node, seg.v)) return { found: false };
      node = node[seg.v];
    }
  }
  return { found: true, value: node };
}
