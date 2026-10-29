import { INDEX_PAGE, indexFile, MAX_INDEX, type MarketSummary, type MarketVersion } from '../protocol.js';
import { type StoredEntry, toSummary } from '../rules.js';
import type { D1Database, D1PreparedStatement } from './env.js';
import { COUNTER, DIRTY } from './store-sql.js';

export const EMPTY_INDEX = '{"entries":[]}';

// compact, the same text the reference server writes
export const summaryText = (s: MarketSummary): string => JSON.stringify(s);
export const entryDocText = (e: StoredEntry): string => JSON.stringify(e);
export const versionText = (v: MarketVersion): string =>
  JSON.stringify({ version: v.version, content: v.content, hash: v.hash });
export const entrySummaryText = (e: StoredEntry): string => summaryText(toSummary(e));

export const bumpGen = (db: D1Database): D1PreparedStatement =>
  db.prepare("UPDATE counters SET n = n + 1 WHERE k = 'gen'");

export const markDirty = (db: D1Database): D1PreparedStatement => db.prepare(DIRTY);

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
