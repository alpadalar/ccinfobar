import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { setProgress } from '../../src/core/edit.js';
import {
  type ApiState,
  applySaved,
  commit,
  init,
  isDirty,
  redo,
  S,
  undo,
} from '../../src/editor/web/store.js';

// WR-03: the progress switch is saved by the server, outside undo
describe('applySaved', () => {
  const start = () => {
    const config = defaultConfig();
    init({ config, savedConfig: config, widgets: [], categories: [] } as unknown as ApiState);
  };

  it('is neither dirty nor undoable', () => {
    start();
    applySaved((c) => setProgress(c, { enabled: true }));
    expect(S.config.progress).toEqual({ enabled: true });
    expect(isDirty()).toBe(false);
    expect(S.undo).toEqual([]);
  });

  it('survives undo and redo of other edits and keeps them dirty', () => {
    start();
    commit({ ...S.config, theme: 'nord' });
    applySaved((c) => setProgress(c, { enabled: true }));
    expect(isDirty()).toBe(true);
    undo();
    expect(S.config.theme).not.toBe('nord');
    expect(S.config.progress).toEqual({ enabled: true });
    expect(isDirty()).toBe(false);
    redo();
    expect(S.config.theme).toBe('nord');
    expect(S.config.progress).toEqual({ enabled: true });
    applySaved((c) => setProgress(c, { enabled: false }));
    undo();
    expect(S.config.progress).toEqual({ enabled: false });
  });
});
