import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { boundStyles, type StyleHistory } from '../../src/core/edit.js';
import type { Config } from '../../src/core/types.js';

const snap = [{ bold: true }];
const withIds = (ids: string[]): Config => ({
  ...defaultConfig(),
  lines: [ids.map((id) => ({ id, type: 'model' }))],
});

describe('boundStyles', () => {
  it('puts config ids first and cuts at the cap', () => {
    const history: StyleHistory = { x: snap, y: snap, z: snap, a: snap };
    const out = boundStyles(history, withIds(['a', 'z']), 3);
    expect(Object.keys(out)).toEqual(['a', 'z', 'x']);
    expect(out.y).toBeUndefined();
  });

  it('keeps history order for the rest and ignores config ids without history', () => {
    const history: StyleHistory = { x: snap, y: snap, z: snap };
    expect(Object.keys(boundStyles(history, withIds(['missing', 'y']), 2))).toEqual(['y', 'x']);
  });

  it('returns the same object when under the cap and already ordered', () => {
    const history: StyleHistory = { a: snap, b: snap, c: snap };
    expect(boundStyles(history, withIds(['a', 'b']), 500)).toBe(history);
    expect(boundStyles(history, withIds([]), 3)).toBe(history);
  });

  it('keeps ids of deleted widgets below the cap', () => {
    const history: StyleHistory = { gone: snap, a: snap };
    expect(boundStyles(history, withIds(['a']), 500)).toBe(history);
  });
});
