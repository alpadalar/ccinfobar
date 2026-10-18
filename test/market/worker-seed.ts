import { createHash, randomBytes } from 'node:crypto';
import type { EntryContent } from '../../src/core/edit.js';
import { canonicalJson, type MarketEntry } from '../../src/market/protocol.js';
import { type StoredEntry, tombOf } from '../../src/market/rules.js';
import type { D1Database } from '../../src/market/worker/env.js';
import {
  bumpGen,
  type EntryState,
  entryDocText,
  entrySummaryText,
  rebuildIndex,
  versionText,
} from '../../src/market/worker/store.js';
import { START } from './conformance.js';

export const ISO = new Date(START).toISOString();

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function seedPublisher(
  db: D1Database,
  p: { handle: string; githubId: number; trusted?: boolean; banned?: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO publishers (handle, github_id, github_login, display_name, trusted, banned_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      p.handle,
      p.githubId,
      p.handle,
      p.handle.toUpperCase(),
      p.trusted ? 1 : 0,
      p.banned ? ISO : null,
      ISO,
    )
    .run();
}

export async function seedToken(db: D1Database, handle: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db
    .prepare('INSERT INTO tokens (sha256, handle, created_at) VALUES (?1, ?2, ?3)')
    .bind(sha256(token), handle, ISO)
    .run();
  return token;
}

export interface SeedVersion {
  content: EntryContent;
  note?: string;
  at?: string;
}

export interface SeedEntry {
  id: string;
  kind?: MarketEntry['kind'];
  state?: EntryState;
  name?: string;
  description?: string;
  author?: string;
  versions: SeedVersion[];
  withdrawnAt?: string;
}

// the entry the reference server would store for the same calls
export function storedEntry(spec: SeedEntry): StoredEntry {
  const [publisher, slug] = spec.id.split('/') as [string, string];
  const versions = spec.versions.map((v, i) => ({
    version: i + 1,
    at: v.at ?? ISO,
    note: v.note ?? '',
    hash: sha256(canonicalJson(v.content)),
  }));
  const last = versions.at(-1)!;
  return {
    id: spec.id,
    kind: spec.kind ?? 'preset',
    name: spec.name ?? `Name ${slug}`,
    description: spec.description ?? 'desc',
    author: spec.author ?? 'Alp',
    publisher,
    version: last.version,
    updatedAt: last.at,
    hash: last.hash,
    versions,
  };
}

export async function seedEntry(
  db: D1Database,
  spec: SeedEntry,
  opts: { rebuild?: boolean } = {},
): Promise<StoredEntry> {
  const [publisher, slug] = spec.id.split('/') as [string, string];
  const state = spec.state ?? 'live';
  const live = storedEntry(spec);
  const gone = state === 'withdrawn' || state === 'removed';
  const doc: StoredEntry = gone ? tombOf(live, spec.withdrawnAt ?? live.updatedAt) : live;
  await db.batch([
    db
      .prepare(
        `INSERT INTO entries (publisher, slug, kind, state, version, hash, created_at, updated_at, summary, doc, gen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, (SELECT n FROM counters WHERE k = 'gen') + 1)`,
      )
      .bind(
        publisher,
        slug,
        doc.kind,
        state,
        doc.version,
        doc.hash,
        live.versions[0]!.at,
        doc.updatedAt,
        entrySummaryText(doc),
        entryDocText(doc),
      ),
    ...spec.versions.map((v, i) =>
      db
        .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
        .bind(
          publisher,
          slug,
          i + 1,
          gone ? null : versionText({ version: i + 1, content: v.content, hash: live.versions[i]!.hash }),
        ),
    ),
    bumpGen(db),
  ]);
  if (opts.rebuild !== false) await rebuildIndex(db, doc.updatedAt);
  return doc;
}

export interface Counts {
  live: number;
  pending: number;
  tombs: number;
  publishers: Record<
    string,
    { live: number; pending: number; tombs: number; bytes: number; pendingBytes: number }
  >;
}

const LEN = 'COALESCE(SUM(length(CAST(v.body AS BLOB))), 0)';

// what the triggers keep, next to a recount of the rows
export async function counts(db: D1Database): Promise<{ kept: Counts; rows: Counts }> {
  const n = async (sql: string) => Number(await db.prepare(sql).first('n'));
  const per = async (sql: string) =>
    Object.fromEntries(
      (await db.prepare(sql).all<Record<string, number | string>>()).results.map((r) => [
        String(r.h),
        {
          live: Number(r.live),
          pending: Number(r.pending),
          tombs: Number(r.tombs),
          bytes: Number(r.bytes),
          pendingBytes: Number(r.pending_bytes),
        },
      ]),
    );
  const kept: Counts = {
    live: await n("SELECT n FROM counters WHERE k = 'live'"),
    pending: await n("SELECT n FROM counters WHERE k = 'pending'"),
    tombs: await n("SELECT n FROM counters WHERE k = 'tombs'"),
    publishers: await per('SELECT handle AS h, live, pending, tombs, bytes, pending_bytes FROM publishers'),
  };
  const rows: Counts = {
    live: await n("SELECT COUNT(*) AS n FROM entries WHERE state = 'live'"),
    pending: await n("SELECT COUNT(*) AS n FROM entries WHERE state = 'pending'"),
    tombs: await n("SELECT COUNT(*) AS n FROM entries WHERE state IN ('withdrawn', 'removed')"),
    publishers: await per(
      `SELECT p.handle AS h,
         (SELECT COUNT(*) FROM entries e WHERE e.publisher = p.handle AND e.state = 'live') AS live,
         (SELECT COUNT(*) FROM entries e WHERE e.publisher = p.handle AND e.state = 'pending') AS pending,
         (SELECT COUNT(*) FROM entries e WHERE e.publisher = p.handle AND e.state IN ('withdrawn', 'removed'))
           AS tombs,
         (SELECT ${LEN} FROM versions v WHERE v.publisher = p.handle) AS bytes,
         (SELECT ${LEN} FROM versions v JOIN entries e ON e.publisher = v.publisher AND e.slug = v.slug
           WHERE v.publisher = p.handle AND e.state = 'pending') AS pending_bytes
       FROM publishers p`,
    ),
  };
  return { kept, rows };
}
