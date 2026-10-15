import { globMatch, PROFILES } from './profiles.js';
import type { Config } from './types.js';

export interface Tier {
  threshold: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

// USD per 1M tokens
export interface Price {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  fast?: { input: number; output: number };
  over?: Tier;
}

export interface Usage {
  in: number;
  out: number;
  cr: number;
  w5: number;
  w1: number;
  fast: boolean;
  big: boolean;
}

export interface ResolvedPrice {
  source: 'override' | 'profile' | 'builtin';
  currency: string;
  vendor: string | null;
  price: Price;
}

export const PRICES_UPDATED = '2026-10-15';

const row = (
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
  extra: Pick<Price, 'fast' | 'over'> = {},
): Price => Object.freeze({ input, output, cacheRead, cacheWrite5m, cacheWrite1h, ...extra });

// anthropic list prices on PRICES_UPDATED; unverified models are absent
export const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  'claude-fable-5-1': row(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': row(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': row(10, 12.5, 20, 1, 50),
  'claude-mythos-5': row(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': row(4, 5, 8, 0.2, 20, { fast: { input: 8, output: 40 } }),
  'claude-opus-5': row(5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
  'claude-opus-4-8': row(5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
  'claude-opus-4-7': row(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': row(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': row(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': row(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': row(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': row(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': row(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': row(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': row(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': row(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': row(0.1, 0.125, 0.2, 0.01, 0.5, {
    over: Object.freeze({
      threshold: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite5m: 0.625,
      cacheWrite1h: 1,
    }),
  }),
  'claude-haiku-4-5': row(1, 1.25, 2, 0.1, 5),
  'claude-3-5-haiku': row(0.8, 1, 1.6, 0.08, 4),
});

const ID_MAX = 200;

export function normalizeModelId(id: string): string {
  const s = id
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, '');
  const at = s.indexOf('claude-');
  if (at < 0) return s;
  return s
    .slice(at)
    .replace(/@\d{8}$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '');
}

type Prices = {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
};

const num = (v: number | null | undefined) => (typeof v === 'number' ? v : null);

function fromProfile(p: Prices): Price {
  const w = num(p.cacheWrite);
  return {
    input: num(p.input),
    output: num(p.output),
    cacheRead: num(p.cacheRead),
    cacheWrite5m: w,
    cacheWrite1h: w,
  };
}

const hasPrice = (p: Prices) => typeof p.input === 'number' && typeof p.output === 'number';

export function priceFor(model: string, config: Pick<Config, 'profiles'>): ResolvedPrice | null {
  if (typeof model !== 'string' || !model || model.length > ID_MAX) return null;
  const raw = model.trim().replace(/\[1m\]$/i, '');
  const id = normalizeModelId(model);
  const hits = (glob: string) => globMatch(glob, raw) || globMatch(glob, id);
  for (const o of config.profiles?.models ?? []) {
    if (!o || typeof o.match !== 'string' || !hasPrice(o) || !hits(o.match)) continue;
    return { source: 'override', currency: o.currency ?? 'USD', vendor: null, price: fromProfile(o) };
  }
  if (config.profiles?.builtIn !== false && !id.startsWith('claude-')) {
    for (const v of PROFILES) {
      const hit = v.models.find((p) => hits(p.match));
      if (!hit || !hasPrice(hit) || !v.currency) continue;
      return { source: 'profile', currency: v.currency, vendor: v.id, price: fromProfile(hit) };
    }
  }
  return Object.hasOwn(PRICES, id)
    ? { source: 'builtin', currency: 'USD', vendor: null, price: PRICES[id]! }
    : null;
}
