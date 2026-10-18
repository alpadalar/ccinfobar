// hand-written Workers types; no workers-types package
import type { CAPS } from '../rules.js';

export interface D1Meta {
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  size_after: number;
  duration: number;
  changed_db?: boolean;
}

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(col: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  DB: D1Database;
  READS?: RateLimit;
  MARKET_NAME?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // weaker: trusts any GitHub token of the user, from any app (R-14)
  ALLOW_UNVERIFIED_GITHUB_TOKENS?: string;
  ADMIN_GITHUB_IDS?: string;
  ALLOW_OVERWRITE?: string;
  MAX_ENTRY_BYTES?: string;
  WRITE_LIMIT?: string;
  SIGNIN_LIMIT?: string;
  REPORT_LIMIT?: string;
  MAX_DB_BYTES?: string;
  PUBLISHER_BYTES?: string;
  PENDING_ENTRIES?: string;
  PENDING_PER_PUBLISHER?: string;
  PENDING_BYTES?: string;
}

export interface WorkerDeps {
  now: () => number;
  fetch: typeof fetch;
  // tests only
  caps?: Partial<typeof CAPS & { versions: number; pending: number; pendingPerPublisher: number }>;
}

// a positive integer var, else null
export function intVar(v: string | undefined): number | null {
  if (!v || !/^[1-9][0-9]{0,15}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

// off unless set exactly (R-14)
export const unverifiedOk = (env: Env): boolean => env.ALLOW_UNVERIFIED_GITHUB_TOKENS === 'true';

// off unless set exactly (R-07)
export const overwriteOn = (env: Env): boolean => env.ALLOW_OVERWRITE === 'true';

// 400 MiB of the 500 MB Free database (R-01)
export const maxDbBytes = (env: Env): number => intVar(env.MAX_DB_BYTES) ?? 419_430_400;

export const publisherBytes = (env: Env): number => intVar(env.PUBLISHER_BYTES) ?? 20_971_520;

// entries waiting for review have small caps of their own (WR-02)
export const pendingCaps = (env: Env): { total: number; perPublisher: number; bytes: number } => ({
  total: intVar(env.PENDING_ENTRIES) ?? 50,
  perPublisher: intVar(env.PENDING_PER_PUBLISHER) ?? 3,
  bytes: intVar(env.PENDING_BYTES) ?? 1_048_576,
});
