import { toEpochMs } from './time.js';
import type { StatusPayload } from './types.js';

export interface Req {
  input: number;
  read: number;
  write: number;
}

export type Outcome = 'cold' | 'uncached' | 'hit' | 'miss' | 'expected';

// Claude Code 2.1.299 miss rule
const HIT_SHARE = 0.95;
const MIN_SHORTFALL = 2000;
const GAP_MS = 2000;
const TTL: Record<string, number> = { '5m': 300_000, '1h': 3_600_000 };

// classify: drop once min Claude Code >= 2.1.251
export function classify(prev: Req | null, cur: Req, everCached: boolean, dropExpected: boolean): Outcome {
  if (!prev) return 'cold';
  if (!everCached && cur.read + cur.write === 0) return 'uncached';
  if (prev.read + prev.write === 0 && cur.read + cur.write > 0) return 'cold';
  const r = Math.min(prev.input + prev.read + prev.write, cur.input + cur.read + cur.write);
  if (cur.read < r * HIT_SHARE && r - cur.read >= MIN_SHORTFALL) return dropExpected ? 'expected' : 'miss';
  return 'hit';
}

export function ttlMs(ttl: unknown): number | undefined {
  return typeof ttl === 'string' && Object.hasOwn(TTL, ttl) ? TTL[ttl] : undefined;
}

const epoch = (v: unknown): number | null =>
  typeof v === 'number' || typeof v === 'string' ? toEpochMs(v) : null;

export function latestMiss(pc: StatusPayload['prompt_cache'] | undefined): 'yes' | 'no' | 'unknown' {
  const miss = epoch(pc?.last_miss_at);
  const exp = epoch(pc?.expires_at);
  const ttl = ttlMs(pc?.ttl);
  if (miss === null || exp === null || ttl === undefined) return 'unknown';
  if (!Number.isFinite(miss) || !Number.isFinite(exp)) return 'unknown';
  return Math.abs(exp - ttl - miss) <= GAP_MS ? 'yes' : 'no';
}
