// pure and browser-safe
import {
  APPEARANCE_KEYS,
  applyCatalogContent,
  type EntryContent,
  type EntryKind,
  LAYOUT_KEYS,
  PERSONAL_KEYS,
} from '../core/edit.js';
import { parseCols, takesCols } from '../core/entry-keys.js';
import { cleanLabel } from '../core/sanitize.js';
import type { ThemeInput } from '../core/themes/style.js';
import type { Config } from '../core/types.js';

export type { EntryContent, EntryKind };
export { APPEARANCE_KEYS, applyCatalogContent, LAYOUT_KEYS, PERSONAL_KEYS };

export const ENTRY_SCHEMA = 1;
export const ENTRY_ID_RE = /^u-[0-9a-f]{12}$/;
export const ENTRY_LIMITS = {
  name: 64,
  description: 200,
  author: 64,
  note: 200,
  fileBytes: 1024 * 1024,
} as const;

export type ShareState = 'local' | 'pending' | 'published' | 'outdated' | 'withdraw-pending' | 'withdrawn';

const KINDS: readonly EntryKind[] = ['preset', 'theme', 'bundle'];
const STATES: readonly ShareState[] = [
  'local',
  'pending',
  'published',
  'outdated',
  'withdraw-pending',
  'withdrawn',
];

export interface EntryVersion {
  version: number;
  at: string;
  note: string;
  content: EntryContent;
  restoredFrom?: number;
  overwrittenAt?: string;
  cols?: number;
}

export interface RemoteRef {
  endpoint: string;
  id: string;
  version: number;
  hash: string;
  publishedAt: string;
  // the marketplace holds it until an admin approves
  review?: 'pending';
  reason?: 'new-link';
  links?: string[];
}

// where an installed entry came from
export interface EntryOrigin {
  endpoint: string;
  id: string;
  version: number;
  hash: string;
  installedAt: string;
}

export interface EntryShare {
  wanted: boolean;
  state: ShareState;
  remote: RemoteRef | null;
  lastError: string | null;
  // a publish whose answer never came: what was sent
  attempt?: ShareAttempt;
}

export interface ShareAttempt {
  endpoint: string;
  slug: string;
  hash: string;
}

export interface CatalogEntry {
  schema: 1;
  id: string;
  rev: number;
  kind: EntryKind;
  slug: string;
  name: string;
  description: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  versions: EntryVersion[];
  share: EntryShare;
  legacy?: { preset?: string; theme?: string };
  origin?: EntryOrigin;
}

// Çalışma → calisma
export function slug(name: string): string {
  return name
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function marketSlug(name: string): string {
  const s = slug(name)
    .replace(/[._]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/, '');
  return s || 'entry';
}

export function pick<K extends keyof Config>(
  c: Partial<Config>,
  keys: readonly K[],
): Partial<Pick<Config, K>> {
  const out: Partial<Pick<Config, K>> = {};
  for (const k of keys) {
    const v = Object.hasOwn(c, k) ? c[k] : undefined;
    if (v !== undefined) out[k] = structuredClone(v) as Config[K];
  }
  return out;
}

export function stripPersonal(c: Partial<Config>): Partial<Config> {
  return pick(c, [...LAYOUT_KEYS, ...APPEARANCE_KEYS]);
}

export function splitContent(config: Config, kind: EntryKind): EntryContent {
  const out: EntryContent = {};
  if (kind !== 'theme') out.layout = pick(config, LAYOUT_KEYS);
  if (kind !== 'preset') out.appearance = pick(config, APPEARANCE_KEYS);
  return out;
}

function cut(s: string, n: number): string {
  return [...s.trim()].slice(0, n).join('').trim();
}

export interface NewEntryInput {
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  content: EntryContent;
  note?: string;
  cols?: number;
  share: boolean;
  now: string;
}

export function newEntry(i: NewEntryInput): CatalogEntry {
  const name = cut(i.name, ENTRY_LIMITS.name);
  return {
    schema: ENTRY_SCHEMA,
    id: i.id,
    rev: 0,
    kind: i.kind,
    slug: slug(name) || 'entry',
    name,
    description: cut(i.description, ENTRY_LIMITS.description),
    author: cut(i.author, ENTRY_LIMITS.author),
    createdAt: i.now,
    updatedAt: i.now,
    version: 1,
    versions: [
      {
        version: 1,
        at: i.now,
        note: cut(i.note ?? '', ENTRY_LIMITS.note),
        content: structuredClone(i.content),
        ...(i.cols === undefined || !takesCols(i.kind) ? {} : { cols: i.cols }),
      },
    ],
    share: { wanted: i.share, state: i.share ? 'pending' : 'local', remote: null, lastError: null },
  };
}

export function latest(e: CatalogEntry): EntryVersion {
  return e.versions[e.versions.length - 1]!;
}

function push(e: CatalogEntry, v: Omit<EntryVersion, 'version'>, now: string): CatalogEntry {
  const next = structuredClone(e);
  next.version = e.version + 1;
  next.versions.push({ version: next.version, ...structuredClone(v) });
  next.updatedAt = now;
  return next;
}

export function appendVersion(
  e: CatalogEntry,
  content: EntryContent,
  note: string,
  now: string,
  cols?: number,
): CatalogEntry {
  const c = takesCols(e.kind) ? (cols ?? latest(e).cols) : undefined;
  return push(
    e,
    { at: now, note: cut(note, ENTRY_LIMITS.note), content, ...(c === undefined ? {} : { cols: c }) },
    now,
  );
}

export function overwriteVersion(
  e: CatalogEntry,
  content: EntryContent,
  note: string,
  now: string,
  cols?: number,
): CatalogEntry {
  const next = structuredClone(e);
  const last = latest(next);
  last.content = structuredClone(content);
  last.note = cut(note, ENTRY_LIMITS.note);
  last.overwrittenAt = now;
  if (cols !== undefined && takesCols(e.kind)) last.cols = cols;
  next.updatedAt = now;
  return next;
}

export function restoreVersion(e: CatalogEntry, n: number, note: string, now: string): CatalogEntry | null {
  const from = e.versions.find((v) => v.version === n);
  if (!from) return null;
  return push(
    e,
    {
      at: now,
      note: cut(note, ENTRY_LIMITS.note),
      content: from.content,
      restoredFrom: n,
      ...(from.cols === undefined ? {} : { cols: from.cols }),
    },
    now,
  );
}

function withShare(e: CatalogEntry, share: Partial<EntryShare>, drop = false): CatalogEntry {
  const next = structuredClone(e);
  next.share = { ...next.share, ...structuredClone(share) };
  if (drop) delete next.share.attempt;
  return next;
}

// a withdrawn id stays reserved on its marketplace, so sharing it again cannot publish
export function isReserved(e: CatalogEntry): boolean {
  return e.share.state === 'withdrawn' && e.share.remote !== null;
}

export function setShare(e: CatalogEntry, wanted: boolean): CatalogEntry {
  const s = e.share.state;
  let state = s;
  if (wanted) {
    if (s === 'local' || s === 'withdrawn') state = 'pending';
    else if (s === 'withdraw-pending') state = e.share.remote ? 'published' : 'pending';
  } else if (s === 'pending') state = 'local';
  else if (s === 'published' || s === 'outdated') state = 'withdraw-pending';
  return withShare(e, { wanted, state });
}

export function markPublished(e: CatalogEntry, remote: RemoteRef): CatalogEntry {
  return withShare(e, { wanted: true, state: 'published', remote, lastError: null }, true);
}

export function markWithdrawn(e: CatalogEntry): CatalogEntry {
  const remote = e.share.remote && withoutReview(e.share.remote);
  return withShare(e, { wanted: false, state: 'withdrawn', remote, lastError: null }, true);
}

// rejected, or gone from the marketplace: the id is free again, so sharing publishes a new entry (WR-04)
export function markDropped(e: CatalogEntry, code: string | null): CatalogEntry {
  return withShare(e, { wanted: false, state: 'local', remote: null, lastError: code }, true);
}

export function clearReview(e: CatalogEntry): CatalogEntry {
  const r = e.share.remote;
  return r?.review ? withShare(e, { remote: withoutReview(r) }) : e;
}

// an admin rejected the held version: the older one stays live, its hash is not known here
export function restoreLive(e: CatalogEntry, version: number): CatalogEntry {
  const r = e.share.remote;
  return r ? withShare(e, { remote: { ...withoutReview(r), version, hash: '' } }) : e;
}

export function markError(e: CatalogEntry, code: string, attempt?: ShareAttempt): CatalogEntry {
  return withShare(e, attempt ? { lastError: code, attempt } : { lastError: code });
}

export function shareView(e: CatalogEntry, latestHash: string | null): ShareState {
  const { state, remote } = e.share;
  if (state === 'published' && remote && latestHash !== null && remote.hash !== latestHash) return 'outdated';
  return state;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const own = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== '__proto__'));

export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

const withoutReview = <T extends object>(r: T): T =>
  Object.fromEntries(
    Object.entries(r).filter(([k]) => k !== 'review' && k !== 'reason' && k !== 'links'),
  ) as T;

const merged = <T extends object>(r: unknown, n: T): T => (isObject(r) ? { ...own(r), ...n } : n);

// replaced content drops the old unknown keys
function mergeContent(r: unknown, n: EntryContent): EntryContent {
  return isObject(r) && canon(parseContent(r)) === canon(n) ? merged(r, n) : n;
}

// keys a newer version added are kept at every level
export function mergeRaw(raw: Record<string, unknown>, next: CatalogEntry): Record<string, unknown> {
  const old = Array.isArray(raw.versions) ? raw.versions.filter(isObject) : [];
  const versions = next.versions.map((v) => {
    const r = old.find((o) => o.version === v.version);
    return r ? { ...own(r), ...v, content: mergeContent(r.content, v.content) } : v;
  });
  const rs = isObject(raw.share) ? raw.share : undefined;
  const nr = next.share.remote;
  const same = nr && isObject(rs?.remote) && rs.remote.id === nr.id && rs.remote.endpoint === nr.endpoint;
  // review is known: a cleared one does not come back
  const prior = same && isObject(rs?.remote) ? withoutReview(rs.remote) : undefined;
  const share = { ...merged(rs, next.share), remote: nr && (same ? merged(prior, nr) : nr) };
  // a cleared marker does not come back
  if (!next.share.attempt) delete (share as Record<string, unknown>).attempt;
  const out: Record<string, unknown> = { ...own(raw), ...next, share, versions };
  if (next.legacy) out.legacy = merged(raw.legacy, next.legacy);
  const ro = isObject(raw.origin) ? raw.origin : undefined;
  const no = next.origin;
  if (no) out.origin = ro && ro.id === no.id && ro.endpoint === no.endpoint ? merged(ro, no) : no;
  return out;
}

const isInt = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;
const isStr = (v: unknown): v is string => typeof v === 'string';
const str = (v: unknown): string => (isStr(v) ? v : '');

function parseContent(v: unknown): EntryContent | null {
  if (!isObject(v)) return null;
  const out: EntryContent = {};
  if (isObject(v.layout)) out.layout = v.layout as Partial<Config>;
  if (isObject(v.appearance)) out.appearance = v.appearance as Partial<Config>;
  if (isObject(v.theme)) out.theme = v.theme as unknown as ThemeInput;
  return out;
}

function parseVersion(v: unknown): EntryVersion | null {
  if (!isObject(v) || !isInt(v.version, 1) || !isStr(v.at)) return null;
  const content = parseContent(v.content);
  if (!content) return null;
  const out: EntryVersion = { version: v.version, at: v.at, note: str(v.note), content };
  if (isInt(v.restoredFrom, 1)) out.restoredFrom = v.restoredFrom;
  if (isStr(v.overwrittenAt)) out.overwrittenAt = v.overwrittenAt;
  const cols = parseCols(v.cols);
  if (cols !== undefined) out.cols = cols;
  return out;
}

const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function parseRemote(v: unknown): RemoteRef | null {
  if (!isObject(v)) return null;
  const { endpoint, id, version, hash, publishedAt } = v;
  if (!isStr(endpoint) || !isStr(id) || !isInt(version, 1) || !isStr(hash) || !isStr(publishedAt))
    return null;
  return {
    endpoint,
    id,
    version,
    hash,
    publishedAt,
    ...(v.review === 'pending' ? { review: v.review } : {}),
    ...(v.review === 'pending' && v.reason === 'new-link' && isStrList(v.links)
      ? { reason: v.reason, links: v.links.slice(0, 20).map((x) => cleanLabel(x).slice(0, 200)) }
      : {}),
  };
}

const REMOTE_ID_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,38}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

function parseOrigin(v: unknown): EntryOrigin | null {
  if (!isObject(v)) return null;
  const { endpoint, id, version, hash, installedAt } = v;
  if (!isStr(endpoint) || !endpoint || !isStr(id) || !REMOTE_ID_RE.test(id) || !isInt(version, 1))
    return null;
  if (!isStr(hash) || !HASH_RE.test(hash) || !isStr(installedAt)) return null;
  return { endpoint, id, version, hash, installedAt };
}

function parseAttempt(v: unknown): ShareAttempt | null {
  if (!isObject(v)) return null;
  const { endpoint, slug, hash } = v;
  if (!isStr(endpoint) || !isStr(slug) || !SLUG_RE.test(slug) || !isStr(hash) || !HASH_RE.test(hash))
    return null;
  return { endpoint, slug, hash };
}

function parseShare(v: unknown): EntryShare {
  if (!isObject(v)) return { wanted: false, state: 'local', remote: null, lastError: null };
  const state = STATES.includes(v.state as ShareState) ? (v.state as ShareState) : 'local';
  const attempt = parseAttempt(v.attempt);
  return {
    wanted: v.wanted === true,
    state,
    remote: parseRemote(v.remote),
    lastError: isStr(v.lastError) ? v.lastError : null,
    ...(attempt ? { attempt } : {}),
  };
}

export function parseEntry(raw: unknown): CatalogEntry | null {
  if (!isObject(raw) || raw.schema !== ENTRY_SCHEMA) return null;
  const { id, kind, rev, version } = raw;
  if (!isStr(id) || !ENTRY_ID_RE.test(id) || !KINDS.includes(kind as EntryKind)) return null;
  if (!isInt(rev, 0) || !isInt(version, 1) || !Array.isArray(raw.versions) || !raw.versions.length)
    return null;
  if (!isStr(raw.slug) || !isStr(raw.name) || !isStr(raw.createdAt) || !isStr(raw.updatedAt)) return null;
  const versions: EntryVersion[] = [];
  for (const r of raw.versions) {
    const v = parseVersion(r);
    if (!v || (versions.length && v.version <= versions[versions.length - 1]!.version)) return null;
    if (!takesCols(kind as EntryKind)) delete v.cols;
    versions.push(v);
  }
  if (versions[versions.length - 1]!.version !== version) return null;
  const out: CatalogEntry = {
    schema: ENTRY_SCHEMA,
    id,
    rev,
    kind: kind as EntryKind,
    slug: raw.slug,
    name: raw.name,
    description: str(raw.description),
    author: str(raw.author),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    version,
    versions,
    share: parseShare(raw.share),
  };
  if (isObject(raw.legacy)) {
    const legacy: { preset?: string; theme?: string } = {};
    if (isStr(raw.legacy.preset)) legacy.preset = raw.legacy.preset;
    if (isStr(raw.legacy.theme)) legacy.theme = raw.legacy.theme;
    out.legacy = legacy;
  }
  const origin = parseOrigin(raw.origin);
  if (origin) out.origin = origin;
  return out;
}
