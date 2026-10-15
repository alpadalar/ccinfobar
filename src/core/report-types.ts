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
  buckets: Record<string, Bucket>;
  time: Record<string, number>;
  files: number;
  gone: boolean;
}

export type ScanNoteCode = 'file-cap' | 'line-skipped' | 'deleted-transcripts' | 'rebuild-kept';

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
  ledgerSince: number | null;
  notes: ScanNote[];
  files: number;
  bytesRead: number;
}
