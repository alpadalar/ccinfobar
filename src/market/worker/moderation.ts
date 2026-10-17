// admin review and moderation (D-09, R-08); every action is logged
import { sanitizeText } from '../../core/sanitize.js';
import { LIST_CAP, REPORT_REASON_MAX } from '../protocol.js';
import { fail } from '../rules.js';
import type { Env, WorkerDeps } from './env.js';
import { json, readJsonBody } from './http.js';
import {
  approveStatements,
  dropPendingStatements,
  type LogRow,
  noteSize,
  pendingEntries,
  readEntryRow,
  rebuildIndex,
  reviewRow,
  writeConflict,
} from './store.js';
import { authPublisher, type Publisher } from './tokens.js';

const NOTE_BODY_CAP = 4096;

const iso = (deps: WorkerDeps): string => new Date(deps.now()).toISOString();

// numeric GitHub ids only; logins are display only (R-08)
export const isAdmin = (env: Env, id: number): boolean =>
  (env.ADMIN_GITHUB_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(String(id));

export async function adminOf(env: Env, req: Request): Promise<Publisher> {
  const who = await authPublisher(env.DB, req);
  if (!who) throw fail(401, 'unauthorized');
  if (!isAdmin(env, who.githubId)) throw fail(403, 'not-admin');
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
  return json(200, { entry, content: v.content, hash: v.hash });
}

async function pendingOnly(env: Env, p: string, s: string): Promise<void> {
  const row = await readEntryRow(env.DB, p, s);
  if (!row) throw fail(404, 'not-found');
  if (row.state !== 'pending') throw fail(409, 'conflict', 'entry is not pending');
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
  await pendingOnly(env, p, s);
  try {
    await env.DB.batch(approveStatements(env.DB, p, s, log));
  } catch (err) {
    if (writeConflict(err) === 'guard') throw fail(409, 'conflict', 'entry is not pending');
    throw err;
  }
  await rebuildIndex(env.DB, log.at);
  return json(200, { id: `${p}/${s}`, approved: true });
};

export const reject: AdminRoute = async (env, deps, req, who, p, s) => {
  const log = await logFor(deps, req, who, 'reject', `${p}/${s}`);
  await pendingOnly(env, p, s);
  try {
    await noteSize(env.DB, await env.DB.batch(dropPendingStatements(env.DB, p, s, log)));
  } catch (err) {
    if (writeConflict(err) === 'guard') throw fail(409, 'conflict', 'entry is not pending');
    throw err;
  }
  return json(200, { id: `${p}/${s}`, rejected: true });
};
