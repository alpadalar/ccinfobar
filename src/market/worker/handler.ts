import {
  adminPendingPath,
  adminReportsPath,
  authGithubPath,
  entriesPath,
  indexPath,
  logoutPath,
  MARKET_LIMITS,
  MAX_PAGES,
  mePath,
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
import { logout, me, signInWithGitHub } from './auth.js';
import {
  type D1Database,
  type Env,
  intVar,
  overwriteOn,
  pendingCaps,
  publisherBytes,
  type WorkerDeps,
} from './env.js';
import { errorResponse, etagMatches, json, notModified, PUBLIC_HEADERS, publicJson } from './http.js';
import {
  type AdminRoute,
  adminOf,
  approve,
  listPending,
  listReports,
  reject,
  remove,
  report,
  resolve,
  review,
  setBan,
} from './moderation.js';
import { landingPage } from './page.js';
import { buckets, check, ipHash, readAllowed } from './rate.js';
import { settleIndex } from './settle.js';
import { indexEtag, indexTag, readEntryDoc, readIndexPage, readVersionDoc } from './store.js';
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
      cols: true,
    },
    auth: ['github-device'],
    ...(clientId ? { github: { clientId } } : {}),
    limits: { ...MARKET_LIMITS, maxEntryBytes: Math.min(MARKET_LIMITS.maxEntryBytes, max ?? Infinity) },
    quota: {
      publisherBytes: publisherBytes(env),
      pendingEntries: pendingCaps(env).perPublisher,
      pendingBytes: pendingCaps(env).bytes,
      pendingTotal: pendingCaps(env).total,
    },
  };
}

const hidden = (r: { state: string; banned: boolean } | null): boolean =>
  !r || r.state === 'pending' || r.banned;

const gone = (state: string): boolean => state === 'withdrawn' || state === 'removed';

const ADMIN_ENTRY_RE = /^\/v1\/admin\/entries\/([^/]+)\/([^/]+)$/;
const ADMIN_ACTION_RE = /^\/v1\/admin\/entries\/([^/]+)\/([^/]+)\/([a-z]+)$/;
const ADMIN_ACTIONS: Record<string, AdminRoute> = { approve, reject, remove };
const BAN_RE = /^\/v1\/admin\/publishers\/([^/]+)\/(ban|unban)$/;
const RESOLVE_RE = /^\/v1\/admin\/reports\/([^/]+)\/resolve$/;
const REPORT_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/reports$/;

// one generation tag covers every page, so a match never reads a body
async function indexPage(
  db: D1Database,
  n: number,
  inm: string | null,
  gen?: number | null,
): Promise<Response> {
  if (inm) {
    const tag = typeof gen === 'number' ? indexTag(gen) : await indexEtag(db, n);
    if (tag && etagMatches(inm, tag)) return notModified(tag);
  }
  const page = await readIndexPage(db, n);
  if (!page) throw fail(404, 'not-found');
  return etagMatches(inm, page.etag) ? notModified(page.etag) : publicJson(page.body, page.etag);
}

// ids are checked before any SQL, in the reference order
async function read(db: D1Database, p: string, inm: string | null, gen?: number | null): Promise<Response> {
  if (p === indexPath()) return indexPage(db, 1, inm, gen);
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
  // approve drops the unreviewed older bodies of a live entry (IN-07)
  if (doc.body === null || !doc.hash) throw fail(410, doc.state === 'live' ? 'version-dropped' : 'withdrawn');
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

  // the admin check comes before ids and bodies
  async function adminGet(req: Request, p: string): Promise<Response> {
    if (p === adminPendingPath()) {
      await adminOf(env, req);
      return listPending(env);
    }
    if (p === adminReportsPath()) {
      await adminOf(env, req);
      return listReports(env);
    }
    const e = ADMIN_ENTRY_RE.exec(p);
    if (!e) throw fail(404, 'not-found');
    await adminOf(env, req);
    return review(env, part(e[1]!), part(e[2]!));
  }

  async function adminPost(req: Request, p: string): Promise<Response> {
    const b = BAN_RE.exec(p);
    if (b) {
      const who = await adminOf(env, req);
      return setBan(env, deps, req, who, part(b[1]!), b[2] === 'ban');
    }
    const r = RESOLVE_RE.exec(p);
    if (r) {
      const who = await adminOf(env, req);
      return resolve(env, deps, req, who, versionNo(r[1]!));
    }
    const a = ADMIN_ACTION_RE.exec(p);
    const fn = a && Object.hasOwn(ADMIN_ACTIONS, a[3]!) ? ADMIN_ACTIONS[a[3]!] : undefined;
    if (!a || !fn) throw fail(404, 'not-found');
    const who = await adminOf(env, req);
    return fn(env, deps, req, who, part(a[1]!), part(a[2]!));
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
      if (p === mePath()) return me(env, req);
      if (p.startsWith('/v1/admin/')) return adminGet(req, p);
      // an index a write left stale is rebuilt first, within the budget (WR-03)
      const gen = p === indexPath() ? await settleIndex(env.DB, env, t) : null;
      return read(env.DB, p, req.headers.get('if-none-match'), gen);
    }
    // ids before the body, like the reference
    if (req.method === 'POST') {
      // publishers sign in with GitHub (D-07)
      if (p === publishersPath()) throw fail(403, 'forbidden', SIGN_IN_ONLY);
      // its own per-address bucket
      if (p === authGithubPath()) return signInWithGitHub(env, deps, req);
      if (p === logoutPath()) return logout(env, req);
      if (p.startsWith('/v1/admin/')) return adminPost(req, p);
      if (p === entriesPath()) {
        await counted(req);
        return publish(env.DB, env, deps, req);
      }
      // its own per-reporter bucket
      const rp = REPORT_RE.exec(p);
      if (rp) return report(env, deps, req, part(rp[1]!), part(rp[2]!));
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
      // HEAD answers like GET without a body
      let head = false;
      let res: Response;
      try {
        head = req.method === 'HEAD';
        res = await route(head ? new Request(req, { method: 'GET' }) : req);
      } catch (err) {
        res = errorResponse(err);
      }
      return head ? new Response(null, { status: res.status, headers: res.headers }) : res;
    },
  };
}
