import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../src/core/config.js';
import { previewHidden, renderPreview } from '../../src/core/preview.js';
import { withoutSideEffects } from '../helpers.js';

const config = (items: Record<string, unknown>[]) => normalizeConfig({ lines: [items] });

describe('previewHidden', () => {
  it('returns the ids a rule hides', () => {
    const c = config([
      { id: 'g1', type: 'model', hideWhen: '!git' },
      { id: 'm2', type: 'model' },
      { id: 'c3', type: 'model', showWhen: 'context.pct >= 0' },
    ]);
    expect(withoutSideEffects(() => previewHidden(c, 'sample', 120))).toEqual(['g1']);
  });

  it('returns nothing without rules', () => {
    const c = config([
      { id: 'a', type: 'model' },
      { id: 'b', type: 'context-percentage' },
    ]);
    expect(withoutSideEffects(() => previewHidden(c, 'sample', 120))).toEqual([]);
  });

  it('returns the ids dropped by priority overflow', () => {
    const items = [
      { id: 'm', type: 'model' },
      { id: 'g', type: 'git-branch' },
      { id: 'p', type: 'gsd-phase' },
      { id: 'c', type: 'context-percentage' },
    ];
    const c = normalizeConfig({ lines: [items], overflow: 'priority', widthOffset: 0 });
    const hidden = withoutSideEffects(() => previewHidden(c, 'sample', 20));
    expect(hidden).toContain('p');
    expect(hidden).not.toContain('m');
    expect(withoutSideEffects(() => previewHidden({ ...c, overflow: 'wrap' }, 'sample', 20))).toEqual([]);
  });

  it('works for scenarios and leaves the lines alone', () => {
    const c = config([
      { id: 'x', type: 'model', hideWhen: 'context.pct >= 50' },
      { id: 'y', type: 'model' },
    ]);
    const src = { scenario: 'context-full' };
    const before = withoutSideEffects(() => renderPreview(c, src, 120));
    expect(withoutSideEffects(() => previewHidden(c, src, 120))).toEqual(['x']);
    expect(withoutSideEffects(() => renderPreview(c, src, 120))).toEqual(before);
  });
});
