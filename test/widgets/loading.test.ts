import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../../src/core/config.js';
import { isFreshSession } from '../../src/core/payload.js';
import { sampleTranscript } from '../../src/core/sample.js';
import type { Config, StatusPayload } from '../../src/core/types.js';
import type { TranscriptInfo } from '../../src/data/transcript.js';
import { loading } from '../../src/widgets/shared.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const FRESH: StatusPayload = { context_window: { context_window_size: 200000, current_usage: null } };

const CONTEXT_TOKEN_WIDGETS = [
  'context-percentage',
  'context-bar',
  'context-length',
  'tokens-input',
  'tokens-output',
  'tokens-cached',
  'tokens-total',
  'cache-hit-rate',
];

const compacted = (): TranscriptInfo => ({ ...sampleTranscript(NOW.getTime()), totalTokens: 120000 });

function render(
  type: string,
  o: {
    payload?: StatusPayload;
    transcript?: () => TranscriptInfo | null;
    config?: Partial<Config>;
    env?: NodeJS.ProcessEnv;
    hideEmpty?: boolean;
  } = {},
) {
  const ctx = ctxWith({
    payload: o.payload ?? FRESH,
    transcript: o.transcript ?? (() => null),
    config: o.config,
    env: o.env ?? {},
  });
  return renderWidget(type, ctx, o.hideEmpty ? { hideEmpty: true } : {});
}

describe('isFreshSession', () => {
  it('is true before the first reply', () => {
    expect(isFreshSession(FRESH, null)).toBe(true);
  });

  it('is false once current_usage is an object', () => {
    const p: StatusPayload = {
      context_window: { context_window_size: 200000, current_usage: { input_tokens: 10 } },
    };
    expect(isFreshSession(p, null)).toBe(false);
  });

  it('is true without context_window, used_percentage, replies or transcript usage', () => {
    expect(isFreshSession({}, null)).toBe(true);
    expect(isFreshSession({}, { ...sampleTranscript(NOW.getTime()), totalTokens: 0 })).toBe(true);
  });

  it('is false when used_percentage is known', () => {
    expect(isFreshSession({ context_window: { used_percentage: 12 } }, null)).toBe(false);
  });

  it('is false with replies or transcript usage', () => {
    expect(isFreshSession({ ...FRESH, cost: { total_cost_usd: 0.1 } }, null)).toBe(false);
    expect(isFreshSession(FRESH, compacted())).toBe(false);
  });
});

describe('loading placeholder for context and token widgets', () => {
  it.each(CONTEXT_TOKEN_WIDGETS)('%s shows loading… in a fresh session', (type) => {
    expect(render(type)).toBe('loading…');
  });

  it('shows numbers right after /compact', () => {
    const out = render('context-percentage', { transcript: compacted });
    expect(out).not.toBe('loading…');
    expect(out).toMatch(/%$/);
  });

  it('shows no placeholder once Claude replied', () => {
    const out = render('context-percentage', { payload: { ...FRESH, cost: { total_cost_usd: 0.2 } } });
    expect(out).toBe('0%');
  });

  it('uses loadingText', () => {
    expect(render('context-percentage', { config: { loadingText: 'wait' } })).toBe('wait');
  });

  it('turns off with an empty loadingText', () => {
    expect(render('context-percentage', { config: { loadingText: '' } })).toBe('0%');
  });

  it('stays hidden for hideEmpty items', () => {
    const ctx = ctxWith({ payload: FRESH, transcript: () => null });
    expect(loading(ctx, { id: 'c', type: 'context-percentage', hideEmpty: true })).toBeNull();
    expect(loading(ctx, { id: 'c', type: 'context-percentage' })?.text).toBe('loading…');
  });

  it('normalizes loadingText', () => {
    const cfg = normalizeConfig({ version: 1, lines: [[]], loadingText: `a\u001b[31mb${'x'.repeat(60)}` });
    expect(cfg.loadingText).not.toContain('\u001b');
    expect(cfg.loadingText!.length).toBeLessThanOrEqual(40);
    expect(normalizeConfig({ version: 1, lines: [[]], loadingText: '' }).loadingText).toBe('');
  });
});

describe('loading placeholder for plan-limit widgets', () => {
  const LIMITS = ['five-hour-usage', 'weekly-usage'];

  it.each(LIMITS)('%s shows loading… for a first-party session', (type) => {
    expect(render(type)).toBe('loading…');
  });

  it.each([
    { ANTHROPIC_API_KEY: 'x' },
    { CLAUDE_CODE_USE_BEDROCK: '1' },
    { ANTHROPIC_BASE_URL: 'https://gw.example.com' },
    { CLAUDE_CODE_USE_VERTEX: '1' },
    { CLAUDE_CODE_USE_FOUNDRY: '1' },
  ])('stays null for %o', (env) => {
    for (const type of LIMITS) expect(render(type, { env })).toBeNull();
  });

  it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN])(
    'treats used_percentage %s as missing',
    (v) => {
      const payload: StatusPayload = { ...FRESH, rate_limits: { five_hour: { used_percentage: v } } };
      const out = render('five-hour-usage', { payload });
      const missing: StatusPayload = { ...FRESH, rate_limits: { five_hour: {} } };
      expect(out).toBe(render('five-hour-usage', { payload: missing }));
      expect(String(out)).not.toMatch(/Infinity|NaN/);
    },
  );

  it('parses 1e999 to Infinity and shows loading', () => {
    const rate = JSON.parse('{"used_percentage":1e999}');
    expect(rate.used_percentage).toBe(Number.POSITIVE_INFINITY);
    const payload: StatusPayload = { ...FRESH, rate_limits: { five_hour: rate } };
    const missing: StatusPayload = { ...FRESH, rate_limits: { five_hour: {} } };
    expect(render('five-hour-usage', { payload })).toBe(render('five-hour-usage', { payload: missing }));
  });

  it('keeps negative and over-100 values', () => {
    const at = (v: number): StatusPayload => ({
      ...FRESH,
      rate_limits: { five_hour: { used_percentage: v } },
    });
    expect(render('five-hour-usage', { payload: at(-5) })).toBe('-5%');
    expect(render('five-hour-usage', { payload: at(130) })).toBe('130%');
  });

  it('lets payload rate_limits win over the env', () => {
    const payload: StatusPayload = { ...FRESH, rate_limits: { five_hour: { used_percentage: 42 } } };
    expect(render('five-hour-usage', { payload, env: { ANTHROPIC_API_KEY: 'x' } })).toBe('42%');
    expect(render('weekly-usage', { payload })).toBeNull();
  });

  it('stays null after the first reply without rate_limits', () => {
    const payload: StatusPayload = { ...FRESH, cost: { total_cost_usd: 0.3 } };
    for (const type of LIMITS) expect(render(type, { payload })).toBeNull();
  });

  it('respects hideEmpty and an empty loadingText', () => {
    expect(render('five-hour-usage', { hideEmpty: true })).toBeNull();
    expect(render('five-hour-usage', { config: { loadingText: '' } })).toBeNull();
  });

  it('covers the other limit widgets', () => {
    for (const type of [
      'five-hour-reset',
      'weekly-reset',
      'weekly-model-usage',
      'spend-limit',
      'usage-pace',
    ]) {
      expect(render(type)).toBe('loading…');
      expect(render(type, { env: { CLAUDE_CODE_USE_BEDROCK: 'true' } })).toBeNull();
    }
  });
});
