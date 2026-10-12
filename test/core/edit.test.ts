import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import {
  addLine,
  insertItem,
  moveItem,
  moveLine,
  removeItem,
  removeLine,
  setOption,
  updateItem,
} from '../../src/core/edit.js';
import type { Config } from '../../src/core/types.js';

const base = (): Config => ({
  ...defaultConfig(),
  lines: [
    [
      { id: 'a', type: 'text' },
      { id: 'b', type: 'text' },
      { id: 'c', type: 'text' },
    ],
    [{ id: 'd', type: 'text' }],
  ],
});
const ids = (c: Config) => c.lines.map((l) => l.map((i) => i.id));

describe('edit ops', () => {
  it('moves within a line in both directions', () => {
    expect(ids(moveItem(base(), 'a', { line: 0, index: 3 }))).toEqual([['b', 'c', 'a'], ['d']]);
    expect(ids(moveItem(base(), 'c', { line: 0, index: 0 }))).toEqual([['c', 'a', 'b'], ['d']]);
    expect(ids(moveItem(base(), 'a', { line: 0, index: 1 }))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('moves across lines and creates missing lines', () => {
    expect(ids(moveItem(base(), 'b', { line: 1, index: 0 }))).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
    expect(ids(moveItem(base(), 'd', { line: 2, index: 0 }))).toEqual([['a', 'b', 'c'], [], ['d']]);
  });

  it('inserts with unique ids and removes', () => {
    const c = insertItem(
      insertItem(base(), { type: 'model' }, { line: 1, index: 9 }),
      { type: 'model' },
      { line: 1, index: 0 },
    );
    expect(ids(c)[1]).toEqual(['model-2', 'd', 'model-1']);
    expect(ids(removeItem(c, 'd'))[1]).toEqual(['model-2', 'model-1']);
  });

  it('updates items and clears undefined keys', () => {
    const c = updateItem(base(), 'a', { color: 'red', bold: true });
    expect(c.lines[0]![0]).toEqual({ id: 'a', type: 'text', color: 'red', bold: true });
    expect(updateItem(c, 'a', { color: undefined }).lines[0]![0]).toEqual({
      id: 'a',
      type: 'text',
      bold: true,
    });
    expect(setOption(c, 'a', 'text', 'hi').lines[0]![0]!.options).toEqual({ text: 'hi' });
  });

  it('manages lines without mutating input', () => {
    const b = base();
    expect(ids(addLine(b, 0))).toEqual([[], ['a', 'b', 'c'], ['d']]);
    expect(ids(removeLine(b, 0))).toEqual([['d']]);
    expect(ids(moveLine(b, 1, 0))).toEqual([['d'], ['a', 'b', 'c']]);
    expect(ids(b)).toEqual([['a', 'b', 'c'], ['d']]);
  });
});
