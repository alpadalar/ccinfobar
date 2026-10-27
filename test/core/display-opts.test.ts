import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { needsWidth } from '../../src/core/display-opts.js';
import type { Config, WidgetItem } from '../../src/core/types.js';

const w = (type: string): WidgetItem => ({ id: type, type });

const plain = (): Config => ({
  ...defaultConfig(),
  autoWrap: false,
  lines: [[w('model'), w('cost')]],
});

describe('needsWidth', () => {
  it('is false for a plain layout', () => {
    expect(needsWidth(plain(), 'powerline')).toBe(false);
  });

  it('is true for the default config (autoWrap)', () => {
    expect(needsWidth(defaultConfig(), 'text')).toBe(true);
  });

  it('is false with a numeric maxWidth even with autoWrap', () => {
    expect(needsWidth({ ...defaultConfig(), maxWidth: 80 }, 'tui')).toBe(false);
  });

  it('is true for each trigger alone', () => {
    expect(needsWidth({ ...plain(), overflow: 'truncate' }, 'text')).toBe(true);
    expect(needsWidth({ ...plain(), lines: [[w('model'), w('flex')]] }, 'text')).toBe(true);
    expect(needsWidth({ ...plain(), align: 'right' }, 'text')).toBe(true);
    expect(needsWidth({ ...plain(), lineAlign: [null, 'center'] }, 'text')).toBe(true);
    expect(needsWidth(plain(), 'tui')).toBe(true);
    expect(needsWidth({ ...plain(), lines: [[w('terminal-width')]] }, 'text')).toBe(true);
  });

  it('left align does not trigger', () => {
    expect(needsWidth({ ...plain(), align: 'left', lineAlign: ['left', null] }, 'text')).toBe(false);
  });
});
