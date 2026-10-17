// all SQL of the Worker; bound parameters only
import { INDEX_PAGE, indexFile, MAX_INDEX, type MarketSummary, type MarketVersion } from '../protocol.js';
import { type StoredEntry, toSummary } from '../rules.js';
import type { D1Database, D1PreparedStatement } from './env.js';

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

// tombstones stay out, like the reference index; banned publishers too
export async function rebuildIndex(db: D1Database, iso: string): Promise<void> {
  const [gen, rows] = await db.batch([
    db.prepare("SELECT n FROM counters WHERE k = 'gen'"),
    db
      .prepare(
        `SELECT summary FROM entries
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

export async function publishCounts(
  db: D1Database,
  handle: string,
  slug: string,
): Promise<{ taken: boolean; live: number; mine: number }> {
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM entries WHERE publisher = ?1 AND slug = ?2) AS taken,
         (SELECT COUNT(*) FROM entries WHERE ${LIVE}) AS live,
         (SELECT COUNT(*) FROM entries WHERE publisher = ?1 AND ${LIVE}) AS mine`,
    )
    .bind(handle, slug)
    .first<{ taken: number; live: number; mine: number }>();
  return { taken: !!row?.taken, live: Number(row?.live ?? 0), mine: Number(row?.mine ?? 0) };
}

// fails the batch when the statement before it changed nothing
const GUARD = "SELECT json_extract(CASE WHEN changes() = 0 THEN 'x' ELSE '{}' END, '$') AS ok";
const MISSED = 'malformed JSON';

const NEXT_GEN = "(SELECT n FROM counters WHERE k = 'gen') + 1";

const addBytes = (db: D1Database, handle: string, bytes: number): D1PreparedStatement =>
  db.prepare('UPDATE publishers SET bytes = bytes + ?2 WHERE handle = ?1').bind(handle, bytes);

export interface NewEntry {
  entry: StoredEntry;
  state: EntryState;
  body: string;
  bytes: number;
  caps: { entries: number; entriesPerPublisher: number };
}

// caps are checked again inside the insert, so racing publishes cannot pass them
export function publishStatements(db: D1Database, n: NewEntry): D1PreparedStatement[] {
  const e = n.entry;
  const [p, s] = [e.publisher, e.id.slice(e.publisher.length + 1)];
  return [
    db
      .prepare(
        `INSERT INTO entries (publisher, slug, kind, state, version, hash, created_at, updated_at, summary, doc, gen)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ${NEXT_GEN}
         WHERE (SELECT COUNT(*) FROM entries WHERE ${LIVE}) < ?10
           AND (SELECT COUNT(*) FROM entries WHERE publisher = ?1 AND ${LIVE}) < ?11`,
      )
      .bind(
        p,
        s,
        e.kind,
        n.state,
        e.version,
        e.hash,
        e.updatedAt,
        entrySummaryText(e),
        entryDocText(e),
        n.caps.entries,
        n.caps.entriesPerPublisher,
      ),
    db.prepare(GUARD),
    db
      .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
      .bind(p, s, e.version, n.body),
    addBytes(db, p, n.bytes),
    bumpGen(db),
  ];
}

export interface NextVersion {
  entry: StoredEntry;
  expected: number;
  body: string;
  bytes: number;
}

// the versions key stops a racing twin, the guarded update a changed entry
export function versionStatements(db: D1Database, n: NextVersion): D1PreparedStatement[] {
  const e = n.entry;
  const [p, s] = [e.publisher, e.id.slice(e.publisher.length + 1)];
  return [
    db
      .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
      .bind(p, s, e.version, n.body),
    db
      .prepare(
        `UPDATE entries SET version = ?3, hash = ?4, updated_at = ?5, summary = ?6, doc = ?7, gen = ${NEXT_GEN}
         WHERE publisher = ?1 AND slug = ?2 AND version = ?8 AND ${LIVE}`,
      )
      .bind(p, s, e.version, e.hash, e.updatedAt, entrySummaryText(e), entryDocText(e), n.expected),
    db.prepare(GUARD),
    addBytes(db, p, n.bytes),
    bumpGen(db),
  ];
}

// which guard stopped a write batch
export function writeConflict(err: unknown): 'entry' | 'version' | 'guard' | null {
  let msg = '';
  for (let e: unknown = err, i = 0; e instanceof Error && i < 3; e = e.cause, i++) msg += ` ${e.message}`;
  if (msg.includes('UNIQUE constraint failed: entries.')) return 'entry';
  if (msg.includes('UNIQUE constraint failed: versions.')) return 'version';
  if (msg.includes(MISSED)) return 'guard';
  return null;
}
