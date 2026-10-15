import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { sampleTranscript } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW, SCENARIOS, scenarioConfig } from '../../src/core/scenarios.js';
import type { Config, RenderContext, StatusPayload, WidgetItem } from '../../src/core/types.js';
import { contextPercent, contextTokens, windowFromPayload, windowSize } from '../../src/widgets/context.js';
import { ctxWith, NOW, renderWidget, withoutSideEffects } from '../helpers.js';

const payload = (size: number, used: number, usedPct?: number): StatusPayload => ({
  context_window: {
    context_window_size: size,
    used_percentage: usedPct ?? Math.round((used / size) * 100),
    current_usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

const pct = (
  size: number,
  used: number,
  options: WidgetItem['options'],
  env: NodeJS.ProcessEnv = {},
  usedPct?: number,
) => renderWidget('context-percentage', ctxWith({ payload: payload(size, used, usedPct), env }), { options });

describe('context basis', () => {
  const cases: [string, number, number, WidgetItem['options'], NodeJS.ProcessEnv, string][] = [
    ['usable on 200K', 200_000, 100_000, { basis: 'usable' }, {}, '60%'],
    ['legacy usable on 200K', 200_000, 100_000, { usable: true }, {}, '60%'],
    ['legacy usable string', 200_000, 100_000, { usable: 'true' }, {}, '60%'],
    ['usable on 1M', 1_000_000, 483_500, { basis: 'usable' }, {}, '50%'],
    [
      'auto-compact window',
      200_000,
      58_500,
      { basis: 'usable' },
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' },
      '50%',
    ],
    [
      'auto-compact window above size',
      200_000,
      83_500,
      { basis: 'usable' },
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' },
      '50%',
    ],
    [
      'small output cap',
      200_000,
      89_500,
      { basis: 'usable' },
      { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' },
      '50%',
    ],
    [
      'large output cap',
      200_000,
      83_500,
      { basis: 'usable' },
      { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' },
      '50%',
    ],
    ['bad output cap', 200_000, 83_500, { basis: 'usable' }, { CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'abc' }, '50%'],
    [
      'both env vars',
      200_000,
      64_500,
      { basis: 'usable' },
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' },
      '50%',
    ],
    ['reserve default', 200_000, 90_000, { basis: 'reserve' }, {}, '50%'],
    ['reserve 50000', 200_000, 90_000, { basis: 'reserve', reserveTokens: 50_000 }, {}, '60%'],
    ['reserve clamps high', 200_000, 190_000, { basis: 'reserve' }, {}, '100%'],
    ['reserveTokens above size', 200_000, 10, { basis: 'reserve', reserveTokens: 300_000 }, {}, '100%'],
    ['negative reserveTokens', 200_000, 90_000, { basis: 'reserve', reserveTokens: -5 }, {}, '45%'],
    ['basis wins over usable', 200_000, 100_000, { basis: 'raw', usable: true }, {}, '50%'],
    ['unknown basis', 200_000, 100_000, { basis: 'bogus' }, {}, '50%'],
    ['unknown basis with usable', 200_000, 100_000, { basis: 'bogus', usable: true }, {}, '60%'],
    ['usable false', 200_000, 100_000, { usable: false }, {}, '50%'],
    [
      'remaining with reserve',
      200_000,
      90_000,
      { basis: 'reserve', reserveTokens: 50_000, mode: 'remaining' },
      {},
      '40%',
    ],
  ];
  it.each(cases)('%s', (_n, size, used, options, env, want) => {
    expect(pct(size, used, options, env)).toBe(want);
  });

  it('raw uses used_percentage', () => {
    expect(pct(200_000, 100_000, { basis: 'raw' }, {}, 34)).toBe('34%');
    expect(pct(200_000, 100_000, {}, {}, 34)).toBe('34%');
  });

  it('default sample output is unchanged', () => {
    expect(renderWidget('context-percentage', ctxWith())).toBe('34%');
    expect(renderWidget('context-bar', ctxWith())).toBe('███░░░░░░░ 34%');
  });

  it('context-bar follows basis', () => {
    const ctx = ctxWith({ payload: payload(200_000, 90_000) });
    expect(renderWidget('context-bar', ctx, { options: { basis: 'reserve' } })).toBe('█████░░░░░ 50%');
    expect(renderWidget('context-bar', ctx, { options: { usable: true } })).toBe('█████░░░░░ 54%');
  });

  it('usable without a window falls back to raw', () => {
    const ctx = ctxWith({
      payload: { context_window: { used_percentage: 12 } },
      transcript: () => null,
    });
    expect(renderWidget('context-percentage', ctx, { options: { basis: 'reserve' } })).toBe('12%');
  });
});

const ITEMS: [string, WidgetItem['options']][] = [
  ['context-percentage', {}],
  ['context-percentage', { basis: 'usable' }],
  ['context-percentage', { basis: 'reserve' }],
  ['context-bar', {}],
  ['context-length', { showMax: true }],
  ['context-window-size', {}],
];

function scenarioCtx(id: string, env?: NodeJS.ProcessEnv): RenderContext {
  const b = getScenario(id)!.build(SCENARIO_NOW);
  return createContext({
    payload: b.payload,
    config: scenarioConfig({ ...defaultConfig(), colorLevel: 0 }, b),
    env: env ?? { ...b.env },
    now: new Date(SCENARIO_NOW),
    preview: true,
    data: b.data,
  });
}

const row = (ctx: () => RenderContext) =>
  withoutSideEffects(() =>
    ITEMS.map(([type, options]) => renderWidget(type, ctx(), { options }) ?? '-').join(' | '),
  );

describe('context window identity', () => {
  it('scenario output is unchanged', () => {
    const out = SCENARIOS.map((s) => `${s.id}: ${row(() => scenarioCtx(s.id))}`);
    expect(out).toEqual([
      'fresh-session: loading… | loading… | loading… | loading… | loading… | 200k',
      'context-full: 94% | 100% | 100% | █████████░ 94% | 188k/200k | 200k',
      'near-5h-limit: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'near-7d-limit: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'many-subagents: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'gsd-project: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'no-git: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'api-key-user: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'bedrock-user: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'gateway-glm: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'over-budget: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'workspace-folder: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'waiting-permission: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'service-incident: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
    ]);
  });

  it('fallback windows are unchanged', () => {
    const t = () => sampleTranscript(NOW.getTime());
    const cases: [string, StatusPayload][] = [
      ['no size', { model: { id: 'claude-opus-5-5' }, context_window: { used_percentage: 12 } }],
      ['1m id', { model: { id: 'claude-opus-5-5[1m]' }, context_window: { used_percentage: 12 } }],
      ['exceeds', { model: { id: 'x' }, exceeds_200k_tokens: true }],
      ['no model', { context_window: { used_percentage: 12 } }],
    ];
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { ANTHROPIC_API_KEY: 'k' },
      { CLAUDE_CODE_USE_BEDROCK: '1' },
      { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '983616' },
    ];
    const out = cases.flatMap(([n, payload]) =>
      envs.map((env, i) => `${n} ${i}: ${row(() => ctxWith({ payload, env, transcript: t }))}`),
    );
    expect(out).toEqual([
      'no size 0: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      'no size 1: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      'no size 2: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      'no size 3: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      '1m id 0: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      '1m id 1: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      '1m id 2: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      '1m id 3: 12% | 12% | 12% | █░░░░░░░░░ 12% | 120k/1M | 1M',
      'exceeds 0: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'exceeds 1: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'exceeds 2: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'exceeds 3: 34% | 35% | 35% | ███░░░░░░░ 34% | 340k/1M | 1M',
      'no model 0: 12% | 12% | 12% | █░░░░░░░░░ 12% | 340k | -',
      'no model 1: 12% | 12% | 12% | █░░░░░░░░░ 12% | 340k | -',
      'no model 2: 12% | 12% | 12% | █░░░░░░░░░ 12% | 340k | -',
      'no model 3: 12% | 12% | 12% | █░░░░░░░░░ 12% | 340k | -',
    ]);
  });
});

describe('gateway context window (D-48)', () => {
  const ZAI = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 't' };
  const glm = (size: number | undefined, used: number, usedPct = 100): StatusPayload => ({
    model: { id: 'glm-5.3', display_name: 'glm-5.3' },
    context_window: {
      ...(size ? { context_window_size: size } : {}),
      used_percentage: usedPct,
      remaining_percentage: 100 - usedPct,
      current_usage: { input_tokens: used, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  const ctx = (payload: StatusPayload, env: NodeJS.ProcessEnv = ZAI, config: Partial<Config> = {}) =>
    ctxWith({ payload, env, config, transcript: () => null });

  it('uses the profile window over the 200K default and recomputes', () => {
    const c = ctx(glm(200_000, 300_000));
    expect(windowSize(c)).toBe(1_000_000);
    expect(windowFromPayload(c)).toBe(false);
    expect(contextPercent(c, 'raw')).toBe(30);
    expect(renderWidget('context-percentage', c)).toBe('30%');
    expect(renderWidget('context-percentage', c, { options: { mode: 'remaining' } })).toBe('70%');
    expect(renderWidget('context-window-size', c)).toBe('1M');
    expect(renderWidget('context-length', c, { options: { showMax: true } })).toBe('300k/1M');
  });

  it('CLAUDE_CODE_MAX_CONTEXT_TOKENS wins', () => {
    const c = ctx(glm(200_000, 300_000), { ...ZAI, CLAUDE_CODE_MAX_CONTEXT_TOKENS: '983616' });
    expect(windowSize(c)).toBe(983_616);
    expect(renderWidget('context-percentage', c)).toBe('30%');
    for (const bad of ['0', '-5', 'abc', 'Infinity', '']) {
      const b = ctx(glm(200_000, 300_000), { ...ZAI, CLAUDE_CODE_MAX_CONTEXT_TOKENS: bad });
      expect(windowSize(b)).toBe(1_000_000);
    }
  });

  it('keeps a payload size that is not the 200K default', () => {
    const c = ctx(glm(500_000, 300_000, 60));
    expect(windowSize(c)).toBe(500_000);
    expect(windowFromPayload(c)).toBe(true);
    expect(renderWidget('context-percentage', c)).toBe('60%');
  });

  it('builtIn false keeps the payload size', () => {
    const c = ctx(glm(200_000, 150_000, 75), ZAI, { profiles: { builtIn: false } });
    expect(windowSize(c)).toBe(200_000);
    expect(renderWidget('context-percentage', c)).toBe('75%');
  });

  it('usable and reserve use the new window', () => {
    const c = ctx(glm(200_000, 483_500));
    expect(renderWidget('context-percentage', c, { options: { basis: 'usable' } })).toBe('50%');
    expect(renderWidget('context-percentage', c, { options: { basis: 'reserve' } })).toBe('49%');
    expect(renderWidget('context-bar', c, { options: { basis: 'usable' } })).toBe('█████░░░░░ 50%');
  });

  it('a user override window applies with no payload size', () => {
    const payload: StatusPayload = {
      model: { id: 'my-model' },
      context_window: { current_usage: { input_tokens: 100_000 } },
    };
    const env = { ANTHROPIC_BASE_URL: 'https://llm.example.com' };
    const c = ctx(payload, env, { profiles: { models: [{ match: 'my-*', contextWindow: 400_000 }] } });
    expect(windowSize(c)).toBe(400_000);
    expect(renderWidget('context-percentage', c)).toBe('25%');
  });

  it('first party ignores the env and overrides', () => {
    const payload = glm(200_000, 100_000, 50);
    const c = ctx(
      payload,
      { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '983616' },
      {
        profiles: { models: [{ match: 'glm-*', contextWindow: 1_000_000 }] },
      },
    );
    expect(windowSize(c)).toBe(200_000);
    expect(renderWidget('context-percentage', c)).toBe('50%');
  });

  it('used_percentage converts to tokens against the payload size', () => {
    const payload: StatusPayload = {
      model: { id: 'glm-5.3' },
      context_window: { context_window_size: 200_000, used_percentage: 50 },
    };
    const c = ctx(payload);
    expect(contextTokens(c)).toBe(100_000);
    expect(renderWidget('context-percentage', c)).toBe('10%');
  });
});
