import { describe, expect, it } from 'vitest';
import {
  deepSanitize,
  keepSgrAndLinks,
  safeConfigUrl,
  safeUrl,
  sanitizeText,
} from '../../src/core/sanitize.js';

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

const ALPHABET = [
  '\x1b',
  '\x07',
  '[',
  ']',
  ';',
  'a',
  'Z',
  'm',
  'P',
  '\\',
  '0',
  '5',
  '\x9b',
  '\x9c',
  '\x85',
  '\u202e',
  '\u2066',
  '\r',
  '\n',
  '\t',
  '\x00',
];

describe('sanitizeText', () => {
  it('strips OSC, CSI and 8-bit CSI', () => {
    expect(sanitizeText('feat/\x1b]52;c;ZXZpbA==\x07x')).toBe('feat/x');
    expect(sanitizeText('a\x1b[31mb\x1b[0m')).toBe('ab');
    expect(sanitizeText('dir\x9b31mname')).toBe('dirname');
  });

  it('removes bidi controls and folds CR/LF/tab', () => {
    expect(sanitizeText('name\u202eevil\nline')).toBe('nameevil line');
    expect(sanitizeText('a\r\n\tb')).toBe('a b');
  });

  it('strips DCS and unterminated OSC', () => {
    expect(sanitizeText('x\x1bPq#0;2;0;0;0\x1b\\y')).toBe('xy');
    expect(sanitizeText('ok\x1b]0;title')).toBe('ok');
  });

  it('removes C0, DEL and C1 but keeps LRM/RLM', () => {
    expect(sanitizeText('a\x00b\x7fc\x85d')).toBe('abcd');
    expect(sanitizeText('a\u200eb\u200fc')).toBe('a\u200eb\u200fc');
  });

  it('is safe and idempotent on random input', () => {
    const rand = mulberry32(0xc0ffee);
    const bad = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rand() * 40);
      let s = '';
      for (let j = 0; j < len; j++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const out = sanitizeText(s);
      expect(bad.test(out), JSON.stringify(s)).toBe(false);
      expect(sanitizeText(out)).toBe(out);
    }
  });
});

describe('keepSgrAndLinks', () => {
  it('keeps SGR', () => {
    expect(keepSgrAndLinks('\x1b[1;31mred\x1b[0m')).toBe('\x1b[1;31mred\x1b[0m');
  });

  it('re-emits safe OSC 8 links with ST', () => {
    expect(keepSgrAndLinks('\x1b]8;;https://a.b/c\x07t\x1b]8;;\x07')).toBe(
      '\x1b]8;;https://a.b/c\x1b\\t\x1b]8;;\x1b\\',
    );
  });

  it('drops clipboard, title and non-SGR CSI', () => {
    expect(keepSgrAndLinks('a\x1b]52;c;Zm9v\x07b')).toBe('ab');
    expect(keepSgrAndLinks('a\x1b]0;title\x07b')).toBe('ab');
    expect(keepSgrAndLinks('a\x1b[2Jb')).toBe('ab');
  });

  it('drops unsafe links but keeps the text', () => {
    const out = keepSgrAndLinks('\x1b]8;;javascript:alert(1)\x07click\x1b]8;;\x07');
    expect(out).toBe('click');
  });

  it('resets colors the output leaves open', () => {
    expect(keepSgrAndLinks('\u001b[31mred')).toBe('\u001b[31mred\u001b[0m');
    expect(keepSgrAndLinks('\u001b[0;1mbold')).toBe('\u001b[0;1mbold\u001b[0m');
    expect(keepSgrAndLinks('\u001b[31mred\u001b[m')).toBe('\u001b[31mred\u001b[m');
    expect(keepSgrAndLinks('plain')).toBe('plain');
  });

  it('cleans text between sequences', () => {
    expect(keepSgrAndLinks('\x1b[32ma\u202e\nb\x85\x1b[0m')).toBe('\x1b[32ma b\x1b[0m');
  });
});

describe('safeUrl', () => {
  it('accepts http(s) only', () => {
    expect(safeUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('file:///etc')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });

  it('rejects control characters and spaces', () => {
    expect(safeUrl('http://x/\x07')).toBeNull();
    expect(safeUrl('https://a b')).toBeNull();
    expect(safeUrl('https://a/\u202e')).toBeNull();
  });

  it('percent-encodes non-ASCII', () => {
    expect(safeUrl('https://é.com/ä')).toBe('https://xn--9ca.com/%C3%A4');
  });
});

describe('safeConfigUrl', () => {
  it('accepts any scheme but javascript and data', () => {
    expect(safeConfigUrl('vscode://file/x')).toBe('vscode://file/x');
    expect(safeConfigUrl('file:///tmp/a')).toBe('file:///tmp/a');
    expect(safeConfigUrl('javascript:x')).toBeNull();
    expect(safeConfigUrl('JavaScript:x')).toBeNull();
    expect(safeConfigUrl('data:text/html,x')).toBeNull();
    expect(safeConfigUrl('https://a\nb')).toBeNull();
  });
});

describe('deepSanitize', () => {
  it('sanitizes string leaves except skipped keys', () => {
    const input = { a: 'x\x1b[2Jy', b: ['\u202e'], c: 5, transcript_path: '/t\x1b' };
    const out = deepSanitize(input, new Set(['transcript_path']));
    expect(out).toEqual({ a: 'xy', b: [''], c: 5, transcript_path: '/t\x1b' });
    expect(input.a).toBe('x\x1b[2Jy');
  });

  it('walks nested objects and handles plain strings', () => {
    expect(deepSanitize({ x: { y: [{ z: 'a\nb' }] } })).toEqual({ x: { y: [{ z: 'a b' }] } });
    expect(deepSanitize('a\x9bm')).toBe('a');
    expect(deepSanitize(null)).toBeNull();
  });

  it('skips keys only at the top level and sanitizes keys', () => {
    const input = {
      transcript_path: '/t\u001b',
      nested: { transcript_path: 'x\u001b[2Jy' },
      ['k\u001b[31m']: 'v',
    };
    expect(deepSanitize(input, new Set(['transcript_path']))).toEqual({
      transcript_path: '/t\u001b',
      nested: { transcript_path: 'xy' },
      k: 'v',
    });
    const proto = deepSanitize(JSON.parse('{"__pro\\u0007to__":{"x":1}}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Object.keys(proto)).toEqual([]);
  });

  it('turns line separators into spaces and rejects marks in URLs', () => {
    expect(sanitizeText('a\u2028b\u2029c')).toBe('a b c');
    expect(safeUrl('https://a.b/\u200e')).toBeNull();
  });

  it('drops __proto__ keys', () => {
    const out = deepSanitize(JSON.parse('{"__proto__":{"x":1},"a":"b"}')) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out).toEqual({ a: 'b' });
  });
});
