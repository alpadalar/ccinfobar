// all SQL of the Worker; bound parameters only
import { INDEX_PAGE, indexFile, MAX_INDEX, type MarketSummary, type MarketVersion } from '../protocol.js';
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

// summaries are already JSON text, so pages are joined, never re-stringified
export function pageBodies(summaries: string[], iso: string): string[] {
  const pages = Math.max(1, Math.ceil(summaries.length / INDEX_PAGE));
  const at = JSON.stringify(iso);
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
export async function rebuildIndex(db: D1Database, iso: string): Promise<void> {
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
  await db.batch(pageStatements(db, pageBodies(summaries, iso), n));
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

export interface EntryRow {
  state: EntryState;
  version: number;
  entry: StoredEntry;
}

export async function readEntryRow(db: D1Database, p: string, s: string): Promise<EntryRow | null> {
  const row = await db
    .prepare('SELECT state, version, doc FROM entries WHERE publisher = ?1 AND slug = ?2')
    .bind(p, s)
    .first<{ state: EntryState; version: number; doc: string }>();
  if (!row) return null;
  return { state: row.state, version: Number(row.version), entry: JSON.parse(row.doc) as StoredEntry };
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

// live and pending bytes one publisher may store
export interface Room {
  live: number;
  pending: number;
}

// the bytes after this batch's own change, so racing writes cannot pass them (IN-06)
const requireRoom = (db: D1Database, p: string, s: string, r: Room): D1PreparedStatement =>
  db
    .prepare(
      `SELECT json_extract('{}', iif(iif((SELECT state FROM entries WHERE publisher = ?1 AND slug = ?2) = 'pending',
         ${MINE('pending_bytes')} <= ?4, ${MINE('bytes - pending_bytes')} <= ?3), '$', ${OVER})) AS ok`,
    )
    .bind(p, s, r.live, r.pending);

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
        `INSERT INTO entries (publisher, slug, kind, state, version, hash, created_at, updated_at, summary, doc, gen)
         SELECT ?1, ?2, ?3, ${STATE_OF}, ?4, ?5, ?6, ?6, ?7, ?8, ${NEXT_GEN}
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
      ),
    db.prepare(GUARD),
    db
      .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
      .bind(p, s, e.version, n.body),
    requireRoom(db, p, s, n.room),
    bumpGen(db),
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
        `UPDATE entries SET version = ?3, hash = ?4, updated_at = ?5, summary = ?6, doc = ?7, gen = ${NEXT_GEN}
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
      ),
    db.prepare(GUARD),
    requireRoom(db, p, s, n.room),
    bumpGen(db),
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
        `UPDATE entries SET hash = ?3, updated_at = ?4, summary = ?5, doc = ?6, gen = ${NEXT_GEN}
         WHERE publisher = ?1 AND slug = ?2 AND version = ?7 AND hash = ?8 AND ${LIVE} AND ${MAY_CHANGE}`,
      )
      .bind(p, s, e.hash, e.updatedAt, entrySummaryText(e), entryDocText(e), e.version, n.expectedHash),
    db.prepare(GUARD),
    db
      .prepare('UPDATE versions SET body = ?4 WHERE publisher = ?1 AND slug = ?2 AND version = ?3')
      .bind(p, s, e.version, n.body),
    requireRoom(db, p, s, n.room),
    bumpGen(db),
  ];
}

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
        `UPDATE entries SET state = ?7, updated_at = ?3, summary = ?4, doc = ?5, gen = ${NEXT_GEN}
         WHERE publisher = ?1 AND slug = ?2 AND version = ?6 AND ${LIVE}`,
      )
      .bind(p, s, tomb.updatedAt, entrySummaryText(tomb), entryDocText(tomb), expected, state),
    db.prepare(GUARD),
    db.prepare('UPDATE versions SET body = NULL WHERE publisher = ?1 AND slug = ?2').bind(p, s),
    bumpGen(db),
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

export function cleanupStatements(db: D1Database, day: string, win: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM salts WHERE day < ?1').bind(day),
    db.prepare('DELETE FROM rate WHERE win < ?1').bind(win),
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

export async function myEntries(
  db: D1Database,
  handle: string,
  cap: number,
): Promise<{ id: string; state: 'pending' | 'live'; version: number }[]> {
  const rows = await db
    .prepare(
      `SELECT slug, state, version FROM entries WHERE publisher = ?1 AND ${LIVE} ORDER BY slug LIMIT ?2`,
    )
    .bind(handle, cap)
    .all<{ slug: string; state: 'pending' | 'live'; version: number }>();
  return rows.results.map((r) => ({ id: `${handle}/${r.slug}`, state: r.state, version: Number(r.version) }));
}

export interface LogRow {
  at: string;
  admin: string;
  action: string;
  target: string;
  note: string;
}

export const logStatement = (db: D1Database, l: LogRow): D1PreparedStatement =>
  db
    .prepare('INSERT INTO moderation (at, admin, action, target, note) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(l.at, l.admin, l.action, l.target, l.note);

const PENDING_LIST = `SELECT summary, created_at FROM entries WHERE state = 'pending'
  ORDER BY created_at, publisher, slug LIMIT ?1`;

export async function pendingEntries(
  db: D1Database,
  cap: number,
): Promise<{ summary: string; at: string }[]> {
  const rows = await db.prepare(PENDING_LIST).bind(cap).all<{ summary: string; created_at: string }>();
  return rows.results.map((r) => ({ summary: String(r.summary), at: String(r.created_at) }));
}

export interface ReviewRow {
  state: EntryState;
  doc: string;
  body: string | null;
  // the entry revision the admin reviewed
  tag: string;
}

export const reviewTag = (hash: string, gen: number): string => `"${hash}-${gen}"`;

export async function reviewRow(db: D1Database, p: string, s: string): Promise<ReviewRow | null> {
  const row = await db
    .prepare(
      `SELECT e.state AS state, e.doc AS doc, e.hash AS hash, e.gen AS gen, v.body AS body FROM entries e
       LEFT JOIN versions v ON v.publisher = e.publisher AND v.slug = e.slug AND v.version = e.version
       WHERE e.publisher = ?1 AND e.slug = ?2`,
    )
    .bind(p, s)
    .first<{ state: EntryState; doc: string; hash: string; gen: number; body: string | null }>();
  if (!row) return null;
  return {
    state: row.state,
    doc: String(row.doc),
    body: row.body ?? null,
    tag: reviewTag(String(row.hash), Number(row.gen)),
  };
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
): D1PreparedStatement[] {
  return [
    gate,
    db
      .prepare(
        `UPDATE entries SET state = 'live', gen = ${NEXT_GEN}
         WHERE publisher = ?1 AND slug = ?2 AND state = 'pending' AND hash = ?3 AND gen = ?4`,
      )
      .bind(p, s, pin.hash, pin.gen),
    db.prepare(GUARD),
    db.prepare('UPDATE publishers SET trusted = 1 WHERE handle = ?1').bind(p),
    db.prepare(`UPDATE versions SET body = NULL WHERE publisher = ?1 AND slug = ?2 AND ${OLDER}`).bind(p, s),
    logStatement(db, log),
    bumpGen(db),
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
