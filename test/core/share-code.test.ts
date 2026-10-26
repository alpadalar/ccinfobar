import { describe, expect, it } from 'vitest';
import { extractCode, MAX_CODE_CHARS, parseShareDoc } from '../../src/core/share-code.js';

describe('extractCode', () => {
  it('accepts every pasted form', () => {
    for (const s of [
      'ccib1:AbC-_9',
      '  "ccib1:AbC-_9"\n',
      '`ccib1:AbC-_9`',
      '<ccib1:AbC-_9>',
      '#c=ccib1:AbC-_9',
      'c=ccib1:AbC-_9',
      'https://example.org/any/path?q=1#c=ccib1:AbC-_9',
      'ccib1:Ab\nC-\r\n_9',
      'https://example.org/#c=ccib1%3AAbC-_9',
    ]) {
      expect(extractCode(s), JSON.stringify(s)).toEqual({ data: 'AbC-_9' });
    }
  });

  it('names what is wrong', () => {
    expect(extractCode('')).toEqual({ errorId: 'err.share.notCode' });
    expect(extractCode('hello')).toEqual({ errorId: 'err.share.notCode' });
    expect(extractCode(42)).toEqual({ errorId: 'err.share.notCode' });
    expect(extractCode('ccib1:')).toEqual({ errorId: 'err.share.notCode' });
    expect(extractCode('ccib1:ab+/=')).toEqual({ errorId: 'err.share.notCode' });
    expect(extractCode('ccib2:abc')).toEqual({ errorId: 'err.share.version' });
    expect(extractCode(`ccib1:${'a'.repeat(MAX_CODE_CHARS)}`)).toEqual({ errorId: 'err.share.tooLong' });
    expect(extractCode('a'.repeat(MAX_CODE_CHARS * 5))).toEqual({ errorId: 'err.share.tooLong' });
    expect(extractCode('#c=%E0%A4%A')).toEqual({ errorId: 'err.share.notCode' });
  });
});

describe('parseShareDoc', () => {
  const lines = [[{ id: 'm', type: 'model' }]];

  it('keeps only layout and appearance keys', () => {
    const doc = parseShareDoc({
      v: 1,
      content: {
        layout: { lines, align: 'right', budget: { daily: 1 }, language: 'tr' },
        appearance: { theme: 'nord', charset: 'nerd' },
        theme: { id: 'x' },
      },
      cols: 120,
    });
    expect(doc).toEqual({
      v: 1,
      content: { layout: { lines, align: 'right' }, appearance: { theme: 'nord' }, theme: { id: 'x' } },
      cols: 120,
    });
  });

  it('ignores prototype keys', () => {
    const raw = JSON.parse(
      '{"v":1,"content":{"layout":{"lines":[],"__proto__":{"polluted":1},"constructor":1},"appearance":{"__proto__":{"x":1}}}}',
    );
    const doc = parseShareDoc(raw);
    expect(doc?.content.layout).toEqual({ lines: [] });
    expect(Object.hasOwn(doc!.content.layout!, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops a cols value out of range', () => {
    expect(parseShareDoc({ v: 1, content: { layout: { lines: [] } }, cols: 5 })).toEqual({
      v: 1,
      content: { layout: { lines: [] } },
    });
  });

  it('rejects malformed documents', () => {
    for (const raw of [
      null,
      [],
      'x',
      { v: 2, content: { layout: { lines: [] } } },
      { v: 1 },
      { v: 1, content: [] },
      { v: 1, content: { layout: { lines: {} } } },
      { v: 1, content: { layout: { lines: [[1]] } } },
      { v: 1, content: { layout: { lines: [] }, extra: 1 } },
      { v: 1, content: { layout: { lines: [] }, theme: 'nord' } },
      { v: 1, content: { layout: { lines: [] }, appearance: [] } },
    ]) {
      expect(parseShareDoc(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
