import { describe, expect, it } from 'vitest';
import type { SpendLimit, WidgetItem } from '../../src/core/types.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, renderWidget, withLang } from '../helpers.js';

const ctx = (spend?: SpendLimit, config = {}) =>
  ctxWith({ payload: spend ? { rate_limits: { spend_limit: spend } } : {}, config });
const r = (spend: SpendLimit | undefined, options: WidgetItem['options'] = {}, config = {}) =>
  renderWidget('spend-limit', ctx(spend, config), { options });
const raw = (spend: SpendLimit, options: WidgetItem['options'] = {}) =>
  getWidget('spend-limit')!.render(ctx(spend), { id: 'x', type: 'spend-limit', options });

const D = { used_usd: 12, limit_usd: 50 };

describe('spend-limit', () => {
  it('keeps $12/$50 by default as a plain string', () => {
    expect(r(D)).toBe('$12/$50');
    expect(raw(D)).toBe('$12/$50');
  });

  it('falls back to the percentage', () => {
    expect(r({ used_percentage: 63 })).toBe('63%');
    expect(r({ used_percentage: 130 })).toBe('130%');
    expect(r({ used_percentage: 63, ...D })).toBe('$12/$50');
  });

  it('percent mode', () => {
    expect(r(D, { show: 'percent' })).toBe('24%');
    expect(r({ used_percentage: 63 }, { show: 'percent' })).toBe('63%');
  });

  it('remaining mode', () => {
    expect(r(D, { show: 'remaining' })).toBe('$38 left');
    expect(r({ used_usd: 60, limit_usd: 50 }, { show: 'remaining' })).toBe('$0 left');
    expect(r({ used_percentage: 63 }, { show: 'remaining' })).toBe('37% left');
    expect(r({ used_percentage: 130 }, { show: 'remaining' })).toBe('0% left');
  });

  it('both mode', () => {
    expect(r(D, { show: 'both' })).toBe('$12/$50 · 24%');
    expect(r(D, { show: 'both' }, { charset: 'text' })).toBe('$12/$50 | 24%');
    expect(r({ used_percentage: 63 }, { show: 'both' })).toBe('63%');
    expect(r(D, { show: 'nope' })).toBe('$12/$50');
  });

  it('appends the period', () => {
    const p = (period: string | null) => r({ ...D, period }, { showPeriod: true });
    expect(p('daily')).toBe('$12/$50/day');
    expect(p('weekly')).toBe('$12/$50/wk');
    expect(p('monthly')).toBe('$12/$50/mo');
    expect(p('yearly')).toBe('$12/$50');
    expect(p(null)).toBe('$12/$50');
    expect(r({ ...D, period: 'daily' })).toBe('$12/$50');
  });

  it('translates period and remaining', () => {
    withLang('tr', () => {
      const p = (period: string) => r({ ...D, period }, { showPeriod: true });
      expect(p('daily')).toBe('$12/$50/gün');
      expect(p('weekly')).toBe('$12/$50/hf');
      expect(p('monthly')).toBe('$12/$50/ay');
      expect(r(D, { show: 'remaining' })).toBe('$38 kaldı');
    });
  });

  it('never throws on bad numbers', () => {
    expect(r({ used_percentage: Number.NaN }, { show: 'percent' })).toBeNull();
    expect(r({ used_usd: Number.POSITIVE_INFINITY, limit_usd: 50 }, { show: 'percent' })).toBeNull();
    expect(r({ used_usd: 12, limit_usd: 0 }, { show: 'percent' })).toBeNull();
    expect(r({ used_usd: 12, limit_usd: 0 })).toBe('$12/$0');
  });

  it('shows loading without data and nothing for an empty spend_limit', () => {
    const fresh = ctxWith({
      payload: { context_window: { context_window_size: 200000, current_usage: null } },
      transcript: () => null,
    });
    expect(renderWidget('spend-limit', fresh)).toBe('loading…');
    expect(r({})).toBeNull();
  });

  it('colours only when enabled', () => {
    const c = (spend: SpendLimit) => raw(spend, { thresholdColors: true });
    expect(c(D)).toEqual({ text: '$12/$50', color: 'green' });
    expect(c({ used_percentage: 63 })).toEqual({ text: '63%', color: 'yellow' });
    expect(c({ used_percentage: 90 })).toEqual({ text: '90%', color: 'red' });
    expect(c({ used_percentage: 130 })).toEqual({ text: '130%', color: 'red' });
    expect(raw({ used_percentage: 63 })).toBe('63%');
  });
});
