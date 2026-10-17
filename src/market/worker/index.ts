import type { Env } from './env.js';
import { createHandler } from './handler.js';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return createHandler(env, { now: Date.now, fetch: (i, o) => fetch(i, o) }).fetch(req);
  },
};
