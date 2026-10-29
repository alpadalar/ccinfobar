import type { StoredEntry } from '../rules.js';
import type { D1Database, D1PreparedStatement } from './env.js';

// a write the index must show leaves its generation; a rebuild catches up to it (WR-03)
export const DIRTY = "UPDATE counters SET n = (SELECT n FROM counters WHERE k = 'gen') WHERE k = 'dirty'";

// withdraw, remove and ban: their rebuild never waits for the budget
export const markTakedown = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "UPDATE counters SET n = (SELECT n FROM counters WHERE k = 'gen') WHERE k IN ('dirty', 'takedown')",
  );
export const dirtyIfLive = (db: D1Database, p: string, s: string): D1PreparedStatement =>
  db
    .prepare(`${DIRTY} AND (SELECT state FROM entries WHERE publisher = ?1 AND slug = ?2) = 'live'`)
    .bind(p, s);

export const LIVE = "state IN ('live', 'pending')";

// trigger-kept counts (0002, 0003), so no cap check counts rows; pending has its own caps (WR-02)
export const COUNTER = (k: string) => `COALESCE((SELECT n FROM counters WHERE k = '${k}'), 0)`;
export const MINE = (col: string) => `COALESCE((SELECT ${col} FROM publishers WHERE handle = ?1), 0)`;
export const TRUSTED = MINE('trusted');

// fails the batch when the statement before it changed nothing
export const GUARD = "SELECT json_extract(CASE WHEN changes() = 0 THEN 'x' ELSE '{}' END, '$') AS ok";
export const MISSED = 'malformed JSON';
// a storage cap fails with another message
export const OVER = "'over-quota'";

export const NEXT_GEN = "(SELECT n FROM counters WHERE k = 'gen') + 1";

export const idOf = (e: StoredEntry): [string, string] => [e.publisher, e.id.slice(e.publisher.length + 1)];

// fails the batch unless the condition holds inside it
export const requireSql = (cond: string): string =>
  `SELECT json_extract(CASE WHEN ${cond} THEN '{}' ELSE 'x' END, '$') AS ok`;

// an unbanned publisher holds the token
export const HOLDER = `SELECT 1 FROM tokens t JOIN publishers p ON p.handle = t.handle
  WHERE t.sha256 = ?1 AND p.banned_at IS NULL`;
export const ACTOR = `EXISTS (${HOLDER})`;

// the token still belongs to this unbanned publisher when the batch commits
export const requireWriter = (db: D1Database, digest: string, handle: string): D1PreparedStatement =>
  db.prepare(requireSql(`EXISTS (${HOLDER} AND p.handle = ?2)`)).bind(digest, handle);

// the token still belongs to an unbanned admin id when the batch commits (R-08)
export const requireAdmin = (db: D1Database, digest: string, admins: string[]): D1PreparedStatement =>
  db
    .prepare(
      requireSql(`EXISTS (${HOLDER} AND CAST(p.github_id AS TEXT) IN (SELECT value FROM json_each(?2)))`),
    )
    .bind(digest, JSON.stringify(admins));
