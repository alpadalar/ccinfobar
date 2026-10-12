import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import {
  addLine,
  applyStyle,
  clearColors,
  hasOwnColors,
  insertItem,
  moveItem,
  moveLine,
  recordStyles,
  removeItem,
  removeLine,
  setLineAlign,
  setOption,
  takeStyle,
  updateItem,
} from '../../src/core/edit.js';
import type { Config, WidgetItem } from '../../src/core/types.js';

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

describe('styles', () => {
  const cfg = (): Config => ({
    ...defaultConfig(),
    lines: [
      [
        {
          id: 'a',
          type: 'context-bar',
          color: 'red',
          bold: true,
          raw: true,
          options: { style: 'dots', width: 6 },
        },
        { id: 'b', type: 'model', color: 'blue', italic: true },
        { id: 'c', type: 'five-hour-usage', options: { display: 'bar' } },
      ],
    ],
  });

  it('copies the chosen groups exactly', () => {
    const c = cfg();
    const snap = takeStyle(c.lines[0]![0]!);
    const colors = applyStyle(c, ['b'], snap, ['colors']).lines[0]![1]!;
    expect(colors).toMatchObject({ color: 'red', italic: true });
    const text = applyStyle(c, ['b'], snap, ['text']).lines[0]![1]!;
    expect(text.bold).toBe(true);
    expect(text.italic).toBeUndefined();
    const bars = applyStyle(c, ['c'], snap, ['bars'], () => ['display', 'style', 'width']).lines[0]![2]!;
    expect(bars.options).toEqual({ style: 'dots', width: 6 });
    expect(applyStyle(c, ['b'], snap, ['label']).lines[0]![1]!.raw).toBe(true);
  });

  it('clears own colors for a theme', () => {
    const c = cfg();
    expect(hasOwnColors(c)).toBe(true);
    const plain = clearColors(c);
    expect(hasOwnColors(plain)).toBe(false);
    expect(plain.lines[0]![0]!.bold).toBe(true);
  });

  it('keeps the last three previous styles per widget', () => {
    let c = cfg();
    let history = {};
    for (const color of ['green', 'yellow', 'cyan', 'magenta']) {
      const next = updateItem(c, 'b', { color });
      history = recordStyles(history, c, next);
      c = next;
    }
    const list = (history as Record<string, { color?: string }[]>).b!;
    expect(list.map((s) => s.color)).toEqual(['cyan', 'yellow', 'green']);
    expect(recordStyles(history, c, c)).toEqual(history);
  });
});

describe('line alignment', () => {
  it('follows its line when lines are added, moved and removed', () => {
    const base = { ...defaultConfig(), lines: [[], [], []] as WidgetItem[][] };
    let c = setLineAlign(base, 1, 'right');
    expect(c.lineAlign).toEqual([null, 'right']);
    c = addLine(c, 0);
    expect(c.lineAlign).toEqual([null, null, 'right']);
    c = moveLine(c, 2, 0);
    expect(c.lineAlign).toEqual(['right']);
    c = removeLine(c, 0);
    expect(c.lineAlign).toBeUndefined();
  });
});
