import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import { sampleLedger } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW, SCENARIOS } from '../../src/core/scenarios.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget, withoutSideEffects } from '../helpers.js';

const view = (today: number) => () => ({ ...sampleLedger(NOW.getTime()), today });

describe('cost-today', () => {
  it('shows the ledger total for today', () => {
    expect(renderWidget('cost-today', ctxWith({ ledger: view(4.12) }))).toBe('$4.12');
    expect(renderWidget('cost-today', ctxWith({ ledger: view(4.12) }), { options: { decimals: 0 } })).toBe(
      '$4',
    );
  });

  it('renders with its estimated label', () => {
    const lines = [[{ id: 'c', type: 'cost-today' }]];
    const out = withoutSideEffects(() =>
      render(ctxWith({ ledger: view(4.12), config: { ...defaultConfig(), colorLevel: 0, lines } })),
    );
    expect(stripAnsi(out[0] ?? '')).toContain('Today ~$4.12');
  });

  it('is empty without a ledger', () => {
    expect(renderWidget('cost-today', ctxWith({ ledger: () => null }))).toBeNull();
    const ctx = createContext({
      payload: {},
      config: { ...defaultConfig(), colorLevel: 0 },
      env: {},
      now: NOW,
    });
    expect(renderWidget('cost-today', ctx)).toBeNull();
  });

  it('follows each scenario', () => {
    const today = (id: string) => getScenario(id)!.build(SCENARIO_NOW).data.ledger()?.today ?? null;
    expect(today('context-full')).toBe(4.12);
    expect(today('fresh-session')).toBeNull();
    expect(today('api-key-user')).toBeNull();
    for (const s of SCENARIOS) {
      const b = s.build(SCENARIO_NOW);
      const ctx = createContext({
        payload: b.payload,
        config: { ...defaultConfig(), colorLevel: 0 },
        env: b.env,
        now: new Date(SCENARIO_NOW),
        data: b.data,
      });
      expect(() => renderWidget('cost-today', ctx), s.id).not.toThrow();
    }
  });
});

const sample = () => sampleLedger(NOW.getTime());

describe('cost-week', () => {
  it('shows the ledger total for this ISO week', () => {
    expect(renderWidget('cost-week', ctxWith())).toBe('$18.40');
    expect(renderWidget('cost-week', ctxWith(), { options: { decimals: 1 } })).toBe('$18.4');
  });

  it('renders with its estimated label', () => {
    const lines = [[{ id: 'w', type: 'cost-week' }]];
    const out = withoutSideEffects(() =>
      render(ctxWith({ config: { ...defaultConfig(), colorLevel: 0, lines } })),
    );
    expect(stripAnsi(out[0] ?? '')).toContain('Week ~$18.40');
  });

  it('is empty without a ledger', () => {
    expect(renderWidget('cost-week', ctxWith({ ledger: () => null }))).toBeNull();
  });
});

describe('cost-project', () => {
  const ledger = () => ({ ...sample(), project: { today: 1.5, week: 7.25, month: 30, all: 62 } });

  it('defaults to the project total since the ledger started', () => {
    expect(renderWidget('cost-project', ctxWith())).toBe('$62.00');
    expect(renderWidget('cost-project', ctxWith({ ledger }))).toBe('$62.00');
  });

  it('follows the period option', () => {
    const at = (period: string) => renderWidget('cost-project', ctxWith({ ledger }), { options: { period } });
    expect(at('today')).toBe('$1.50');
    expect(at('week')).toBe('$7.25');
    expect(at('month')).toBe('$30.00');
    expect(at('all')).toBe('$62.00');
    expect(at('decade')).toBe('$62.00');
  });

  it('honours decimals', () => {
    expect(
      renderWidget('cost-project', ctxWith({ ledger }), { options: { decimals: 0, period: 'week' } }),
    ).toBe('$7');
  });

  it('renders with its estimated label', () => {
    const lines = [[{ id: 'p', type: 'cost-project' }]];
    const out = withoutSideEffects(() =>
      render(ctxWith({ config: { ...defaultConfig(), colorLevel: 0, lines } })),
    );
    expect(stripAnsi(out[0] ?? '')).toContain('Project ~$62.00');
  });

  it('is empty without a ledger', () => {
    expect(renderWidget('cost-project', ctxWith({ ledger: () => null }))).toBeNull();
  });
});

describe('ledger widget descriptions', () => {
  it('say the numbers are estimated', () => {
    for (const type of ['cost-today', 'cost-week', 'cost-project'])
      expect(getWidget(type)?.description, type).toMatch(/^Estimated/);
  });
});

describe('ledger still being built', () => {
  it('marks the totals with an ellipsis', () => {
    const ledger = () => ({ ...sampleLedger(NOW.getTime()), partial: true });
    expect(renderWidget('cost-today', ctxWith({ ledger }))).toBe('$4.12…');
    expect(renderWidget('cost-week', ctxWith({ ledger }))).toBe('$18.40…');
    expect(renderWidget('cost-project', ctxWith({ ledger }))).toBe('$62.00…');
  });
});
