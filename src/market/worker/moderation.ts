// admin review and moderation (D-09, R-08); every action is logged
import { sanitizeText } from '../../core/sanitize.js';
import { LIST_CAP, REPORT_REASON_MAX } from '../protocol.js';
import { fail, tombOf } from '../rules.js';
import type { Env, WorkerDeps } from './env.js';
import { json, readJsonBody } from './http.js';
import { buckets, check } from './rate.js';
import {
  approveStatements,
  banStatements,
  dropPendingStatements,
  entryStatus,
  insertReport,
  type LogRow,
  noteSize,
  openReports,
  pendingEntries,
  publisherRow,
  readEntryRow,
  rebuildIndex,
  removeStatements,
  requireAdmin,
  resolveStatements,
  reviewRow,
  reviewTag,
  writeConflict,
} from './store.js';
import { authPublisher, type Publisher } from './tokens.js';

const NOTE_BODY_CAP = 4096;

const iso = (deps: WorkerDeps): string => new Date(deps.now()).toISOString();

// numeric GitHub ids only; logins are display only (R-08)
const adminIds = (env: Env): string[] =>
  (env.ADMIN_GITHUB_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const isAdmin = (env: Env, id: number): boolean => adminIds(env).includes(String(id));

export async function adminOf(env: Env, req: Request): Promise<Publisher> {
  const who = await authPublisher(env.DB, req);
  if (!who) throw fail(401, 'unauthorized');
  if (!isAdmin(env, who.githubId)) throw fail(403, 'not-admin');
  if (who.banned) throw fail(403, 'banned');
  return who;
}

export function cleanText(v: string, max: number): string {
  return [...sanitizeText(v).trim()].slice(0, max).join('').trim();
}

// an empty request has no note
async function readNote(req: Request): Promise<string> {
  if (!req.body && !req.headers.get('content-type')) return '';
  const raw = await readJsonBody(req, NOTE_BODY_CAP);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, 'invalid');
  const note = (raw as { note?: unknown }).note;
  if (note === undefined || note === null) return '';
  if (typeof note !== 'string') throw fail(400, 'invalid');
  return cleanText(note, REPORT_REASON_MAX);
}

async function logFor(
  deps: WorkerDeps,
  req: Request,
  who: Publisher,
  action: string,
  target: string,
): Promise<LogRow> {
  return { at: iso(deps), admin: who.handle, action, target, note: await readNote(req) };
}

export async function listPending(env: Env): Promise<Response> {
  const rows = await pendingEntries(env.DB, LIST_CAP);
  return json(200, { entries: rows.map((r) => ({ ...JSON.parse(r.summary), createdAt: r.at })) });
}

export async function review(env: Env, p: string, s: string): Promise<Response> {
  const row = await reviewRow(env.DB, p, s);
  if (!row) throw fail(404, 'not-found');
  if (row.state === 'withdrawn' || row.state === 'removed' || row.body === null) {
    throw fail(410, 'withdrawn');
  }
  const v = JSON.parse(row.body) as { content: unknown; hash: string };
  const entry = { ...(JSON.parse(row.doc) as Record<string, unknown>), state: row.state };
  // approve sends this tag back as If-Match
  return json(200, { entry, content: v.content, hash: v.hash }, { etag: row.tag });
}

const CHANGED = 'entry changed since review';
// Cloudflare weakens ETags on compressed answers, so W/ is accepted
const PIN_RE = /^(?:W\/)?"([0-9a-f]{64})-([1-9][0-9]{0,15})"$/;

// what the admin reviewed; checked again inside the approve batch
function pinOf(req: Request): { hash: string; gen: number } {
  const m = PIN_RE.exec(req.headers.get('if-match') ?? '');
  if (!m) throw fail(412, 'stale', 'review the entry first');
  return { hash: m[1]!, gen: Number(m[2]) };
}

async function pendingOnly(env: Env, p: string, s: string): Promise<string> {
  const row = await reviewRow(env.DB, p, s);
  if (!row) throw fail(404, 'not-found');
  if (row.state !== 'pending') throw fail(409, 'conflict', 'entry is not pending');
  return row.tag;
}

const gateOf = (env: Env, who: Publisher) => requireAdmin(env.DB, who.digest, adminIds(env));

// a failed batch: the admin, the entry or its revision changed meanwhile
async function whyNot(env: Env, req: Request, p: string, s: string, pin?: string): Promise<never> {
  await adminOf(env, req);
  const tag = await pendingOnly(env, p, s);
  if (pin && tag !== pin) throw fail(412, 'stale', CHANGED);
  throw fail(409, 'conflict');
}

export type AdminRoute = (
  env: Env,
  deps: WorkerDeps,
  req: Request,
  who: Publisher,
  p: string,
  s: string,
) => Promise<Response>;

export const approve: AdminRoute = async (env, deps, req, who, p, s) => {
  const log = await logFor(deps, req, who, 'approve', `${p}/${s}`);
  const tag = await pendingOnly(env, p, s);
  const pin = pinOf(req);
  if (reviewTag(pin.hash, pin.gen) !== tag) throw fail(412, 'stale', CHANGED);
  try {
    await env.DB.batch(approveStatements(env.DB, gateOf(env, who), p, s, pin, log));
  } catch (err) {
    if (writeConflict(err) !== 'guard') throw err;
    await whyNot(env, req, p, s, tag);
  }
  await rebuildIndex(env.DB, log.at);
  return json(200, { id: `${p}/${s}`, approved: true });
};

export const reject: AdminRoute = async (env, deps, req, who, p, s) => {
  const log = await logFor(deps, req, who, 'reject', `${p}/${s}`);
  await pendingOnly(env, p, s);
  try {
    await noteSize(env.DB, await env.DB.batch(dropPendingStatements(env.DB, gateOf(env, who), p, s, log)));
  } catch (err) {
    if (writeConflict(err) !== 'guard') throw err;
    await whyNot(env, req, p, s);
  }
  return json(200, { id: `${p}/${s}`, rejected: true });
};

const gone = (state: string): boolean => state === 'withdrawn' || state === 'removed';

// a racing new version is retried into the tombstone, like withdraw
export const remove: AdminRoute = async (env, deps, req, who, p, s) => {
  const db = env.DB;
  const log = await logFor(deps, req, who, 'remove', `${p}/${s}`);
  for (let i = 0; i < 3; i++) {
    const row = await readEntryRow(db, p, s);
    if (!row) throw fail(404, 'not-found');
    if (gone(row.state)) throw fail(409, 'conflict', 'entry is already gone');
    try {
      const tomb = tombOf(row.entry, log.at);
      await noteSize(db, await db.batch(removeStatements(db, gateOf(env, who), tomb, row.version, log)));
    } catch (err) {
      if (writeConflict(err) !== 'guard') throw err;
      await adminOf(env, req);
      continue;
    }
    await rebuildIndex(db, log.at);
    return json(200, { id: `${p}/${s}`, removed: true });
  }
  throw fail(409, 'conflict');
};

export async function setBan(
  env: Env,
  deps: WorkerDeps,
  req: Request,
  who: Publisher,
  handle: string,
  ban: boolean,
): Promise<Response> {
  const log = await logFor(deps, req, who, ban ? 'ban' : 'unban', handle);
  const target = await publisherRow(env.DB, handle);
  if (!target) throw fail(404, 'not-found');
  const admins = adminIds(env);
  if (ban && admins.includes(String(target.githubId))) throw fail(409, 'conflict', 'admins cannot be banned');
  try {
    await env.DB.batch(banStatements(env.DB, gateOf(env, who), handle, ban, admins, log));
  } catch (err) {
    if (writeConflict(err) !== 'guard') throw err;
    await adminOf(env, req);
    throw fail(409, 'conflict');
  }
  await rebuildIndex(env.DB, log.at);
  return json(200, { handle, banned: ban });
}

const REPORT_BODY_CAP = 4096;

export async function report(env: Env, deps: WorkerDeps, req: Request, p: string, s: string) {
  const db = env.DB;
  const raw = await readJsonBody(req, REPORT_BODY_CAP);
  const who = await authPublisher(db, req);
  if (!who) throw fail(401, 'unauthorized');
  if (who.banned) throw fail(403, 'banned');
  const r =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { reason?: unknown }).reason : null;
  if (typeof r !== 'string' || [...sanitizeText(r).trim()].length > REPORT_REASON_MAX) {
    throw fail(400, 'invalid');
  }
  const reason = cleanText(r, REPORT_REASON_MAX);
  if (!reason) throw fail(400, 'invalid');
  const now = deps.now();
  await check(db, `r:${who.handle}`, buckets(env).report, now);
  const row = { publisher: p, slug: s, reporter: who.handle, reason, at: new Date(now).toISOString() };
  const id = await insertReport(db, who.digest, row);
  if (id !== null) return json(201, { id });
  // the insert checked everything at once; find out which part failed
  const again = await authPublisher(db, req);
  if (!again) throw fail(401, 'unauthorized');
  if (again.banned) throw fail(403, 'banned');
  const e = await entryStatus(db, p, s);
  if (e?.state !== 'live' || e.banned) throw fail(404, 'not-found');
  throw fail(409, 'conflict', 'already reported');
}

export async function listReports(env: Env): Promise<Response> {
  return json(200, { reports: await openReports(env.DB, LIST_CAP) });
}

export async function resolve(env: Env, deps: WorkerDeps, req: Request, who: Publisher, id: number) {
  const log = await logFor(deps, req, who, 'resolve', `report/${id}`);
  try {
    await env.DB.batch(resolveStatements(env.DB, gateOf(env, who), id, log));
  } catch (err) {
    if (writeConflict(err) !== 'guard') throw err;
    await adminOf(env, req);
    throw fail(404, 'not-found');
  }
  return json(200, { id, resolved: true });
}
