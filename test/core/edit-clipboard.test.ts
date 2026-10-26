import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { lineEnd, pasteItem, pasteTarget, takeItem } from '../../src/core/edit.js';
import type { Config, WidgetItem } from '../../src/core/types.js';

const config = (lines: WidgetItem[][]): Config => ({ ...defaultConfig(), lines });

const two = config([
  [
    { id: 'w1', type: 'model' },
    { id: 'model-1', type: 'model' },
  ],
  [{ id: 'w3', type: 'git-branch' }],
]);

describe('lineEnd', () => {
  it('clamps the line and points past its last item', () => {
    expect(lineEnd(two, 5)).toEqual({ line: 1, index: 1 });
    expect(lineEnd(two, -1)).toEqual({ line: 0, index: 2 });
    expect(lineEnd(two, 0)).toEqual({ line: 0, index: 2 });
    expect(lineEnd(config([]), 3)).toEqual({ line: 0, index: 0 });
  });
});

describe('takeItem', () => {
  it('copies everything but the id', () => {
    const item: WidgetItem = {
      id: 'w1',
      type: 'model',
      merge: true,
      color: 'cyan',
      options: { short: true },
      showWhen: 'cost > 1',
      priority: 3,
    };
    const snap = takeItem(item);
    expect(snap).not.toHaveProperty('id');
    expect(snap).toEqual({
      type: 'model',
      merge: true,
      color: 'cyan',
      options: { short: true },
      showWhen: 'cost > 1',
      priority: 3,
    });
    snap.options!.short = false;
    expect(item.options).toEqual({ short: true });
  });
});

describe('pasteTarget', () => {
  it('goes after the selected chip', () => {
    expect(pasteTarget(two, 'w1', 1)).toEqual({ line: 0, index: 1 });
    expect(pasteTarget(two, 'w3', 0)).toEqual({ line: 1, index: 1 });
  });

  it('falls back to the end of the line', () => {
    expect(pasteTarget(two, null, 1)).toEqual(lineEnd(two, 1));
    expect(pasteTarget(two, 'missing', 1)).toEqual(lineEnd(two, 1));
  });
});

describe('pasteItem', () => {
  it('inserts a copy with a fresh id', () => {
    const before = JSON.stringify(two);
    const { config: next, id } = pasteItem(
      two,
      { type: 'model', options: { short: true } },
      { line: 0, index: 1 },
    );
    expect(id).toBe('model-2');
    expect(next.lines[0]![1]).toEqual({ type: 'model', options: { short: true }, id: 'model-2' });
    expect(next.lines[0]).toHaveLength(3);
    expect(JSON.stringify(two)).toBe(before);
  });

  it('creates the first line when there is none', () => {
    const { config: next, id } = pasteItem(config([]), { type: 'cost' }, lineEnd(config([]), 0));
    expect(next.lines).toEqual([[{ type: 'cost', id }]]);
    expect(id).toBe('cost-1');
  });
});
