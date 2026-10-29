import { describe, expect, it } from 'vitest';
import { render } from '../../src/core/renderer.js';
import type { RenderContext, WidgetItem } from '../../src/core/types.js';
import { ALL_WIDGETS, getWidget } from '../../src/widgets/index.js';
import { ctxWith, renderWidget, withLang } from '../helpers.js';

type Src = NonNullable<RenderContext['data']['sandbox']>;
const run = (sandbox: Src, options: WidgetItem['options'] = {}) =>
  renderWidget('sandbox', ctxWith({ sandbox }), { options });

describe('sandbox widget', () => {
  it('shows the chip when enabled', () => {
    expect(run(() => ({ enabled: true, strict: false }))).toBe('sandbox');
  });

  it('marks strict only with showStrict', () => {
    const s: Src = () => ({ enabled: true, strict: true });
    expect(run(s)).toBe('sandbox');
    expect(run(s, { showStrict: true })).toBe('sandbox strict');
  });

  it('hides when off unless showOff', () => {
    const s: Src = () => ({ enabled: false, strict: false });
    expect(run(s)).toBeNull();
    expect(run(s, { showOff: true })).toBe('sandbox off');
  });

  it('returns null without data and never throws', () => {
    expect(run(() => null)).toBeNull();
    const ctx = ctxWith();
    delete (ctx.data as { sandbox?: unknown }).sandbox;
    expect(renderWidget('sandbox', ctx)).toBeNull();
    const bad: Src = () => {
      throw new Error('x');
    };
    expect(() => run(bad)).not.toThrow();
    expect(run(bad)).toBeNull();
  });

  it('leaves no label or dash in a line when empty', () => {
    const ctx = ctxWith({
      sandbox: () => null,
      config: {
        lines: [
          [
            { id: 'a', type: 'sandbox' },
            { id: 'b', type: 'model' },
          ],
        ],
      },
    });
    const out = render(ctx).join('\n');
    expect(out).not.toContain('sandbox');
    expect(out).not.toContain('—');
  });

  it('translates to Turkish', () => {
    withLang('tr', () => {
      expect(run(() => ({ enabled: true, strict: false }))).toBe('sandbox');
      expect(run(() => ({ enabled: false, strict: false }), { showOff: true })).toBe('sandbox kapalı');
      expect(run(() => ({ enabled: true, strict: true }), { showStrict: true })).toBe('sandbox katı');
    });
  });

  it('is a session widget with boolean options', () => {
    const def = ALL_WIDGETS.find((w) => w.type === 'sandbox')!;
    expect(def.category).toBe('session');
    expect(def.hideWhenEmpty).toBe(true);
    expect(def.options?.map((o) => [o.key, o.kind, o.default])).toEqual([
      ['hideOff', 'boolean', true],
      ['showStrict', 'boolean', false],
    ]);
    expect(getWidget('sandbox')?.sample).toBe('sandbox');
  });
});
