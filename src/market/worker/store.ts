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
