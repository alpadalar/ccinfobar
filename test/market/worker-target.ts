import { REGISTERS_PER_MINUTE } from '../../src/market/rules.js';
import { fixedWindow } from '../../src/market/server.js';
import type { Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import type { MarketTarget, TargetOpts } from './conformance.js';
import { fakeRateLimit, makeEnv } from './worker-env.js';
import { seedPublisher, seedToken } from './worker-seed.js';

// the Worker handler behind a loopback URL; nothing leaves the process
export async function makeWorkerTarget(o: TargetOpts = {}): Promise<MarketTarget> {
  const r = o.rateLimit;
  const vars: Partial<Env> = { ALLOW_OVERWRITE: o.allowOverwrite === false ? 'false' : 'true' };
  if (r) {
    vars.WRITE_LIMIT = String(r.perMinute);
    vars.SIGNIN_LIMIT = String(r.registersPerMinute ?? Math.min(r.perMinute, REGISTERS_PER_MINUTE));
  }
  const { env, db, clock } = await makeEnv(vars);
  // the READS binding, played by the reference's own window
  if (r?.readsPerMinute) {
    const reads = fixedWindow(r.readsPerMinute, clock.now);
    env.READS = { limit: async ({ key }) => ({ success: reads(key) === null }) };
  }
  if (r) {
    env.WRITES = fakeRateLimit(r.perMinute, clock.now);
    env.SIGNIN = fakeRateLimit(
      r.registersPerMinute ?? Math.min(r.perMinute, REGISTERS_PER_MINUTE),
      clock.now,
    );
  }
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
      rateLimit: true,
    },
    async close() {
      db.close();
    },
  };
}
