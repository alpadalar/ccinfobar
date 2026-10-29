import type { HeldInfo } from '../protocol.js';
import type { StoredEntry } from '../rules.js';
import type { D1Database, D1PreparedStatement } from './env.js';
import { type EntryState, type Held, heldOf, withdrawStatements } from './store-entries.js';
import { bumpGen, markDirty } from './store-index.js';
import { ACTOR, COUNTER, GUARD, idOf, MINE, markTakedown, NEXT_GEN } from './store-sql.js';

const NEWER_OF =
  'version > (SELECT e.version FROM entries e WHERE e.publisher = versions.publisher AND e.slug = versions.slug)';

export interface LogRow {
  at: string;
  // the handle that acted
  admin: string;
  action: string;
  target: string;
  note: string;
  // a publisher acting on their own entry, apart from admin actions (IN-02)
  actor?: 'admin' | 'publisher';
}

export const logStatement = (db: D1Database, l: LogRow): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO moderation (at, admin, action, target, note, actor) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    )
    .bind(l.at, l.admin, l.action, l.target, l.note, l.actor ?? 'admin');

const PENDING_LIST = `SELECT publisher, slug, summary, created_at FROM entries WHERE state = 'pending'
  ORDER BY created_at, publisher, slug LIMIT ?1`;
// live entries with a held version, through the partial index (0010)
const HELD_LIST = `SELECT publisher, slug, summary, created_at, held FROM entries INDEXED BY entries_held
  WHERE held IS NOT NULL ORDER BY created_at, publisher, slug LIMIT ?1`;

export async function pendingEntries(
  db: D1Database,
  cap: number,
): Promise<{ summary: string; at: string; held?: HeldInfo }[]> {
  type Row = { publisher: string; slug: string; summary: string; created_at: string; held?: string };
  const [pending, held] = await Promise.all([
    db.prepare(PENDING_LIST).bind(cap).all<Row>(),
    db.prepare(HELD_LIST).bind(cap).all<Row>(),
  ]);
  const key = (r: Row) => `${r.created_at}\u0000${r.publisher}\u0000${r.slug}`;
  return [...pending.results, ...held.results]
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .slice(0, cap)
    .map((r) => {
      const out: { summary: string; at: string; held?: HeldInfo } = {
        summary: String(r.summary),
        at: String(r.created_at),
      };
      const h = heldOf(r.held);
      if (h) out.held = { version: h.version, reason: h.reason, links: h.links };
      return out;
    });
}

export interface ReviewRow {
  state: EntryState;
  doc: string;
  body: string | null;
  // the entry revision the admin reviewed
  tag: string;
  // the version number under review when it is a held one
  held?: number;
  // links the held version adds
  added?: string[];
}

export const reviewTag = (hash: string, gen: number): string => `"${hash}-${gen}"`;

export async function reviewRow(db: D1Database, p: string, s: string): Promise<ReviewRow | null> {
  const row = await db
    .prepare(
      `SELECT e.state AS state, e.doc AS doc, e.hash AS hash, e.gen AS gen, e.held AS held, v.body AS body,
         hv.body AS held_body
       FROM entries e
       LEFT JOIN versions v ON v.publisher = e.publisher AND v.slug = e.slug AND v.version = e.version
       LEFT JOIN versions hv ON hv.publisher = e.publisher AND hv.slug = e.slug
         AND hv.version = json_extract(e.held, '$.version')
       WHERE e.publisher = ?1 AND e.slug = ?2`,
    )
    .bind(p, s)
    .first<{
      state: EntryState;
      doc: string;
      hash: string;
      gen: number;
      held: string | null;
      body: string | null;
      held_body: string | null;
    }>();
  if (!row) return null;
  const held = heldOf(row.held);
  const out: ReviewRow = {
    state: row.state,
    doc: held ? held.doc : String(row.doc),
    body: (held ? row.held_body : row.body) ?? null,
    tag: reviewTag(held ? held.hash : String(row.hash), Number(row.gen)),
  };
  if (held) {
    out.held = held.version;
    out.added = held.links;
  }
  return out;
}

const OLDER = 'version < (SELECT version FROM entries WHERE publisher = ?1 AND slug = ?2)';

// only the reviewed revision goes public, unreviewed older bodies go; the publisher is trusted (D-09)
export function approveStatements(
  db: D1Database,
  gate: D1PreparedStatement,
  p: string,
  s: string,
  pin: { hash: string; gen: number },
  log: LogRow,
  caps: { entries: number; entriesPerPublisher: number },
): D1PreparedStatement[] {
  return [
    gate,
    db
      .prepare(
        `UPDATE entries SET state = 'live', gen = ${NEXT_GEN}
         WHERE publisher = ?1 AND slug = ?2 AND state = 'pending' AND hash = ?3 AND gen = ?4
           AND ${COUNTER('live')} < ?5 AND ${MINE('live')} < ?6`,
      )
      .bind(p, s, pin.hash, pin.gen, caps.entries, caps.entriesPerPublisher),
    db.prepare(GUARD),
    db.prepare('UPDATE publishers SET trusted = 1 WHERE handle = ?1').bind(p),
    db.prepare(`UPDATE versions SET body = NULL WHERE publisher = ?1 AND slug = ?2 AND ${OLDER}`).bind(p, s),
    logStatement(db, log),
    bumpGen(db),
    markDirty(db),
  ];
}

// the held version becomes the entry; older bodies stay, a live entry keeps its history
export function approveHeldStatements(
  db: D1Database,
  gate: D1PreparedStatement,
  p: string,
  s: string,
  pin: { hash: string; gen: number },
  held: Held,
  log: LogRow,
): D1PreparedStatement[] {
  let cols: number | null = null;
  try {
    const c = (JSON.parse(held.doc) as { cols?: unknown }).cols;
    if (typeof c === 'number') cols = c;
  } catch {}
  return [
    gate,
    db
      .prepare(
        `UPDATE entries SET version = ?3, hash = ?4, updated_at = ?5, summary = ?6, doc = ?7, held = NULL,
           gen = ${NEXT_GEN}, cols = ?10
         WHERE publisher = ?1 AND slug = ?2 AND state = 'live' AND held IS NOT NULL
           AND json_extract(held, '$.hash') = ?8 AND gen = ?9`,
      )
      .bind(p, s, held.version, held.hash, held.at, held.summary, held.doc, pin.hash, pin.gen, cols),
    db.prepare(GUARD),
    logStatement(db, log),
    bumpGen(db),
    markDirty(db),
  ];
}

// the held body goes; the live entry is untouched
export function rejectHeldStatements(
  db: D1Database,
  gate: D1PreparedStatement,
  p: string,
  s: string,
  heldVersion: number,
  log: LogRow,
): D1PreparedStatement[] {
  return [
    gate,
    db
      .prepare('DELETE FROM versions WHERE publisher = ?1 AND slug = ?2 AND version = ?3')
      .bind(p, s, heldVersion),
    db
      .prepare(
        `UPDATE entries SET held = NULL
         WHERE publisher = ?1 AND slug = ?2 AND held IS NOT NULL AND json_extract(held, '$.version') = ?3`,
      )
      .bind(p, s, heldVersion),
    db.prepare(GUARD),
    logStatement(db, log),
  ];
}

// only rows that were never public
export function dropPendingStatements(
  db: D1Database,
  gate: D1PreparedStatement,
  p: string,
  s: string,
  log: LogRow,
): D1PreparedStatement[] {
  return [
    gate,
    db.prepare("DELETE FROM entries WHERE publisher = ?1 AND slug = ?2 AND state = 'pending'").bind(p, s),
    db.prepare(GUARD),
    db.prepare('DELETE FROM versions WHERE publisher = ?1 AND slug = ?2').bind(p, s),
    logStatement(db, log),
  ];
}

// removed content goes back to review next time
export function removeStatements(
  db: D1Database,
  gate: D1PreparedStatement,
  tomb: StoredEntry,
  expected: number,
  log: LogRow,
): D1PreparedStatement[] {
  const [p, s] = idOf(tomb);
  return [
    gate,
    ...withdrawStatements(db, tomb, expected, 'removed'),
    db.prepare('UPDATE publishers SET trusted = 0 WHERE handle = ?1').bind(p),
    db
      .prepare(
        'UPDATE reports SET resolved_at = ?3 WHERE publisher = ?1 AND slug = ?2 AND resolved_at IS NULL',
      )
      .bind(p, s, tomb.updatedAt),
    logStatement(db, log),
  ];
}

export async function needsReview(db: D1Database, handle: string, slug: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT e.state = 'live' AND COALESCE(p.trusted, 0) = 0 AS held
       FROM entries e JOIN publishers p ON p.handle = e.publisher WHERE e.publisher = ?1 AND e.slug = ?2`,
    )
    .bind(handle, slug)
    .first<{ held: number }>();
  return !!row?.held;
}

export async function publisherRow(
  db: D1Database,
  handle: string,
): Promise<{ githubId: number; banned: boolean } | null> {
  const row = await db
    .prepare('SELECT github_id, banned_at IS NOT NULL AS banned FROM publishers WHERE handle = ?1')
    .bind(handle)
    .first<{ github_id: number; banned: number }>();
  return row ? { githubId: Number(row.github_id), banned: !!row.banned } : null;
}

// admins are never banned; the first ban time stays; a ban deletes pending entries, never public (WR-02)
export function banStatements(
  db: D1Database,
  gate: D1PreparedStatement,
  handle: string,
  ban: boolean,
  admins: string[],
  log: LogRow,
): D1PreparedStatement[] {
  const drop = ban
    ? [
        db
          .prepare(
            `DELETE FROM versions WHERE publisher = ?1
             AND slug IN (SELECT slug FROM entries WHERE publisher = ?1 AND state = 'pending')`,
          )
          .bind(handle),
        db
          .prepare(
            `DELETE FROM versions WHERE publisher = ?1
             AND slug IN (SELECT slug FROM entries WHERE publisher = ?1 AND held IS NOT NULL)
             AND ${NEWER_OF}`,
          )
          .bind(handle),
        db.prepare('UPDATE entries SET held = NULL WHERE publisher = ?1 AND held IS NOT NULL').bind(handle),
        db.prepare("DELETE FROM entries WHERE publisher = ?1 AND state = 'pending'").bind(handle),
      ]
    : [];
  return [
    gate,
    db
      .prepare(
        `UPDATE publishers SET banned_at = CASE WHEN ?3 = 1 THEN COALESCE(banned_at, ?2) ELSE NULL END
         WHERE handle = ?1 AND (?3 = 0 OR CAST(github_id AS TEXT) NOT IN (SELECT value FROM json_each(?4)))`,
      )
      .bind(handle, log.at, ban ? 1 : 0, JSON.stringify(admins)),
    db.prepare(GUARD),
    ...drop,
    logStatement(db, log),
    bumpGen(db),
    ban ? markTakedown(db) : markDirty(db),
  ];
}

export async function entryStatus(
  db: D1Database,
  p: string,
  s: string,
): Promise<{ state: EntryState; banned: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT e.state AS state, p.banned_at IS NOT NULL AS banned
       FROM entries e LEFT JOIN publishers p ON p.handle = e.publisher WHERE e.publisher = ?1 AND e.slug = ?2`,
    )
    .bind(p, s)
    .first<{ state: EntryState; banned: number }>();
  return row ? { state: row.state, banned: !!row.banned } : null;
}

export interface NewReport {
  publisher: string;
  slug: string;
  reporter: string;
  reason: string;
  at: string;
}

// null when the reporter, the entry or the uniqueness check stops it
export async function insertReport(db: D1Database, digest: string, r: NewReport): Promise<number | null> {
  const id = await db
    .prepare(
      `INSERT INTO reports (publisher, slug, reporter, reason, created_at)
       SELECT ?2, ?3, ?4, ?5, ?6 WHERE ${ACTOR}
         AND EXISTS (SELECT 1 FROM entries e JOIN publishers p ON p.handle = e.publisher
           WHERE e.publisher = ?2 AND e.slug = ?3 AND e.state = 'live' AND p.banned_at IS NULL)
       ON CONFLICT DO NOTHING RETURNING id`,
    )
    .bind(digest, r.publisher, r.slug, r.reporter, r.reason, r.at)
    .first<number>('id');
  return id === null ? null : Number(id);
}

export async function openReports(
  db: D1Database,
  cap: number,
): Promise<{ id: number; entry: string; reporter: string; reason: string; createdAt: string }[]> {
  const rows = await db
    .prepare(
      `SELECT id, publisher, slug, reporter, reason, created_at FROM reports WHERE resolved_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT ?1`,
    )
    .bind(cap)
    .all<{
      id: number;
      publisher: string;
      slug: string;
      reporter: string;
      reason: string;
      created_at: string;
    }>();
  return rows.results.map((r) => ({
    id: Number(r.id),
    entry: `${r.publisher}/${r.slug}`,
    reporter: String(r.reporter),
    reason: String(r.reason),
    createdAt: String(r.created_at),
  }));
}

export function resolveStatements(
  db: D1Database,
  gate: D1PreparedStatement,
  id: number,
  log: LogRow,
): D1PreparedStatement[] {
  return [
    gate,
    db.prepare('UPDATE reports SET resolved_at = COALESCE(resolved_at, ?2) WHERE id = ?1').bind(id, log.at),
    db.prepare(GUARD),
    logStatement(db, log),
  ];
}
