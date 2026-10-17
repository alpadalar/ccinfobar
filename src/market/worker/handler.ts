import { MARKET_LIMITS, metaPath, PROTOCOL_VERSION } from '../protocol.js';
import { fail } from '../rules.js';
import { type Env, intVar, type WorkerDeps } from './env.js';
import { errorResponse, json, PUBLIC_HEADERS } from './http.js';
import { landingPage } from './page.js';

export interface WorkerHandler {
  fetch(req: Request): Promise<Response>;
}

export function buildMeta(env: Env): Record<string, unknown> {
  const max = intVar(env.MAX_ENTRY_BYTES);
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  return {
    protocol: PROTOCOL_VERSION,
    name: env.MARKET_NAME || 'ccinfobar marketplace',
    capabilities: {
      write: true,
      overwrite: env.ALLOW_OVERWRITE === 'true',
      withdraw: true,
      submit: 'api',
      review: true,
      report: true,
    },
    auth: ['github-device'],
    ...(clientId ? { github: { clientId } } : {}),
    limits: { ...MARKET_LIMITS, maxEntryBytes: Math.min(MARKET_LIMITS.maxEntryBytes, max ?? Infinity) },
  };
}

export function createHandler(env: Env, _deps: WorkerDeps): WorkerHandler {
  const meta = buildMeta(env);
  const name = env.MARKET_NAME || 'ccinfobar marketplace';

  async function route(req: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw fail(400, 'invalid');
    }
    const p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/') return landingPage(name);
      if (p === metaPath()) return json(200, meta, PUBLIC_HEADERS);
    }
    throw fail(404, 'not-found');
  }

  return {
    async fetch(req) {
      try {
        return await route(req);
      } catch (err) {
        return errorResponse(err);
      }
    },
  };
}
