// pure and browser-safe
import {
  APPEARANCE_KEYS,
  type EntryContent,
  type EntryKind,
  LAYOUT_KEYS,
  PERSONAL_KEYS,
} from '../core/edit.js';
import { deepSanitize, safeConfigUrl, safeUrl, sanitizeText } from '../core/sanitize.js';

export const PROTOCOL_VERSION = 1;
export const ID_PART_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export const MARKET_LIMITS = {
  maxEntryBytes: 256 * 1024,
  maxBodyBytes: 1024 * 1024,
  name: 64,
  description: 200,
  author: 64,
  note: 200,
  displayName: 64,
} as const;

export const ERROR_CODES = [
  'invalid',
  'too-large',
  'conflict',
  'stale',
  'forbidden',
  'not-found',
  'withdrawn',
  'rate-limited',
  'overwrite-disabled',
  'unsupported-media',
  'unauthorized',
] as const;
export type MarketErrorCode = (typeof ERROR_CODES)[number];

const MAX_LIST = 5000;
const MAX_AUTH = 8;
const STAMP = 64;
const HASH_RE = /^[0-9a-f]{64}$/;
const AUTH_RE = /^[a-z0-9-]{1,32}$/;
const KINDS: readonly EntryKind[] = ['preset', 'theme', 'bundle'];
const THEME_KEYS = new Set([
  'id',
  'name',
  'description',
  'author',
  'extends',
  'style',
  'separator',
  'padding',
  'bold',
  'statusColors',
  'gradient',
  'glyphs',
  'colors',
]);
const LAYOUT = new Set<string>(LAYOUT_KEYS);
const APPEARANCE = new Set<string>(APPEARANCE_KEYS);
const PERSONAL = new Set<string>(PERSONAL_KEYS);

export interface MarketMeta {
  protocol: 1;
  name: string;
  capabilities: { write: boolean; overwrite: boolean; withdraw: boolean; submit: 'api' | 'pull-request' };
  auth: string[];
  limits: Partial<Record<keyof typeof MARKET_LIMITS, number>>;
  submitUrl?: string;
}

export interface MarketSummary {
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  publisher: string;
  version: number;
  updatedAt: string;
  hash: string;
  withdrawn?: boolean;
}

export interface MarketIndex {
  entries: MarketSummary[];
  generatedAt: string;
}

export interface MarketVersionInfo {
  version: number;
  at: string;
  note: string;
  hash: string;
}

export interface MarketEntry extends MarketSummary {
  versions: MarketVersionInfo[];
}

export interface MarketVersion {
  version: number;
  content: EntryContent;
  hash: string;
}

export interface PublishPayload {
  kind: EntryKind;
  slug: string;
  name: string;
  description: string;
  author: string;
  content: EntryContent;
  note: string;
}

export interface VersionPayload {
  content: EntryContent;
  note: string;
  name?: string;
  description?: string;
}

export function isRemoteId(id: string): boolean {
  if (typeof id !== 'string') return false;
  const parts = id.split('/');
  return parts.length === 2 && parts.every((p) => ID_PART_RE.test(p));
}

function idParts(id: string): [string, string] {
  if (!isRemoteId(id)) throw new Error('invalid marketplace id');
  const [p, s] = id.split('/');
  return [p!, s!];
}

function versionNo(n: number): number {
  if (!isVersion(n)) throw new Error('invalid marketplace version');
  return n;
}

export const metaPath = () => '/v1/meta.json';
export const indexPath = () => '/v1/index.json';
export const entriesPath = () => '/v1/entries';
export const publishersPath = () => '/v1/publishers';

export function entryPath(id: string): string {
  const [p, s] = idParts(id);
  return `/v1/entries/${p}/${s}.json`;
}

export function versionPath(id: string, n: number): string {
  const [p, s] = idParts(id);
  return `/v1/entries/${p}/${s}/${versionNo(n)}.json`;
}

export function versionsPath(id: string): string {
  const [p, s] = idParts(id);
  return `/v1/entries/${p}/${s}/versions`;
}

export function versionPutPath(id: string, n: number): string {
  const [p, s] = idParts(id);
  return `/v1/entries/${p}/${s}/versions/${versionNo(n)}`;
}

export function withdrawPath(id: string): string {
  const [p, s] = idParts(id);
  return `/v1/entries/${p}/${s}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isVersion(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
}

const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  return [...sanitizeText(v).trim()].slice(0, max).join('').trim();
}

const optText = (v: unknown, max: number): string | null => (v === undefined ? '' : text(v, max));

function hash(v: unknown): string | null {
  return typeof v === 'string' && HASH_RE.test(v) ? v : null;
}

function kind(v: unknown): EntryKind | null {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v) ? (v as EntryKind) : null;
}

export function parseMeta(raw: unknown): MarketMeta | null {
  if (!isObject(raw) || own(raw, 'protocol') !== PROTOCOL_VERSION) return null;
  const name = text(own(raw, 'name'), MARKET_LIMITS.displayName);
  const caps = own(raw, 'capabilities');
  if (name === null || !isObject(caps)) return null;
  const write = own(caps, 'write') === true;
  const submit = own(caps, 'submit');
  const m: MarketMeta = {
    protocol: 1,
    name,
    capabilities: {
      write,
      overwrite: own(caps, 'overwrite') === true,
      withdraw: own(caps, 'withdraw') === true,
      submit: submit === 'api' || submit === 'pull-request' ? submit : write ? 'api' : 'pull-request',
    },
    auth: [],
    limits: {},
  };
  const auth = own(raw, 'auth');
  if (Array.isArray(auth)) {
    m.auth = [...new Set(auth.filter((a): a is string => typeof a === 'string' && AUTH_RE.test(a)))].slice(
      0,
      MAX_AUTH,
    );
  }
  const limits = own(raw, 'limits');
  if (isObject(limits)) {
    for (const k of Object.keys(MARKET_LIMITS) as (keyof typeof MARKET_LIMITS)[]) {
      const v = own(limits, k);
      if (isVersion(v)) m.limits[k] = v;
    }
  }
  const url = own(raw, 'submitUrl');
  const href = typeof url === 'string' ? safeUrl(url) : null;
  if (href) m.submitUrl = href;
  return m;
}

function parseSummary(raw: unknown): MarketSummary | null {
  if (!isObject(raw)) return null;
  const id = own(raw, 'id');
  if (typeof id !== 'string' || !isRemoteId(id)) return null;
  const publisher = id.split('/')[0]!;
  const pub = own(raw, 'publisher');
  if (pub !== undefined && pub !== publisher) return null;
  const k = kind(own(raw, 'kind'));
  const name = text(own(raw, 'name'), MARKET_LIMITS.name);
  const description = optText(own(raw, 'description'), MARKET_LIMITS.description);
  const author = optText(own(raw, 'author'), MARKET_LIMITS.author);
  const version = own(raw, 'version');
  const updatedAt = optText(own(raw, 'updatedAt'), STAMP);
  const h = hash(own(raw, 'hash'));
  if (!k || !name || description === null || author === null || !isVersion(version)) return null;
  if (updatedAt === null || !h) return null;
  const s: MarketSummary = { id, kind: k, name, description, author, publisher, version, updatedAt, hash: h };
  if (own(raw, 'withdrawn') === true) s.withdrawn = true;
  return s;
}

export function parseIndex(raw: unknown): MarketIndex | null {
  if (!isObject(raw)) return null;
  const list = own(raw, 'entries');
  if (!Array.isArray(list)) return null;
  const generatedAt = optText(own(raw, 'generatedAt'), STAMP) ?? '';
  const seen = new Set<string>();
  const entries: MarketSummary[] = [];
  for (const item of list) {
    if (entries.length >= MAX_LIST) break;
    const s = parseSummary(item);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    entries.push(s);
  }
  return { entries, generatedAt };
}

export function parseRemoteEntry(raw: unknown): MarketEntry | null {
  const s = parseSummary(raw);
  const list = isObject(raw) ? own(raw, 'versions') : undefined;
  if (!s || !Array.isArray(list) || list.length === 0 || list.length > MAX_LIST) return null;
  const versions: MarketVersionInfo[] = [];
  for (const v of list) {
    if (!isObject(v)) return null;
    const version = own(v, 'version');
    const at = text(own(v, 'at'), STAMP);
    const note = optText(own(v, 'note'), MARKET_LIMITS.note);
    const h = hash(own(v, 'hash'));
    if (!isVersion(version) || at === null || note === null || !h) return null;
    const prev = versions.at(-1);
    if (prev && version <= prev.version) return null;
    versions.push({ version, at, note, hash: h });
  }
  if (versions.at(-1)!.version !== s.version) return null;
  return { ...s, versions };
}

function parseContent(raw: unknown): EntryContent | null {
  if (!isObject(raw)) return null;
  const out: EntryContent = {};
  for (const k of ['layout', 'appearance', 'theme'] as const) {
    const v = own(raw, k);
    if (v === undefined) continue;
    if (!isObject(v)) return null;
    out[k] = deepSanitize(v) as never;
  }
  return out;
}

export function parseRemoteVersion(raw: unknown): MarketVersion | null {
  if (!isObject(raw)) return null;
  const version = own(raw, 'version');
  const h = hash(own(raw, 'hash'));
  const content = parseContent(own(raw, 'content'));
  if (!isVersion(version) || !h || !content) return null;
  return { version, content, hash: h };
}

export function parsePublishPayload(raw: unknown): PublishPayload | null {
  if (!isObject(raw)) return null;
  const k = kind(own(raw, 'kind'));
  const slug = own(raw, 'slug');
  const name = text(own(raw, 'name'), MARKET_LIMITS.name);
  const description = optText(own(raw, 'description'), MARKET_LIMITS.description);
  const author = optText(own(raw, 'author'), MARKET_LIMITS.author);
  const note = optText(own(raw, 'note'), MARKET_LIMITS.note);
  const content = parseContent(own(raw, 'content'));
  if (!k || typeof slug !== 'string' || !ID_PART_RE.test(slug) || !name) return null;
  if (description === null || author === null || note === null || !content) return null;
  return { kind: k, slug, name, description, author, content, note };
}

export function parseVersionPayload(raw: unknown): VersionPayload | null {
  if (!isObject(raw)) return null;
  const content = parseContent(own(raw, 'content'));
  const note = optText(own(raw, 'note'), MARKET_LIMITS.note);
  if (!content || note === null) return null;
  const p: VersionPayload = { content, note };
  if (own(raw, 'name') !== undefined) {
    const name = text(own(raw, 'name'), MARKET_LIMITS.name);
    if (!name) return null;
    p.name = name;
  }
  if (own(raw, 'description') !== undefined) {
    const d = text(own(raw, 'description'), MARKET_LIMITS.description);
    if (d === null) return null;
    p.description = d;
  }
  return p;
}

export function parseErrorBody(raw: unknown): MarketErrorCode | null {
  const err = isObject(raw) ? own(raw, 'error') : undefined;
  const code = isObject(err) ? own(err, 'code') : undefined;
  return typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)
    ? (code as MarketErrorCode)
    : null;
}

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (skip(x) ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const parts = Object.keys(o)
      .sort()
      .filter((k) => !skip(o[k]))
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`);
    return `{${parts.join(',')}}`;
  }
  return skip(v) ? 'null' : JSON.stringify(v);
}

const skip = (v: unknown) => v === undefined || typeof v === 'function' || typeof v === 'symbol';

function sectionProblems(part: Record<string, unknown>, allowed: ReadonlySet<string>, out: string[]): void {
  for (const k of Object.keys(part)) {
    if (PERSONAL.has(k)) out.push(`personal-key:${k}`);
    else if (!allowed.has(k)) out.push(`unknown-key:${k}`);
  }
}

function widgetProblems(lines: unknown, out: string[]): void {
  if (!Array.isArray(lines) || !lines.every((l) => Array.isArray(l) && l.every(isObject))) {
    out.push('bad-lines');
    return;
  }
  for (const item of (lines as Record<string, unknown>[][]).flat()) {
    const type = own(item, 'type');
    const opts = own(item, 'options');
    if (type === 'command') out.push('command-widget');
    else if (type === 'http') out.push('http-widget');
    else if (type === 'link' && isObject(opts)) {
      const url = own(opts, 'url');
      if (url !== undefined && (typeof url !== 'string' || !safeConfigUrl(url))) out.push('unsafe-link');
    }
  }
}

export function contentProblems(kind: EntryKind, content: unknown): string[] {
  if (!isObject(content)) return ['not-object'];
  const out: string[] = [];
  const allowed = new Set<string>(
    kind === 'preset'
      ? ['layout']
      : kind === 'theme'
        ? ['appearance', 'theme']
        : ['layout', 'appearance', 'theme'],
  );
  for (const k of Object.keys(content)) if (!allowed.has(k)) out.push(`unknown-key:${k}`);
  const layout = own(content, 'layout');
  const appearance = own(content, 'appearance');
  const theme = own(content, 'theme');
  if (allowed.has('layout')) {
    if (!isObject(layout)) out.push('layout-missing');
    else {
      sectionProblems(layout, LAYOUT, out);
      widgetProblems(own(layout, 'lines'), out);
    }
  }
  if (kind !== 'preset') {
    if (isObject(appearance)) sectionProblems(appearance, APPEARANCE, out);
    else if (appearance !== undefined || kind === 'bundle' || !isObject(theme))
      out.push('appearance-missing');
    if (theme !== undefined) {
      if (!isObject(theme)) out.push('bad-theme');
      else for (const k of Object.keys(theme)) if (!THEME_KEYS.has(k)) out.push(`unknown-key:theme.${k}`);
    }
  }
  if (new TextEncoder().encode(canonicalJson(content)).length > MARKET_LIMITS.maxEntryBytes) {
    out.push('too-large');
  }
  return [...new Set(out)];
}
