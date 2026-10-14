import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { StatusPayload, WidgetItem, WidgetOutput } from '../../src/core/types.js';
import type { TranscriptInfo } from '../../src/data/transcript.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const base = (): StatusPayload => samplePayload(NOW.getTime());
const tr = (o: Record<string, unknown> = {}) =>
  ({
    ...sampleTranscript(NOW.getTime()),
    responseMs: 3200,
    responseCount: 20,
    cacheMisses: 2,
    ...o,
  }) as TranscriptInfo;

function perf(
  o: { payload?: StatusPayload; transcript?: TranscriptInfo | null; options?: WidgetItem['options'] } = {},
): string | null {
  const t = o.transcript === undefined ? tr() : o.transcript;
  const ctx = ctxWith({ payload: o.payload ?? base(), transcript: () => t });
  return renderWidget('performance', ctx, o.options ? { options: o.options } : {});
}

function color(payload: StatusPayload, options: WidgetItem['options'] = {}): string | undefined {
  const ctx = ctxWith({ payload, transcript: () => tr() });
  const out = getWidget('performance')!.render(ctx, {
    id: 'p',
    type: 'performance',
    options: { display: 'badge', ...options },
  }) as WidgetOutput | string | null;
  return out && typeof out === 'object' ? out.color : undefined;
}

const withPc = (pc: Partial<NonNullable<StatusPayload['prompt_cache']>>, apiMs?: number): StatusPayload => {
  const p = base();
  return {
    ...p,
    cost: { ...p.cost, ...(apiMs === undefined ? {} : { total_api_duration_ms: apiMs }) },
    prompt_cache: { ...p.prompt_cache, ...pc },
  };
};

const noPc = (): StatusPayload => {
  const { prompt_cache: _pc, ...rest } = base();
  return rest;
};

describe('performance', () => {
  it('renders hit rate and average API time from the sample payload', () => {
    expect(perf()).toBe('94% · 16.9s');
  });

  it.each([
    ['hit', '94%'],
    ['time', '16.9s'],
    ['both', '94% · 16.9s'],
  ])('show %s', (show, expected) => {
    expect(perf({ options: { show } })).toBe(expected);
  });

  it('uses a plausible payload ratio', () => {
    expect(perf({ payload: withPc({ requests: 21 }, 803_000) })).toBe('94% · 38.2s');
  });

  it('falls back to the transcript when the ratio is implausible after a resume', () => {
    expect(perf({ payload: withPc({ requests: 2 }, 9_000_000) })).toBe('94% · 3.2s');
  });

  it('falls back to the transcript when requests is zero', () => {
    expect(perf({ payload: withPc({ requests: 0 }) })).toBe('94% · 3.2s');
  });

  it('formats times of a minute or more as a duration', () => {
    expect(perf({ payload: withPc({ requests: 1 }, 120_000), options: { show: 'time' } })).toBe('2m');
  });

  it('accepts a hit ratio given as a percent', () => {
    expect(perf({ payload: withPc({ hit_ratio: 81 }), options: { show: 'hit' } })).toBe('81%');
  });

  it('uses the transcript without prompt_cache', () => {
    expect(perf({ payload: noPc() })).toBe('86% · 3.2s');
  });

  it('shows only the hit rate when no time is known', () => {
    expect(perf({ payload: noPc(), transcript: tr({ responseMs: null }) })).toBe('86%');
  });

  it('appends payload misses with showMisses', () => {
    expect(perf({ options: { showMisses: true } })).toBe('94% · 16.9s · 3 miss');
  });

  it('appends transcript misses without prompt_cache', () => {
    expect(perf({ payload: noPc(), options: { showMisses: true } })).toBe('86% · 3.2s · 2 miss');
  });

  it('ignores transcript misses when the payload has prompt_cache', () => {
    expect(perf({ payload: withPc({ misses: undefined }), options: { showMisses: true } })).toBe(
      '94% · 16.9s',
    );
  });

  it('returns plain text unless display is badge', () => {
    const ctx = ctxWith({ payload: base(), transcript: () => tr() });
    expect(typeof getWidget('performance')!.render(ctx, { id: 'p', type: 'performance' })).toBe('string');
  });

  it.each([
    ['both good', { hit_ratio: 0.9, requests: 100 }, 500_000, {}, 'green'],
    ['slow time in one band', { hit_ratio: 0.9, requests: 10 }, 150_000, {}, 'yellow'],
    ['hit in one band', { hit_ratio: 0.6, requests: 100 }, 500_000, {}, 'yellow'],
    ['hit far below', { hit_ratio: 0.4, requests: 100 }, 500_000, {}, 'red'],
    ['time far above', { hit_ratio: 0.9, requests: 10 }, 250_000, {}, 'red'],
    ['worse of the two wins', { hit_ratio: 0.6, requests: 10 }, 250_000, {}, 'red'],
    ['custom hitWarn', { hit_ratio: 0.9, requests: 100 }, 500_000, { hitWarn: 95 }, 'yellow'],
    ['custom timeWarn', { hit_ratio: 0.9, requests: 10 }, 150_000, { timeWarn: 20 }, 'green'],
    ['show hit ignores time', { hit_ratio: 0.9, requests: 10 }, 250_000, { show: 'hit' }, 'green'],
  ] as const)('badge %s', (_name, pc, apiMs, options, expected) => {
    expect(color(withPc(pc, apiMs), options)).toBe(expected);
  });

  it('shows the loading placeholder before the first reply', () => {
    const fresh: StatusPayload = { context_window: { context_window_size: 200000, current_usage: null } };
    expect(perf({ payload: fresh, transcript: null })).toBe('loading…');
  });

  it('returns null without any data', () => {
    const p: StatusPayload = { context_window: { current_usage: { input_tokens: 10 } } };
    expect(perf({ payload: p, transcript: null })).toBeNull();
  });

  it('is opt-in in the tokens category', () => {
    expect(getWidget('performance')?.category).toBe('tokens');
    expect(JSON.stringify(defaultConfig())).not.toContain('"performance"');
  });
});
