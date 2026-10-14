import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import { sampleLedger } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW, SCENARIOS } from '../../src/core/scenarios.js';
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
