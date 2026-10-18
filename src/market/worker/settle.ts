// index rebuilds within a daily budget, and the scheduled cleanup (WR-03, WR-05)
import { type D1Database, type Env, intVar } from './env.js';
import { cleanup } from './rate.js';
import { CLEANUP_BATCH, claimRebuild, indexState, rebuildIndex, releaseRebuild } from './store.js';

const DAY_MS = 86_400_000;
// once the budget is spent, one rebuild per gap at most
export const REBUILD_GAP_MS = 600_000;
// a rebuild that died keeps its lease this long
export const REBUILD_LEASE_MS = 30_000;
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
  // a second round picks up writes that committed during the first rebuild
  for (let round = 0; round < 2; round++) {
    let claimed = false;
    try {
      const st = await indexState(db);
      const kept = round === 0 ? st.built : null;
      if (st.dirty <= st.built) return kept;
      claimed = await claimRebuild(db, now, {
        // a takedown never stays listed, budget or not
        free: force || st.takedown > st.built,
        day: Math.floor(now / DAY_MS),
        budget: rebuildRows(env),
        gapMs: REBUILD_GAP_MS,
        leaseMs: REBUILD_LEASE_MS,
      });
      if (!claimed) return kept;
      await rebuildIndex(db, new Date(now).toISOString(), now);
    } catch {
      console.error('market: index');
      if (claimed)
        await releaseRebuild(db, now)
          .run()
          .catch(() => {});
      return null;
    }
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
