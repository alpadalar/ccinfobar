// D1 fixed windows keyed by salted address hashes; no address is stored (D-10)
import {
  fail,
  limited,
  REGISTERS_PER_MINUTE,
  retryAfterSeconds,
  WINDOW_MS,
  WRITES_PER_MINUTE,
  windowOf,
} from '../rules.js';
import { type D1Database, type Env, intVar, limitersOpen, type RateLimit, type WorkerDeps } from './env.js';
import { MEMORY_LIMITS } from './limiter.js';
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

const limitKey = async (prefix: string, req: Request, now: number): Promise<string> =>
  `${prefix}:${(await sha256Hex(dayOf(now) + ipOf(req))).slice(0, 32)}`;

// the key lives in memory only; a missing or failing binding never blocks; logs carry no key
export async function bindingAllowed(
  b: RateLimit | undefined,
  prefix: string,
  req: Request,
  now: number,
): Promise<boolean> {
  if (!b) return true;
  const key = await limitKey(prefix, req, now);
  try {
    const r = (await b.limit({ key })) as { success?: unknown } | undefined;
    if (typeof r?.success !== 'boolean') {
      console.warn('ratelimit', prefix, 'unexpected');
      return true;
    }
    if (!r.success) console.log('ratelimit', prefix, 'refused');
    return r.success;
  } catch {
    console.warn('ratelimit', prefix, 'threw');
    return true;
  }
}

async function layered(
  b: RateLimit | undefined,
  prefix: keyof typeof MEMORY_LIMITS,
  req: Request,
  now: number,
  deps?: Pick<WorkerDeps, 'memo'>,
): Promise<boolean> {
  if (deps?.memo) {
    const key = await limitKey(prefix, req, now);
    if (!deps.memo.hit(key, MEMORY_LIMITS[prefix], now)) return false;
  }
  return bindingAllowed(b, prefix, req, now);
}

// writes and sign-in refuse (503) without their binding unless the dev flag opens them
export async function limiterAllowed(
  env: Env,
  b: RateLimit | undefined,
  prefix: keyof typeof MEMORY_LIMITS,
  req: Request,
  now: number,
  deps?: Pick<WorkerDeps, 'memo'>,
): Promise<boolean> {
  if (!b && !limitersOpen(env)) throw fail(503, 'unavailable', 'rate limiter is not configured');
  return layered(b, prefix, req, now, deps);
}

export const readAllowed = (
  env: Env,
  req: Request,
  now: number,
  deps?: Pick<WorkerDeps, 'memo'>,
): Promise<boolean> => layered(env.READS, 'r', req, now, deps);

// older salts go, so their hashes become unlinkable; answers the rate rows deleted
export async function cleanup(db: D1Database, now: number): Promise<number> {
  const done = await db.batch(cleanupStatements(db, dayOf(now - DAY_MS), now - 2 * HOUR_MS));
  return Number(done[1]?.meta?.changes ?? 0);
}
