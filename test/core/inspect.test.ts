import { describe, expect, it, vi } from 'vitest';
import { sanitize } from '../../src/core/ansi.js';
import { inspectRows, lineReport } from '../../src/core/inspect.js';
import { normalizeResult, renderValue } from '../../src/core/renderer.js';
import { getScenario, SCENARIO_NOW } from '../../src/core/scenarios.js';
import type { RenderContext, WidgetDef, WidgetItem } from '../../src/core/types.js';
import { ALL_WIDGETS, getWidget } from '../../src/widgets/index.js';
import { ctxWith, withoutSideEffects } from '../helpers.js';

const seen: RenderContext[] = [];

vi.mock('../../src/widgets/index.js', async (orig) => {
  const mod = await orig<typeof import('../../src/widgets/index.js')>();
  const extra: Record<string, WidgetDef> = {
    boom: {
      type: 'boom',
      name: 'Boom',
      category: 'custom',
      description: '',
      color: 'white',
      render() {
        throw new Error('bo\u001b[31mom\nsecond');
      },
    },
    probe: {
      type: 'probe',
      name: 'Probe',
      category: 'custom',
      description: '',
      color: 'white',
      render(ctx) {
        seen.push(ctx);
        return 'p';
      },
    },
  };
  return { ...mod, getWidget: (type: string) => extra[type] ?? mod.getWidget(type) };
});

const item = (type: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({ id: type, type, ...extra });
const rowsFor = (ctx: RenderContext) => withoutSideEffects(() => inspectRows(ctx));

describe('inspectRows', () => {
  it('gives one shown row per widget on the default config', () => {
    const ctx = ctxWith();
    const rows = rowsFor(ctx);
    const items = ctx.config.lines.flat();
    expect(rows).toHaveLength(items.length);
    for (const [l, line] of ctx.config.lines.entries()) {
      for (const [i, it] of line.entries()) {
        const r = rows.find((x) => x.line === l && x.index === i)!;
        expect(r.id).toBe(it.id);
        expect(r.type).toBe(it.type);
      }
    }
    for (const r of rows.filter((x) => x.type !== 'flex')) {
      if (r.status === 'shown') {
        expect(typeof r.value).toBe('string');
        expect(r.value).not.toContain('\u001b');
      }
      expect(r.sources).toEqual([]);
    }
    expect(rows.find((r) => r.type === 'model')!.status).toBe('shown');
  });

  it('skips flex', () => {
    const rows = rowsFor(ctxWith({ config: { lines: [[item('model'), item('flex'), item('cwd')]] } }));
    expect(rows[1]).toMatchObject({ status: 'skipped', value: null, empty: null, index: 1 });
  });

  it('marks null results empty or hidden', () => {
    const rows = rowsFor(
      ctxWith({
        git: () => null,
        config: {
          lines: [
            [
              item('git-branch'),
              item('git-changes', { hideEmpty: true }),
              item('text', { options: { text: '' } }),
            ],
          ],
        },
      }),
    );
    expect(rows.map((r) => r.status)).toEqual(['empty', 'hidden', 'hidden']);
    for (const r of rows) {
      expect(r.value).toBeNull();
      expect(r.empty).not.toBeNull();
    }
  });

  it('marks the loading placeholder', () => {
    const b = getScenario('fresh-session')!.build(SCENARIO_NOW);
    const ctx = ctxWith({
      payload: b.payload,
      transcript: b.data.transcript,
      config: { lines: [[item('context-bar')]] },
    });
    const [r] = rowsFor(ctx);
    expect(r).toMatchObject({ status: 'loading', value: 'loading…' });
  });

  it('marks unknown types empty', () => {
    const [r] = rowsFor(ctxWith({ config: { lines: [[item('nope')]] } }));
    expect(r!.status).toBe('empty');
    expect(r!.empty).not.toBeNull();
  });

  it('reports a throwing widget and keeps the others', () => {
    const rows = rowsFor(ctxWith({ config: { lines: [[item('boom'), item('model')]] } }));
    expect(rows[0]).toMatchObject({ status: 'error', error: 'boom', value: null });
    expect(rows[1]!.status).toBe('shown');
  });

  it('gives each widget its own ctx', () => {
    seen.length = 0;
    const ctx = ctxWith({
      config: { lines: [[item('probe'), item('probe'), item('context-graph'), item('cost-graph')]] },
    });
    const rows = rowsFor(ctx);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe(ctx);
    expect(rows[2]!.status).toBe('shown');
    expect(rows[3]!.status).toBe('shown');
  });

  it('runs command widgets with commandEnv', () => {
    const base = ctxWith({
      config: {
        lines: [
          [
            item('command', {
              options: {
                command: 'node -e "process.stdout.write(process.env.CCIB_T || \'none\')"',
                timeout: 5000,
              },
            }),
          ],
        ],
      },
    });
    const ctx = { ...base, cwd: process.cwd(), env: { ...process.env } };
    const [plain] = inspectRows(ctx);
    const [withEnv] = inspectRows(ctx, { commandEnv: { ...process.env, CCIB_T: 'v' } });
    expect(plain!.value).toBe('none');
    expect(withEnv!.value).toBe('v');
  });
});

describe('normalizeResult', () => {
  const def = getWidget('model')!;

  it('drops blank text and sanitizes', () => {
    expect(normalizeResult(def, '  ')).toBeNull();
    expect(normalizeResult(def, null)).toBeNull();
    expect(normalizeResult(def, { text: 'a\u0000\u0007b', color: 'red' })).toEqual({
      text: 'ab',
      color: 'red',
    });
    expect(normalizeResult(def, { text: 'a\u001b[2Jb' })).toEqual({ text: sanitize('a\u001b[2Jb') });
  });

  it('matches renderValue for every widget', () => {
    withoutSideEffects(() => {
      for (const d of ALL_WIDGETS) {
        if (d.type === 'command') continue;
        const it = item(d.type);
        expect(renderValue(ctxWith(), d, it), d.type).toEqual(normalizeResult(d, d.render(ctxWith(), it)));
      }
    });
  });
});

describe('lineReport', () => {
  it('flags a line wider than the max', () => {
    const ctx = ctxWith({ width: 20, config: { autoWrap: false } });
    const [l] = lineReport(ctx);
    expect(l!.cut).toBe(true);
    expect(l!.width).toBeGreaterThan(l!.max!);
  });

  it('is empty for the tui style', () => {
    expect(lineReport(ctxWith({ config: { style: 'tui' } }))).toEqual([]);
  });
});
