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
  it('implicit truncate needs a width (D-03)', () => {
    expect(needsWidth(plain())).toBe(true);
  });

  it('is true for the default config (autoWrap)', () => {
    expect(needsWidth(defaultConfig())).toBe(true);
  });

  it('is false with a numeric maxWidth even with autoWrap', () => {
    expect(needsWidth({ ...defaultConfig(), maxWidth: 80 })).toBe(false);
    expect(needsWidth({ ...plain(), maxWidth: 80 })).toBe(false);
  });

  it('is true for each trigger alone', () => {
    expect(needsWidth({ ...plain(), overflow: 'truncate' })).toBe(true);
    expect(needsWidth({ ...plain(), lines: [[w('model'), w('flex')]] })).toBe(true);
    expect(needsWidth({ ...plain(), align: 'right' })).toBe(true);
    expect(needsWidth({ ...plain(), lineAlign: [null, 'center'] })).toBe(true);
    expect(needsWidth(plain())).toBe(true);
    expect(needsWidth({ ...plain(), lines: [[w('terminal-width')]] })).toBe(true);
  });

  it('left align changes nothing', () => {
    expect(needsWidth({ ...plain(), align: 'left', lineAlign: ['left', null] })).toBe(true);
  });
});
