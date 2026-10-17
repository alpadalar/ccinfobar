import {
  entriesPath,
  indexPath,
  MARKET_LIMITS,
  MAX_PAGES,
  metaPath,
  PROTOCOL_VERSION,
  publishersPath,
} from '../protocol.js';
import {
  ENTRY_RE,
  fail,
  limited,
  PAGE_RE,
  PUT_RE,
  part,
  retryAfterSeconds,
  SIGN_IN_ONLY,
  VERSION_FILE_RE,
  VERSIONS_RE,
  versionNo,
  WITHDRAW_RE,
  windowOf,
} from '../rules.js';
import { type D1Database, type Env, intVar, overwriteOn, publisherBytes, type WorkerDeps } from './env.js';
import { errorResponse, etagMatches, json, notModified, PUBLIC_HEADERS, publicJson } from './http.js';
import { landingPage } from './page.js';
import { buckets, check, ipHash, readAllowed } from './rate.js';
import { indexEtag, readEntryDoc, readIndexPage, readVersionDoc } from './store.js';
import { addVersion, overwrite, publish, withdraw } from './write.js';

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
      overwrite: overwriteOn(env),
      withdraw: true,
      submit: 'api',
      review: true,
      report: true,
    },
    auth: ['github-device'],
    ...(clientId ? { github: { clientId } } : {}),
    limits: { ...MARKET_LIMITS, maxEntryBytes: Math.min(MARKET_LIMITS.maxEntryBytes, max ?? Infinity) },
    quota: { publisherBytes: publisherBytes(env) },
  };
}

const hidden = (r: { state: string; banned: boolean } | null): boolean =>
  !r || r.state === 'pending' || r.banned;

const gone = (state: string): boolean => state === 'withdrawn' || state === 'removed';

// one generation tag covers every page, so a match never reads a body
async function indexPage(db: D1Database, n: number, inm: string | null): Promise<Response> {
  if (inm) {
    const tag = await indexEtag(db, n);
    if (tag && etagMatches(inm, tag)) return notModified(tag);
  }
  const page = await readIndexPage(db, n);
  if (!page) throw fail(404, 'not-found');
  return etagMatches(inm, page.etag) ? notModified(page.etag) : publicJson(page.body, page.etag);
}

// ids are checked before any SQL, in the reference order
async function read(db: D1Database, p: string, inm: string | null): Promise<Response> {
  if (p === indexPath()) return indexPage(db, 1, inm);
  const page = PAGE_RE.exec(p);
  if (page && Number(page[1]) >= 2 && Number(page[1]) <= MAX_PAGES)
    return indexPage(db, Number(page[1]), inm);
  const e = ENTRY_RE.exec(p);
  if (e) {
    const doc = await readEntryDoc(db, part(e[1]!), part(e[2]!));
    if (!doc || hidden(doc)) throw fail(404, 'not-found');
    return etagMatches(inm, doc.etag) ? notModified(doc.etag) : publicJson(doc.doc, doc.etag);
  }
  const v = VERSION_FILE_RE.exec(p);
  if (!v) throw fail(404, 'not-found');
  const [pp, s] = [part(v[1]!), part(v[2]!)];
  const n = versionNo(v[3]!);
  const doc = await readVersionDoc(db, pp, s, n);
  if (!doc || hidden(doc)) throw fail(404, 'not-found');
  if (gone(doc.state)) throw fail(410, 'withdrawn');
  if (!doc.found) throw fail(404, 'not-found');
  if (doc.body === null || !doc.hash) throw fail(410, 'withdrawn');
  const tag = `"${doc.hash}"`;
  return etagMatches(inm, tag) ? notModified(tag) : publicJson(doc.body, tag);
}

export function createHandler(env: Env, deps: WorkerDeps): WorkerHandler {
  const meta = buildMeta(env);
  const name = env.MARKET_NAME || 'ccinfobar marketplace';
  const writes = buckets(env).write;

  // only routes that reach the database count, so junk costs no row writes
  async function counted(req: Request): Promise<void> {
    const t = deps.now();
    await check(env.DB, `w:${await ipHash(env.DB, req, t)}`, writes, t);
  }

  async function route(req: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw fail(400, 'invalid');
    }
    const p = url.pathname;
    if (req.method === 'GET') {
      const t = deps.now();
      if (!(await readAllowed(env, req, t))) throw limited(retryAfterSeconds(windowOf(t), t));
      if (p === '/') return landingPage(name);
      if (p === metaPath()) return json(200, meta, PUBLIC_HEADERS);
      return read(env.DB, p, req.headers.get('if-none-match'));
    }
    // ids before the body, like the reference
    if (req.method === 'POST') {
      // publishers sign in with GitHub (D-07)
      if (p === publishersPath()) throw fail(403, 'forbidden', SIGN_IN_ONLY);
      if (p === entriesPath()) {
        await counted(req);
        return publish(env.DB, env, deps, req);
      }
      const v = VERSIONS_RE.exec(p);
      if (v) {
        const [pp, s] = [part(v[1]!), part(v[2]!)];
        await counted(req);
        return addVersion(env.DB, env, deps, req, pp, s);
      }
    }
    if (req.method === 'PUT') {
      const m = PUT_RE.exec(p);
      if (m) {
        const [pp, s, n] = [part(m[1]!), part(m[2]!), versionNo(m[3]!)];
        await counted(req);
        return overwrite(env.DB, env, deps, req, pp, s, n);
      }
    }
    if (req.method === 'DELETE') {
      const w = WITHDRAW_RE.exec(p);
      if (w) {
        const [pp, s] = [part(w[1]!), part(w[2]!)];
        await counted(req);
        return withdraw(env.DB, env, deps, req, pp, s);
      }
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
