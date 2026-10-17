// D1 fixed windows keyed by salted address hashes; no address is stored (D-10)
import {
  limited,
  REGISTERS_PER_MINUTE,
  retryAfterSeconds,
  WINDOW_MS,
  WRITES_PER_MINUTE,
  windowOf,
} from '../rules.js';
import { type D1Database, type Env, intVar } from './env.js';
import { bumpRate, cleanupStatements, saltStatements } from './store.js';
import { randomToken, sha256Hex } from './tokens.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const REPORTS_PER_HOUR = 5;

export interface Bucket {
  limit: number;
  ms: number;
}

export function buckets(env: Env): { write: Bucket; signIn: Bucket; report: Bucket } {
  return {
    write: { limit: intVar(env.WRITE_LIMIT) ?? WRITES_PER_MINUTE, ms: WINDOW_MS },
    signIn: { limit: intVar(env.SIGNIN_LIMIT) ?? REGISTERS_PER_MINUTE, ms: WINDOW_MS },
    report: { limit: intVar(env.REPORT_LIMIT) ?? REPORTS_PER_HOUR, ms: HOUR_MS },
  };
}

const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

// set by Cloudflare
const ipOf = (req: Request): string => req.headers.get('cf-connecting-ip') || 'local';

export async function ipHash(db: D1Database, req: Request, now: number): Promise<string> {
  const day = dayOf(now);
  const [, row] = await db.batch(saltStatements(db, day, randomToken()));
  const salt = (row?.results[0] as { salt?: unknown } | undefined)?.salt;
  if (typeof salt !== 'string') throw new Error('no salt');
  return (await sha256Hex(salt + ipOf(req))).slice(0, 32);
}

// retry-after seconds when over the limit
export async function hit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<number | null> {
  const win = windowOf(now, windowMs);
  const n = await bumpRate(db, key, win);
  return n > limit ? retryAfterSeconds(win, now, windowMs) : null;
}

export async function check(db: D1Database, key: string, b: Bucket, now: number): Promise<void> {
  const wait = await hit(db, key, b.limit, b.ms, now);
  if (wait !== null) throw limited(wait);
}

// the key lives in memory only; a missing or failing binding never blocks reads
export async function readAllowed(env: Env, req: Request, now: number): Promise<boolean> {
  if (!env.READS) return true;
  const key = `r:${(await sha256Hex(dayOf(now) + ipOf(req))).slice(0, 32)}`;
  try {
    return (await env.READS.limit({ key })).success !== false;
  } catch {
    return true;
  }
}

// older salts go, so their hashes become unlinkable
export async function cleanup(db: D1Database, now: number): Promise<void> {
  await db.batch(cleanupStatements(db, dayOf(now - DAY_MS), now - 2 * HOUR_MS));
}
