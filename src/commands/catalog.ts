import '../core/i18n/lazy.js';
import path from 'node:path';
import {
  applyCatalogContent,
  type CatalogEntry,
  ENTRY_LIMITS,
  type EntryContent,
  type EntryKind,
  isReserved,
  latest,
  marketSlug,
  newEntry,
  restoreVersion,
  type ShareState,
  setShare,
  slug,
} from '../catalog/model.js';
import { shareState } from '../catalog/share.js';
import { contentFromConfig } from '../catalog/snapshot.js';
import {
  adoptLegacy,
  CatalogStoreError,
  catalogDir,
  DEFAULT_MARKETPLACE,
  deleteEntry,
  deleteLegacy,
  type EndpointSource,
  findByName,
  forgetPublisher,
  installEntryTheme,
  isHandle,
  type LegacyItem,
  listEntries,
  listLegacy,
  marketEndpoint,
  marketEndpointInfo,
  readCredential,
  readProfile,
  readPublisher,
  restoreEntry,
  type StoreCode,
  saveEntry,
  themeChain,
  updateShare,
  writeProfile,
  writePublisher,
} from '../catalog/store.js';
import { type SystemEntry, systemEntries } from '../catalog/system.js';
import type { Args } from '../cli/args.js';
import { stripAnsi } from '../core/ansi.js';
import { defaultConfig, type LoadResult, saveConfig } from '../core/config.js';
import { keepLanguage } from '../core/edit.js';
import { resolveGlyphMode } from '../core/glyphs.js';
import { bundleText, presetText, themeDescription } from '../core/i18n/catalog-text.js';
import { formatDateTime } from '../core/i18n/format.js';
import { languageLocale, type MessageId, t, withLanguage } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { tildify } from '../core/paths.js';
import { ID_RE } from '../core/presets.js';
import { type PreviewSource, renderPreview, scenarioFlag, scenarioListLines } from '../core/preview.js';
import { finalizeLine } from '../core/renderer.js';
import { sanitizeText } from '../core/sanitize.js';
import { parseThemeInput, resolveThemeInput, type Theme } from '../core/themes.js';
import { padVisible, visibleWidth } from '../core/width.js';
import { gsdInstalled } from '../data/gsd.js';
import { type ImportTarget, importTargets } from '../importers/confirm.js';
import { checkEndpoint } from '../market/endpoint.js';
import { type PromptIo, plainOutput, promptIo, reportConfigIssue } from './io.js';

export interface CatalogDeps {
  io?: PromptIo;
  env?: NodeJS.ProcessEnv;
  dir?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  gsd?: boolean;
  defaultEndpoint?: string | null;
  open?: (url: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export type AnyEntry =
  | { source: 'user'; entry: CatalogEntry }
  | { source: 'legacy'; item: LegacyItem }
  | { source: 'system'; entry: SystemEntry };

interface Summary {
  ref: string;
  source: AnyEntry['source'];
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  version: number;
  share: ShareState | null;
  updatedAt: string | null;
  review?: 'pending';
}

interface VersionRow {
  version: number;
  at: string | null;
  note: string;
  restoredFrom: number | null;
  overwrittenAt: string | null;
}

export interface Ctx {
  args: Args;
  cfgFile: string;
  io: PromptIo;
  env: NodeJS.ProcessEnv;
  dir: string;
  gsd: boolean;
  now: () => Date;
  json: boolean;
  dryRun: boolean;
  fetch?: typeof fetch;
  defaultEndpoint: string | null;
  open?: (url: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  fail(msg: string): void;
}

export const endpointOf = (c: Ctx): string | null => marketEndpoint(c.env, c.dir, c.defaultEndpoint);

export const KINDS: readonly EntryKind[] = ['bundle', 'preset', 'theme'];
export const GROUPS: Record<EntryKind, MessageId> = {
  bundle: 'catalog.group.bundles',
  preset: 'catalog.group.presets',
  theme: 'catalog.group.themes',
};
const SHARE_IDS: Record<ShareState, MessageId> = {
  local: 'catalog.share.local',
  pending: 'catalog.share.pending',
  published: 'catalog.share.published',
  outdated: 'catalog.share.outdated',
  'withdraw-pending': 'catalog.share.withdrawPending',
  withdrawn: 'catalog.share.withdrawn',
};

export const clean = (v: unknown): string => sanitizeText(typeof v === 'string' ? v : '');

const kindOf = (a: AnyEntry): EntryKind => (a.source === 'legacy' ? a.item.kind : a.entry.kind);

function refOf(a: AnyEntry): string {
  if (a.source === 'user') return a.entry.id;
  return a.source === 'legacy' ? a.item.ref : a.entry.ref;
}

function bareOf(a: AnyEntry): string {
  if (a.source === 'user') return a.entry.slug;
  return a.source === 'legacy' ? a.item.legacyId : a.entry.id;
}

export function resolveRef(ref: string, all: AnyEntry[]): AnyEntry | { ambiguous: string[] } | null {
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r) return null;
  const pick = (hits: AnyEntry[]) =>
    hits.length === 1 ? hits[0]! : hits.length ? { ambiguous: hits.map(refOf) } : null;
  const exact = all.find(
    (a) => (a.source === 'user' && a.entry.id === r) || (a.source === 'legacy' && a.item.ref === r),
  );
  if (exact) return exact;
  const own = pick(all.filter((a) => a.source === 'user' && `${a.entry.kind}/${a.entry.slug}` === r));
  if (own) return own;
  const sys = all.find((a) => a.source === 'system' && a.entry.ref === r);
  if (sys) return sys;
  if (/[/:]/.test(r)) return null;
  const s = slug(r);
  return pick(all.filter((a) => bareOf(a) === r || (s !== '' && bareOf(a) === s)));
}

function systemText(e: SystemEntry, field: 'name' | 'description'): string {
  if (e.kind === 'bundle') return bundleText(e, field);
  if (e.kind === 'preset') return presetText(e, field);
  return field === 'name' ? e.name : themeDescription(e);
}

function summary(a: AnyEntry): Summary {
  const base = { ref: refOf(a), source: a.source, kind: kindOf(a) };
  if (a.source === 'user') {
    const e = a.entry;
    return {
      ...base,
      name: clean(e.name),
      description: clean(e.description),
      author: clean(e.author),
      version: e.version,
      share: shareState(e),
      updatedAt: e.updatedAt,
      ...(e.share.remote?.review === 'pending' ? { review: 'pending' as const } : {}),
    };
  }
  const item = a.source === 'legacy' ? a.item : null;
  const sys = a.source === 'system' ? a.entry : null;
  return {
    ...base,
    name: clean(item ? item.name : systemText(sys!, 'name')),
    description: clean(item ? item.description : systemText(sys!, 'description')),
    author: clean(item ? item.author : sys!.author),
    version: 1,
    share: null,
    updatedAt: null,
  };
}

function versionRows(a: AnyEntry): VersionRow[] {
  if (a.source !== 'user')
    return [{ version: 1, at: null, note: '', restoredFrom: null, overwrittenAt: null }];
  return a.entry.versions.map((v) => ({
    version: v.version,
    at: v.at,
    note: clean(v.note),
    restoredFrom: v.restoredFrom ?? null,
    overwrittenAt: v.overwrittenAt ?? null,
  }));
}

// a presets/ or themes/ file that is not a catalog entry
const fileLabel = (kind: EntryKind): MessageId =>
  kind === 'theme' ? 'catalog.source.themeFile' : 'catalog.source.presetFile';

function chip(a: AnyEntry, s: Summary): string {
  if (a.source === 'legacy') return t(fileLabel(a.item.kind));
  if (a.source === 'system') return t('catalog.source.system');
  const version = a.entry.share.remote?.version ?? a.entry.version;
  if (s.share === 'published' && s.review) return t('catalog.share.review');
  return s.share ? t(SHARE_IDS[s.share], { version }) : '';
}

function contentOf(a: AnyEntry): EntryContent {
  if (a.source === 'user') return latest(a.entry).content;
  return a.source === 'legacy' ? a.item.content : a.entry.content;
}

// the same draft path as POST /api/preview; nothing is installed
function draftTheme(raw: unknown): Theme | undefined {
  try {
    const input = parseThemeInput(raw);
    if (input.extends !== undefined && !ID_RE.test(input.extends)) delete input.extends;
    return resolveThemeInput(input);
  } catch {
    return undefined;
  }
}

export function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? clean(at) : formatDateTime(d, languageLocale());
}

function collect(c: Ctx): AnyEntry[] {
  const user: AnyEntry[] = listEntries(c.dir).map((entry) => ({ source: 'user', entry }));
  const legacy: AnyEntry[] = listLegacy({ dir: c.dir }).map((item) => ({ source: 'legacy', item }));
  const system: AnyEntry[] = systemEntries({ gsd: c.gsd }).map((entry) => ({ source: 'system', entry }));
  return [...user, ...legacy, ...system];
}

export function find(c: Ctx, ref: string | undefined): AnyEntry | null {
  if (!ref) {
    c.fail(t('catalog.usage'));
    return null;
  }
  const hit = resolveRef(ref, collect(c));
  if (!hit) c.fail(t('err.catalog.unknownRef', { ref: clean(ref) }));
  else if ('ambiguous' in hit) {
    c.fail(t('err.catalog.ambiguousRef', { ref: clean(ref), refs: hit.ambiguous.map(clean).join(', ') }));
  } else return hit;
  return null;
}

const json = (c: Ctx, build: () => unknown) =>
  c.io.log(withLanguage('en', () => JSON.stringify({ schema: 1, ...(build() as object) })));

function sectionLines(entries: AnyEntry[]): string[] {
  const rows = entries.map((a) => {
    const s = summary(a);
    return {
      a,
      s,
      cells: [
        s.name,
        s.ref,
        t(`catalog.kind.${s.kind}`),
        t('catalog.version', { version: s.version }),
        s.author,
      ],
    };
  });
  const widths = [0, 1, 2, 3].map((i) => Math.max(0, ...rows.map((r) => visibleWidth(r.cells[i]!))));
  const out: string[] = [];
  for (const kind of KINDS) {
    const group = rows.filter((r) => r.s.kind === kind);
    if (!group.length) continue;
    out.push(`  ${t(GROUPS[kind])}`);
    for (const r of group) {
      const cells = [...r.cells.slice(0, 4).map((x, i) => padVisible(x, widths[i]!)), r.cells[4]!];
      if (r.a.source !== 'system') cells.push(chip(r.a, r.s));
      out.push(`    ${cells.filter((x, i) => i < 4 || x).join('  ')}`.trimEnd());
    }
  }
  return out;
}

function runList(c: Ctx): void {
  const flag = c.args.flags.kind;
  if (flag !== undefined && !KINDS.includes(flag as EntryKind)) {
    c.fail(t('catalog.badKind'));
    return;
  }
  const showUser = c.args.flags.user === true || c.args.flags.system !== true;
  const showSystem = c.args.flags.system === true || c.args.flags.user !== true;
  const all = collect(c);
  const mine = all.filter((a) => a.source !== 'system');
  const keep = (a: AnyEntry) => flag === undefined || kindOf(a) === flag;
  const user = showUser ? mine.filter(keep) : [];
  const system = showSystem ? all.filter((a) => a.source === 'system' && keep(a)) : [];
  if (c.args.flags.json === true) {
    json(c, () => ({ user: user.map(summary), system: system.map(summary) }));
    return;
  }
  const out: string[] = [];
  if (showUser && (user.length || !mine.length)) {
    out.push(t('catalog.section.user'));
    out.push(...(user.length ? sectionLines(user) : [`  ${t('catalog.list.noUser')}`]));
  }
  if (system.length) {
    if (out.length) out.push('');
    out.push(t('catalog.section.system'), ...sectionLines(system));
  }
  for (const line of out) c.io.log(line);
}

function previewLines(c: Ctx, a: AnyEntry, source: PreviewSource, width: number): string[] {
  const loaded = loadForUse(c.cfgFile, () => c.gsd);
  const current = loaded.issue || loaded.error ? defaultConfig() : loaded.config;
  const content = contentOf(a);
  const kind = kindOf(a);
  const theme = kind !== 'preset' && content.theme ? draftTheme(content.theme) : undefined;
  const config = applyCatalogContent(current, content, kind);
  const pasteSafe = resolveGlyphMode(config, c.env) === 'paste-safe';
  return renderPreview(config, source, width, theme).map((l) =>
    pasteSafe ? finalizeLine(l, { pasteSafe }) : l,
  );
}

function runShow(c: Ctx): void {
  const flag = scenarioFlag(c.args.flags.scenario);
  if (flag.kind === 'list') {
    for (const line of scenarioListLines()) c.io.log(line);
    return;
  }
  if (flag.kind === 'unknown') {
    c.fail(t('preview.unknownScenario', { name: clean(flag.name) }));
    for (const line of scenarioListLines().slice(1)) c.io.error(line);
    return;
  }
  const hit = find(c, c.args.positional[1]);
  if (!hit) return;
  const w = typeof c.args.flags.width === 'string' ? Math.floor(Number(c.args.flags.width)) : Number.NaN;
  const width = Number.isFinite(w) && w > 0 ? Math.min(400, Math.max(20, w)) : (c.io.columns ?? 120);
  const source: PreviewSource = flag.kind === 'scenario' ? { scenario: flag.id } : 'sample';
  if (c.args.flags.json === true) {
    json(c, () => {
      const entry: Summary & { versions?: VersionRow[] } = summary(hit);
      if (hit.source === 'user') entry.versions = versionRows(hit);
      return { entry, preview: previewLines(c, hit, source, width).map(stripAnsi) };
    });
    return;
  }
  const s = summary(hit);
  const meta = [t(`catalog.kind.${s.kind}`), t('catalog.version', { version: s.version })];
  if (s.author) meta.push(t('catalog.by', { author: s.author }));
  const state = chip(hit, s);
  if (state) meta.push(state);
  c.io.log(`${s.name}  ${s.ref}`);
  c.io.log(meta.join(' · '));
  if (s.description) c.io.log(s.description);
  c.io.log('');
  c.io.log(t('catalog.show.preview'));
  const plain = plainOutput(c.io.tty, c.env);
  for (const line of previewLines(c, hit, source, width)) c.io.log(`  ${plain ? stripAnsi(line) : line}`);
}

function runHistory(c: Ctx): void {
  const hit = find(c, c.args.positional[1]);
  if (!hit) return;
  const rows = versionRows(hit);
  if (c.args.flags.json === true) {
    json(c, () => ({ ref: refOf(hit), versions: rows }));
    return;
  }
  const s = summary(hit);
  const at = t(hit.source === 'legacy' ? fileLabel(hit.item.kind) : 'catalog.source.system');
  c.io.log(t('catalog.history.title', { name: s.name }));
  for (const r of rows) {
    const extra: string[] = [];
    if (r.restoredFrom !== null) extra.push(t('catalog.history.restored', { from: r.restoredFrom }));
    if (r.overwrittenAt !== null) extra.push(t('catalog.history.overwritten', { at: when(r.overwrittenAt) }));
    const row = t('catalog.history.row', { version: r.version, at: r.at ? when(r.at) : at, note: r.note });
    c.io.log(`  ${[row.trimEnd(), ...extra].join('  ')}`);
  }
}

const STORE_IDS: Record<StoreCode, MessageId> = {
  exists: 'err.catalog.exists',
  changed: 'err.catalog.changed',
  'too-large': 'err.catalog.tooLarge',
  'not-found': 'err.catalog.unknownRef',
  'bad-id': 'err.catalog.badId',
  'bad-name': 'err.catalog.badName',
  'bad-content': 'err.catalog.badContent',
  'bad-endpoint': 'err.catalog.badEndpoint',
  'no-version': 'err.catalog.noVersion',
  busy: 'err.catalog.busy',
  reserved: 'catalog.publish.reserved',
  installed: 'err.catalog.installed',
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const kindWord = (kind: EntryKind): string =>
  t(`catalog.kind.${kind}`).toLocaleLowerCase(languageLocale());

function flagKind(c: Ctx): EntryKind | null {
  const flag = c.args.flags.kind;
  return flag === undefined ? 'bundle' : KINDS.includes(flag as EntryKind) ? (flag as EntryKind) : null;
}

function storeFail(c: Ctx, err: CatalogStoreError): void {
  const d = err.data;
  const kind = flagKind(c);
  c.fail(
    t(STORE_IDS[err.code], {
      ref: clean(c.args.positional[1]),
      kind: kind ? kindWord(kind) : '',
      name: clean(d.name),
      version: typeof d.version === 'number' ? d.version : '',
    }),
  );
}

const textFlag = (c: Ctx, key: string): string | undefined =>
  typeof c.args.flags[key] === 'string' ? (c.args.flags[key] as string) : undefined;

const shown = (file: string): string => clean(tildify(file));

function dryRunDone(c: Ctx): void {
  if (c.dryRun) c.io.log(t('catalog.dryRun'));
}

const shareText = (e: CatalogEntry, state: ShareState): string =>
  t(SHARE_IDS[state], { version: e.share.remote?.version ?? e.version });

function usable(c: Ctx, loaded: LoadResult): boolean {
  if (reportConfigIssue(loaded, c.io)) {
    process.exitCode = 1;
    return false;
  }
  if (loaded.error) {
    c.fail(t('catalog.failed', { error: clean(loaded.error) }));
    return false;
  }
  return true;
}

// a legacy item becomes an entry on its first change; a dry run only pretends
function writable(c: Ctx, hit: AnyEntry): CatalogEntry | null {
  if (hit.source === 'system') {
    c.fail(t('err.catalog.systemReadOnly'));
    return null;
  }
  if (hit.source === 'user') return hit.entry;
  const i = hit.item;
  if (!c.dryRun) return adoptLegacy(i.ref, c.now(), c.dir);
  return newEntry({
    id: i.ref,
    kind: i.kind,
    name: i.name,
    description: i.description,
    author: i.author,
    content: i.content,
    share: false,
    now: c.now().toISOString(),
  });
}

const targetKey = (x: ImportTarget) => `${x.kind}\u0000${x.target}`;

async function runApply(c: Ctx): Promise<void> {
  const hit = find(c, c.args.positional[1]);
  if (!hit) return;
  const loaded = loadForUse(c.cfgFile, () => c.gsd);
  if (!usable(c, loaded)) return;
  const current = loaded.config;
  const m = await import('./manage.js');
  const ref = refOf(hit);
  const kind = kindOf(hit);
  const name = summary(hit).name;
  const content = structuredClone(contentOf(hit));
  let dropped: ImportTarget[] = [];
  if (kind !== 'theme' && content.layout) {
    const before = importTargets(content.layout);
    const parts = [m.selfCommand(), 'catalog', 'apply', m.shellArg(ref) ?? ref, '--allow-commands'];
    if (c.dryRun) parts.push('--dry-run');
    const rerun = { command: sanitizeText(parts.join(' ')), addFile: false, addCommand: false };
    const flags = {
      allowCommands: c.args.flags['allow-commands'] === true,
      yes: c.args.flags.yes === true,
      dryRun: c.dryRun,
    };
    const io: PromptIo = c.json ? { ...c.io, tty: false, log: () => {} } : c.io;
    const kept = await m.confirmTargets({ config: content.layout, notes: [] }, flags, io, rerun);
    const left = importTargets(kept.config).map(targetKey);
    dropped = before.filter((x) => {
      const i = left.indexOf(targetKey(x));
      if (i >= 0) left.splice(i, 1);
      return i < 0;
    });
    content.layout = kept.config;
  }
  const lost = () => dropped.map((x) => ({ kind: x.kind, target: x.target }));
  const embedded = kind !== 'preset' && !!content.theme;
  if (c.dryRun) {
    const config = keepLanguage(applyCatalogContent(current, content, kind), current);
    const io: PromptIo = c.json ? { ...c.io, tty: false } : c.io;
    const preview = m.dryRunPreview(config, io, embedded ? draftTheme(content.theme) : undefined);
    if (c.json) {
      json(c, () => ({
        applied: ref,
        kind,
        file: c.cfgFile,
        backup: null,
        theme: null,
        dropped: lost(),
        dryRun: true,
        preview: preview.map(stripAnsi),
      }));
      return;
    }
    c.io.log(t('catalog.apply.dryRun', { name }));
    for (const line of preview) c.io.log(line);
    return;
  }
  const installed = embedded ? installEntryTheme(content, path.join(path.dirname(c.dir), 'themes')) : null;
  const next = applyCatalogContent(current, content, kind, installed?.id);
  const backup = m.backupConfig(c.cfgFile);
  saveConfig(keepLanguage(next, current), c.cfgFile, { overwriteBroken: true });
  if (c.json) {
    json(c, () => ({ applied: ref, kind, file: c.cfgFile, backup, theme: installed, dropped: lost() }));
    return;
  }
  c.io.log(t('catalog.apply.done', { name, file: shown(c.cfgFile) }));
  if (backup) c.io.log(t('catalog.apply.previous', { file: shown(backup) }));
  if (installed?.renamed) {
    const own = content.theme?.id;
    const base = typeof own === 'string' && ID_RE.test(own) ? own : clean(content.appearance?.theme);
    c.io.log(t('catalog.apply.themeRenamed', { id: clean(base), newId: clean(installed.id) }));
  } else if (installed?.written) c.io.log(t('catalog.apply.themeInstalled', { id: clean(installed.id) }));
}

async function runSave(c: Ctx): Promise<void> {
  const name = (c.args.positional.slice(1).join(' ') || textFlag(c, 'name') || '').normalize('NFC').trim();
  if (!name) {
    c.fail(t('catalog.usage'));
    return;
  }
  if ([...name].length > ENTRY_LIMITS.name || CONTROL.test(name)) {
    c.fail(t('err.catalog.badName'));
    return;
  }
  const kind = flagKind(c);
  if (!kind) {
    c.fail(t('catalog.badKind'));
    return;
  }
  const { update, overwrite } = c.args.flags;
  if (update === true && overwrite === true) {
    c.fail(t('catalog.save.bothModes'));
    return;
  }
  const loaded = loadForUse(c.cfgFile, () => c.gsd);
  if (!usable(c, loaded)) return;
  const content = contentFromConfig(loaded.config, kind);
  const existing = findByName(kind, name, c.dir);
  let mode: 'new' | 'update' | 'overwrite' = 'new';
  if (existing) {
    const { version } = existing;
    const shownName = clean(existing.name);
    if (update === true) mode = 'update';
    else if (overwrite === true) mode = 'overwrite';
    else if (!c.io.tty || c.json) {
      c.fail(t('catalog.save.exists', { name: shownName, version }));
      return;
    } else {
      c.io.log(t('catalog.save.ask', { name: shownName, version, next: version + 1 }));
      if (await c.io.ask(t('catalog.save.askUpdate', { next: version + 1 }), false)) mode = 'update';
      else if (await c.io.ask(t('catalog.save.askOverwrite', { version }), false)) mode = 'overwrite';
      else {
        c.io.log(t('catalog.save.cancelled'));
        return;
      }
    }
  }
  const old = mode === 'new' ? null : existing;
  const author = textFlag(c, 'author') ?? old?.author ?? readProfile(c.dir).author;
  const description = textFlag(c, 'description') ?? old?.description ?? '';
  const note = textFlag(c, 'note') ?? '';
  const share = c.args.flags.share;
  if (c.dryRun) {
    const version = old ? old.version + (mode === 'update' ? 1 : 0) : 1;
    const wanted = typeof share === 'boolean' ? share : old ? old.share.wanted : true;
    const state = old ? shareState(setShare(old, wanted)) : wanted ? 'pending' : 'local';
    if (c.json) {
      json(c, () => ({
        id: old?.id ?? null,
        kind,
        name,
        version,
        share: state,
        mode,
        dryRun: true,
        content,
      }));
      return;
    }
    c.io.log(t('catalog.save.dryRun', { kind: kindWord(kind), name: clean(name), version }));
    for (const line of JSON.stringify(content, null, 2).split('\n')) c.io.log(`  ${clean(line)}`);
    return;
  }
  const e = saveEntry(
    {
      kind,
      name,
      description,
      author,
      content,
      note,
      share: share !== false,
      mode,
      ...(old ? { id: old.id, rev: old.rev } : {}),
      ...(old && typeof share === 'boolean' ? { shareChange: share } : {}),
      now: c.now(),
    },
    c.dir,
  );
  if (textFlag(c, 'author') !== undefined) writeProfile({ author }, c.dir);
  const state = shareState(e);
  if (c.json) {
    json(c, () => ({ id: e.id, kind, name: clean(e.name), version: e.version, share: state, mode }));
    return;
  }
  c.io.log(t('catalog.save.done', { kind: kindWord(kind), name: clean(e.name), version: e.version }));
  if (state === 'pending')
    c.io.log(t(endpointOf(c) ? 'catalog.save.waitingEndpoint' : 'catalog.save.waiting'));
  else if (state === 'local') c.io.log(t('catalog.save.notShared', { ref: e.id }));
}

function runRestore(c: Ctx): void {
  const hit = find(c, c.args.positional[1]);
  if (!hit) return;
  const raw = c.args.positional[2] ?? '';
  const n = /^v?\d{1,9}$/i.test(raw) ? Number(raw.replace(/^v/i, '')) : 0;
  if (n < 1) {
    c.fail(t('catalog.usage'));
    return;
  }
  if (hit.source !== 'system' && !versionRows(hit).some((r) => r.version === n)) {
    c.fail(t('err.catalog.noVersion', { ref: clean(refOf(hit)), version: n }));
    return;
  }
  const e = writable(c, hit);
  if (!e) return;
  // restoredFrom labels it; no note in the language of the moment
  const next = c.dryRun
    ? restoreVersion(e, n, '', c.now().toISOString())!
    : restoreEntry(e.id, n, e.rev, '', c.dir, c.now());
  if (c.json) {
    json(c, () => ({
      id: next.id,
      version: next.version,
      restoredFrom: n,
      ...(c.dryRun ? { dryRun: true } : {}),
    }));
    return;
  }
  c.io.log(t('catalog.restore.done', { from: n, name: clean(next.name), version: next.version }));
  dryRunDone(c);
}

function shareCommand(wanted: boolean): (c: Ctx) => void {
  return (c) => {
    const hit = find(c, c.args.positional[1]);
    if (!hit) return;
    const e = writable(c, hit);
    if (!e) return;
    if (wanted && isReserved(e)) {
      c.fail(t('catalog.publish.reserved', { name: clean(e.name) }));
      return;
    }
    if (wanted && e.origin) {
      c.fail(t('err.catalog.installed'));
      return;
    }
    const next = c.dryRun ? setShare(e, wanted) : updateShare(e.id, wanted, e.rev, c.dir);
    const state = shareState(next);
    if (c.json) {
      json(c, () => ({ id: next.id, share: state, ...(c.dryRun ? { dryRun: true } : {}) }));
      return;
    }
    const name = clean(next.name);
    c.io.log(t(wanted ? 'catalog.share.on' : 'catalog.share.off', { name, state: shareText(next, state) }));
    if (state === 'withdraw-pending') c.io.log(t('catalog.share.withdrawLater'));
    dryRunDone(c);
  };
}

const themesOf = (c: Ctx): string => path.join(path.dirname(c.dir), 'themes');

// the config theme and its parents; an unreadable config keeps the file
function themesInUse(c: Ctx, e: CatalogEntry): string[] {
  const loaded = loadForUse(c.cfgFile, () => c.gsd);
  if (loaded.issue || loaded.error) return e.legacy?.theme ? [e.legacy.theme] : [];
  return themeChain(loaded.config.theme, themesOf(c));
}

async function runDelete(c: Ctx): Promise<void> {
  const hit = find(c, c.args.positional[1]);
  if (!hit) return;
  if (hit.source === 'system') {
    c.fail(t('err.catalog.systemReadOnly'));
    return;
  }
  const name = summary(hit).name;
  const trash = path.join(c.dir, 'trash');
  // ccinfobar cannot withdraw the copy once the entry is gone
  const remote = hit.source === 'user' ? hit.entry.share.remote : null;
  if (!c.dryRun && c.args.flags.yes !== true) {
    if (!c.io.tty || c.json) {
      c.fail(t('catalog.delete.needsYes', { name }));
      return;
    }
    const ask = remote ? 'catalog.delete.askPublished' : 'catalog.delete.ask';
    if (!(await c.io.ask(t(ask, { name, dir: shown(trash) }), false))) {
      c.io.log(t('catalog.delete.kept', { name }));
      return;
    }
  }
  let file = trash;
  let kept: string | null = null;
  if (!c.dryRun) {
    if (hit.source === 'user') {
      const done = deleteEntry(hit.entry.id, c.dir, c.now(), { themesInUse: themesInUse(c, hit.entry) });
      file = done.file;
      kept = done.kept;
    } else if (!deleteLegacy(hit.item.ref, c.dir, c.now())) {
      c.fail(t('err.catalog.unknownRef', { ref: clean(hit.item.ref) }));
      return;
    }
  }
  if (c.json) {
    json(c, () => ({
      deleted: refOf(hit),
      trash: file,
      kept,
      published: remote !== null,
      ...(c.dryRun ? { dryRun: true } : {}),
    }));
    return;
  }
  c.io.log(t('catalog.delete.done', { name, file: shown(file) }));
  if (remote) c.io.log(t('catalog.delete.publishedStays', { id: clean(remote.id) }));
  if (kept) c.io.log(t('catalog.delete.keptTheme', { file: shown(path.join(themesOf(c), `${kept}.json`)) }));
  dryRunDone(c);
}

function runAuthor(c: Ctx): void {
  const given = c.args.positional.length > 1;
  let author = readProfile(c.dir).author;
  if (given) {
    const raw = c.args.positional.slice(1).join(' ');
    author = c.dryRun
      ? [...sanitizeText(raw).trim()].slice(0, ENTRY_LIMITS.author).join('').trim()
      : writeProfile({ author: raw }, c.dir).author;
  }
  if (c.json) {
    json(c, () => ({ author: author || null, ...(c.dryRun && given ? { dryRun: true } : {}) }));
    return;
  }
  const id: MessageId = !author
    ? 'catalog.author.none'
    : given
      ? 'catalog.author.set'
      : 'catalog.author.show';
  c.io.log(t(id, { author: clean(author) }));
  if (given) dryRunDone(c);
}

const SOURCE_IDS: Partial<Record<EndpointSource, MessageId>> = {
  env: 'catalog.endpoint.source.env',
  set: 'catalog.endpoint.source.set',
  default: 'catalog.endpoint.source.default',
};

// validates only; nothing is sent
async function runEndpoint(c: Ctx): Promise<void> {
  const raw = c.args.positional[1];
  const clear = c.args.flags.clear === true;
  const off = c.args.flags.off === true;
  if ((clear && off) || ((clear || off) && raw !== undefined)) {
    c.fail(t('catalog.usage'));
    return;
  }
  let url: string | null;
  let source: EndpointSource;
  let id: MessageId;
  if (off) {
    if (!c.dryRun) writeProfile({ endpoint: false }, c.dir);
    url = null;
    source = 'off';
    id = 'catalog.endpoint.off';
  } else if (clear) {
    if (!c.dryRun) writeProfile({ endpoint: null }, c.dir);
    url = c.defaultEndpoint;
    source = url ? 'default' : 'none';
    id = url ? 'catalog.endpoint.default' : 'catalog.endpoint.cleared';
  } else if (raw !== undefined) {
    const u = checkEndpoint(raw);
    if (!u) {
      c.fail(t('err.catalog.badEndpoint'));
      return;
    }
    url = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (!c.dryRun) writeProfile({ endpoint: url }, c.dir);
    source = 'set';
    id = 'catalog.endpoint.set';
  } else {
    ({ url, source } = marketEndpointInfo(c.env, c.dir, c.defaultEndpoint));
    id = source === 'off' ? 'catalog.endpoint.off' : url ? 'catalog.endpoint.show' : 'catalog.endpoint.none';
  }
  const changed = clear || off || raw !== undefined;
  if (c.json) {
    json(c, () => ({ endpoint: url, source, ...(c.dryRun && changed ? { dryRun: true } : {}) }));
    return;
  }
  const from = SOURCE_IDS[source];
  c.io.log(t(id, { url: clean(url), source: from ? t(from) : '' }));
  if (changed) dryRunDone(c);
}

// per endpoint; only a new handle or --check sends a request
async function runPublisher(c: Ctx): Promise<void> {
  if (c.args.flags.check === true) {
    await market(c, 'check');
    return;
  }
  const endpoint = endpointOf(c);
  if (!endpoint) {
    c.fail(t('err.catalog.noEndpoint'));
    return;
  }
  const raw = c.args.positional[1];
  const forget = c.args.flags.forget === true;
  if (forget && raw !== undefined) {
    c.fail(t('catalog.usage'));
    return;
  }
  const ep = clean(endpoint);
  const cur = readPublisher(endpoint, c.dir);
  const registered = readCredential(endpoint, c.dir) !== null;
  let handle = cur;
  let id: MessageId;
  if (forget) {
    if (!c.dryRun) forgetPublisher(endpoint, c.dir);
    handle = null;
    id = 'catalog.publisher.forgot';
  } else if (raw !== undefined) {
    const next = raw.trim();
    if (!isHandle(next)) {
      c.fail(t('err.catalog.badHandle'));
      return;
    }
    // the handle comes from GitHub sign-in there
    if (await (await import('./catalog-market.js')).githubOnly(c, endpoint)) {
      c.fail(t('err.catalog.githubHandle'));
      return;
    }
    if (registered && cur !== null && cur !== next) {
      c.fail(t('catalog.publisher.registered', { handle: cur, endpoint: ep }));
      return;
    }
    if (!c.dryRun) writePublisher(endpoint, next, c.dir);
    handle = next;
    id = 'catalog.publisher.set';
  } else
    id = !cur
      ? 'catalog.publisher.none'
      : registered
        ? 'catalog.publisher.registeredShow'
        : 'catalog.publisher.show';
  const changed = forget || raw !== undefined;
  if (c.json) {
    json(c, () => ({
      endpoint,
      publisher: handle,
      registered: forget ? false : registered,
      ...(c.dryRun && changed ? { dryRun: true } : {}),
    }));
    return;
  }
  const guess = marketSlug(readProfile(c.dir).author || 'publisher');
  c.io.log(t(id, { endpoint: ep, handle: clean(handle ?? guess) }));
  if (changed) dryRunDone(c);
}

// marketplace code loads only for publish, sign-in, --check and --remote
async function market(
  c: Ctx,
  sub: 'publish' | 'list' | 'show' | 'login' | 'logout' | 'check',
): Promise<void> {
  const m = await import('./catalog-market.js');
  if (sub === 'publish') await m.runPublishCommand(c);
  else if (sub === 'check') await m.runPublisherCheck(c);
  else if (sub === 'login') await m.runLogin(c);
  else if (sub === 'logout') await m.runLogout(c);
  else if (sub === 'list') await m.runRemoteList(c);
  else await m.runRemoteShow(c);
}

const local =
  (sub: 'list' | 'show', run: (c: Ctx) => void) =>
  (c: Ctx): void | Promise<void> =>
    c.args.flags.remote === true ? market(c, sub) : run(c);

const SUBCOMMANDS: Record<string, (c: Ctx) => void | Promise<void>> = {
  list: local('list', runList),
  show: local('show', runShow),
  history: runHistory,
  apply: runApply,
  save: runSave,
  restore: runRestore,
  share: shareCommand(true),
  unshare: shareCommand(false),
  delete: runDelete,
  author: runAuthor,
  endpoint: runEndpoint,
  publisher: runPublisher,
  publish: (c) => market(c, 'publish'),
  login: (c) => market(c, 'login'),
  logout: (c) => market(c, 'logout'),
};

export async function runCatalog(args: Args, cfgFile: string, deps: CatalogDeps = {}): Promise<void> {
  const io = deps.io ?? promptIo();
  const env = deps.env ?? process.env;
  const fail = (msg: string) => {
    io.error(msg);
    process.exitCode = 1;
  };
  const sub = args.positional[0];
  const run = sub !== undefined && Object.hasOwn(SUBCOMMANDS, sub) ? SUBCOMMANDS[sub] : undefined;
  if (!run) {
    fail(t('catalog.usage'));
    return;
  }
  const dir = deps.dir ?? catalogDir(env);
  const c: Ctx = {
    args,
    cfgFile,
    io,
    env,
    dir,
    gsd: deps.gsd ?? gsdInstalled(env),
    now: deps.now ?? (() => new Date()),
    json: args.flags.json === true,
    dryRun: args.flags['dry-run'] === true,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    defaultEndpoint: deps.defaultEndpoint !== undefined ? deps.defaultEndpoint : DEFAULT_MARKETPLACE,
    ...(deps.open ? { open: deps.open } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    fail,
  };
  try {
    await run(c);
  } catch (err) {
    if (err instanceof CatalogStoreError) storeFail(c, err);
    else fail(t('catalog.failed', { error: clean((err as Error)?.message) }));
  }
}
