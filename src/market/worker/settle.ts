// index rebuilds within a daily budget, and the scheduled cleanup (WR-03, WR-05)
import { type D1Database, type Env, intVar } from './env.js';
import { cleanup } from './rate.js';
import { CLEANUP_BATCH, indexState, rebuildIndex } from './store.js';

const DAY_MS = 86_400_000;
// once the budget is spent, one rebuild per gap at most
export const REBUILD_GAP_MS = 600_000;
const CLEANUP_ROUNDS = 20;

// live summaries the rebuilds may read a day before they slow down (DoS audit)
export const rebuildRows = (env: Env): number => intVar(env.INDEX_REBUILD_ROWS) ?? 2_000_000;

// rebuilds a stale index; a failure leaves it stale for the next write, read or cron;
// answers the generation of page 1 when nothing was rebuilt, so a check needs no second read
export async function settleIndex(
  db: D1Database,
  env: Env,
  now: number,
  force = false,
): Promise<number | null> {
  try {
    const st = await indexState(db);
    if (st.dirty <= st.built) return st.built;
    const spent = st.day === Math.floor(now / DAY_MS) && st.rows >= rebuildRows(env);
    if (spent && !force && now - st.at < REBUILD_GAP_MS) return st.built;
    await rebuildIndex(db, new Date(now).toISOString(), now);
  } catch {
    console.error('market: index');
  }
  return null;
}

// the cron: old salts and rate rows go in bounded batches, then a stale index is rebuilt
export async function scheduled(env: Env, now: number): Promise<void> {
  for (let i = 0; i < CLEANUP_ROUNDS; i++) {
    let n = 0;
    try {
      n = await cleanup(env.DB, now);
    } catch {
      console.error('market: cleanup');
    }
    if (n < CLEANUP_BATCH) break;
  }
  await settleIndex(env.DB, env, now, true);
}
