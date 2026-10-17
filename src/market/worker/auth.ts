// GitHub sign-in; the GitHub token is used once, never stored or logged (D-06, D-10, R-14)
import { sanitizeText } from '../../core/sanitize.js';
import { CLIENT_ID_RE, LIST_CAP, MARKET_LIMITS } from '../protocol.js';
import { fail, limited, TOKEN_RE } from '../rules.js';
import { type Env, unverifiedOk, type WorkerDeps } from './env.js';
import { boundedJson, json, PRIVATE_HEADERS, readJsonBody } from './http.js';
import { isAdmin } from './moderation.js';
import { buckets, check, cleanup, ipHash } from './rate.js';
import {
  type Account,
  accountByToken,
  claimHandle,
  deleteToken,
  type GitHubUser,
  knownAccount,
  myEntries,
  tokenStatements,
} from './store.js';
import { randomToken, sha256Hex } from './tokens.js';

const API = 'https://api.github.com';
const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2026-03-10',
  'user-agent': 'ccinfobar-market',
};
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const BODY_CAP = 4096;
const ANSWER_CAP = 16 * 1024;
const TIMEOUT_MS = 8000;
const HANDLE_MAX = 39;
const LAST_VARIANT = 20;
const KEEP_TOKENS = 10;

const iso = (deps: WorkerDeps): string => new Date(deps.now()).toISOString();

function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return [...sanitizeText(v).trim()].slice(0, max).join('').trim();
}

// GitHub's own wait, else a minute
function retryAfter(res: Response, now: number): number {
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(3600, Math.ceil(ra));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(3600, Math.max(1, Math.ceil(reset - now / 1000)));
  return 60;
}

// the timeout covers headers and body
async function ask(
  deps: WorkerDeps,
  url: string,
  init: RequestInit,
): Promise<{ res: Response; body: unknown }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(fail(502, 'upstream')), { once: true });
  });
  const work = (async () => {
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, signal, redirect: 'manual' });
    } catch {
      throw fail(502, 'upstream');
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { res, body: null };
    }
    return { res, body: await boundedJson(res, ANSWER_CAP) };
  })();
  return Promise.race([work, timedOut]);
}

function statusError(res: Response, now: number): Error {
  if (res.status === 401) return fail(401, 'unauthorized');
  if (res.status === 403 || res.status === 429) return limited(retryAfter(res, now));
  return fail(502, 'upstream');
}

function toUser(v: unknown): GitHubUser {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw fail(502, 'upstream');
  const u = v as Record<string, unknown>;
  if (u.type !== 'User') throw fail(401, 'unauthorized');
  const { id, login } = u;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw fail(502, 'upstream');
  if (typeof login !== 'string' || !LOGIN_RE.test(login)) throw fail(502, 'upstream');
  return { id, login, name: clean(u.name, MARKET_LIMITS.displayName) || login };
}

async function viaUser(deps: WorkerDeps, token: string): Promise<GitHubUser> {
  const { res, body } = await ask(deps, `${API}/user`, {
    headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) throw statusError(res, deps.now());
  return toUser(body);
}

// binds the token to our OAuth app (R-03, R-14)
async function viaCheckToken(
  deps: WorkerDeps,
  token: string,
  clientId: string,
  secret: string,
): Promise<GitHubUser> {
  let basic: string;
  try {
    basic = btoa(`${clientId}:${secret}`);
  } catch {
    throw fail(502, 'upstream');
  }
  const { res, body } = await ask(deps, `${API}/applications/${clientId}/token`, {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, authorization: `Basic ${basic}`, 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: token }),
  });
  if (res.status === 404 || res.status === 422) throw fail(401, 'unauthorized');
  // our credentials, not the user's
  if (res.status === 401) throw fail(502, 'upstream');
  if (res.status !== 200) throw statusError(res, deps.now());
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (!b) throw fail(502, 'upstream');
  // fail closed: the token must belong to our app
  const app = b.app && typeof b.app === 'object' ? (b.app as { client_id?: unknown }) : null;
  if (app?.client_id !== clientId) throw fail(401, 'unauthorized');
  return b.user === undefined || b.user === null ? viaUser(deps, token) : toUser(b.user);
}

// base, then base-2 … base-20 cut to fit
export function handleCandidates(login: string): string[] {
  const base = login.toLowerCase();
  const out = [base];
  for (let n = 2; n <= LAST_VARIANT; n++) {
    const tail = `-${n}`;
    out.push(base.slice(0, HANDLE_MAX - tail.length).replace(/-+$/, '') + tail);
  }
  return out;
}

async function accountFor(env: Env, u: GitHubUser, at: string): Promise<Account> {
  const known = await knownAccount(env.DB, u);
  if (known) return known;
  for (const handle of handleCandidates(u.login)) {
    const got = await claimHandle(env.DB, u, handle, at);
    if (got !== 'taken') return got;
  }
  throw fail(409, 'conflict', 'no free handle');
}

export async function signInWithGitHub(env: Env, deps: WorkerDeps, req: Request): Promise<Response> {
  const db = env.DB;
  const clientId = env.GITHUB_CLIENT_ID?.trim() ?? '';
  const secret = env.GITHUB_CLIENT_SECRET ?? '';
  // no GitHub call and no row write on a server that cannot verify tokens
  if (secret ? !CLIENT_ID_RE.test(clientId) : !unverifiedOk(env)) throw fail(503, 'unavailable');
  const now = deps.now();
  await check(db, `a:${await ipHash(db, req, now)}`, buckets(env).signIn, now);
  await cleanup(db, now).catch(() => {});
  const raw = await readJsonBody(req, BODY_CAP);
  const token =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { token?: unknown }).token : undefined;
  if (typeof token !== 'string' || !GITHUB_TOKEN_RE.test(token)) throw fail(400, 'invalid');
  const user = secret ? await viaCheckToken(deps, token, clientId, secret) : await viaUser(deps, token);
  const at = iso(deps);
  const account = await accountFor(env, user, at);
  if (account.banned) throw fail(403, 'banned');
  const mine = randomToken();
  await db.batch(tokenStatements(db, account.handle, await sha256Hex(mine), at, KEEP_TOKENS));
  return json(200, {
    handle: account.handle,
    token: mine,
    displayName: account.displayName,
    admin: isAdmin(env, account.githubId),
  });
}

const bearer = async (req: Request): Promise<string | null> => {
  const m = TOKEN_RE.exec(req.headers.get('authorization') ?? '');
  return m ? sha256Hex(m[1]!) : null;
};

export async function logout(env: Env, req: Request): Promise<Response> {
  const digest = await bearer(req);
  if (!digest || !(await deleteToken(env.DB, digest))) throw fail(401, 'unauthorized');
  return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
}

export async function me(env: Env, req: Request): Promise<Response> {
  const digest = await bearer(req);
  const who = digest ? await accountByToken(env.DB, digest) : null;
  if (!who) throw fail(401, 'unauthorized');
  if (who.banned) throw fail(403, 'banned');
  return json(200, {
    handle: who.handle,
    displayName: who.displayName,
    login: who.login,
    admin: isAdmin(env, who.githubId),
    trusted: who.trusted,
    entries: await myEntries(env.DB, who.handle, LIST_CAP),
  });
}
