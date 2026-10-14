import { describe, expect, it } from 'vitest';
import { classify, latestMiss, type Outcome, type Req, ttlMs } from '../../src/core/cache-rule.js';
import type { StatusPayload } from '../../src/core/types.js';

const req = (input: number, read: number, write: number): Req => ({ input, read, write });

const cases: [string, Req | null, Req, boolean, boolean, Outcome][] = [
  ['first request', null, req(100, 0, 5000), false, false, 'cold'],
  ['never cached', req(5000, 0, 0), req(6000, 0, 0), false, false, 'uncached'],
  ['first cache write', req(5000, 0, 0), req(100, 0, 6000), false, false, 'cold'],
  ['miss', req(100, 50000, 0), req(3000, 47000, 1000), true, false, 'miss'],
  ['miss after compaction', req(100, 50000, 0), req(3000, 47000, 1000), true, true, 'expected'],
  ['small shortfall', req(0, 20000, 0), req(1500, 18500, 0), true, false, 'hit'],
  ['at 95 percent', req(0, 100000, 0), req(5000, 95000, 0), true, false, 'hit'],
  ['full read', req(100, 50000, 0), req(200, 50100, 300), true, false, 'hit'],
  ['cached before, none now', req(100, 50000, 0), req(52000, 0, 0), true, false, 'miss'],
];

describe('classify', () => {
  it.each(cases)('%s', (_name, prev, cur, ever, drop, expected) => {
    expect(classify(prev, cur, ever, drop)).toBe(expected);
  });
});

describe('ttlMs', () => {
  it.each([
    ['5m', 300_000],
    ['1h', 3_600_000],
    ['7m', undefined],
    ['toString', undefined],
    [5, undefined],
    [null, undefined],
  ])('%s', (ttl, ms) => {
    expect(ttlMs(ttl)).toBe(ms);
  });
});

type PC = StatusPayload['prompt_cache'];
const SEC = 1_791_000_000;

describe('latestMiss', () => {
  const pc = (extra: Record<string, unknown>): PC =>
    ({ ttl: '5m', expires_at: SEC + 300, last_miss_at: SEC, ...extra }) as PC;

  it.each<[string, PC | undefined, 'yes' | 'no' | 'unknown']>([
    ['latest request missed', pc({}), 'yes'],
    ['within tolerance', pc({ expires_at: SEC + 302 }), 'yes'],
    ['older miss', pc({ last_miss_at: SEC - 600 }), 'no'],
    ['just outside tolerance', pc({ expires_at: SEC + 303 }), 'no'],
    ['1h ttl', pc({ ttl: '1h', expires_at: SEC + 3600 }), 'yes'],
    [
      'string timestamps',
      pc({ expires_at: String(SEC + 300), last_miss_at: new Date(SEC * 1000).toISOString() }),
      'yes',
    ],
    ['millisecond timestamps', pc({ expires_at: (SEC + 300) * 1000, last_miss_at: SEC * 1000 }), 'yes'],
    ['no last_miss_at', pc({ last_miss_at: undefined }), 'unknown'],
    ['null last_miss_at', pc({ last_miss_at: null }), 'unknown'],
    ['null expires_at', pc({ expires_at: null }), 'unknown'],
    ['no ttl', pc({ ttl: undefined }), 'unknown'],
    ['unknown ttl', pc({ ttl: '7m' }), 'unknown'],
    ['bad string', pc({ expires_at: 'soon' }), 'unknown'],
    ['wrong type', pc({ expires_at: true }), 'unknown'],
    ['no prompt_cache', undefined, 'unknown'],
  ])('%s', (_name, value, expected) => {
    expect(latestMiss(value)).toBe(expected);
  });
});
