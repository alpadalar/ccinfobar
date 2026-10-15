import { describe, expect, it } from 'vitest';
import { parseToml, TomlError } from '../../src/importers/toml.js';
import { type Style, serialize } from './toml-serialize.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rnd = () => number;
type Obj = Record<string, unknown>;

const KEYS = [
  'a',
  'b',
  'id',
  'name',
  'x-1',
  'snake_key',
  '12',
  'true',
  'inf',
  'a b',
  ' lead',
  'a.b',
  '1.5',
  'q"x',
  "it's",
  'back\\slash',
  'tab\tkey',
  'é',
  '\u{f024b}',
  '',
  'toString',
  'hasOwnProperty',
];
const CHARS = [
  'a',
  'Z',
  '0',
  ' ',
  ' ',
  '"',
  "'",
  '\\',
  '\t',
  '\n',
  '\r',
  '\b',
  '\f',
  '\u0001',
  '\u001f',
  '\u007f',
  'é',
  '😀',
  '\u{f024b}',
  '#',
  '=',
  '[',
  ']',
  '{',
  '}',
  ',',
  '.',
  '$',
];
const SEEDS = 300;
const STYLES: Style[] = ['headers', 'dotted', 'inline', 'mixed'];

const int = (rnd: Rnd, n: number) => Math.floor(rnd() * n);

function genString(rnd: Rnd): string {
  let s = '';
  for (let i = int(rnd, 9); i > 0; i--) s += CHARS[int(rnd, CHARS.length)];
  return s;
}

function genNumber(rnd: Rnd): number {
  const r = rnd();
  let n: number;
  if (r < 0.3) n = int(rnd, 2000) - 1000;
  else if (r < 0.45) n = Math.floor((rnd() * 2 - 1) * Number.MAX_SAFE_INTEGER);
  else if (r < 0.75) n = (rnd() - 0.5) * 10 ** (int(rnd, 40) - 20);
  else if (r < 0.85) n = rnd() * 1e300;
  else if (r < 0.9) n = 2 ** 60 * (int(rnd, 3) - 1);
  else n = [Infinity, -Infinity, Number.NaN, 0.5, 1e21][int(rnd, 5)]!;
  return Object.is(n, -0) ? 0 : n;
}

function genTable(rnd: Rnd, depth: number): Obj {
  const out: Obj = {};
  for (let i = int(rnd, 5); i > 0; i--) out[KEYS[int(rnd, KEYS.length)]!] = genValue(rnd, depth + 1);
  return out;
}

function genValue(rnd: Rnd, depth: number): unknown {
  const r = depth >= 4 ? rnd() * 0.58 : rnd();
  if (r < 0.25) return genString(rnd);
  if (r < 0.5) return genNumber(rnd);
  if (r < 0.58) return rnd() < 0.5;
  if (r < 0.72) return Array.from({ length: int(rnd, 4) }, () => genValue(rnd, depth + 1));
  if (r < 0.88) return genTable(rnd, depth);
  return Array.from({ length: 1 + int(rnd, 3) }, () => genTable(rnd, depth + 1));
}

function roundTrip(seed: number, style: Style): string {
  const rnd = mulberry32(seed);
  const value = genTable(rnd, 0);
  const text = serialize(value, style, rnd);
  const label = `seed ${seed}, style ${style}:\n${text}`;
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    if (e instanceof TomlError) throw new Error(`${label}\n${e.code} at ${e.line}:${e.col} ${e.message}`);
    throw e;
  }
  expect(parsed, label).toEqual(value);
  return text;
}

describe('TOML round-trip property', () => {
  it.each(STYLES)('parseToml(serialize(v)) equals v in the %s style', (style) => {
    for (let seed = 1; seed <= SEEDS; seed++) roundTrip(seed * 7919 + style.length, style);
  });

  it('exercises every serializer form', () => {
    const texts = (style: Style) =>
      Array.from({ length: SEEDS }, (_, i) => roundTrip(i * 7919 + 1000, style)).join('\n');
    const headers = texts('headers');
    const dotted = texts('dotted');
    const inline = texts('inline');
    const mixed = texts('mixed');
    expect(headers).toMatch(/^\[\[[^\n]+\]\]$/m);
    expect(headers).toMatch(/^\[[^[\n][^\n]*\]$/m);
    expect(headers).toContain('"""\n');
    expect(dotted).toMatch(/^[^\n=]+\.[^\n=]+ = /m);
    expect(dotted).toMatch(/ = '/);
    expect(inline).toMatch(/= \[\{ /);
    expect(inline).not.toMatch(/^\[/m);
    expect(mixed).toContain("'''\n");
    expect(mixed).toContain('\r\n');
    expect(mixed).toMatch(/= 0x/);
  });
});
