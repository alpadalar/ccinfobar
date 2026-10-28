import { contentHash } from '../src/market/client.js';
import { json } from './fake-fetch.js';

export const GH_ENDPOINT = 'https://market.example.com';
export const GH_TOKEN = 'b'.repeat(64);

export interface GhCall {
  url: string;
  method: string;
  auth: string | null;
  body: string;
}

interface Stored {
  id: string;
  version: number;
  state: 'pending' | 'live';
  held?: number;
  // links the next version adds: it is held instead of live
  holdNext?: string[];
}

// a GitHub-backed marketplace: no registration, the first entries wait for review
export function githubMarket(opts: { trusted?: boolean; auth?: string[]; handle?: string } = {}) {
  const calls: GhCall[] = [];
  const entries = new Map<string, Stored>();
  const handle = opts.handle ?? 'octo';
  const state = { trusted: opts.trusted === true, admin: false };
  const meta = {
    protocol: 1,
    name: 'GitHub marketplace',
    capabilities: { write: true, overwrite: false, withdraw: true, submit: 'api', review: true },
    auth: opts.auth ?? ['github-device'],
    github: { clientId: 'Ov23liVCN9Nf6VlLv3St' },
    limits: {},
  };
  const written = (e: Stored, content: unknown, status = 201) =>
    json(
      {
        id: e.id,
        version: e.version,
        hash: contentHash(content as never),
        ...(e.state === 'pending' ? { pending: true } : {}),
      },
      status,
    );
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init.method ?? 'GET';
    const auth = new Headers(init.headers).get('authorization');
    const body = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, method, auth, body });
    if (!url.startsWith(`${GH_ENDPOINT}/`)) throw new TypeError(`no route for ${url}`);
    const p = url.slice(GH_ENDPOINT.length);
    if (p === '/v1/meta.json' && method === 'GET') return json(meta);
    if (p === '/v1/publishers')
      return json({ error: { code: 'forbidden', message: 'sign in with GitHub to publish' } }, 403);
    // the public file only exists once an admin approved
    if (/^\/v1\/entries\/[^/]+\/[^/]+\.json$/.test(p) && method === 'GET')
      return json({ error: { code: 'not-found', message: 'no entry' } }, 404);
    if (auth !== `Bearer ${GH_TOKEN}`)
      return json({ error: { code: 'unauthorized', message: 'sign in' } }, 401);
    if (p === '/v1/me' && method === 'GET')
      return json({
        handle,
        displayName: 'Octo',
        login: 'octo',
        admin: state.admin,
        trusted: state.trusted,
        entries: [...entries.values()].map(({ id, state: s, version, held }) => ({
          id,
          state: s,
          version,
          ...(held ? { held } : {}),
        })),
      });
    if (p === '/v1/entries' && method === 'POST') {
      const b = JSON.parse(body);
      if (entries.has(`${handle}/${b.slug}`))
        return json({ error: { code: 'conflict', message: 'slug taken' } }, 409);
      const e: Stored = { id: `${handle}/${b.slug}`, version: 1, state: state.trusted ? 'live' : 'pending' };
      entries.set(e.id, e);
      return written(e, b.content);
    }
    const m = /^\/v1\/entries\/([^/]+\/[^/]+)\/versions$/.exec(p);
    if (m && method === 'POST') {
      const e = entries.get(m[1]!);
      if (!e) return json({ error: { code: 'not-found', message: 'no entry' } }, 404);
      const content = JSON.parse(body).content;
      if (e.state === 'live' && e.holdNext) {
        e.held = e.version + 1;
        const links = e.holdNext;
        e.holdNext = undefined;
        return json(
          {
            id: e.id,
            version: e.held,
            hash: contentHash(content as never),
            pending: true,
            reason: 'new-link',
            links,
          },
          202,
        );
      }
      e.version++;
      return written(e, content);
    }
    const w = /^\/v1\/entries\/([^/]+\/[^/]+)$/.exec(p);
    if (w && method === 'DELETE') {
      entries.delete(w[1]!);
      return json({ ok: true });
    }
    throw new TypeError(`no route for ${method} ${url}`);
  };
  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    entries,
    state,
    // an admin approves: the entry goes live and later writes too
    approve(id: string) {
      const e = entries.get(id);
      if (e) e.state = 'live';
      state.trusted = true;
    },
  };
}
