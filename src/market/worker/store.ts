// all SQL of the Worker; bound parameters only
import {
  type HeldInfo,
  INDEX_PAGE,
  indexFile,
  MAX_INDEX,
  type MarketSummary,
  type MarketVersion,
  type MeEntry,
} from '../protocol.js';
import { type StoredEntry, toSummary } from '../rules.js';
import type { D1Database, D1PreparedStatement, D1Result } from './env.js';

export type EntryState = 'pending' | 'live' | 'withdrawn' | 'removed';

export const EMPTY_INDEX = '{"entries":[]}';

// compact, the same text the reference server writes
export const summaryText = (s: MarketSummary): string => JSON.stringify(s);
export const entryDocText = (e: StoredEntry): string => JSON.stringify(e);
export const versionText = (v: MarketVersion): string =>
  JSON.stringify({ version: v.version, content: v.content, hash: v.hash });
export const entrySummaryText = (e: StoredEntry): string => summaryText(toSummary(e));

export const bumpGen = (db: D1Database): D1PreparedStatement =>
  db.prepare("UPDATE counters SET n = n + 1 WHERE k = 'gen'");

// a write the index must show leaves its generation; a rebuild catches up to it (WR-03)
const DIRTY = "UPDATE counters SET n = (SELECT n FROM counters WHERE k = 'gen') WHERE k = 'dirty'";
export const markDirty = (db: D1Database): D1PreparedStatement => db.prepare(DIRTY);
// withdraw, remove and ban: their rebuild never waits for the budget
const markTakedown = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "UPDATE counters SET n = (SELECT n FROM counters WHERE k = 'gen') WHERE k IN ('dirty', 'takedown')",
  );
const dirtyIfLive = (db: D1Database, p: string, s: string): D1PreparedStatement =>
  db
    .prepare(`${DIRTY} AND (SELECT state FROM entries WHERE publisher = ?1 AND slug = ?2) = 'live'`)
    .bind(p, s);

// summaries are already JSON text, so pages are joined, never re-stringified
export function pageBodies(summaries: string[], iso: string, gen: number): string[] {
  const pages = Math.max(1, Math.ceil(summaries.length / INDEX_PAGE));
  const at = `${JSON.stringify(iso)},"gen":${gen}`;
  const out: string[] = [];
  for (let n = 1; n <= pages; n++) {
    const list = summaries.slice((n - 1) * INDEX_PAGE, n * INDEX_PAGE).join(',');
    const next = n < pages ? `,"next":${JSON.stringify(indexFile(n + 1))}` : '';
    out.push(`{"entries":[${list}],"generatedAt":${at}${next}}`);
  }
  return out;
}

// an older rebuild never replaces or adds pages once a newer one is stored
export function pageStatements(db: D1Database, bodies: string[], gen: number): D1PreparedStatement[] {
  const put = db.prepare(
    `INSERT INTO index_pages (page, gen, body)
     SELECT ?1, ?2, ?3 WHERE ?2 >= (SELECT COALESCE(MAX(gen), 0) FROM index_pages)
     ON CONFLICT(page) DO UPDATE SET gen = excluded.gen, body = excluded.body WHERE excluded.gen > index_pages.gen`,
  );
  return [
    ...bodies.map((b, i) => put.bind(i + 1, gen, b)),
    db.prepare('DELETE FROM index_pages WHERE page > ?1 AND gen < ?2').bind(bodies.length, gen),
  ];
}

// tombstones stay out, like the reference index; banned publishers too; one covering index read
export async function rebuildIndex(db: D1Database, iso: string, now = Date.parse(iso)): Promise<void> {
  const [gen, rows] = await db.batch([
    db.prepare("SELECT n FROM counters WHERE k = 'gen'"),
    db
      .prepare(
        `SELECT summary FROM entries INDEXED BY entries_live
         WHERE state = 'live' AND publisher NOT IN (SELECT handle FROM publishers WHERE banned_at IS NOT NULL)
         ORDER BY publisher, slug LIMIT ?1`,
      )
      .bind(MAX_INDEX),
  ]);
  const n = Number((gen?.results[0] as { n?: number } | undefined)?.n ?? 0);
  const summaries = (rows?.results ?? []).map((r) => String((r as { summary: string }).summary));
  const day = Math.floor(now / 86_400_000);
  await db.batch([
    ...pageStatements(db, pageBodies(summaries, iso, n), n),
    // the rows this rebuild read, toward today's budget
    db
      .prepare(
        `UPDATE counters SET n = iif((SELECT n FROM counters WHERE k = 'rebuild_day') = ?1, n, 0) + ?2
         WHERE k = 'rebuild_rows'`,
      )
      .bind(day, summaries.length + 1),
    db
      .prepare(
        "UPDATE counters SET n = iif(k = 'rebuild_day', ?1, ?2) WHERE k IN ('rebuild_day', 'rebuilt_at')",
      )
      .bind(day, now),
    releaseRebuild(db, now),
  ]);
}

// the lease of the rebuild that started at now, if still held
export const releaseRebuild = (db: D1Database, now: number): D1PreparedStatement =>
  db.prepare("UPDATE counters SET n = 0 WHERE k = 'rebuilding' AND n = ?1").bind(now);

export interface RebuildClaim {
  // a takedown or the cron: the budget does not apply
  free: boolean;
  day: number;
  budget: number;
  gapMs: number;
  leaseMs: number;
}

// one atomic claim, so concurrent requests cannot all pass the budget or run side by side
export async function claimRebuild(db: D1Database, now: number, c: RebuildClaim): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE counters SET n = ?1 WHERE k = 'rebuilding' AND (n = 0 OR n < ?1 - ?2)
         AND (?3 = 1 OR ${COUNTER('rebuild_day')} <> ?4 OR ${COUNTER('rebuild_rows')} < ?5
           OR ${COUNTER('rebuilt_at')} <= ?1 - ?6)
       RETURNING n`,
    )
    .bind(now, c.leaseMs, c.free ? 1 : 0, c.day, c.budget, c.gapMs)
    .first();
  return row !== null;
}

export interface IndexState {
  dirty: number;
  takedown: number;
  built: number;
  day: number;
  rows: number;
  at: number;
}

export async function indexState(db: D1Database): Promise<IndexState> {
  const row = await db
    .prepare(
      `SELECT ${COUNTER('dirty')} AS dirty, ${COUNTER('takedown')} AS takedown, COALESCE((SELECT gen FROM index_pages WHERE page = 1), 0) AS built,
         ${COUNTER('rebuild_day')} AS day, ${COUNTER('rebuild_rows')} AS rows, ${COUNTER('rebuilt_at')} AS at`,
    )
    .first<Record<string, number>>();
  const n = (k: string) => Number(row?.[k] ?? 0);
  return {
    dirty: n('dirty'),
    takedown: n('takedown'),
    built: n('built'),
    day: n('day'),
    rows: n('rows'),
    at: n('at'),
  };
}

export const indexTag = (gen: number): string => `"g${gen}"`;

export async function indexEtag(db: D1Database, n = 1): Promise<string | null> {
  const gen = await db.prepare('SELECT gen FROM index_pages WHERE page = ?1').bind(n).first<number>('gen');
  if (gen === null) return n === 1 ? indexTag(0) : null;
  return indexTag(Number(gen));
}

export async function readIndexPage(
  db: D1Database,
  n: number,
): Promise<{ body: string; etag: string } | null> {
  const row = await db
    .prepare('SELECT gen, body FROM index_pages WHERE page = ?1')
    .bind(n)
    .first<{ gen: number; body: string }>();
  if (!row) return n === 1 ? { body: EMPTY_INDEX, etag: indexTag(0) } : null;
  return { body: row.body, etag: indexTag(Number(row.gen)) };
}

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

export async function tokenPublisher(
  db: D1Database,
  digest: string,
): Promise<{ handle: string; githubId: number; trusted: boolean; banned: boolean } | null> {
  const row = await db
    .prepare(
      `SELECT p.handle AS handle, p.github_id AS github_id, p.trusted AS trusted,
         p.banned_at IS NOT NULL AS banned
       FROM tokens t JOIN publishers p ON p.handle = t.handle WHERE t.sha256 = ?1`,
    )
    .bind(digest)
    .first<{ handle: string; github_id: number; trusted: number; banned: number }>();
  if (!row) return null;
  return {
    handle: String(row.handle),
    githubId: Number(row.github_id),
    trusted: !!row.trusted,
    banned: !!row.banned,
  };
}

// a trusted publisher's next version waiting for link review (17-D-02)
export interface Held {
  version: number;
  hash: string;
  at: string;
  reason: 'new-link';
  links: string[];
  summary: string;
  doc: string;
}

const heldOf = (v: unknown): Held | null => {
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

const LIVE = "state IN ('live', 'pending')";

// trigger-kept counts (0002, 0003), so no cap check counts rows; pending has its own caps (WR-02)
const COUNTER = (k: string) => `COALESCE((SELECT n FROM counters WHERE k = '${k}'), 0)`;
const MINE = (col: string) => `COALESCE((SELECT ${col} FROM publishers WHERE handle = ?1), 0)`;
const TRUSTED = MINE('trusted');

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

// fails the batch when the statement before it changed nothing
const GUARD = "SELECT json_extract(CASE WHEN changes() = 0 THEN 'x' ELSE '{}' END, '$') AS ok";
const MISSED = 'malformed JSON';
// a storage cap fails with another message
const OVER = "'over-quota'";

const NEXT_GEN = "(SELECT n FROM counters WHERE k = 'gen') + 1";

const idOf = (e: StoredEntry): [string, string] => [e.publisher, e.id.slice(e.publisher.length + 1)];

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

const NEWER_OF =
  'version > (SELECT e.version FROM entries e WHERE e.publisher = versions.publisher AND e.slug = versions.slug)';
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
       ON CONFLICT(key) DO UPDATE SET n = CASE WHEN win = ?2 THEN n + 1 ELSE 1 END, win = ?2
       RETURNING n`,
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

export interface Account {
  handle: string;
  githubId: number;
  login: string;
  displayName: string;
  trusted: boolean;
  banned: boolean;
}

const ACCOUNT_COLS = `p.handle AS handle, p.github_id AS github_id, p.github_login AS login,
  p.display_name AS display_name, p.trusted AS trusted, p.banned_at IS NOT NULL AS banned`;
const RETURN_ACCOUNT = ACCOUNT_COLS.replace(/\bp\./g, '');

type AccountRow = {
  handle: string;
  github_id: number;
  login: string;
  display_name: string;
  trusted: number;
  banned: number;
};

const toAccount = (r: AccountRow): Account => ({
  handle: String(r.handle),
  githubId: Number(r.github_id),
  login: String(r.login),
  displayName: String(r.display_name),
  trusted: !!r.trusted,
  banned: !!r.banned,
});

export async function accountByToken(db: D1Database, digest: string): Promise<Account | null> {
  const row = await db
    .prepare(
      `SELECT ${ACCOUNT_COLS} FROM tokens t JOIN publishers p ON p.handle = t.handle WHERE t.sha256 = ?1`,
    )
    .bind(digest)
    .first<AccountRow>();
  return row ? toAccount(row) : null;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
}

// a known id keeps its handle; login and name follow GitHub
export async function knownAccount(db: D1Database, u: GitHubUser): Promise<Account | null> {
  const row = await db
    .prepare(
      `UPDATE publishers SET github_login = ?2, display_name = ?3 WHERE github_id = ?1
       RETURNING ${RETURN_ACCOUNT}`,
    )
    .bind(u.id, u.login, u.name)
    .first<AccountRow>();
  return row ? toAccount(row) : null;
}

// 'taken' when the handle is, 'full' at the publishers cap; a racing insert of the same id wins
export async function claimHandle(
  db: D1Database,
  u: GitHubUser,
  handle: string,
  iso: string,
  cap: number,
): Promise<Account | 'taken' | 'full'> {
  const [, row, count] = await db.batch([
    db
      .prepare(
        `INSERT INTO publishers (handle, github_id, github_login, display_name, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${COUNTER('publishers')} < ?6 ON CONFLICT DO NOTHING`,
      )
      .bind(handle, u.id, u.login, u.name, iso, cap),
    db.prepare(`SELECT ${ACCOUNT_COLS} FROM publishers p WHERE p.github_id = ?1`).bind(u.id),
    db.prepare(`SELECT ${COUNTER('publishers')} AS n`),
  ]);
  const r = row?.results[0] as AccountRow | undefined;
  if (r) return toAccount(r);
  return Number((count?.results[0] as { n?: number } | undefined)?.n ?? 0) >= cap ? 'full' : 'taken';
}

// the new token always stays, even when timestamps tie
export function tokenStatements(
  db: D1Database,
  handle: string,
  digest: string,
  iso: string,
  keep: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare('INSERT INTO tokens (sha256, handle, created_at) VALUES (?1, ?2, ?3)')
      .bind(digest, handle, iso),
    db
      .prepare(
        `DELETE FROM tokens WHERE handle = ?1 AND sha256 NOT IN
         (SELECT sha256 FROM tokens WHERE handle = ?1 ORDER BY sha256 = ?2 DESC, created_at DESC LIMIT ?3)`,
      )
      .bind(handle, digest, keep),
  ];
}

export async function deleteToken(db: D1Database, digest: string): Promise<boolean> {
  const row = await db.prepare('DELETE FROM tokens WHERE sha256 = ?1 RETURNING handle').bind(digest).first();
  return row !== null;
}

export async function myEntries(db: D1Database, handle: string, cap: number): Promise<MeEntry[]> {
  const rows = await db
    .prepare(
      `SELECT slug, state, version, cols, json_extract(held, '$.version') AS held
       FROM entries INDEXED BY entries_by_state
       WHERE publisher = ?1 AND ${LIVE} ORDER BY slug LIMIT ?2`,
    )
    .bind(handle, cap)
    .all<{
      slug: string;
      state: 'pending' | 'live';
      version: number;
      cols: number | null;
      held: number | null;
    }>();
  return rows.results.map((r) => {
    const e: MeEntry = { id: `${handle}/${r.slug}`, state: r.state, version: Number(r.version) };
    if (typeof r.cols === 'number') e.cols = r.cols;
    if (r.state === 'live' && typeof r.held === 'number') e.held = r.held;
    return e;
  });
}

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
    doc: String(row.doc),
    body: (held ? row.held_body : row.body) ?? null,
    tag: reviewTag(held ? held.hash : String(row.hash), Number(row.gen)),
  };
  if (held) out.held = held.version;
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

// fails the batch unless the condition holds inside it
const requireSql = (cond: string): string =>
  `SELECT json_extract(CASE WHEN ${cond} THEN '{}' ELSE 'x' END, '$') AS ok`;

// an unbanned publisher holds the token
const HOLDER = `SELECT 1 FROM tokens t JOIN publishers p ON p.handle = t.handle
  WHERE t.sha256 = ?1 AND p.banned_at IS NULL`;
const ACTOR = `EXISTS (${HOLDER})`;

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
