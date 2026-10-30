import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { normalizeConfig } from '../../src/core/config.js';
import { renderPreview } from '../../src/core/preview.js';
import { withoutSideEffects } from '../helpers.js';

describe('sample preview clock', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds the context time from the same clock as the sample data', () => {
    const past = Math.floor((Date.now() - 10 * 86_400_000) / 1000) * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(past);
    const config = normalizeConfig({ lines: [[{ id: 'a', type: 'five-hour-reset' }]] });
    const out = withoutSideEffects(() => renderPreview(config, 'sample', 120).map(stripAnsi).join('\n'));
    expect(out).toContain('2h 14m');
  });
});
