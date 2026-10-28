import type { Credited, SessionRow } from '../data/ledger.js';
import type { LoadResult } from './config.js';
import type { priceFor, requestCost } from './prices.js';
import type { ProfileVendor } from './profiles.js';
import type { Config } from './types.js';

export const IDLE_CAP_MS = 300_000;
export const MAX_REPORT_LINE = 16 * 1024 * 1024;
export const MAX_REPORT_FILES = 100_000;

export type FileKind = 'main' | 'agent' | 'aside';

// usd is the sum of entry costUSD, only in buckets whose key ends with |1
export interface Bucket {
  in: number;
  out: number;
  cr: number;
  w5: number;
  w1: number;
  n: number;
  usd: number;
}

// k: 53-bit key hash, b: bucket key
export interface RecentReq {
  k: number;
  b: string;
  in: number;
  out: number;
  cr: number;
  w5: number;
  w1: number;
  usd: number | null;
}

export interface FileEntry {
  kind: FileKind;
  sid: string;
  enc: string;
  id: string | null;
  size: number;
  mtimeMs: number;
  offset: number;
  tail: string;
  gone: boolean;
  cwd: string | null;
  buckets: Record<string, Bucket>;
  time: Record<string, number>;
  lastTs: number | null;
  horizon: number;
  recent: RecentReq[];
  skipped: number;
  // first entry timestamp and birth time decide which copy owns a request
  first: number | null;
  born: number;
  // gone file kept while the key set was lost
  lost: boolean;
  // time zone its days were cut in
  tz: string;
  // cwd in its own letter case when the key folds it
  shown: string | null;
}

// files keyed by relPath with / separators; owners maps key hash to the owning relPath
export interface IndexState {
  v: 1;
  files: Record<string, FileEntry>;
  owners: Map<number, string>;
}

export interface SessionData {
  sid: string;
  enc: string;
  cwd: string | null;
  shown?: string | null;
  buckets: Record<string, Bucket>;
  time: Record<string, number>;
  files: number;
  gone: boolean;
}

export type ScanNoteCode =
  | 'file-cap'
  | 'line-skipped'
  | 'deleted-transcripts'
  | 'rebuild-kept'
  | 'keys-lost'
  | 'old-zone';

export interface ScanNote {
  code: ScanNoteCode;
  count: number;
}

export interface LedgerSession {
  a: string;
  p: string;
  first: number;
  firstT: number;
  total: number;
  days: Record<string, number>;
}

export interface ScanResult {
  claudeDir: string;
  sessions: Record<string, SessionData>;
  ledger: Record<string, LedgerSession>;
  projectNames?: Map<string, string>;
  ledgerSince: number | null;
  notes: ScanNote[];
  files: number;
  bytesRead: number;
}

export type Period = 'day' | 'week' | 'month';

export const LEDGER_ZERO_USD = 0.005;

export type CostSource = 'ledger' | 'transcript' | 'mixed' | null;

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ReportRow {
  period: string;
  project: string;
  approx: boolean;
  sessions: number;
  tokens: Tokens | null;
  costUsd: number | null;
  costSource: CostSource;
  partial: boolean;
  activeMs: number | null;
  // some sessions of the row have no transcript, so tokens and time are low
  tokensPartial?: boolean;
  costOther?: Record<string, number>;
}

export type NoteCode =
  | 'estimate'
  | 'ledger-since'
  | 'unpriced'
  | 'non-usd'
  | 'partial'
  | 'profile-price'
  | 'approx-project'
  | 'ledger-only'
  | 'tokens-partial'
  | ScanNoteCode;

export interface ReportNote {
  code: NoteCode;
  params?: Record<string, string | number>;
}

// subtotal rows have project '', the total row has period '' and project ''
export interface Report {
  period: Period;
  since: string | null;
  until: string | null;
  rows: ReportRow[];
  subtotals: ReportRow[];
  total: ReportRow | null;
  unpriced: { models: string[]; requests: number };
  ledgerSince: string | null;
  pricesUpdated: string;
  notes: ReportNote[];
}

// cwd: the longest known project root that is cwd or contains it
export type ProjectFilter = { kind: 'substring'; text: string } | { kind: 'cwd'; cwd: string };

export interface RangeInput {
  period?: string | boolean;
  since?: string | boolean;
  until?: string | boolean;
  all?: boolean;
}

export interface PriceDeps {
  priceFor: typeof priceFor;
  requestCost: typeof requestCost;
  updated: string;
}

export interface PriceBuiltins {
  vendors: readonly ProfileVendor[];
  globMatch(glob: string, text: string): boolean;
}

// render-path helpers handed in by cli/main.ts, so report code shares no render chunk (D-33)
export interface ReportDeps {
  loadConfig(file: string): LoadResult;
  applyLanguage(config: Config): unknown;
  ledgerDir(env: NodeJS.ProcessEnv): string;
  monthFiles(dir: string): string[];
  projectHash(root: string): string;
  stepText(rows: Record<string, SessionRow>, text: string, on: (c: Credited) => void): void;
  rebuildSummary(env: NodeJS.ProcessEnv, now: number): unknown;
  accountKeysForDir(env: NodeJS.ProcessEnv): Set<string>;
  profiles: PriceBuiltins;
  prices: PriceDeps;
}

export type LedgerDeps = Pick<
  ReportDeps,
  'ledgerDir' | 'monthFiles' | 'stepText' | 'accountKeysForDir' | 'projectHash'
>;
