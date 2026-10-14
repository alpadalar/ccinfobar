import { describe, expect, it } from 'vitest';
import { t } from '../../src/core/i18n/index.js';
import { lineColumn, locateJsonError, locateKey } from '../../src/core/json-locate.js';

function at(text: string) {
  const issue = locateJsonError(text);
  expect(issue, text).not.toBeNull();
  return issue!;
}

describe('locateJsonError', () => {
  it('returns null for valid JSON', () => {
    for (const s of [
      '{"a":1}',
      '{}',
      '[1,2]',
      '  "x"  ',
      '0',
      '-1.5e+3',
      'null',
      '"\\u00e9\\n"',
      '{"a":[{}]}',
    ]) {
      expect(locateJsonError(s), s).toBeNull();
    }
  });

  it('finds a trailing comma', () => {
    const issue = at('{\n  "a": 1,\n}');
    expect(issue).toMatchObject({ line: 3, column: 1, message: t('json.trailingComma') });
  });

  it('finds a missing colon', () => {
    expect(at('{"a" 1}')).toMatchObject({ line: 1, column: 6, message: t('json.expectedColon') });
  });

  it('flags a bad literal at its start', () => {
    const issue = at('{"a":tru}');
    expect(issue.line).toBe(1);
    expect(issue.column).toBe(6);
  });

  it('finds an empty array slot', () => {
    expect(at('[1,,2]')).toMatchObject({ line: 1, column: 4 });
  });

  it('names string and file errors', () => {
    expect(at('{"a":"x').message).toBe(t('json.unterminatedString'));
    expect(at('{"a":"\\q"}').message).toBe(t('json.badEscape'));
    expect(at('{"a":"\\u12g4"}').message).toBe(t('json.badEscape'));
    expect(at('{"a":"\u0009"}').message).toBe(t('json.controlChar'));
    expect(at('').message).toBe(t('json.empty'));
    expect(at(' \n ').message).toBe(t('json.empty'));
    expect(at('{} x')).toMatchObject({ line: 1, column: 4, message: t('json.trailingData') });
    expect(at('[1').message).toBe(t('json.unexpectedEnd'));
    expect(at('1.').message).toBe(t('json.badNumber'));
    expect(at('{1:2}').message).toBe(t('json.expectedKey'));
    expect(at('[1 2]').message).toBe(t('json.expectedCommaOrClose', { close: ']' }));
  });

  it('counts CRLF as one line break', () => {
    expect(at('{\r\n"a":1,\r\n}')).toMatchObject({ line: 3, column: 1 });
  });

  it('handles deep nesting without recursion', () => {
    expect(locateJsonError('['.repeat(100000) + ']'.repeat(100000))).toBeNull();
    expect(at('['.repeat(100000)).message).toBe(t('json.unexpectedEnd'));
  });

  it('agrees with JSON.parse on fuzzed inputs', () => {
    const samples = [
      '{"a":1,"b":[true,false,null],"c":{"d":"e"}}',
      '[1, -2.5, 3e10, 0.1E-2, "x\\ny", {}]',
      '{\n  "version": 1,\n  "lines": [\n    [{ "type": "model" }]\n  ]\n}',
      '"\\u0041\\"\\\\\\/\\b\\f\\r\\t"',
      '{"x": {"y": {"z": [[], [{}], ""]}}}',
      '  -0  ',
      '{"emoji": "é中", "n": 12345678901234567890}',
      '[null,true,false]',
      '{"a":"","b":0,"c":-0.0e0}',
      '{\r\n\t"k": [1,2,3]\r\n}',
    ];
    for (const s of samples) expect(() => JSON.parse(s), s).not.toThrow();
    const chars = '{}[],:"\\ 0123456789eE.-+tfnurl\t\n\r\u0000\u001f ﻿axq/';
    let seed = 0x9e3779b9;
    const rand = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const mismatches: string[] = [];
    for (let i = 0; i < 3000; i++) {
      let s = samples[i % samples.length]!;
      const steps = 1 + rand(2);
      for (let k = 0; k < steps; k++) {
        const pos = rand(s.length + 1);
        const ch = chars[rand(chars.length)]!;
        const op = rand(3);
        if (op === 0) s = s.slice(0, pos) + ch + s.slice(pos);
        else if (op === 1) s = s.slice(0, pos) + s.slice(pos + 1);
        else s = s.slice(0, pos) + ch + s.slice(pos + 1);
      }
      let ok = true;
      try {
        JSON.parse(s);
      } catch {
        ok = false;
      }
      if ((locateJsonError(s) === null) !== ok) mismatches.push(JSON.stringify(s));
    }
    expect(mismatches).toEqual([]);
  });
});

describe('lineColumn', () => {
  it('is 1-based and counts UTF-16 units', () => {
    expect(lineColumn('abc', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn('a\nbc', 3)).toEqual({ line: 2, column: 2 });
    expect(lineColumn('a\r\nb', 3)).toEqual({ line: 2, column: 1 });
    expect(lineColumn('😀x', 2)).toEqual({ line: 1, column: 3 });
  });
});

describe('locateKey', () => {
  it('finds a top-level key', () => {
    expect(locateKey('{\n  "lines": {}\n}', 'lines')).toMatchObject({ line: 2, column: 3, offset: 4 });
  });

  it('ignores nested keys and missing keys', () => {
    expect(locateKey('{"a":{"lines":1}}', 'lines')).toBeNull();
    expect(locateKey('{"a":1}', 'lines')).toBeNull();
    expect(locateKey('[]', 'lines')).toBeNull();
  });

  it('decodes escaped keys and returns the last duplicate', () => {
    expect(locateKey('{"li\\u006ees":1,\n"lines":2}', 'lines')).toMatchObject({ line: 2, column: 1 });
  });
});
