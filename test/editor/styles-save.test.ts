import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { StyleHistory } from '../../src/core/edit.js';
import type { Config } from '../../src/core/types.js';
import type { ApiState } from '../../src/editor/web/store.js';
import { withLangAsync } from '../helpers.js';

const { saveStyles, toast } = vi.hoisted(() => ({ saveStyles: vi.fn(), toast: vi.fn() }));
vi.mock('../../src/editor/web/api.js', () => ({ api: { saveStyles } }));
vi.mock('../../src/editor/web/ui.js', () => ({ toast }));

const { rememberStyles } = await import('../../src/editor/web/styles.js');
const store = await import('../../src/editor/web/store.js');

const withColor = (color: string): Config => ({
  ...defaultConfig(),
  lines: [[{ id: 'model-1', type: 'model', color }]],
});
const before = withColor('red');
const after = withColor('blue');

let prev: StyleHistory;

beforeEach(() => {
  saveStyles.mockReset();
  toast.mockReset();
  prev = {};
  store.init({
    config: before,
    savedConfig: before,
    widgets: [],
    categories: [],
    styleHistory: prev,
  } as unknown as ApiState);
});

describe('rememberStyles', () => {
  it('rolls back and tells the user when the save fails', async () => {
    saveStyles.mockRejectedValueOnce(new Error('400'));
    await rememberStyles(before, after);
    expect(store.S.api.styleHistory).toBe(prev);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Could not save the style history', 'error');
  });

  it('says it in Turkish', async () => {
    saveStyles.mockRejectedValueOnce(new Error('400'));
    await withLangAsync('tr', () => rememberStyles(before, after));
    expect(toast).toHaveBeenCalledWith('Stil geçmişi kaydedilemedi', 'error');
  });

  it('keeps the new history and stays quiet on success', async () => {
    saveStyles.mockResolvedValueOnce({ ok: true });
    await rememberStyles(before, after);
    expect(store.S.api.styleHistory).not.toBe(prev);
    expect(store.S.api.styleHistory['model-1']).toEqual([{ color: 'red' }]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not clobber a later change when an earlier save fails', async () => {
    let fail: (e: Error) => void = () => {};
    saveStyles.mockReturnValueOnce(new Promise((_, rej) => (fail = rej)));
    const first = rememberStyles(before, after);
    const later: StyleHistory = { other: [{ bold: true }] };
    store.S.api.styleHistory = later;
    fail(new Error('400'));
    await first;
    expect(store.S.api.styleHistory).toBe(later);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
