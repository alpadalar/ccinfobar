import { describe, expect, it, vi } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import {
  CATEGORY_PRIORITY,
  effectivePriority,
  type LineReport,
  maxLineWidth,
  overflowOf,
  render,
  renderLine,
} from '../../src/core/renderer.js';
import { getScenario, SCENARIO_NOW, SCENARIOS, scenarioConfig } from '../../src/core/scenarios.js';
import type { Config, RenderContext, WidgetDef, WidgetItem } from '../../src/core/types.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, withoutSideEffects } from '../helpers.js';

vi.mock('../../src/widgets/index.js', async (orig) => {
  const mod = await orig<typeof import('../../src/widgets/index.js')>();
  const w: WidgetDef = {
    type: 'w',
    name: 'W',
    category: 'custom',
    description: '',
    color: 'white',
    render: (_ctx, item) => String(item.options?.text ?? ''),
  };
  return { ...mod, getWidget: (type: string) => (type === 'w' ? w : mod.getWidget(type)) };
});

const w = (id: string, text: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({
  id,
  type: 'w',
  options: { text },
  ...extra,
});
const flex = (id: string): WidgetItem => ({ id, type: 'flex' });

const ctxFor = (lines: WidgetItem[][], width: number | null, config: Partial<Config> = {}) =>
  ctxWith({
    width,
    config: {
      widthOffset: 0,
      overflow: 'priority',
      lines,
      ...(width === null ? {} : { maxWidth: width }),
      ...config,
    },
  });

const lines = (items: WidgetItem[], width: number | null, config: Partial<Config> = {}) =>
  withoutSideEffects(() => render(ctxFor([items], width, config)));

const one = (items: WidgetItem[], width: number | null, config: Partial<Config> = {}) => {
  const out = lines(items, width, config);
  expect(out.length).toBeLessThanOrEqual(1);
  return out[0] ?? '';
};

const report = (items: WidgetItem[], width: number, config: Partial<Config> = {}) => {
  const r: LineReport = { dropped: [], width: null };
  const text = withoutSideEffects(() => renderLine(ctxFor([items], width, config), items, 0, undefined, r));
  return { text, ...r };
};

const fullWidth = (items: WidgetItem[], config: Partial<Config> = {}) =>
  visibleWidth(one(items, null, config));

describe('overflowOf', () => {
  it('follows autoWrap when overflow is absent and lets overflow win', () => {
    expect(overflowOf({ autoWrap: true })).toBe('wrap');
    expect(overflowOf({ autoWrap: false })).toBe('truncate');
    expect(overflowOf({ autoWrap: true, overflow: 'truncate' })).toBe('truncate');
    expect(overflowOf({ autoWrap: false, overflow: 'priority' })).toBe('priority');
  });
});

describe('effectivePriority', () => {
  const pr = (type: string, priority?: number) =>
    effectivePriority({ id: type, type, ...(priority === undefined ? {} : { priority }) }, getWidget(type)!);

  it('defaults by category and lets the item override it', () => {
    expect(pr('model')).toBe(70);
    expect(pr('context-percentage')).toBe(70);
    expect(pr('git-branch')).toBe(50);
    expect(pr('gsd-phase')).toBe(30);
    expect(pr('w')).toBe(30);
    expect(pr('gsd-phase', 90)).toBe(90);
    expect(pr('model', 0)).toBe(0);
    expect(CATEGORY_PRIORITY.limits).toBe(70);
    expect(CATEGORY_PRIORITY.cost).toBe(50);
    expect(CATEGORY_PRIORITY.agents).toBe(30);
  });
});

describe('priority overflow', () => {
  const m: WidgetItem = { id: 'm', type: 'model' };
  const g: WidgetItem = { id: 'g', type: 'git-branch' };
  const p: WidgetItem = { id: 'p', type: 'gsd-phase' };
  const c: WidgetItem = { id: 'c', type: 'context-percentage' };

  it('drops by category priority, rightmost on ties, and never the last unit', () => {
    const all = [m, g, p, c];
    const full = fullWidth(all);
    expect(full).toBeGreaterThan(40);
    expect(report(all, full).dropped).toEqual([]);
    expect(report(all, full - 1).dropped).toEqual(['p']);
    expect(report(all, fullWidth([m, g, c])).dropped).toEqual(['p']);
    expect(report(all, fullWidth([m, c])).dropped).toEqual(['p', 'g']);
    expect(report(all, fullWidth([m, c]) - 1).dropped).toEqual(['p', 'g', 'c']);
    const narrow = fullWidth([m]) - 2;
    const tight = report(all, narrow);
    expect(tight.dropped).toEqual(['p', 'g', 'c']);
    expect(visibleWidth(tight.text)).toBe(narrow);
    expect(tight.text.endsWith('…')).toBe(true);
    expect(report(all, 40).dropped[0]).toBe('p');
  });

  it('truncates the single top unit with …', () => {
    const r = report([w('a', 'x'.repeat(30), { priority: 80 }), w('b', 'short')], 20);
    expect(r.dropped).toEqual(['b']);
    expect(r.text.endsWith('…')).toBe(true);
    expect(visibleWidth(r.text)).toBe(20);
  });

  it('keeps an explicit priority 90 over the 70s', () => {
    const hi = { ...p, priority: 90 };
    const r = report([m, g, hi, c], fullWidth([hi]));
    expect(r.dropped).toEqual(['g', 'c', 'm']);
    expect(r.text).toBe(one([hi], null));
  });

  it('drops a merged chain as one unit with the highest member priority', () => {
    const a = w('a', 'aaaaaaaa', { merge: true, priority: 10 });
    const b = w('b', 'bbbbbbbb', { priority: 60 });
    const x = w('x', 'xxxxxxxx', { priority: 40 });
    expect(report([a, b, x], fullWidth([a, b])).dropped).toEqual(['x']);
    const lo = { ...b, priority: 20 };
    const r = report([x, a, lo], fullWidth([x]));
    expect(r.dropped).toEqual(['a', 'b']);
    expect(r.text).toBe('xxxxxxxx');
  });

  it('keeps flex parts and re-spreads the groups', () => {
    const items = [
      w('a', 'left-side'),
      flex('f'),
      w('b', 'drop-me-please', { priority: 5 }),
      w('c', 'right'),
    ];
    const r = report(items, 24);
    expect(r.dropped).toEqual(['b']);
    expect(visibleWidth(r.text)).toBe(24);
    expect(r.text.startsWith('left-side')).toBe(true);
    expect(r.text.endsWith('right')).toBe(true);
  });

  it('recomputes powerline separators', () => {
    const cfg: Partial<Config> = { theme: 'classic', style: 'powerline' };
    const a = w('a', 'alpha');
    const b = w('b', 'beta');
    const z = w('z', 'zzzzzzzzzzzz', { priority: 1 });
    const kept = one([a, b], null, cfg);
    const r = report([a, b, z], visibleWidth(kept), cfg);
    expect(r.dropped).toEqual(['z']);
    expect(r.text).toBe(kept);
  });

  it('drops below-lines with their part and keeps the others', () => {
    const a = 'a'.repeat(12);
    const b = 'b'.repeat(12);
    const items = [w('a', `${a}\nbelow-a`, { priority: 10 }), w('b', `${b}\nbelow-b`, { priority: 60 })];
    const out = lines(items, 20).map(stripAnsi);
    expect(out).toEqual([b, 'below-b']);
    const both = lines(items, 40).map(stripAnsi);
    expect(both).toContain('below-a');
    expect(both).toContain('below-b');
  });

  it('fills the sink only when given one and does not change the output', () => {
    const items = [w('a', 'aaaaaaaaaa'), w('b', 'bbbbbbbbbb', { priority: 10 }), w('c', 'cccccccccc')];
    const r = report(items, 25);
    expect(r).toMatchObject({ dropped: ['b'], width: 25 });
    const ctx = ctxFor([items], 25);
    expect(withoutSideEffects(() => renderLine(ctx, items, 0))).toBe(r.text);
  });

  it('leaves lines that fit alone and keeps wrap and truncate as before', () => {
    const items = [w('a', 'aaaaaaaaaa'), w('b', 'bbbbbbbbbb'), w('c', 'cccccccccc')];
    const fits = fullWidth(items);
    expect(one(items, fits)).toBe(one(items, fits, { overflow: undefined, autoWrap: false }));
    expect(lines(items, 25, { overflow: 'wrap', autoWrap: false })).toEqual(
      lines(items, 25, { overflow: undefined, autoWrap: true }),
    );
    expect(lines(items, 25, { overflow: 'truncate', autoWrap: true })).toEqual(
      lines(items, 25, { overflow: undefined, autoWrap: false }),
    );
    expect(lines(items, 25, { overflow: 'wrap' }).length).toBeGreaterThan(1);
  });

  it('never drops layout items on their own', () => {
    const items = [
      w('a', 'aaaaaaaaaa'),
      { id: 't', type: 'text', options: { text: 'label' } },
      w('b', 'bbbbbbbb'),
    ];
    const r = report(items, 18);
    expect(r.dropped).toEqual(['b']);
    expect(stripAnsi(r.text)).toContain('label');
  });

  // WR-01
  describe('separators and text next to dropped widgets', () => {
    const sep = (id: string): WidgetItem => ({ id, type: 'separator' });
    const txt = (id: string, text: string): WidgetItem => ({ id, type: 'text', options: { text } });
    const a = w('a', 'aaaaaaaa', { priority: 90 });
    const b = w('b', 'bbbbbbbb', { priority: 10 });
    const c = w('c', 'cccccccc', { priority: 5 });
    const plain = (items: WidgetItem[], width: number, config: Partial<Config> = {}) => {
      const r = report(items, width, config);
      return { ...r, text: stripAnsi(r.text) };
    };
    const cfg: Partial<Config> = { theme: 'classic' };
    const sepText = stripAnsi(one([sep('x')], null, cfg)).trim();

    it('drops the separator before a dropped widget at the end', () => {
      const items = [a, sep('s1'), b, sep('s2'), c];
      const r = plain(items, fullWidth([a, sep('s1'), b], cfg), cfg);
      expect(r.dropped).toEqual(['c', 's2']);
      expect(r.text).toBe(stripAnsi(one([a, sep('s1'), b], null, cfg)));
      const two = plain(items, fullWidth([a], cfg) + 2, cfg);
      expect(two.dropped).toEqual(['c', 'b', 's1', 's2']);
      expect(two.text.trim()).toBe('aaaaaaaa');
    });

    it('keeps one gap of separators when a middle widget drops', () => {
      const items = [a, sep('s1'), b, sep('s2'), w('d', 'dddddddd', { priority: 80 })];
      const keep = [a, sep('s1'), w('d', 'dddddddd', { priority: 80 })];
      const r = plain(items, fullWidth(keep, cfg), cfg);
      expect(r.dropped).toEqual(['b', 's2']);
      expect(r.text).toBe(stripAnsi(one(keep, null, cfg)));
      expect(r.text.split(sepText)).toHaveLength(2);
    });

    it('never leaves a separator at a group start', () => {
      const lead = w('l', 'llllllll', { priority: 1 });
      const items = [lead, sep('s1'), a, sep('s2'), w('d', 'dddddddd', { priority: 80 })];
      const keep = [a, sep('s2'), w('d', 'dddddddd', { priority: 80 })];
      const r = plain(items, fullWidth(keep, cfg), cfg);
      expect(r.dropped).toEqual(['l', 's1']);
      expect(r.text).toBe(stripAnsi(one(keep, null, cfg)));
    });

    it('keeps separators that were already at an edge or doubled', () => {
      const items = [sep('e1'), a, sep('s1'), sep('s2'), b, sep('s3'), c, sep('e2')];
      const keep = [sep('e1'), a, sep('s1'), sep('s2'), b, sep('e2')];
      const r = plain(items, fullWidth(keep, cfg), cfg);
      expect(r.dropped).toEqual(['c', 's3']);
      expect(r.text).toBe(stripAnsi(one(keep, null, cfg)));
    });

    it('drops a text item with the widget before it, or after it at a group start', () => {
      const items = [
        txt('t0', 'Label:'),
        b,
        a,
        txt('t1', '!'),
        flex('f'),
        txt('t2', 'Cost'),
        c,
        w('d', 'dddd'),
      ];
      const r = plain(
        items,
        fullWidth([txt('t0', 'Label:'), b, a, txt('t1', '!'), flex('f'), w('d', 'dddd')]),
      );
      expect(r.dropped).toEqual(['t2', 'c']);
      expect(r.text.startsWith('Label:')).toBe(true);
      const tight = plain(items, fullWidth([a, txt('t1', '!'), flex('f'), w('d', 'dddd')]));
      expect(tight.dropped).toEqual(['t2', 'c', 't0', 'b']);
      expect(tight.text).toContain('aaaaaaaa │ !');
    });

    it('never renders wider than the width', () => {
      const items = [
        sep('e'),
        a,
        sep('s1'),
        txt('t', 'x'),
        b,
        flex('f'),
        sep('s2'),
        c,
        sep('s3'),
        w('d', 'dd'),
      ];
      for (let width = 4; width <= fullWidth(items, cfg) + 2; width++)
        expect(visibleWidth(report(items, width, cfg).text)).toBeLessThanOrEqual(width);
    });
  });

  it('leaves the tui style to the panel', () => {
    const items = [m, g, p, c];
    const tui = (overflow: Config['overflow']) => lines(items, 30, { style: 'tui', overflow });
    expect(tui('priority')).toEqual(tui(undefined));
  });
});

describe('width sweep', () => {
  const sweep = (id: string, style: Config['style']) => {
    const b = getScenario(id)!.build(SCENARIO_NOW);
    for (let width = 20; width <= 200; width += 7) {
      const ctx: RenderContext = createContext({
        payload: b.payload,
        config: scenarioConfig({ ...defaultConfig(), colorLevel: 0, overflow: 'priority', style }, b),
        env: { ...b.env },
        now: new Date(SCENARIO_NOW),
        preview: true,
        terminalWidth: width,
        data: b.data,
      });
      const max = maxLineWidth(ctx)!;
      for (const line of withoutSideEffects(() => render(ctx))) {
        expect(visibleWidth(line), `${id} ${style} ${width}`).toBeLessThanOrEqual(max);
      }
    }
  };

  it.each(SCENARIOS.map((s) => s.id))('%s never renders a line wider than the max', (id) => {
    sweep(id, 'text');
    sweep(id, 'powerline');
  });
});
