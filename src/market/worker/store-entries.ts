import type { StoredEntry } from '../rules.js';
import type { D1Database, D1PreparedStatement, D1Result } from './env.js';
import { bumpGen, entryDocText, entrySummaryText } from './store-index.js';
import {
  COUNTER,
  dirtyIfLive,
  GUARD,
  idOf,
  LIVE,
  MINE,
  MISSED,
  markTakedown,
  NEXT_GEN,
  OVER,
  TRUSTED,
} from './store-sql.js';

export type EntryState = 'pending' | 'live' | 'withdrawn' | 'removed';

export interface EntryDoc {
  state: EntryState;
  doc: string;
  etag: string;
  banned: boolean;
}

export async function readEntryDoc(db: D1Database, p: string, s: string): Promise<EntryDoc | null> {
  const row = await db
    .prepare(
      `SELECT e.state AS state, e.doc AS doc, e.hash AS hash, e.gen AS gen, p.banned_at IS NOT NULL AS banned
       FROM entries e LEFT JOIN publishers p ON p.handle = e.publisher
       WHERE e.publisher = ?1 AND e.slug = ?2`,
    )
    .bind(p, s)
    .first<{ state: EntryState; doc: string; hash: string; gen: number; banned: number }>();
  if (!row) return null;
  return { state: row.state, doc: row.doc, etag: `"${row.hash}-${row.gen}"`, banned: !!row.banned };
}

export async function readVersionBody(
  db: D1Database,
  p: string,
  s: string,
  n: number,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT body FROM versions WHERE publisher = ?1 AND slug = ?2 AND version = ?3')
    .bind(p, s, n)
    .first<{ body: string | null }>();
  return row?.body ?? null;
}

export interface VersionDoc {
  state: EntryState;
  found: boolean;
  body: string | null;
  hash: string | null;
  banned: boolean;
}

export async function readVersionDoc(
  db: D1Database,
  p: string,
  s: string,
  n: number,
): Promise<VersionDoc | null> {
  const row = await db
    .prepare(
      `SELECT e.state AS state, p.banned_at IS NOT NULL AS banned, v.version IS NOT NULL AS found,
         v.body AS body, json_extract(v.body, '$.hash') AS hash
       FROM entries e LEFT JOIN publishers p ON p.handle = e.publisher
         LEFT JOIN versions v ON v.publisher = e.publisher AND v.slug = e.slug AND v.version = ?3
           AND v.version <= e.version
       WHERE e.publisher = ?1 AND e.slug = ?2`,
    )
    .bind(p, s, n)
    .first<{ state: EntryState; banned: number; found: number; body: string | null; hash: unknown }>();
  if (!row) return null;
  return {
    state: row.state,
    found: !!row.found,
    body: row.body ?? null,
    hash: typeof row.hash === 'string' ? row.hash : null,
    banned: !!row.banned,
  };
}

// a trusted publisher's next version waiting for link review (17-D-17)
export interface Held {
  version: number;
  hash: string;
  at: string;
  reason: 'new-link';
  links: string[];
  summary: string;
  doc: string;
}

export const heldOf = (v: unknown): Held | null => {
  if (typeof v !== 'string') return null;
  try {
    const h = JSON.parse(v) as Record<string, unknown>;
    if (h === null || typeof h !== 'object') return null;
    const { version, hash, at, reason, links, summary, doc } = h;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null;
    if (typeof hash !== 'string' || typeof at !== 'string' || reason !== 'new-link') return null;
    if (!Array.isArray(links) || !links.every((l) => typeof l === 'string')) return null;
    if (typeof summary !== 'string' || typeof doc !== 'string') return null;
    return { version, hash, at, reason, links: links as string[], summary, doc };
  } catch {
    return null;
  }
};

export interface EntryRow {
  state: EntryState;
  version: number;
  entry: StoredEntry;
  held: Held | null;
}

export async function readEntryRow(db: D1Database, p: string, s: string): Promise<EntryRow | null> {
  const row = await db
    .prepare('SELECT state, version, doc, held FROM entries WHERE publisher = ?1 AND slug = ?2')
    .bind(p, s)
    .first<{ state: EntryState; version: number; doc: string; held: string | null }>();
  if (!row) return null;
  return {
    state: row.state,
    version: Number(row.version),
    entry: JSON.parse(row.doc) as StoredEntry,
    held: heldOf(row.held),
  };
}

export interface Counts {
  taken: boolean;
  trusted: boolean;
  live: number;
  mine: number;
  pending: number;
  myPending: number;
  tombs: number;
  myTombs: number;
}

export async function publishCounts(db: D1Database, handle: string, slug: string): Promise<Counts> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM entries WHERE publisher = ?1 AND slug = ?2) AS taken, ${TRUSTED} AS trusted,
         ${COUNTER('live')} AS live, ${MINE('live')} AS mine, ${COUNTER('pending')} AS pending,
         ${MINE('pending')} AS my_pending, ${COUNTER('tombs')} AS tombs, ${MINE('tombs')} AS my_tombs`,
    )
    .bind(handle, slug)
    .first<Record<string, number>>();
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    taken: !!row?.taken,
    trusted: !!row?.trusted,
    live: n('live'),
    mine: n('mine'),
    pending: n('pending'),
    myPending: n('my_pending'),
    tombs: n('tombs'),
    myTombs: n('my_tombs'),
  };
}

export interface PublishCaps {
  entries: number;
  entriesPerPublisher: number;
  tombstones: number;
  tombstonesPerPublisher: number;
  pending: number;
  pendingPerPublisher: number;
}

// live and pending bytes one publisher may store, and the database size writes stop at
export interface Room {
  live: number;
  pending: number;
  db: number;
}

// the bytes after this batch's own change, so racing writes cannot pass them (IN-06)
const requireRoom = (db: D1Database, p: string, s: string, r: Room): D1PreparedStatement =>
  db
    .prepare(
      `SELECT json_extract('{}', iif(iif((SELECT state FROM entries WHERE publisher = ?1 AND slug = ?2) = 'pending',
         ${MINE('pending_bytes')} <= ?4, ${MINE('bytes - pending_bytes')} <= ?3)
         AND ${COUNTER('bytes')} < ?5, '$', ${OVER})) AS ok`,
    )
    .bind(p, s, r.live, r.pending, r.db);

export interface NewEntry {
  entry: StoredEntry;
  body: string;
  caps: PublishCaps;
  room: Room;
}

// live only for a publisher trusted when the batch commits (D-09)
const STATE_OF = `CASE WHEN ${TRUSTED} = 1 THEN 'live' ELSE 'pending' END`;

// a live entry takes new content only from a trusted publisher; public ids never go back to pending (D-09)
const MAY_CHANGE = "(state = 'pending' OR (SELECT trusted FROM publishers WHERE handle = ?1) = 1)";

// caps and trust are read inside the insert, so racing writes cannot pass them
export function publishStatements(db: D1Database, n: NewEntry): D1PreparedStatement[] {
  const e = n.entry;
  const [p, s] = idOf(e);
  return [
    db
      .prepare(
        `INSERT INTO entries (publisher, slug, kind, state, version, hash, created_at, updated_at, summary, doc, gen, cols)
         SELECT ?1, ?2, ?3, ${STATE_OF}, ?4, ?5, ?6, ?6, ?7, ?8, ${NEXT_GEN}, ?15
         WHERE iif(${TRUSTED} = 1, ${COUNTER('live')} < ?9 AND ${MINE('live')} < ?10,
             ${COUNTER('pending')} < ?13 AND ${MINE('pending')} < ?14)
           AND ${COUNTER('tombs')} < ?11 AND ${MINE('tombs')} < ?12
         RETURNING state`,
      )
      .bind(
        p,
        s,
        e.kind,
        e.version,
        e.hash,
        e.updatedAt,
        entrySummaryText(e),
        entryDocText(e),
        n.caps.entries,
        n.caps.entriesPerPublisher,
        n.caps.tombstones,
        n.caps.tombstonesPerPublisher,
        n.caps.pending,
        n.caps.pendingPerPublisher,
        e.cols ?? null,
      ),
    db.prepare(GUARD),
    db
      .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
      .bind(p, s, e.version, n.body),
    requireRoom(db, p, s, n.room),
    bumpGen(db),
    dirtyIfLive(db, p, s),
  ];
}

export interface NextVersion {
  entry: StoredEntry;
  expected: number;
  expectedHash: string;
  body: string;
  room: Room;
}

// the versions key stops a racing twin, the guarded update a changed or overwritten entry
export function versionStatements(db: D1Database, n: NextVersion): D1PreparedStatement[] {
  const e = n.entry;
  const [p, s] = idOf(e);
  return [
    db
      .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
      .bind(p, s, e.version, n.body),
    db
      .prepare(
        `UPDATE entries SET version = ?3, hash = ?4, updated_at = ?5, summary = ?6, doc = ?7, gen = ${NEXT_GEN},
           cols = ?10
         WHERE publisher = ?1 AND slug = ?2 AND version = ?8 AND hash = ?9 AND ${LIVE} AND ${MAY_CHANGE}`,
      )
      .bind(
        p,
        s,
        e.version,
        e.hash,
        e.updatedAt,
        entrySummaryText(e),
        entryDocText(e),
        n.expected,
        n.expectedHash,
        e.cols ?? null,
      ),
    db.prepare(GUARD),
    requireRoom(db, p, s, n.room),
    bumpGen(db),
    dirtyIfLive(db, p, s),
  ];
}

export interface NewHeld {
  entry: StoredEntry;
  expected: number;
  expectedHash: string;
  body: string;
  room: Room;
  held: Held;
}

// the public entry and the index stay as they are; only the versions row and the held column are written
export function heldStatements(db: D1Database, n: NewHeld): D1PreparedStatement[] {
  const [p, s] = idOf(n.entry);
  return [
    db
      .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
      .bind(p, s, n.entry.version, n.body),
    db
      .prepare(
        `UPDATE entries SET held = ?3
         WHERE publisher = ?1 AND slug = ?2 AND version = ?4 AND hash = ?5 AND state = 'live' AND held IS NULL`,
      )
      .bind(p, s, JSON.stringify(n.held), n.expected, n.expectedHash),
    db.prepare(GUARD),
    requireRoom(db, p, s, n.room),
  ];
}

export interface Overwrite {
  entry: StoredEntry;
  expectedHash: string;
  body: string;
  room: Room;
}

// triggers keep the stored bytes of every body change (0003)
export function overwriteStatements(db: D1Database, n: Overwrite): D1PreparedStatement[] {
  const e = n.entry;
  const [p, s] = idOf(e);
  return [
    db
      .prepare(
        `UPDATE entries SET hash = ?3, updated_at = ?4, summary = ?5, doc = ?6, gen = ${NEXT_GEN}, cols = ?9
         WHERE publisher = ?1 AND slug = ?2 AND version = ?7 AND hash = ?8 AND ${LIVE} AND ${MAY_CHANGE}`,
      )
      .bind(
        p,
        s,
        e.hash,
        e.updatedAt,
        entrySummaryText(e),
        entryDocText(e),
        e.version,
        n.expectedHash,
        e.cols ?? null,
      ),
    db.prepare(GUARD),
    db
      .prepare('UPDATE versions SET body = ?4 WHERE publisher = ?1 AND slug = ?2 AND version = ?3')
      .bind(p, s, e.version, n.body),
    requireRoom(db, p, s, n.room),
    bumpGen(db),
    dirtyIfLive(db, p, s),
  ];
}

const NEWER = 'version > (SELECT version FROM entries WHERE publisher = ?1 AND slug = ?2)';

// tombstone, freed bytes and NULL bodies commit together
export function withdrawStatements(
  db: D1Database,
  tomb: StoredEntry,
  expected: number,
  state: 'withdrawn' | 'removed' = 'withdrawn',
): D1PreparedStatement[] {
  const [p, s] = idOf(tomb);
  return [
    db
      .prepare(
        `UPDATE entries SET state = ?7, updated_at = ?3, summary = ?4, doc = ?5, gen = ${NEXT_GEN}, cols = NULL,
           held = NULL
         WHERE publisher = ?1 AND slug = ?2 AND version = ?6 AND ${LIVE}`,
      )
      .bind(p, s, tomb.updatedAt, entrySummaryText(tomb), entryDocText(tomb), expected, state),
    db.prepare(GUARD),
    db.prepare(`DELETE FROM versions WHERE publisher = ?1 AND slug = ?2 AND ${NEWER}`).bind(p, s),
    db.prepare('UPDATE versions SET body = NULL WHERE publisher = ?1 AND slug = ?2').bind(p, s),
    bumpGen(db),
    markTakedown(db),
  ];
}

// which guard stopped a write batch
export function writeConflict(err: unknown): 'entry' | 'version' | 'guard' | 'quota' | null {
  let msg = '';
  for (let e: unknown = err, i = 0; e instanceof Error && i < 3; e = e.cause, i++) msg += ` ${e.message}`;
  if (msg.includes('UNIQUE constraint failed: entries.')) return 'entry';
  if (msg.includes('UNIQUE constraint failed: versions.')) return 'version';
  if (msg.includes(MISSED)) return 'guard';
  if (msg.includes(OVER)) return 'quota';
  return null;
}

// one salt per UTC day; the first writer wins
export function saltStatements(db: D1Database, day: string, salt: string): D1PreparedStatement[] {
  return [
    db.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?1, ?2)').bind(day, salt),
    db.prepare('SELECT salt FROM salts WHERE day = ?1').bind(day),
  ];
}

export async function bumpRate(db: D1Database, key: string, win: number): Promise<number> {
  const n = await db
    .prepare(
      `INSERT INTO rate (key, win, n) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET n = CASE WHEN ?2 > win THEN 1 WHEN ?2 = win THEN n + 1 ELSE n END, win = max(win, ?2)
       RETURNING CASE WHEN win > ?2 THEN 0 ELSE n END AS n`,
    )
    .bind(key, win)
    .first<number>('n');
  return Number(n);
}

export async function peekRate(db: D1Database, key: string, win: number): Promise<number> {
  const n = await db
    .prepare('SELECT n FROM rate WHERE key = ?1 AND win = ?2')
    .bind(key, win)
    .first<number>('n');
  return Number(n ?? 0);
}

// bounded per call; the rate rows are found through their window index (0004)
export const CLEANUP_BATCH = 500;

export function cleanupStatements(db: D1Database, day: string, win: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM salts WHERE day < ?1').bind(day),
    db
      .prepare('DELETE FROM rate WHERE key IN (SELECT key FROM rate WHERE win < ?1 LIMIT ?2)')
      .bind(win, CLEANUP_BATCH),
  ];
}

// mine is live content only; pending bytes count apart (WR-02)
export async function storageUse(
  db: D1Database,
  handle: string,
): Promise<{ total: number; mine: number; pending: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT n FROM counters WHERE k = 'bytes') AS total,
         (SELECT bytes - pending_bytes FROM publishers WHERE handle = ?1) AS mine,
         (SELECT pending_bytes FROM publishers WHERE handle = ?1) AS pending`,
    )
    .bind(handle)
    .first<{ total: number | null; mine: number | null; pending: number | null }>();
  return { total: Number(row?.total ?? 0), mine: Number(row?.mine ?? 0), pending: Number(row?.pending ?? 0) };
}

// the database size D1 reports after a write; bookkeeping only
export async function noteSize(db: D1Database, results: D1Result[]): Promise<void> {
  const size = Math.max(0, ...results.map((r) => Number(r?.meta?.size_after) || 0));
  if (!Number.isSafeInteger(size) || size <= 0) return;
  try {
    await db.prepare("UPDATE counters SET n = ?1 WHERE k = 'bytes'").bind(size).run();
  } catch {}
}
