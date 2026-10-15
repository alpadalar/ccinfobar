import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { inspectRows } from '../../src/core/inspect.js';
import { getScenario, SCENARIO_NOW, type ScenarioBundle, scenarioConfig } from '../../src/core/scenarios.js';
import type { Config, RenderContext, StatusPayload } from '../../src/core/types.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { renderWidget, withoutSideEffects } from '../helpers.js';

const EXTRA = ['usage-pace', 'usage-projection', 'limit-eta', 'limit-risk'];
const TYPES = [
  ...new Set([
    ...ALL_WIDGETS.filter((w) => w.category === 'limits').map((w) => w.type),
    ...ALL_WIDGETS.filter((w) => EXTRA.includes(w.type)).map((w) => w.type),
  ]),
];
const NO_PLAN = ['api-key-user', 'bedrock-user', 'gateway-glm'];
const LOADING = 'still loading';
const SEC = Math.floor(SCENARIO_NOW / 1000);

function bundle(id: string, edit?: (b: ScenarioBundle) => void): ScenarioBundle {
  const b = getScenario(id)!.build(SCENARIO_NOW);
  edit?.(b);
  return b;
}

function ctxOf(b: ScenarioBundle, config: Partial<Config> = {}): RenderContext {
  return createContext({
    payload: b.payload,
    config: scenarioConfig({ ...defaultConfig(), colorLevel: 0, loadingText: LOADING, ...config }, b),
    env: { ...b.env },
    now: new Date(SCENARIO_NOW),
    preview: true,
    data: b.data,
  });
}

const render = (b: ScenarioBundle, type: string) => withoutSideEffects(() => renderWidget(type, ctxOf(b)));

// a session before the first reply, where first-party sessions show the loading text
function fresh(id: string): ScenarioBundle {
  const env = bundle(id).env;
  return bundle('fresh-session', (b) => {
    b.env = env;
    delete b.payload.rate_limits;
  });
}

describe('plan-limit widgets for providers without plan limits (EXT-05)', () => {
  it('covers every limits widget plus pace and projections from the registry', () => {
    expect(TYPES.length).toBeGreaterThanOrEqual(12);
    for (const type of EXTRA) expect(TYPES, type).toContain(type);
    for (const type of ['five-hour-usage', 'weekly-reset', 'spend-limit']) expect(TYPES).toContain(type);
  });

  it.each(NO_PLAN)('%s: every widget is null without rate_limits', (id) => {
    const b = bundle(id);
    expect(b.payload.rate_limits).toBeUndefined();
    for (const type of TYPES) expect(render(b, type), `${id} ${type}`).toBeNull();
  });

  it.each(NO_PLAN)('%s: never shows the loading text in a fresh session', (id) => {
    const b = fresh(id);
    for (const type of TYPES) {
      const out = render(b, type);
      expect(out, `${id} ${type}`).toBeNull();
      expect(out).not.toBe(t('loading.default'));
    }
  });

  it('first party in a fresh session still shows the loading text', () => {
    expect(render(bundle('fresh-session'), 'five-hour-usage')).toBe(LOADING);
  });

  it.each(NO_PLAN)('%s: explain says the provider has no plan limits', (id) => {
    const b = bundle(id);
    const lines = TYPES.map((type) => [{ id: type, type }]);
    const rows = withoutSideEffects(() => inspectRows(ctxOf(b, { lines })));
    expect(rows).toHaveLength(TYPES.length);
    for (const row of rows) expect(row.empty?.code, `${id} ${row.type}`).toBe('provider-no-plan-limits');
  });

  it('gateway-glm with payload rate_limits still shows them (payload wins)', () => {
    const rate_limits: NonNullable<StatusPayload['rate_limits']> = {
      five_hour: { used_percentage: 42, resets_at: SEC + 2 * 3600 },
      seven_day: { used_percentage: 61, resets_at: SEC + 86_400 },
    };
    const b = bundle('gateway-glm', (x) => {
      x.payload.rate_limits = rate_limits;
    });
    expect(render(b, 'five-hour-usage')).toBe('42%');
    expect(render(b, 'weekly-usage')).toBe('61%');
    expect(render(b, 'five-hour-reset')).toMatch(/^2h/);
    expect(render(b, 'weekly-reset')).toMatch(/^1d/);
    expect(render(b, 'usage-pace')).not.toBeNull();
    for (const type of TYPES) expect(render(b, type), type).not.toBe(LOADING);
  });

  it('gateway-glm with a payload spend_limit shows the spend widget', () => {
    const b = bundle('gateway-glm', (x) => {
      x.payload.rate_limits = { spend_limit: { used_usd: 12, limit_usd: 50 } };
    });
    expect(render(b, 'spend-limit')).toBe('$12/$50');
    for (const type of TYPES) expect(render(b, type), type).not.toBe(LOADING);
  });
});
