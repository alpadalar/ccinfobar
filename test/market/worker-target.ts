import { createHandler } from '../../src/market/worker/handler.js';
import type { MarketTarget, TargetOpts } from './conformance.js';
import { makeEnv } from './worker-env.js';
import { seedPublisher, seedToken } from './worker-seed.js';

// the Worker handler behind a loopback URL; nothing leaves the process
export async function makeWorkerTarget(o: TargetOpts = {}): Promise<MarketTarget> {
  const { env, db, clock } = await makeEnv({
    ALLOW_OVERWRITE: o.allowOverwrite === false ? 'false' : 'true',
  });
  const handler = createHandler(env, {
    now: clock.now,
    fetch: () => Promise.reject(new Error('no network in tests')),
    ...(o.caps ? { caps: o.caps } : {}),
  });
  let githubId = 1000;
  return {
    url: 'http://127.0.0.1:8787',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      handler.fetch(new Request(input, init))) as typeof fetch,
    async signIn(handle) {
      await seedPublisher(env.DB, { handle, githubId: githubId++, trusted: true });
      return seedToken(env.DB, handle);
    },
    advance: clock.advance,
    caps: {
      overwrite: o.allowOverwrite !== false,
      registersAnon: false,
      etag: true,
      review: true,
      // 12-12
      rateLimit: false,
    },
    async close() {
      db.close();
    },
  };
}
