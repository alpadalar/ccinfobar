import { describe, expect, it } from 'vitest';
import { PRICES } from '../../src/core/prices.js';
import type { Config, StatusPayload } from '../../src/core/types.js';
import { formatMoney } from '../../src/widgets/shared.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

type Cache = NonNullable<StatusPayload['prompt_cache']>;

const run = (
  opts: {
    cache?: Partial<Cache>;
    model?: string;
    fast?: boolean;
    config?: Partial<Config>;
    mode?: string;
  } = {},
) => {
  const payload: StatusPayload = {
    model: { id: opts.model ?? 'claude-opus-5-5' },
    ...(opts.fast ? { fast_mode: true } : {}),
    prompt_cache: {
      warm: true,
      caching_observed: true,
      ttl: '1h',
      expires_at: NOW.getTime() / 1000 + 41 * 60,
      recache_tokens_if_cold: 28_400,
      ...opts.cache,
    },
  };
  const options: Record<string, string> = opts.mode ? { showColdCost: opts.mode } : {};
  return renderWidget('cache-timer', ctxWith({ payload, config: opts.config }), { options });
};

const opus = PRICES['claude-opus-5-5']!;
const usd = (n: number, rate: number, cur = 'USD') => formatMoney((n * rate) / 1e6, cur, 2);

describe('cache-timer showColdCost', () => {
  it('off by default and explicitly', () => {
    expect(run()).toBe('41m');
    expect(run({ mode: 'off' })).toBe('41m');
  });

  it('tokens', () => {
    expect(run({ mode: 'tokens' })).toBe('41m · 28.4k');
    expect(run({ mode: 'tokens', config: { charset: 'text' } })).toBe('41m | 28.4k');
  });

  it('usd uses the cache-write rate of the TTL', () => {
    expect(run({ mode: 'usd' })).toBe(`41m · ${usd(28_400, opus.cacheWrite1h!)}`);
    const five = run({ mode: 'usd', cache: { ttl: '5m' } });
    expect(five).toBe(`41m · ${usd(28_400, opus.cacheWrite5m!)}`);
    expect(five).not.toBe(run({ mode: 'usd' }));
  });

  it('shows the cost on the cold text', () => {
    const want = `cold · ${usd(28_400, opus.cacheWrite1h!)}`;
    expect(run({ mode: 'usd', cache: { warm: false } })).toBe(want);
    expect(run({ mode: 'usd', cache: { expires_at: NOW.getTime() / 1000 - 60 } })).toBe(want);
  });

  it('hides the part without a usable estimate', () => {
    for (const v of [null, 0, -5, Number.NaN, undefined]) {
      expect(run({ mode: 'usd', cache: { recache_tokens_if_cold: v as number } })).toBe('41m');
      expect(run({ mode: 'tokens', cache: { recache_tokens_if_cold: v as number } })).toBe('41m');
    }
  });

  it('adds nothing when caching is off', () => {
    const out = run({ mode: 'usd', cache: { caching_observed: false } });
    expect(out).not.toContain('$');
    expect(out).not.toContain('28.4k');
  });

  it('unknown model: no usd, tokens still shown', () => {
    expect(run({ mode: 'usd', model: 'mystery-9' })).toBe('41m');
    expect(run({ mode: 'tokens', model: 'mystery-9' })).toBe('41m · 28.4k');
  });

  it('profile override sets the currency', () => {
    const config = {
      profiles: { models: [{ match: 'mystery-*', input: 1, output: 2, cacheWrite: 4, currency: 'EUR' }] },
    } as Partial<Config>;
    expect(run({ mode: 'usd', model: 'mystery-9', config })).toBe(`41m · ${usd(28_400, 4, 'EUR')}`);
  });

  it('fast mode costs more', () => {
    const num = (s: string | null) => Number(/([\d.]+)$/.exec(s ?? '')![1]);
    const base = num(run({ mode: 'usd' }));
    const fast = num(run({ mode: 'usd', fast: true }));
    expect(fast).toBeGreaterThan(base);
  });

  it('uses the over tier past the threshold', () => {
    const h = PRICES['claude-haiku-5-5']!;
    const n = h.over!.threshold + 1000;
    const out = run({ mode: 'usd', model: 'claude-haiku-5-5', cache: { recache_tokens_if_cold: n } });
    expect(out).toBe(`41m · ${usd(n, h.over!.cacheWrite1h)}`);
  });
});
