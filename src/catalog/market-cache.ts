import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir as defaultCacheDir } from '../core/paths.js';
import { resolveReal, writeAtomic } from '../data/store.js';
import { contentHash, type MarketClient, MarketError } from '../market/client.js';
import {
  isRemoteId,
  type MarketEntry,
  type MarketIndex,
  type MarketVersion,
  parseIndex,
  parseRemoteEntry,
  parseRemoteVersion,
} from '../market/protocol.js';
import type { EntryKind } from './model.js';
import { endpointKey } from './store.js';

// R-12: a day, then one conditional request
export const INDEX_TTL_MS = 86_400_000;
export const MIN_REFRESH_MS = 30_000;

// 2: summaries and entries keep cols
const SCHEMA = 2;
const READ_CAP = 16 * 1024 * 1024;
const ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface CacheDeps {
  client: MarketClient;
  now?: () => Date;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CachedIndex {
  index: MarketIndex;
  fromCache: boolean;
  // the last time the server confirmed the index
  checkedAt: string;
  stale?: true;
  // pages of two index builds: shown once, never saved (WR-08)
  partial?: true;
}

export interface CachedEntry {
  entry: MarketEntry;
  fromCache: boolean;
  checkedAt: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const tagOf = (v: unknown): string | null => (typeof v === 'string' && ETAG_RE.test(v) ? v : null);

function keyOf(endpoint: string): string {
  const key = endpointKey(endpoint);
  if (!key) throw new MarketError('bad-endpoint');
  return key;
}

interface Root {
  base: string;
  dir: string;
}

function rootOf(key: string, deps: CacheDeps): Root {
  const base = deps.cacheDir ?? defaultCacheDir(deps.env ?? process.env);
  const sub = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return { base, dir: path.join(base, 'market', sub) };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (fs.statSync(file).size > READ_CAP) return null;
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(v) && v.schema === SCHEMA ? v : null;
  } catch {
    return null;
  }
}

// a link planted in the cache never sends the write elsewhere
function inside(file: string, root: string): boolean {
  try {
    const rel = path.relative(resolveReal(root), resolveReal(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function writeJson(file: string, root: Root, data: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (inside(file, root.base)) writeAtomic(file, `${JSON.stringify({ schema: SCHEMA, ...data })}\n`);
  } catch {}
}

const stamp = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

interface IndexFile {
  etag: string | null;
  checkedAt: string;
  index: MarketIndex;
}

function readIndex(file: string, key: string): IndexFile | null {
  const raw = readJson(file);
  if (!raw || raw.endpoint !== key || stamp(raw.checkedAt) === null) return null;
  if (raw.etag !== null && tagOf(raw.etag) === null) return null;
  const index = parseIndex({ entries: raw.entries, generatedAt: raw.generatedAt });
  if (!index) return null;
  return { etag: tagOf(raw.etag), checkedAt: raw.checkedAt as string, index };
}

const inflight = new Map<string, Promise<CachedIndex>>();

// a partial walk is never saved as fresh, so the next load asks again
function walked(r: { index: MarketIndex }, at: string, save: () => void): CachedIndex {
  const { partial, ...index } = r.index;
  if (partial) return { index, fromCache: false, checkedAt: at, partial: true };
  save();
  return { index, fromCache: false, checkedAt: at };
}

// identical calls share one walk; a refresh never joins a plain load (IN-05)
export function cachedIndex(endpoint: string, deps: CacheDeps & { refresh?: boolean }): Promise<CachedIndex> {
  const key = keyOf(endpoint);
  const root = rootOf(key, deps);
  const file = path.join(root.dir, 'index.json');
  const slot = `${deps.refresh ? 'r' : 'p'}:${file}`;
  const running = inflight.get(slot);
  if (running) return running;
  const p = loadIndex(key, root, file, deps).finally(() => inflight.delete(slot));
  inflight.set(slot, p);
  return p;
}

async function loadIndex(
  key: string,
  root: Root,
  file: string,
  deps: CacheDeps & { refresh?: boolean },
): Promise<CachedIndex> {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const cache = readIndex(file, key);
  const save = (etag: string | null, index: MarketIndex) =>
    writeJson(file, root, {
      endpoint: key,
      etag,
      checkedAt: at,
      generatedAt: index.generatedAt,
      entries: index.entries,
    });
  if (cache) {
    // a clock that went back counts as expired
    const age = now.getTime() - stamp(cache.checkedAt)!;
    const hit = { index: cache.index, fromCache: true, checkedAt: cache.checkedAt };
    if (age >= 0 && age < (deps.refresh ? MIN_REFRESH_MS : INDEX_TTL_MS)) return hit;
    let r: Awaited<ReturnType<MarketClient['indexIfChanged']>>;
    try {
      r = await deps.client.indexIfChanged(cache.etag);
    } catch {
      return { ...hit, stale: true };
    }
    if (!r.changed) {
      save(cache.etag, cache.index);
      return { ...hit, checkedAt: at };
    }
    return walked(r, at, () => save(r.etag, r.index));
  }
  const r = await deps.client.indexIfChanged(null);
  if (!r.changed) throw new MarketError('bad-json');
  return walked(r, at, () => save(r.etag, r.index));
}

// a hash, never the id: con, nul or com1 are devices on Windows (WR-09)
function idPath(root: Root, dir: string, id: string): string {
  if (!isRemoteId(id)) throw new MarketError('invalid');
  return path.join(root.dir, dir, createHash('sha256').update(id).digest('hex').slice(0, 32));
}

// only when the user opens details or installs
export async function cachedEntry(endpoint: string, id: string, deps: CacheDeps): Promise<CachedEntry> {
  const key = keyOf(endpoint);
  const root = rootOf(key, deps);
  const file = `${idPath(root, 'entries', id)}.json`;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const raw = readJson(file);
  const cached = raw ? parseRemoteEntry(raw.entry) : null;
  const old = cached && cached.id === id && (raw!.etag === null || tagOf(raw!.etag)) ? cached : null;
  const etag = old ? tagOf(raw!.etag) : null;
  const r = await deps.client.entryIfChanged(id, etag);
  if (!r.changed) {
    if (!old) throw new MarketError('bad-json');
    writeJson(file, root, { etag, checkedAt: at, entry: old });
    return { entry: old, fromCache: true, checkedAt: at };
  }
  writeJson(file, root, { etag: r.etag, checkedAt: at, entry: r.entry });
  return { entry: r.entry, fromCache: false, checkedAt: at };
}

export interface VersionDeps extends CacheDeps {
  kind: EntryKind;
  // overwrite off on the server: versions never change; read only on a miss
  immutable: boolean | (() => Promise<boolean>);
}

function readVersion(file: string, n: number, expected: string): MarketVersion | null {
  const raw = readJson(file);
  if (!raw || raw.hash !== expected) return null;
  const v = parseRemoteVersion(raw.version);
  if (!v || v.version !== n || v.hash !== expected) return null;
  // edited files fail here and are fetched again
  return contentHash(v.content) === expected ? v : null;
}

// unknown counts as mutable: nothing is kept
async function isImmutable(v: VersionDeps['immutable']): Promise<boolean> {
  try {
    return typeof v === 'function' ? (await v()) === true : v === true;
  } catch {
    return false;
  }
}

export async function cachedVersion(
  endpoint: string,
  id: string,
  n: number,
  expectedHash: string,
  deps: VersionDeps,
): Promise<MarketVersion> {
  const key = keyOf(endpoint);
  const root = rootOf(key, deps);
  if (!Number.isSafeInteger(n) || n < 1 || !HASH_RE.test(expectedHash)) throw new MarketError('invalid');
  const file = path.join(idPath(root, 'versions', id), `${n}.json`);
  const hit = readVersion(file, n, expectedHash);
  if (hit) return hit;
  const got = await deps.client.version(id, n, deps.kind, expectedHash);
  const v: MarketVersion = { version: got.version, content: got.raw, hash: got.hash };
  if (await isImmutable(deps.immutable)) writeJson(file, root, { hash: v.hash, version: v });
  return v;
}
