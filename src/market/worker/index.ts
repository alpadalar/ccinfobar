import type { Env, ExecutionContextLike } from './env.js';
import { createHandler } from './handler.js';
import { MemoryLimiter } from './limiter.js';
import { scheduled } from './settle.js';

export { RateCounter } from './limiter.js';

const memo = new MemoryLimiter();

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return createHandler(env, { now: Date.now, fetch: (i, o) => fetch(i, o), memo }).fetch(req);
  },
  // the cron trigger in wrangler.jsonc
  scheduled(_event: unknown, env: Env, ctx: ExecutionContextLike): void {
    ctx.waitUntil(scheduled(env, Date.now()));
  },
};
