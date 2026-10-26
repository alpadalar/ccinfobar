import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../../src/core/config.js';
import { previewHidden, previewHiddenBy, renderPreview } from '../../src/core/preview.js';
import { pickRotationTheme } from '../../src/core/rotation.js';
import { resolveTheme } from '../../src/core/themes.js';
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

  it('tells rule hides from priority drops', () => {
    const items = [
      { id: 'm', type: 'model' },
      { id: 'r', type: 'model', hideWhen: '!git' },
      { id: 'g', type: 'git-branch' },
      { id: 'p', type: 'gsd-phase' },
      { id: 'c', type: 'context-percentage' },
    ];
    const c = normalizeConfig({ lines: [items], overflow: 'priority', widthOffset: 0 });
    const by = withoutSideEffects(() => previewHiddenBy(c, 'sample', 20));
    expect(by.hidden).toContain('r');
    expect(by.dropped).toContain('p');
    expect(by.dropped).not.toContain('r');
    expect(by.dropped.every((id) => by.hidden.includes(id))).toBe(true);
    expect(withoutSideEffects(() => previewHidden(c, 'sample', 20))).toEqual(by.hidden);
    const plain = normalizeConfig({ lines: [[{ id: 'm', type: 'model' }]] });
    expect(withoutSideEffects(() => previewHiddenBy(plain, 'sample', 20))).toEqual({
      hidden: [],
      dropped: [],
    });
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

describe('theme rotation in previews', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const items = [
    { id: 'm', type: 'model' },
    { id: 'c', type: 'context-percentage' },
  ];

  it('renders the rotated theme', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 13, 10, 0));
    const rot = {
      themes: ['dracula', 'powerline', 'nord'],
      every: 'hour' as const,
      order: 'shuffle' as const,
    };
    const c = normalizeConfig({ lines: [items], colorLevel: 3, themeRotation: rot });
    const want = pickRotationTheme(rot, new Date(), () => true)!;
    const plain = normalizeConfig({ lines: [items], colorLevel: 3, theme: want });
    const got = withoutSideEffects(() => renderPreview(c, 'sample', 120));
    expect(got).toEqual(withoutSideEffects(() => renderPreview(plain, 'sample', 120)));
    expect(got).not.toEqual(
      withoutSideEffects(() => renderPreview({ ...plain, theme: 'classic' }, 'sample', 120)),
    );
  });

  it('uses an explicit theme over the rotation', () => {
    const c = normalizeConfig({ lines: [items], colorLevel: 3, themeRotation: { themes: ['dracula'] } });
    const th = resolveTheme('nord');
    const plain = normalizeConfig({ lines: [items], colorLevel: 3 });
    expect(withoutSideEffects(() => renderPreview(c, 'sample', 120, th))).toEqual(
      withoutSideEffects(() => renderPreview(plain, 'sample', 120, th)),
    );
  });
});
