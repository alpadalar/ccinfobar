import fs from 'node:fs';
import path from 'node:path';
import { randomHex } from '../core/builtins.js';
import { normalizeConfig } from '../core/config.js';
import { parseCols, takesCols } from '../core/entry-keys.js';
import { isFileId } from '../core/ids.js';
import { configDir } from '../core/paths.js';
import { deleteUserPreset, ID_RE, listPresets, type Preset } from '../core/presets.js';
import { cleanLabel, stripInvisible } from '../core/sanitize.js';
import type { ThemeInput } from '../core/themes/style.js';
import {
  BUILTIN_THEMES,
  deleteUserTheme,
  listThemes,
  parseThemeInput,
  resolveTheme,
  resolveThemeInput,
  saveUserTheme,
  type Theme,
  themesDir,
  themeToInput,
} from '../core/themes.js';
import type { Config } from '../core/types.js';
import { acquireLock, renameWithRetry, sleepSync, writeAtomic } from '../data/store.js';
import {
  APPEARANCE_KEYS,
  appendVersion,
  type CatalogEntry,
  ENTRY_ID_RE,
  ENTRY_LIMITS,
  type EntryContent,
  type EntryKind,
  type EntryOrigin,
  isReserved,
  LAYOUT_KEYS,
  mergeRaw,
  newEntry,
  overwriteVersion,
  parseEntry,
  pick,
  restoreVersion,
  setShare,
  slug,
  stripPersonal,
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
  | 'bad-endpoint'
  | 'no-version'
  | 'busy'
  | 'reserved'
  | 'installed';

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
  // update and overwrite keep the entry author when undefined
  author?: string;
  content: EntryContent;
  note?: string;
  // the author's preview width; update and overwrite keep it when undefined
  cols?: number;
  share: boolean;
  mode: 'new' | 'update' | 'overwrite';
  // update and overwrite: a new share choice, in the same write
  shareChange?: boolean;
  // set by a marketplace install
  origin?: EntryOrigin;
  id?: string;
  rev?: number;
  now?: Date;
}

const KINDS: readonly EntryKind[] = ['preset', 'theme', 'bundle'];
const TRASH_KEEP = 20;
// hand-made files only; we never write more than fileBytes
const READ_CAP = ENTRY_LIMITS.fileBytes * 4;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const TRASH_RE =
  /^(?:u-[0-9a-f]{12}|legacy-(?:preset|theme)-[a-z0-9][a-z0-9._-]*)-(\d{8}T\d{9}Z)(?:-(\d+))?\.json$/i;

function fail(code: StoreCode, data: Record<string, unknown> = {}): never {
  throw new CatalogStoreError(code, data);
}

// MK-14: new dirs private, wider ones only tightened when a secret is written
function ensurePrivateDir(dir: string, tighten = false): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (tighten && process.platform !== 'win32' && (fs.statSync(dir).mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
    }
  } catch {}
}

export const STORE_LOCK = { waitMs: 3000, staleMs: 10_000 };
const held = new Set<string>();

// one writer at a time across processes; read, compare and rename happen inside
export function withStoreLock<T>(dir: string, fn: () => T): T {
  ensurePrivateDir(dir);
  const file = path.join(dir, '.lock');
  if (held.has(file)) return fn();
  const start = Date.now();
  for (let wait = 10; !acquireLock(file, STORE_LOCK.staleMs); wait = Math.min(100, wait + 10)) {
    if (Date.now() - start + wait > STORE_LOCK.waitMs) fail('busy');
    sleepSync(wait);
  }
  held.add(file);
  try {
    return fn();
  } finally {
    held.delete(file);
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const entriesDir = (dir: string) => path.join(dir, 'entries');
const entryFile = (dir: string, id: string) => path.join(entriesDir(dir), `${id}.json`);

function clip(s: unknown, n: number): string {
  return [...(typeof s === 'string' ? s : '').trim()].slice(0, n).join('').trim();
}

const lbl = (v: unknown): string => (typeof v === 'string' ? stripInvisible(v) : '');

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
  return withStoreLock(dir, () => commitLocked(next, expectedRev, dir, now));
}

function commitLocked(next: CatalogEntry, expectedRev: number, dir: string, now: Date): CatalogEntry {
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
  return withStoreLock(dir, () => saveLocked(input, dir));
}

function saveLocked(input: SaveInput, dir: string): CatalogEntry {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  let name = (typeof input.name === 'string' ? input.name : '').normalize('NFC').trim();
  name = stripInvisible(name).trim();
  if (!name || [...name].length > ENTRY_LIMITS.name || CONTROL.test(name))
    fail('bad-name', { limit: ENTRY_LIMITS.name });
  if (!KINDS.includes(input.kind)) fail('bad-content', { kind: input.kind });
  const content = cleanContent(input.kind, input.content);
  const note = stripInvisible(input.note ?? '');
  const cols = takesCols(input.kind) ? parseCols(input.cols) : undefined;
  if (input.mode === 'new') {
    const hit = findByName(input.kind, name, dir);
    if (hit) fail('exists', { id: hit.id, version: hit.version, name: hit.name });
    const e = newEntry({
      id: `u-${randomHex(6)}`,
      kind: input.kind,
      name,
      description: clip(lbl(input.description), ENTRY_LIMITS.description),
      author: clip(lbl(input.author), ENTRY_LIMITS.author),
      content,
      note,
      ...(cols === undefined ? {} : { cols }),
      share: input.share === true && !input.origin,
      now: at,
    });
    if (input.origin) e.origin = structuredClone(input.origin);
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
      ? appendVersion(cur, content, note, at, cols)
      : overwriteVersion(cur, content, note, at, cols);
  next.description = clip(lbl(input.description), ENTRY_LIMITS.description);
  if (input.author !== undefined) next.author = clip(lbl(input.author), ENTRY_LIMITS.author);
  if (input.origin) next.origin = structuredClone(input.origin);
  const change = input.shareChange;
  if (change === true && isReserved(cur)) fail('reserved', { id, name: cur.name });
  if (change === true && next.origin) fail('installed', { id, name: cur.name });
  const shared = typeof change === 'boolean' && change !== cur.share.wanted ? setShare(next, change) : next;
  return commitEntry(shared, rev, dir, now);
}

export function restoreEntry(
  id: string,
  version: number,
  rev: number,
  note: string,
  dir = catalogDir(),
  now = new Date(),
): CatalogEntry {
  return withStoreLock(dir, () => {
    const cur = load(id, dir, rev);
    const next = restoreVersion(cur, version, note, now.toISOString());
    if (!next) fail('no-version', { id, version });
    return commitEntry(next, rev, dir, now);
  });
}

export function updateShare(id: string, wanted: boolean, rev: number, dir = catalogDir()): CatalogEntry {
  return withStoreLock(dir, () => {
    const cur = load(id, dir, rev);
    if (wanted && isReserved(cur)) fail('reserved', { id, name: cur.name });
    // someone else's work is never published as yours
    if (wanted && cur.origin) fail('installed', { id, name: cur.name });
    return commitEntry(setShare(cur, wanted), rev, dir);
  });
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

function trashTarget(trash: string, base: string): string {
  let target = path.join(trash, `${base}.json`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(trash, `${base}-${n}.json`);
  return target;
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

export interface Deleted {
  file: string;
  // a linked theme file the config still uses stays
  kept: string | null;
}

// the theme and the user themes it extends
export function themeChain(id: string | undefined, themes = themesDir()): string[] {
  const out: string[] = [];
  let cur = id;
  while (cur && ID_RE.test(cur) && out.length < 8 && !out.includes(cur)) {
    out.push(cur);
    const raw = readObject(path.join(themes, `${cur}.json`));
    cur = raw && typeof raw.extends === 'string' ? raw.extends : undefined;
  }
  return out;
}

export function deleteEntry(
  id: string,
  dir = catalogDir(),
  now = new Date(),
  opts: { themesInUse?: readonly string[] } = {},
): Deleted {
  if (typeof id !== 'string' || !ENTRY_ID_RE.test(id)) fail('bad-id', { id });
  return withStoreLock(dir, () => deleteLocked(id, dir, now, opts.themesInUse ?? []));
}

function deleteLocked(id: string, dir: string, now: Date, inUse: readonly string[]): Deleted {
  const file = entryFile(dir, id);
  if (!fs.existsSync(file)) fail('not-found', { id });
  const linked = readEntry(id, dir)?.entry.legacy;
  const trash = path.join(dir, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const target = trashTarget(trash, `${id}-${stamp(now)}`);
  renameWithRetry(file, target, 2000);
  try {
    fs.rmSync(`${file}.bak`, { force: true });
  } catch {}
  // else the adopted file shows up again; the status line may still use a theme
  if (linked?.preset) deleteLegacy(`legacy:preset/${linked.preset}`, dir, now);
  const kept = linked?.theme && inUse.includes(linked.theme) ? linked.theme : null;
  if (linked?.theme && !kept) deleteLegacy(`legacy:theme/${linked.theme}`, dir, now);
  rotateTrash(trash);
  return { file: target, kept };
}

export interface LegacyItem {
  source: 'legacy';
  ref: string;
  kind: EntryKind;
  legacyId: string;
  name: string;
  description: string;
  author: string;
  file: string;
  content: EntryContent;
}

export interface LegacyDirs {
  dir?: string;
  presets?: string;
  themes?: string;
}

type LegacyType = 'preset' | 'theme';
const REF_RE = /^legacy:(preset|theme)\/(.*)$/;

function parseRef(ref: unknown): { type: LegacyType; id: string } | null {
  const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
  if (!m || !ID_RE.test(m[2]!)) return null;
  return { type: m[1] as LegacyType, id: m[2]! };
}

function legacyDirs(o: LegacyDirs): Required<LegacyDirs> {
  const dir = o.dir ?? catalogDir();
  const base = path.dirname(dir);
  return {
    dir,
    presets: o.presets ?? path.join(base, 'presets'),
    themes: o.themes ?? path.join(base, 'themes'),
  };
}

const safe = (s: unknown, n: number) => clip(cleanLabel(typeof s === 'string' ? s : ''), n);

function presetItem(p: Preset, dir: string): LegacyItem | null {
  const file = path.join(dir, `${p.id}.json`);
  const buf = readBytes(file);
  const raw = buf ? parseRaw(buf) : null;
  if (!raw) return null;
  const theme = isObject(raw.config) ? raw.config.theme : undefined;
  const kind: EntryKind = typeof theme === 'string' && theme.trim() ? 'bundle' : 'preset';
  const config = p.build();
  const content: EntryContent = { layout: stripPersonal(pick(config, LAYOUT_KEYS)) };
  if (kind === 'bundle') content.appearance = pick(config, APPEARANCE_KEYS);
  return {
    source: 'legacy',
    ref: `legacy:preset/${p.id}`,
    kind,
    legacyId: p.id,
    name: safe(p.name, ENTRY_LIMITS.name) || p.id,
    description: safe(p.description, ENTRY_LIMITS.description),
    author: '',
    file,
    content,
  };
}

function themeItem(t: Theme, dir: string): LegacyItem {
  return {
    source: 'legacy',
    ref: `legacy:theme/${t.id}`,
    kind: 'theme',
    legacyId: t.id,
    name: safe(t.name, ENTRY_LIMITS.name) || t.id,
    description: safe(t.description, ENTRY_LIMITS.description),
    author: safe(t.author, ENTRY_LIMITS.author),
    file: path.join(dir, `${t.id}.json`),
    content: { appearance: { theme: t.id }, theme: themeToInput(t, t.id) },
  };
}

function legacyItems(d: Required<LegacyDirs>, only?: { type: LegacyType; id: string }): LegacyItem[] {
  const out: LegacyItem[] = [];
  if (!only || only.type === 'preset') {
    for (const p of listPresets(d.presets)) {
      if (p.source !== 'user' || (only && p.id !== only.id)) continue;
      const item = presetItem(p, d.presets);
      if (item) out.push(item);
    }
  }
  if (!only || only.type === 'theme') {
    for (const t of listThemes(d.themes)) {
      if (t.source === 'user' && (!only || t.id === only.id)) out.push(themeItem(t, d.themes));
    }
  }
  return out;
}

const linkedTo = (e: CatalogEntry, type: LegacyType, id: string) =>
  (type === 'preset' ? e.legacy?.preset : e.legacy?.theme) === id;

// read only; files stay until an explicit delete
export function listLegacy(opts: LegacyDirs = {}): LegacyItem[] {
  const d = legacyDirs(opts);
  const entries = listEntries(d.dir);
  const type = (i: LegacyItem): LegacyType => (i.ref.startsWith('legacy:theme/') ? 'theme' : 'preset');
  return legacyItems(d).filter((i) => !entries.some((e) => linkedTo(e, type(i), i.legacyId)));
}

export function adoptLegacy(
  ref: string,
  now: Date,
  dir = catalogDir(),
  opts: Omit<LegacyDirs, 'dir'> = {},
): CatalogEntry {
  const r = parseRef(ref);
  if (!r) fail('bad-id', { id: ref });
  return withStoreLock(dir, () => adoptLocked(r, now, dir, opts));
}

function adoptLocked(
  r: { type: LegacyType; id: string },
  now: Date,
  dir: string,
  opts: Omit<LegacyDirs, 'dir'>,
): CatalogEntry {
  const all = listEntries(dir);
  const hit = all.find((e) => linkedTo(e, r.type, r.id));
  if (hit) return hit;
  const item = legacyItems(legacyDirs({ ...opts, dir }), r)[0];
  if (!item) fail('not-found', { ref: `legacy:${r.type}/${r.id}` });
  const e = newEntry({
    id: `u-${randomHex(6)}`,
    kind: item.kind,
    name: item.name,
    description: item.description,
    author: item.author,
    content: cleanContent(item.kind, item.content),
    share: false,
    now: now.toISOString(),
  });
  e.legacy = r.type === 'preset' ? { preset: r.id } : { theme: r.id };
  // a free slug, so findByName and bare refs never pick the wrong entry
  const taken = new Set(all.filter((x) => x.kind === e.kind).map((x) => x.slug));
  for (let n = 2; taken.has(e.slug); n++) e.slug = suffixed(slug(e.name) || 'entry', n);
  return normalizeEntry(commitEntry(e, 0, dir, now));
}

export function deleteLegacy(
  ref: string,
  dir = catalogDir(),
  now = new Date(),
  opts: Omit<LegacyDirs, 'dir'> = {},
): boolean {
  const r = parseRef(ref);
  if (!r) return false;
  const d = legacyDirs({ ...opts, dir });
  const folder = r.type === 'preset' ? d.presets : d.themes;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(folder, `${r.id}.json`));
  } catch {
    return false;
  }
  const trash = path.join(dir, 'trash');
  fs.mkdirSync(trash, { recursive: true });
  writeAtomic(trashTarget(trash, `legacy-${r.type}-${r.id}-${stamp(now)}`), bytes, { class: 'settings' });
  const ok = r.type === 'preset' ? deleteUserPreset(r.id, folder) : deleteUserTheme(r.id, folder);
  rotateTrash(trash);
  return ok;
}

export interface InstalledTheme {
  id: string;
  written: boolean;
  renamed: boolean;
}

const BUILTIN_BY_ID = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));

function themeBody(v: unknown): ThemeInput {
  const t = parseThemeInput(v);
  delete t.id;
  delete t.extends;
  return t;
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObject(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

// what a theme looks like; names and authors do not count
function look(t: Theme): string {
  const { style, separator, padding, bold, statusColors, gradient, glyphs, colors } = t;
  return canon({ style, separator, padding, bold, statusColors, gradient, glyphs, colors });
}

function suffixed(id: string, n: number): string {
  const s = `-${n}`;
  return `${id.slice(0, 64 - s.length)}${s}`;
}

// a different theme is never overwritten
export function installEntryTheme(content: EntryContent, themes = themesDir()): InstalledTheme | null {
  const theme = isObject(content) ? content.theme : undefined;
  if (!isObject(theme)) return null;
  const input = parseThemeInput(theme);
  const app = isObject(content.appearance) ? content.appearance.theme : undefined;
  const asked = typeof input.id === 'string' ? input.id : null;
  const base = isFileId(asked) ? asked : isFileId(app) ? app : 'theme';
  const want = themeBody(input);
  const key = canon(want);
  // a saved bundle embeds the resolved theme, so compare resolved looks too
  const wanted = look(resolveThemeInput(want, themes));
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : suffixed(base, n);
    const renamed = n > 1 || (asked !== null && asked !== id);
    const file = path.join(themes, `${id}.json`);
    if (fs.existsSync(file)) {
      const buf = readBytes(file);
      const raw = buf ? parseRaw(buf) : null;
      if (raw && (canon(themeBody(raw)) === key || look(resolveTheme(id, themes)) === wanted))
        return { id, written: false, renamed };
      continue;
    }
    const builtin = BUILTIN_BY_ID.get(id.toLowerCase());
    if (builtin) {
      if (canon(themeBody(themeToInput(builtin, id))) === key)
        return { id: builtin.id, written: false, renamed: n > 1 };
      continue;
    }
    saveUserTheme({ ...want, id }, themes);
    return { id, written: true, renamed };
  }
  fail('exists', { id: base });
}

export interface CatalogProfile {
  schema: 1;
  author: string;
  // false: switched off; older builds read it as no endpoint
  endpoint: string | null | false;
  // publisher handle per endpoint key
  publishers: Record<string, string>;
}

const profileFile = (dir: string) => path.join(dir, 'profile.json');
const credentialsFile = (dir: string) => path.join(dir, 'credentials.json');
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

function readObject(file: string): Record<string, unknown> | null {
  const buf = readBytes(file);
  return buf ? parseRaw(buf) : null;
}

const plain = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== '__proto__'));

function orNull(v: unknown, n?: number): string | null {
  if (typeof v !== 'string') return null;
  const s = n === undefined ? v.trim() : safe(v, n);
  return s || null;
}

// origin plus base path: two marketplaces on one host never share a token or handle
export function endpointKey(raw: unknown): string | null {
  try {
    const u = new URL(String(raw).trim());
    if (!u.origin || u.origin === 'null') return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function publishersOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(v)) return out;
  for (const [k, h] of Object.entries(v)) {
    if (endpointKey(k) === k && typeof h === 'string' && HANDLE_RE.test(h)) out[k] = h;
  }
  return out;
}

function profileOf(raw: Record<string, unknown>): CatalogProfile {
  return {
    schema: 1,
    author: safe(raw.author, ENTRY_LIMITS.author),
    endpoint: raw.endpoint === false ? false : orNull(raw.endpoint),
    publishers: publishersOf(raw.publishers),
  };
}

export function readProfile(dir = catalogDir()): CatalogProfile {
  return profileOf(readObject(profileFile(dir)) ?? {});
}

function patchProfile(dir: string, edit: (p: CatalogProfile) => void): CatalogProfile {
  return withStoreLock(dir, () => {
    const raw = plain(readObject(profileFile(dir)) ?? {});
    const next = profileOf(raw);
    edit(next);
    const data = { ...raw, ...next };
    writeAtomic(profileFile(dir), `${JSON.stringify(data, null, 2)}\n`, { class: 'settings' });
    return next;
  });
}

export function writeProfile(
  patch: Partial<Pick<CatalogProfile, 'author' | 'endpoint'>>,
  dir = catalogDir(),
): CatalogProfile {
  return patchProfile(dir, (next) => {
    if (patch.author !== undefined) next.author = safe(patch.author, ENTRY_LIMITS.author);
    if (patch.endpoint !== undefined)
      next.endpoint = patch.endpoint === false ? false : orNull(patch.endpoint);
  });
}

export const isHandle = (v: unknown): v is string => typeof v === 'string' && HANDLE_RE.test(v);

export function readPublisher(endpoint: string, dir = catalogDir()): string | null {
  const key = endpointKey(endpoint);
  return (key && readProfile(dir).publishers[key]) || null;
}

export function writePublisher(endpoint: string, handle: string | null, dir = catalogDir()): void {
  const key = endpointKey(endpoint);
  if (!key) fail('bad-endpoint');
  if (handle !== null && !isHandle(handle)) fail('bad-name');
  patchProfile(dir, (next) => {
    if (handle === null) delete next.publishers[key];
    else next.publishers[key] = handle;
  });
}

export const DEFAULT_MARKETPLACE: string | null = 'https://ccinfobar-market.alp-adalar.workers.dev';

export type EndpointSource = 'env' | 'set' | 'default' | 'off' | 'none';

// pure lookup: only explicit marketplace actions send requests
export function marketEndpointInfo(
  env: NodeJS.ProcessEnv = process.env,
  dir = catalogDir(),
  fallback: string | null = DEFAULT_MARKETPLACE,
): { url: string | null; source: EndpointSource } {
  const v = typeof env.CCINFOBAR_MARKETPLACE_URL === 'string' ? env.CCINFOBAR_MARKETPLACE_URL.trim() : '';
  if (v.toLowerCase() === 'off') return { url: null, source: 'off' };
  if (v) return { url: v, source: 'env' };
  const set = readProfile(dir).endpoint;
  if (typeof set === 'string') return { url: set, source: 'set' };
  if (set === false) return { url: null, source: 'off' };
  return fallback ? { url: fallback, source: 'default' } : { url: null, source: 'none' };
}

export function marketEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  dir = catalogDir(),
  fallback: string | null = DEFAULT_MARKETPLACE,
): string | null {
  return marketEndpointInfo(env, dir, fallback).url;
}

export function readCredential(endpoint: string, dir = catalogDir()): string | null {
  const key = endpointKey(endpoint);
  const raw = key ? readObject(credentialsFile(dir)) : null;
  const v = raw && key && Object.hasOwn(raw, key) ? raw[key] : null;
  return isObject(v) && typeof v.token === 'string' && v.token ? v.token : null;
}

export function writeCredential(endpoint: string, token: string, dir = catalogDir()): void {
  const key = endpointKey(endpoint);
  if (!key) fail('bad-endpoint');
  ensurePrivateDir(dir, true);
  withStoreLock(dir, () => {
    const data = plain(readObject(credentialsFile(dir)) ?? {});
    const cur = data[key];
    if (typeof token === 'string' && token) data[key] = { ...(isObject(cur) ? plain(cur) : {}), token };
    else delete data[key];
    writeAtomic(credentialsFile(dir), `${JSON.stringify(data, null, 2)}\n`, {
      mode: 0o600,
      class: 'settings',
    });
  });
}

// the token is never shown; forgetting it makes the next publish register again
export function forgetPublisher(endpoint: string, dir = catalogDir()): void {
  withStoreLock(dir, () => {
    writeCredential(endpoint, '', dir);
    writePublisher(endpoint, null, dir);
  });
}
