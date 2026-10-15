import { describe, expect, it } from 'vitest';
import { evaluatePath, type PathSeg, parsePath } from '../../src/core/jsonpath.js';
import { withLang } from '../helpers.js';

const SAMPLE = {
  data: { balance: 12.5, 'total-usage': 3, 'a b': 'x' },
  'a b': 'spaced',
  items: [{ id: 1 }, { id: 2 }, { id: 3 }],
  a: [1, 2],
  n: 4,
  \u00e9t\u00e9: 'summer',
  '\u{1f600}': 'smile',
};

const segs = (src: string): PathSeg[] => {
  const r = parsePath(src);
  if (!r.ok) throw new Error(r.error);
  return r.segs;
};

const run = (src: string, root: unknown = SAMPLE) => evaluatePath(root, segs(src));

const error = (src: string): string => {
  const r = parsePath(src);
  if (r.ok) throw new Error(`expected an error for ${src}`);
  return r.error;
};

describe('parsePath', () => {
  it('parses the root', () => {
    expect(segs('$')).toEqual([]);
    expect(run('$')).toEqual({ found: true, value: SAMPLE });
  });

  it.each([
    ['$.data.balance', 12.5],
    ["$['data']['total-usage']", 3],
    ['$["a b"]', 'spaced'],
    ["$[ 'a b' ]", 'spaced'],
    ['$.items[0]', { id: 1 }],
    ['$.items[-1]', { id: 3 }],
    ['$.items[ 1 ].id', 2],
    ['$.items[-3].id', 1],
    ['$.data["a b"]', 'x'],
    ['$.\u00e9t\u00e9', 'summer'],
    ['$.\u{1f600}', 'smile'],
  ])('parses and evaluates %s', (src, value) => {
    expect(run(src)).toEqual({ found: true, value });
  });

  it('builds name and index segments', () => {
    expect(segs("$.a['b'][2][-1]")).toEqual([
      { k: 'name', v: 'a' },
      { k: 'name', v: 'b' },
      { k: 'index', v: 2 },
      { k: 'index', v: -1 },
    ]);
  });

  it('decodes escapes in quoted names', () => {
    expect(segs("$['a\\'b']")).toEqual([{ k: 'name', v: "a'b" }]);
    expect(segs('$["a\\"b"]')).toEqual([{ k: 'name', v: 'a"b' }]);
    expect(segs("$['\\b\\f\\n\\r\\t\\/\\\\']")).toEqual([{ k: 'name', v: '\b\f\n\r\t/\\' }]);
    expect(segs("$['\\u00e9']")).toEqual([{ k: 'name', v: '\u00e9' }]);
    expect(segs('$["it\'s"]')).toEqual([{ k: 'name', v: "it's" }]);
  });

  it('requires a leading $', () => {
    expect(error('data')).toContain("unexpected 'd' at 0");
    expect(error('')).toMatch(/at 0/);
    expect(error('.a')).toContain("unexpected '.' at 0");
  });

  it('points at the offending character', () => {
    expect(error('$.a?b')).toContain("'?' at 3");
    expect(error('$a')).toContain("unexpected 'a' at 1");
    expect(error('$.')).toContain('at 2');
    expect(error('$.1a')).toContain("unexpected '1' at 2");
    expect(error('$.a.0')).toContain("unexpected '0' at 4");
  });

  it('suggests brackets for names with dashes', () => {
    const msg = error('$.foo-bar');
    expect(msg).toContain("unexpected '-' at 5");
    expect(msg).toContain("use ['foo-bar']");
  });

  it('rejects recursive descent', () => {
    expect(error('$..a')).toMatch(/'\.\.' at 1/);
  });

  it('rejects wildcards', () => {
    expect(error('$.*')).toContain('wildcard');
    expect(error('$[*]')).toContain('wildcard');
    expect(error('$.items[ * ]')).toContain('wildcard');
  });

  it.each(['$[01]', '$[-0]', '$[-]', '$[1', '$[1 2]', '$[9007199254740992]'])(
    'rejects bad index %s',
    (src) => {
      expect(error(src)).toBeTruthy();
    },
  );

  it('rejects slices, filters, unions and @', () => {
    expect(error('$[1:2]')).toContain('slice');
    expect(error('$[:2]')).toBeTruthy();
    expect(error('$[?(@.x)]')).toContain('filter');
    expect(error('$[0,1]')).toContain('one selector');
    expect(error('$.@')).toContain("'@'");
  });

  it('reports unterminated strings at the end', () => {
    expect(error("$['a")).toContain('at 4');
    expect(error("$['a'")).toContain('at 5');
    expect(error("$['a\\")).toBeTruthy();
    expect(error("$['\\u12']")).toBeTruthy();
    expect(error("$['\\q']")).toBeTruthy();
  });

  it('rejects raw control characters', () => {
    expect(error("$['a\u0001']")).toContain('\\u0001');
    expect(error('$.a\u0007')).toContain('\\u0007');
  });

  it('rejects lone surrogates in names', () => {
    expect(error('$.\ud800')).toBeTruthy();
    expect(error('$.a\udc00')).toBeTruthy();
  });

  it.each(['$.__proto__', "$['constructor']", '$.prototype', '$["__proto__"]', "$.a['prototype']"])(
    'rejects the prototype segment in %s',
    (src) => {
      expect(error(src)).toMatch(/__proto__|constructor|prototype/);
    },
  );

  it('caps length and segment count', () => {
    expect(error(`$.${'a'.repeat(300)}`)).toContain('256');
    expect(error(`$${'.a'.repeat(40)}`)).toContain('32');
    expect(parsePath(`$${'.a'.repeat(32)}`).ok).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(parsePath(42 as any).ok).toBe(false);
  });
});

describe('evaluatePath', () => {
  it('uses own properties only', () => {
    const root = JSON.parse('{"__proto__": 1, "x": {}}');
    expect(run('$.toString', root)).toEqual({ found: false });
    expect(run('$.x.hasOwnProperty', root)).toEqual({ found: false });
    expect(run('$.length', 'str')).toEqual({ found: false });
    expect(run('$.a.length')).toEqual({ found: false });
  });

  it('refuses prototype names in hand-built segments', () => {
    const root = JSON.parse('{"__proto__": {"a": 1}}');
    expect(evaluatePath(root, [{ k: 'name', v: '__proto__' }])).toEqual({ found: false });
  });

  it('misses out-of-range indices and non-containers', () => {
    expect(run('$.a[5]')).toEqual({ found: false });
    expect(run('$.a[-3]')).toEqual({ found: false });
    expect(run('$.a.b')).toEqual({ found: false });
    expect(run('$.n.b')).toEqual({ found: false });
    expect(run('$.n[0]')).toEqual({ found: false });
    expect(run('$.data[0]')).toEqual({ found: false });
    expect(run('$.x', null)).toEqual({ found: false });
  });

  it('finds null and falsy values', () => {
    expect(run('$.v', { v: null })).toEqual({ found: true, value: null });
    expect(run('$[0]', [0])).toEqual({ found: true, value: 0 });
  });
});

describe('parsePath errors in Turkish', () => {
  const trError = (src: string): string => withLang('tr', () => error(src));

  it('keeps the character, position and quoting', () => {
    expect(trError('$[*]')).toBe(
      "'*' joker karakteri desteklenmiyor (konum 2); bileşen tek bir değer gösterir",
    );
    expect(trError('data')).toBe("beklenmeyen 'd' (konum 0); yollar '$' ile başlar");
    expect(trError('$.foo-bar')).toBe("beklenmeyen '-' (konum 5); ['foo-bar'] kullanın");
    expect(trError('$[0')).toBe("beklenmeyen yol sonu (konum 3); kapatılmamış '[' (konum 1)");
    expect(trError('$.__proto__')).toBe("'__proto__' yol parçasına izin verilmiyor");
  });

  it('stays English by default', () => {
    expect(error('$[0')).toBe("unexpected end at 3; unterminated '[' at 1");
    expect(error('$.foo-bar')).toBe("unexpected '-' at 5; use ['foo-bar']");
  });
});
