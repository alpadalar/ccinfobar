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
  ADMIN_GITHUB_IDS?: string;
  ALLOW_OVERWRITE?: string;
  MAX_ENTRY_BYTES?: string;
  WRITE_LIMIT?: string;
  SIGNIN_LIMIT?: string;
  REPORT_LIMIT?: string;
  MAX_DB_BYTES?: string;
  PUBLISHER_BYTES?: string;
}

export interface WorkerDeps {
  now: () => number;
  fetch: typeof fetch;
  // tests only
  caps?: Partial<typeof CAPS>;
}

// a positive integer var, else null
export function intVar(v: string | undefined): number | null {
  if (!v || !/^[1-9][0-9]{0,15}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}
