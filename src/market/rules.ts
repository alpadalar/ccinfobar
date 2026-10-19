// pure server rules shared by the reference server and the Worker
import {
  ID_PART_RE,
  type MarketEntry,
  type MarketSummary,
  type MarketVersionInfo,
  RESPONSE_CAPS,
} from './protocol.js';

export const MAX_VERSIONS = 5000;
export const WINDOW_MS = 60_000;
export const READS_FACTOR = 20;
export const WRITES_PER_MINUTE = 30;
// live entries and tombstones have their own caps, so publish and withdraw cannot loop forever
export const CAPS = {
  publishers: 10_000,
  entries: 5000,
  entriesPerPublisher: 200,
  tombstones: 50_000,
  tombstonesPerPublisher: 1000,
};
export const REGISTERS_PER_MINUTE = 5;
export const TOKEN_RE = /^Bearer ([0-9a-f]{64})$/;
export const DIGEST_RE = /^[0-9a-f]{64}$/;
export const VERSION_RE = /^[1-9][0-9]{0,15}$/;
export const IF_MATCH_RE = /^"([1-9][0-9]{0,15})"$/;
export const ENTRY_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\.json$/;
export const VERSION_FILE_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/([^/]+)\.json$/;
export const VERSIONS_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/versions$/;
export const PUT_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/versions\/([^/]+)$/;
export const WITHDRAW_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)$/;
export const STAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;
export const PAGE_RE = /^\/v1\/index-([1-9][0-9]{0,3})\.json$/;

// fixed English, never echoes input
export const MESSAGES: Record<string, string> = {
  invalid: 'invalid request',
  'too-large': 'request too large',
  'over-quota': 'limit reached',
  conflict: 'already exists',
  stale: 'not the latest version',
  forbidden: 'not your entry',
  'not-found': 'not found',
  withdrawn: 'entry withdrawn',
  'version-dropped': 'this version is no longer available',
  unauthorized: 'missing or unknown token',
  'overwrite-disabled': 'overwrite is disabled on this server',
  'unsupported-media': 'content-type must be application/json',
  'rate-limited': 'too many requests',
  banned: 'publisher is banned',
  'not-admin': 'admins only',
  upstream: 'sign-in service unavailable',
  unavailable: 'sign-in is not configured',
  internal: 'internal error',
};

// the Worker's 403 on POST /v1/publishers
export const SIGN_IN_ONLY = 'sign in with GitHub to publish';

export class MarketHttpError extends Error {
  retryAfter: number | null = null;
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? MESSAGES[code] ?? code);
  }
}

export const fail = (status: number, code: string, message?: string) =>
  new MarketHttpError(status, code, message);

export type StoredVersionInfo = MarketVersionInfo & { overwrittenAt?: string };
export type StoredEntry = MarketEntry & { versions: StoredVersionInfo[] };

export const windowOf = (t: number, ms = WINDOW_MS): number => Math.floor(t / ms) * ms;

export const retryAfterSeconds = (windowStart: number, t: number, ms = WINDOW_MS): number =>
  Math.max(1, Math.ceil((windowStart + ms - t) / 1000));

export function limited(seconds: number): MarketHttpError {
  const e = fail(429, 'rate-limited');
  e.retryAfter = seconds;
  return e;
}

export function isJsonType(v: string | undefined): boolean {
  return (v ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}

// decode in try, then the id regex, before any path.join
export function part(raw: string): string {
  let v = '';
  try {
    v = decodeURIComponent(raw);
  } catch {}
  if (!ID_PART_RE.test(v)) throw fail(400, 'invalid', 'invalid id');
  return v;
}

export function versionNo(raw: string): number {
  if (!VERSION_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw fail(400, 'invalid', 'invalid version');
  }
  return Number(raw);
}

export const personal = (e: MarketEntry): boolean =>
  !!(e.name || e.description || e.author || e.versions.some((v) => v.note));

// ids, versions and hashes only: names, authors and notes are personal data
export function tombOf(e: MarketEntry, at: string): MarketEntry & { withdrawnAt: string } {
  return {
    id: e.id,
    kind: e.kind,
    name: '',
    description: '',
    author: '',
    publisher: e.publisher,
    version: e.version,
    updatedAt: at,
    hash: e.hash,
    versions: e.versions.map((v) => ({ version: v.version, at: v.at, note: '', hash: v.hash })),
    withdrawn: true,
    withdrawnAt: at,
  };
}

// a withdrawn entry keeps no personal data, also from older tombstones
export function toSummary(e: MarketEntry): MarketSummary {
  const gone = e.withdrawn === true;
  const s: MarketSummary = {
    id: e.id,
    kind: e.kind,
    name: gone ? '' : e.name,
    description: gone ? '' : e.description,
    author: gone ? '' : e.author,
    publisher: e.publisher,
    version: e.version,
    updatedAt: e.updatedAt,
    hash: e.hash,
  };
  if (e.withdrawn) s.withdrawn = true;
  else if (typeof e.cols === 'number') s.cols = e.cols;
  return s;
}

// ids compare as (publisher, slug), like the dir walk
export const order = (a: MarketSummary, b: MarketSummary): number => {
  const [ap, as] = a.id.split('/') as [string, string];
  const [bp, bs] = b.id.split('/') as [string, string];
  if (ap !== bp) return ap < bp ? -1 : 1;
  return as < bs ? -1 : as > bs ? 1 : 0;
};

// an entry document must stay readable by the client
export function fits(e: MarketEntry): void {
  if (new TextEncoder().encode(JSON.stringify(e)).length + 1 > RESPONSE_CAPS.document) {
    throw fail(413, 'over-quota', 'version history too large');
  }
}
