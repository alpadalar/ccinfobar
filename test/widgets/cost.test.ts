import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { getScenario, SCENARIO_NOW, SCENARIOS, scenarioConfig } from '../../src/core/scenarios.js';
import type { Config, RenderContext, WidgetItem } from '../../src/core/types.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { ctxWith, renderWidget, withoutSideEffects } from '../helpers.js';

const COST = ALL_WIDGETS.filter((w) => w.category === 'cost').map((w) => w.type);
const ITEMS: [string, WidgetItem['options']][] = [
  ...COST.map((type): [string, WidgetItem['options']] => [type, {}]),
  ['budget', { period: 'session' }],
];

function scenarioCtx(id: string, config: Partial<Config> = {}): RenderContext {
  const b = getScenario(id)!.build(SCENARIO_NOW);
  return createContext({
    payload: b.payload,
    config: scenarioConfig(
      { ...defaultConfig(), colorLevel: 0, budget: { daily: 10, session: 5 }, ...config },
      b,
    ),
    env: { ...b.env },
    now: new Date(SCENARIO_NOW),
    preview: true,
    data: b.data,
  });
}

const row = (id: string, options: WidgetItem['options'] = {}) =>
  withoutSideEffects(() =>
    ITEMS.map(
      ([type, o]) => renderWidget(type, scenarioCtx(id), { options: { ...o, ...options } }) ?? '-',
    ).join(' | '),
  );

const BEFORE = [
  'fresh-session: $0.00 | - | - | - | - | - | 0s | 0s | +0 -0 | - | ~$0.00/$5',
  'context-full: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'near-5h-limit: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'near-7d-limit: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'many-subagents: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'gsd-project: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'no-git: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'api-key-user: $1.87 | - | - | - | - | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'bedrock-user: $1.87 | - | - | - | - | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'gateway-glm: $1.87 | - | - | - | - | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'over-budget: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$3 | $2.47/h | 45m | 13m | +214 -63 | 86 | -',
  'workspace-folder: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'waiting-permission: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
  'service-incident: $1.87 | $4.12 | $18.40 | $62.00 | ~$4.12/$10 | $2.47/h | 45m | 13m | +214 -63 | 86 | ~$1.87/$5',
];

describe('cost widgets identity', () => {
  it('scenario output is unchanged', () => {
    const out = SCENARIOS.map((s) => `${s.id}: ${row(s.id)}`);
    expect(out).toEqual(BEFORE);
    expect(SCENARIOS.map((s) => `${s.id}: ${row(s.id, { basis: 'payload' })}`)).toEqual(BEFORE);
  });

  it('auto keeps the payload cost without a priced third-party profile', () => {
    const same = BEFORE.filter((l) => !l.startsWith('gateway-glm:'));
    const ids = SCENARIOS.map((s) => s.id).filter((id) => id !== 'gateway-glm');
    expect(ids.map((id) => `${id}: ${row(id, { basis: 'auto' })}`)).toEqual(same);
  });

  it('gateway-glm ledger and budget widgets stay USD from the payload', () => {
    const want = BEFORE.find((l) => l.startsWith('gateway-glm:'))!
      .split(' | ')
      .slice(1);
    expect(row('gateway-glm', { basis: 'auto' }).split(' | ').slice(1)).toEqual(want);
  });
});

const ZAI = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 't' };
const glm = { id: 'glm-5.3', display_name: 'glm-5.3' };
const totals = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 2_000_000,
  cacheWriteTokens: 0,
};

function cost(
  basis: string | undefined,
  env: NodeJS.ProcessEnv,
  opts: {
    config?: Partial<Config>;
    model?: { id?: string; display_name?: string };
    transcript?: Partial<typeof totals> | null;
    payloadTotals?: { total_input_tokens?: number; total_output_tokens?: number };
    decimals?: number;
  } = {},
) {
  const c = ctxWith({
    env,
    config: opts.config,
    payload: {
      model: opts.model ?? glm,
      cost: { total_cost_usd: 1.87 },
      context_window: { ...opts.payloadTotals },
    },
    transcript: () =>
      opts.transcript === null
        ? null
        : ({ ...totals, ...opts.transcript } as ReturnType<RenderContext['data']['transcript']>),
  });
  const options: WidgetItem['options'] = {};
  if (basis) options.basis = basis;
  if (opts.decimals !== undefined) options.decimals = opts.decimals;
  return renderWidget('session-cost', c, { options });
}

describe('session-cost basis', () => {
  it('payload is the default', () => {
    expect(cost(undefined, ZAI)).toBe('$1.87');
    expect(cost('payload', ZAI)).toBe('$1.87');
    expect(cost('bogus', ZAI)).toBe('$1.87');
  });

  it('profile prices the transcript totals', () => {
    expect(cost('profile', ZAI)).toBe('$2.36');
    expect(cost('profile', ZAI, { decimals: 3 })).toBe('$2.360');
  });

  it('cache write falls back to the input price', () => {
    expect(cost('profile', ZAI, { transcript: { cacheWriteTokens: 1_000_000 } })).toBe('$3.76');
  });

  it('falls back to payload token totals', () => {
    const payloadTotals = { total_input_tokens: 1_000_000, total_output_tokens: 100_000 };
    expect(cost('profile', ZAI, { transcript: null, payloadTotals })).toBe('$1.84');
    expect(cost('profile', ZAI, { transcript: null })).toBeNull();
  });

  it('uses the override currency', () => {
    const config: Partial<Config> = {
      profiles: { models: [{ match: 'glm-*', input: 2, output: 8, currency: 'CNY' }] },
    };
    expect(cost('profile', ZAI, { config })).toBe('¥6.80');
    const eur: Partial<Config> = {
      profiles: { models: [{ match: 'glm-*', input: 2, output: 8, currency: 'EUR' }] },
    };
    expect(cost('profile', ZAI, { config: eur })).toBe('€6.80');
    const gbp: Partial<Config> = {
      profiles: { models: [{ match: 'glm-*', input: 2, output: 8, currency: 'GBP' }] },
    };
    expect(cost('profile', ZAI, { config: gbp })).toBe('GBP 6.80');
  });

  it('auto picks the profile only for a priced third-party profile', () => {
    expect(cost('auto', {})).toBe('$1.87');
    expect(cost('auto', ZAI)).toBe('$2.36');
    const other = { ANTHROPIC_BASE_URL: 'https://llm.example.com' };
    expect(cost('auto', other)).toBe('$1.87');
    expect(cost('auto', ZAI, { transcript: null })).toBe('$1.87');
  });

  it('profile without a priced profile is null', () => {
    expect(cost('profile', { ANTHROPIC_BASE_URL: 'https://llm.example.com' })).toBeNull();
    expect(cost('profile', {})).toBeNull();
    expect(cost('profile', ZAI, { config: { profiles: { builtIn: false } } })).toBeNull();
    expect(cost('profile', ZAI, { model: { id: 'claude-opus-5-5' } })).toBeNull();
  });

  it('gateway-glm scenario with auto uses the profile prices', () => {
    const c = scenarioCtx('gateway-glm');
    expect(withoutSideEffects(() => renderWidget('session-cost', c, { options: { basis: 'auto' } }))).toBe(
      '$1.69',
    );
  });
});
