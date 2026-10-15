import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../../src/core/config.js';
import { lineReport } from '../../src/core/inspect.js';
import { previewHiddenBy, renderPreview, renderPreviewReport } from '../../src/core/preview.js';
import type { WidgetDef } from '../../src/core/types.js';
import { ctxWith, withoutSideEffects } from '../helpers.js';

const calls = new Map<string, number>();

vi.mock('../../src/widgets/index.js', async (orig) => {
  const mod = await orig<typeof import('../../src/widgets/index.js')>();
  const w: WidgetDef = {
    type: 'counted',
    name: 'Counted',
    category: 'custom',
    description: '',
    color: 'white',
    render: (_ctx, item) => {
      calls.set(item.id, (calls.get(item.id) ?? 0) + 1);
      return String(item.options?.text ?? '');
    },
  };
  return { ...mod, getWidget: (type: string) => (type === 'counted' ? w : mod.getWidget(type)) };
});

const item = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'counted',
  options: { text },
  ...extra,
});

// WR-08: a preview renders each widget once, even with rules and priority overflow
describe('one render per preview', () => {
  const config = normalizeConfig({
    overflow: 'priority',
    widthOffset: 0,
    lines: [
      [
        item('a', 'a'.repeat(12), { priority: 90 }),
        item('h', 'hidden', { hideWhen: 'context.pct >= 0' }),
        item('b', 'b'.repeat(12), { priority: 10 }),
        item('c', 'c'.repeat(12), { priority: 50 }),
      ],
    ],
  });

  it('reports hidden and dropped ids from the same render', () => {
    calls.clear();
    const r = withoutSideEffects(() => renderPreviewReport(config, 'sample', 30));
    expect(r.hidden).toEqual(['h', 'b']);
    expect(r.dropped).toEqual(['b']);
    expect(r.lines.join('')).toContain('a'.repeat(12));
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
    expect(calls.has('h')).toBe(false);
    expect(withoutSideEffects(() => previewHiddenBy(config, 'sample', 30))).toEqual({
      hidden: r.hidden,
      dropped: r.dropped,
    });
    calls.clear();
    expect(withoutSideEffects(() => renderPreview(config, 'sample', 30))).toEqual(r.lines);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
  });

  it('lineReport renders each widget once per line', () => {
    calls.clear();
    const rows = withoutSideEffects(() => lineReport(ctxWith({ config: { ...config, maxWidth: 30 } })));
    expect(rows[0]).toMatchObject({ dropped: ['b'], max: 30, cut: false });
    expect(rows[0]!.width).toBeGreaterThan(30);
    expect([...calls.values()].every((n) => n === 1)).toBe(true);
  });
});
