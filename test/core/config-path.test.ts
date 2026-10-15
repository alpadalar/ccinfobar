import { describe, expect, it } from 'vitest';
import { getPath, PathError, parsePath, setPath, unsetPath } from '../../src/core/config-path.js';
import { withLang } from '../helpers.js';

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof PathError ? e.code : 'other';
  }
};

describe('parsePath', () => {
  it('splits on dots and turns digit segments into indices', () => {
    expect(parsePath('lines.0.2.type')).toEqual(['lines', 0, 2, 'type']);
    expect(parsePath('theme')).toEqual(['theme']);
  });

  it('rejects empty segments', () => {
    for (const p of ['', 'a..b', '.a', 'a.']) expect(code(() => parsePath(p))).toBe('badPath');
  });

  it('rejects prototype segments, case-sensitively', () => {
    for (const p of ['__proto__.x', 'a.constructor', 'a.prototype.b']) {
      expect(code(() => parsePath(p))).toBe('protoSegment');
    }
    expect(parsePath('a.Constructor')).toEqual(['a', 'Constructor']);
  });

  it('names the offending segment', () => {
    try {
      parsePath('a.__proto__');
    } catch (e) {
      expect((e as PathError).segment).toBe('__proto__');
    }
  });
});

describe('getPath', () => {
  it('reads nested values', () => {
    expect(getPath({ a: [{ b: 1 }] }, ['a', 0, 'b'])).toEqual({ found: true, value: 1 });
  });

  it('reports missing paths', () => {
    expect(getPath({ a: [{ b: 1 }] }, ['a', 1, 'b'])).toEqual({ found: false, value: undefined });
    expect(getPath({ a: 'str' }, ['a', 'length'])).toEqual({ found: false, value: undefined });
    expect(getPath({}, ['toString'])).toEqual({ found: false, value: undefined });
    expect(getPath({ a: [1] }, ['a', 'length'])).toEqual({ found: false, value: undefined });
  });
});

describe('setPath', () => {
  it('creates objects for missing keys', () => {
    expect(setPath({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
    expect(setPath({}, ['a', 0], 1)).toEqual({ a: { 0: 1 } });
  });

  it('replaces and appends array elements', () => {
    expect(setPath({ l: [1] }, ['l', 0], 2)).toEqual({ l: [2] });
    expect(setPath({ l: [1] }, ['l', 1], 2)).toEqual({ l: [1, 2] });
  });

  it('refuses to index past the end of an array', () => {
    expect(code(() => setPath({ l: [1] }, ['l', 5], 2))).toBe('outOfRange');
  });

  it('refuses non-container intermediates', () => {
    expect(code(() => setPath({ a: 'str' }, ['a', 'b'], 1))).toBe('notContainer');
    expect(code(() => setPath({ a: null }, ['a', 'b'], 1))).toBe('notContainer');
    expect(code(() => setPath({ l: [1] }, ['l', 'x'], 1))).toBe('notContainer');
  });

  it('does not mutate the input', () => {
    const input = { a: { b: [1, 2] }, c: { d: 1 } };
    const snapshot = structuredClone(input);
    const out = setPath(input, ['a', 'b', 0], 9) as typeof input;
    expect(input).toEqual(snapshot);
    expect(out).toEqual({ a: { b: [9, 2] }, c: { d: 1 } });
  });
});

describe('unsetPath', () => {
  it('splices array elements', () => {
    expect(unsetPath({ l: [1, 2, 3] }, ['l', 1])).toEqual({ found: true, value: { l: [1, 3] } });
  });

  it('deletes object keys', () => {
    expect(unsetPath({ a: { b: 1 } }, ['a', 'b'])).toEqual({ found: true, value: { a: {} } });
  });

  it('reports missing paths and leaves the root alone', () => {
    const root = { a: { b: 1 } };
    const r = unsetPath(root, ['a', 'c']);
    expect(r.found).toBe(false);
    expect(r.value).toBe(root);
    expect(unsetPath({ l: [1] }, ['l', 3]).found).toBe(false);
  });

  it('does not mutate the input', () => {
    const input = { l: [1, 2, 3], a: { b: 1 } };
    unsetPath(input, ['l', 0]);
    unsetPath(input, ['a', 'b']);
    expect(input).toEqual({ l: [1, 2, 3], a: { b: 1 } });
  });
});

describe('prototype safety', () => {
  it('never pollutes Object.prototype', () => {
    expect(code(() => setPath({}, ['__proto__', 'polluted'], 1))).toBe('protoSegment');
    expect(code(() => setPath({}, ['constructor', 'prototype', 'polluted'], 1))).toBe('protoSegment');
    expect(code(() => unsetPath({}, ['__proto__']))).toBe('protoSegment');
    expect(code(() => getPath({}, ['__proto__']))).toBe('protoSegment');
    const parsed = JSON.parse('{"__proto__": {"polluted": 1}}');
    setPath(parsed, ['a'], 1);
    unsetPath(parsed, ['a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('creates plain objects', () => {
    const out = setPath({}, ['a', 'b'], 1) as { a: object };
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
  });
});

describe('path errors in Turkish', () => {
  const caught = (fn: () => unknown): PathError => {
    try {
      fn();
    } catch (e) {
      return e as PathError;
    }
    throw new Error('expected a PathError');
  };

  it('translates the message and keeps the code and segment', () => {
    const e = withLang('tr', () => caught(() => parsePath('a.__proto__')));
    expect(e).toBeInstanceOf(PathError);
    expect(e.code).toBe('protoSegment');
    expect(e.segment).toBe('__proto__');
    expect(e.message).toBe('"__proto__" yol parçasına izin verilmiyor');
    expect(withLang('tr', () => caught(() => setPath({ a: [] }, ['a', 3], 1))).message).toBe(
      '3 dizini listenin sonunu aşıyor',
    );
    expect(caught(() => setPath({ a: [] }, ['a', 3], 1)).message).toBe('index 3 is past the end');
  });
});
