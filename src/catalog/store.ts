import fs from 'node:fs';
import path from 'node:path';
import { randomHex } from '../core/builtins.js';
import { normalizeConfig } from '../core/config.js';
import { configDir } from '../core/paths.js';
import type { ThemeInput } from '../core/themes/style.js';
import type { Config } from '../core/types.js';
import { renameWithRetry, writeAtomic } from '../data/store.js';
import {
  APPEARANCE_KEYS,
  appendVersion,
  type CatalogEntry,
  ENTRY_ID_RE,
  ENTRY_LIMITS,
  type EntryContent,
  type EntryKind,
  LAYOUT_KEYS,
  mergeRaw,
  newEntry,
  overwriteVersion,
  parseEntry,
  pick,
  restoreVersion,
  setShare,
  slug,
} from './model.js';

export function catalogDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'catalog');
}

export type StoreCode =
  | 'exists'
  | 'changed'
  | 'too-large'
  | 'not-found'
  | 'bad-id'
  | 'bad-name'
  | 'bad-content'
  | 'no-version';

export class CatalogStoreError extends Error {
  readonly code: StoreCode;
  readonly data: Record<string, unknown>;
  constructor(code: StoreCode, data: Record<string, unknown> = {}) {
    super(code);
    this.name = 'CatalogStoreError';
    this.code = code;
    this.data = data;
  }
}

export interface StoredEntry {
  entry: CatalogEntry;
  raw: Record<string, unknown>;
  file: string;
}

export interface SaveInput {
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  content: EntryContent;
  note?: string;
  share: boolean;
  mode: 'new' | 'update' | 'overwrite';
  id?: string;
  rev?: number;
  now?: Date;
}

const KINDS: readonly EntryKind[] = ['preset', 'theme', 'bundle'];
const TRASH_KEEP = 20;
// hand-made files only; we never write more than fileBytes
const READ_CAP = ENTRY_LIMITS.fileBytes * 4;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TRASH_RE = /^u-[0-9a-f]{12}-(\d{8}T\d{9}Z)(?:-(\d+))?\.json$/;

function fail(code: StoreCode, data: Record<string, unknown> = {}): never {
  throw new CatalogStoreError(code, data);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const entriesDir = (dir: string) => path.join(dir, 'entries');
const entryFile = (dir: string, id: string) => path.join(entriesDir(dir), `${id}.json`);

function clip(s: unknown, n: number): string {
  return [...(typeof s === 'string' ? s : '').trim()].slice(0, n).join('').trim();
}

function readBytes(file: string): Buffer | null {
  try {
    if (fs.statSync(file).size > READ_CAP) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function parseRaw(buf: Buffer): Record<string, unknown> | null {
  try {
    const text = buf.toString('utf8');
    const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

export function readEntry(id: string, dir = catalogDir()): StoredEntry | null {
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) return null;
  const file = entryFile(dir, id);
  const buf = readBytes(file);
  const raw = buf ? parseRaw(buf) : null;
  const entry = raw ? parseEntry(raw) : null;
  return raw && entry && entry.id === id ? { entry, raw, file } : null;
}

function cleanPart(part: Partial<Config>, keys: readonly (keyof Config)[]): Partial<Config> {
  try {
    const out: Partial<Config> = pick(
      normalizeConfig(part),
      keys.filter((k) => Object.hasOwn(part, k)),
    );
    if (keys.includes('lines') && Object.hasOwn(part, 'lines') && !Array.isArray(part.lines)) out.lines = [];
    return out;
  } catch {
    return {};
  }
}

// what callers render and apply; storage keeps the file as is
export function normalizeEntry(e: CatalogEntry): CatalogEntry {
  const next = structuredClone(e);
  for (const v of next.versions) {
    const c: EntryContent = {};
    if (v.content.layout) c.layout = cleanPart(v.content.layout, LAYOUT_KEYS);
    if (v.content.appearance) c.appearance = cleanPart(v.content.appearance, APPEARANCE_KEYS);
    if (v.content.theme) c.theme = v.content.theme;
    v.content = c;
  }
  return next;
}

export function listEntries(dir = catalogDir()): CatalogEntry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(entriesDir(dir));
  } catch {}
  const out: CatalogEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = readEntry(name.slice(0, -5), dir);
    if (s) out.push(normalizeEntry(s.entry));
  }
  return out.sort((a, b) =>
    a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.id < b.id ? -1 : 1,
  );
}

export function findByName(kind: EntryKind, name: string, dir = catalogDir()): CatalogEntry | null {
  const s = slug(name.normalize('NFC')) || 'entry';
  return listEntries(dir).find((e) => e.kind === kind && e.slug === s) ?? null;
}

function cleanContent(kind: EntryKind, c: unknown): EntryContent {
  if (!isObject(c)) fail('bad-content', { kind });
  const out: EntryContent = {};
  if (kind !== 'theme' && isObject(c.layout)) out.layout = pick(c.layout as Partial<Config>, LAYOUT_KEYS);
  if (kind !== 'preset' && isObject(c.appearance))
    out.appearance = pick(c.appearance as Partial<Config>, APPEARANCE_KEYS);
  if (kind !== 'preset' && isObject(c.theme)) out.theme = structuredClone(c.theme) as unknown as ThemeInput;
  const ok = kind === 'theme' ? !!(out.appearance || out.theme) : !!out.layout;
  if (!ok) fail('bad-content', { kind });
  return out;
}

function load(id: string, dir: string, rev: number): CatalogEntry {
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) fail('bad-id', { id });
  const s = readEntry(id, dir);
  if (!s) fail('not-found', { id });
  if (rev !== s.entry.rev) fail('changed', { id, rev: s.entry.rev });
  return s.entry;
}

export function commitEntry(
  next: CatalogEntry,
  expectedRev: number,
  dir = catalogDir(),
  now = new Date(),
): CatalogEntry {
  const id = next.id;
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) fail('bad-id', { id });
  const file = entryFile(dir, id);
  let prev: Buffer | null = null;
  try {
    prev = fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  let raw: Record<string, unknown> = {};
  if (prev) {
    const cur = parseRaw(prev);
    if (!cur) fail('changed', { id });
    const rev = Number.isInteger(cur.rev) ? (cur.rev as number) : -1;
    if (rev !== expectedRev) fail('changed', { id, rev });
    raw = cur;
  } else if (expectedRev !== 0) fail('not-found', { id });
  const entry: CatalogEntry = {
    ...structuredClone(next),
    rev: expectedRev + 1,
    updatedAt: now.toISOString(),
  };
  const data = mergeRaw(raw, entry);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const parsed = parseEntry(JSON.parse(text));
  if (!parsed) fail('bad-content', { id });
  if (Buffer.byteLength(text) > ENTRY_LIMITS.fileBytes)
    fail('too-large', { id, limit: ENTRY_LIMITS.fileBytes });
  if (prev) writeAtomic(`${file}.bak`, prev, { class: 'settings' });
  writeAtomic(file, text, { class: 'settings' });
  return parsed;
}

export function saveEntry(input: SaveInput, dir = catalogDir()): CatalogEntry {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const name = (typeof input.name === 'string' ? input.name : '').normalize('NFC').trim();
  if (!name || [...name].length > ENTRY_LIMITS.name || CONTROL.test(name))
    fail('bad-name', { limit: ENTRY_LIMITS.name });
  if (!KINDS.includes(input.kind)) fail('bad-content', { kind: input.kind });
  const content = cleanContent(input.kind, input.content);
  const note = input.note ?? '';
  if (input.mode === 'new') {
    const hit = findByName(input.kind, name, dir);
    if (hit) fail('exists', { id: hit.id, version: hit.version, name: hit.name });
    const e = newEntry({
      id: `u-${randomHex(6)}`,
      kind: input.kind,
      name,
      description: clip(input.description, ENTRY_LIMITS.description),
      author: clip(input.author, ENTRY_LIMITS.author),
      content,
      note,
      share: input.share === true,
      now: at,
    });
    return commitEntry(e, 0, dir, now);
  }
  if (input.mode !== 'update' && input.mode !== 'overwrite') fail('bad-content', { mode: input.mode });
  let id = input.id;
  if (id === undefined) {
    id = findByName(input.kind, name, dir)?.id;
    if (!id) fail('not-found', { name });
  }
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) fail('bad-id', { id });
  const cur = readEntry(id, dir)?.entry;
  if (!cur || cur.kind !== input.kind) fail('not-found', { id });
  const rev = input.rev ?? cur.rev;
  if (rev !== cur.rev) fail('changed', { id, rev: cur.rev });
  const next =
    input.mode === 'update'
      ? appendVersion(cur, content, note, at)
      : overwriteVersion(cur, content, note, at);
  next.description = clip(input.description, ENTRY_LIMITS.description);
  next.author = clip(input.author, ENTRY_LIMITS.author);
  return commitEntry(next, rev, dir, now);
}

export function restoreEntry(
  id: string,
  version: number,
  rev: number,
  note: string,
  dir = catalogDir(),
  now = new Date(),
): CatalogEntry {
  const cur = load(id, dir, rev);
  const next = restoreVersion(cur, version, note, now.toISOString());
  if (!next) fail('no-version', { id, version });
  return commitEntry(next, rev, dir, now);
}

export function updateShare(id: string, wanted: boolean, rev: number, dir = catalogDir()): CatalogEntry {
  return commitEntry(setShare(load(id, dir, rev), wanted), rev, dir);
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

function rotateTrash(trash: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(trash);
  } catch {
    return;
  }
  const mine = names
    .map((name) => ({ name, m: TRASH_RE.exec(name) }))
    .filter((x) => x.m)
    .map(({ name, m }) => ({ name, at: m?.[1] ?? '', n: Number(m?.[2] ?? 1) }))
    .sort((a, b) =>
      a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.n !== b.n ? a.n - b.n : a.name < b.name ? -1 : 1,
    );
  for (const old of mine.slice(0, Math.max(0, mine.length - TRASH_KEEP))) {
    try {
      fs.rmSync(path.join(trash, old.name), { force: true });
    } catch {}
  }
}

export function deleteEntry(id: string, dir = catalogDir(), now = new Date()): string {
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) fail('bad-id', { id });
  const file = entryFile(dir, id);
  if (!fs.existsSync(file)) fail('not-found', { id });
  const trash = path.join(dir, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const base = `${id}-${stamp(now)}`;
  let target = path.join(trash, `${base}.json`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(trash, `${base}-${n}.json`);
  renameWithRetry(file, target, 2000);
  try {
    fs.rmSync(`${file}.bak`, { force: true });
  } catch {}
  rotateTrash(trash);
  return target;
}
