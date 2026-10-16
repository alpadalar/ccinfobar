import { describe, expect, it } from 'vitest';
import {
  normalizeModelId,
  PRICES,
  PRICES_UPDATED,
  priceFor,
  requestCost,
  type Usage,
} from '../../src/core/prices.js';
import type { Config, ProfilesConfig } from '../../src/core/types.js';
import { BUILTINS } from '../report-deps.js';

const none = {};
const price = (model: string, config: Pick<Config, 'profiles'>) => priceFor(model, config, BUILTINS);
const cfg = (profiles: ProfilesConfig) => ({ profiles });

describe('PRICES', () => {
  it('is dated and lists every verified row', () => {
    expect(PRICES_UPDATED).toBe('2026-10-15');
    expect(Object.keys(PRICES).sort()).toEqual(
      [
        'claude-fable-5-1',
        'claude-mythos-5-1',
        'claude-fable-5',
        'claude-mythos-5',
        'claude-opus-5-5',
        'claude-opus-5',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-opus-4-5',
        'claude-opus-4-1',
        'claude-opus-4',
        'claude-sonnet-5-5',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5',
        'claude-sonnet-4',
        'claude-haiku-5-5',
        'claude-haiku-4-5',
        'claude-3-5-haiku',
      ].sort(),
    );
  });

  it('keeps unverified models out', () => {
    for (const k of ['claude-3-7-sonnet', 'claude-3-opus', 'claude-mythos-preview', 'claude-3-haiku'])
      expect(Object.hasOwn(PRICES, k)).toBe(false);
  });

  it('matches the research table', () => {
    expect(PRICES['claude-opus-5-5']).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
      fast: { input: 8, output: 40 },
    });
    expect(PRICES['claude-opus-5']?.fast).toEqual({ input: 10, output: 50 });
    expect(PRICES['claude-opus-4-8']?.fast).toEqual({ input: 10, output: 50 });
    expect(PRICES['claude-opus-4-7']?.fast).toBeUndefined();
    expect(PRICES['claude-fable-5-1']?.cacheRead).toBe(0.25);
    expect(PRICES['claude-sonnet-5-5']?.cacheRead).toBe(0.1);
    expect(PRICES['claude-sonnet-4-5']?.over).toBeUndefined();
    expect(PRICES['claude-haiku-5-5']).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      over: {
        threshold: 100_000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite5m: 0.625,
        cacheWrite1h: 1,
      },
    });
    expect(PRICES['claude-3-5-haiku']).toEqual({
      input: 0.8,
      output: 4,
      cacheRead: 0.08,
      cacheWrite5m: 1,
      cacheWrite1h: 1.6,
    });
    expect(Object.isFrozen(PRICES)).toBe(true);
    expect(Object.isFrozen(PRICES['claude-opus-5-5'])).toBe(true);
  });
});

describe('normalizeModelId', () => {
  it('reduces provider ids to the table key', () => {
    expect(normalizeModelId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('claude-sonnet-4-5');
    expect(normalizeModelId('anthropic.claude-3-5-haiku-20241022-v1')).toBe('claude-3-5-haiku');
    expect(normalizeModelId('claude-opus-4-1@20250805')).toBe('claude-opus-4-1');
    expect(normalizeModelId('Claude-Opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(normalizeModelId('glm-5.3')).toBe('glm-5.3');
    expect(normalizeModelId('GLM-5.3[1M]')).toBe('glm-5.3');
    expect(normalizeModelId('deepseek-v4')).toBe('deepseek-v4');
  });
});

describe('priceFor', () => {
  it('matches exactly, never by prefix', () => {
    const p = price('claude-opus-4-5-20251101', none);
    expect(p?.source).toBe('builtin');
    expect(p?.currency).toBe('USD');
    expect(p?.price.input).toBe(5);
    expect(p?.price.output).toBe(25);
    expect(price('claude-opus-4', none)?.price).toMatchObject({ input: 15, output: 75 });
    expect(price('claude-opus-4-20250514', none)?.price).toMatchObject({ input: 15, output: 75 });
    expect(price('claude-opus-4-9', none)).toBeNull();
    expect(price('claude-3-7-sonnet-20250219', none)).toBeNull();
    expect(price('us.anthropic.claude-sonnet-4-5-20250929-v1:0', none)?.price.input).toBe(3);
  });

  it('rejects hostile and oversized ids', () => {
    expect(price('__proto__', none)).toBeNull();
    expect(price('claude-__proto__', none)).toBeNull();
    expect(price('constructor', none)).toBeNull();
    expect(price(`claude-opus-5-5${' '.repeat(200)}`, none)).toBeNull();
    expect(price('', none)).toBeNull();
  });

  it('lets a user override win', () => {
    const p = price('claude-opus-5-5', cfg({ models: [{ match: 'claude-opus-5-5', input: 1, output: 2 }] }));
    expect(p).toEqual({
      source: 'override',
      currency: 'USD',
      vendor: null,
      price: { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    });
    const dated = price(
      'claude-opus-5-5-20260901',
      cfg({ models: [{ match: 'claude-opus-5-5', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 }] }),
    );
    expect(dated?.price).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite5m: 1.5,
      cacheWrite1h: 1.5,
    });
  });

  it('keeps a non-USD currency', () => {
    const p = price('glm-5.3', cfg({ models: [{ match: 'glm-5*', input: 2, output: 8, currency: 'CNY' }] }));
    expect(p?.source).toBe('override');
    expect(p?.currency).toBe('CNY');
    expect(p?.price.input).toBe(2);
  });

  it('skips an override without prices', () => {
    const p = price('claude-opus-5-5', cfg({ models: [{ match: 'claude-*', contextWindow: 500_000 }] }));
    expect(p?.source).toBe('builtin');
    expect(p?.price.input).toBe(4);
  });

  it('uses built-in profiles for other vendors', () => {
    const p = price('glm-5.3', none);
    expect(p).toEqual({
      source: 'profile',
      currency: 'USD',
      vendor: 'zai',
      price: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite5m: null, cacheWrite1h: null },
    });
    expect(price('kimi-k3', none)?.price).toMatchObject({ cacheWrite5m: 3, cacheWrite1h: 3 });
    expect(price('kimi-k3', none)?.vendor).toBe('moonshot');
    expect(price('glm-5.3', cfg({ builtIn: false }))).toBeNull();
    expect(price('qwen-unknown', none)).toBeNull();
  });

  it('never prices a claude id through built-in profiles', () => {
    expect(price('claude-opus-4-9', none)).toBeNull();
    expect(price('us.anthropic.claude-opus-5-5', none)?.source).toBe('builtin');
  });
});

const M = 1e6;
const use = (u: Partial<Usage>): Usage => ({
  in: 0,
  out: 0,
  cr: 0,
  w5: 0,
  w1: 0,
  fast: false,
  big: false,
  ...u,
});
const all = (extra: Partial<Usage> = {}) => use({ in: M, out: M, cr: M, w5: M, w1: M, ...extra });

describe('requestCost', () => {
  const opus = PRICES['claude-opus-5-5']!;
  const haiku = PRICES['claude-haiku-5-5']!;

  it('prices every token class separately', () => {
    expect(requestCost(opus, all())).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 10);
    expect(requestCost(opus, use({}))).toBe(0);
    expect(requestCost(opus, use({ out: 1000 }))).toBeCloseTo(0.02, 10);
  });

  it('uses fast prices and scales cache prices', () => {
    expect(requestCost(opus, use({ in: M, fast: true }))).toBeCloseTo(8, 10);
    expect(requestCost(opus, use({ out: M, fast: true }))).toBeCloseTo(40, 10);
    expect(requestCost(opus, use({ cr: M, fast: true }))).toBeCloseTo(0.4, 10);
    expect(requestCost(opus, use({ w5: M, fast: true }))).toBeCloseTo(10, 10);
    expect(requestCost(opus, use({ w1: M, fast: true }))).toBeCloseTo(16, 10);
    const o5 = PRICES['claude-opus-5']!;
    expect(requestCost(o5, use({ w5: M, w1: M, cr: M, fast: true }))).toBeCloseTo(12.5 + 20 + 1, 10);
  });

  it('bills fast at standard prices without a fast price', () => {
    const o47 = PRICES['claude-opus-4-7']!;
    expect(requestCost(o47, all({ fast: true }))).toBeCloseTo(requestCost(o47, all())!, 10);
  });

  it('switches the Haiku 5.5 tier per request', () => {
    expect(requestCost(haiku, use({ in: M, out: M }))).toBeCloseTo(0.6, 10);
    expect(requestCost(haiku, use({ in: M, out: M, cr: M, big: true }))).toBeCloseTo(0.5 + 2.5 + 0.05, 10);
    expect(requestCost(haiku, use({ w5: M, w1: M, big: true }))).toBeCloseTo(0.625 + 1, 10);
  });

  it('never applies a tier the table does not have', () => {
    const s45 = PRICES['claude-sonnet-4-5']!;
    expect(requestCost(s45, all({ big: true }))).toBeCloseTo(3 + 15 + 0.3 + 3.75 + 6, 10);
  });

  it('returns null when a used class has no price', () => {
    const p = price('glm-5.3', {})!.price;
    expect(requestCost(p, use({ in: M, out: M, cr: M }))).toBeCloseTo(1.4 + 4.4 + 0.26, 10);
    expect(requestCost(p, use({ in: M, w5: 1 }))).toBeNull();
    const bare = { input: 1, output: 2, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null };
    expect(requestCost(bare, use({ in: M, cr: 1 }))).toBeNull();
    expect(requestCost(bare, use({ in: M, out: M }))).toBeCloseTo(3, 10);
    expect(requestCost({ ...bare, input: null }, use({ out: M }))).toBeCloseTo(2, 10);
    expect(requestCost({ ...bare, input: null }, use({ in: 1 }))).toBeNull();
  });
});
