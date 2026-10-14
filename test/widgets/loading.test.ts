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
