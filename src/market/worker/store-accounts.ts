import type { MeEntry } from '../protocol.js';
import type { D1Database, D1PreparedStatement } from './env.js';
import { COUNTER, LIVE } from './store-sql.js';

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
