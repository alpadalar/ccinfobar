import { describe, expect, it } from 'vitest';
import type { StatusPayload, WidgetItem } from '../../src/core/types.js';
import { ctxWith, renderWidget } from '../helpers.js';

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
