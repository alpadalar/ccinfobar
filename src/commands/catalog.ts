import '../core/i18n/lazy.js';
import {
  applyCatalogContent,
  type CatalogEntry,
  type EntryContent,
  type EntryKind,
  latest,
  type ShareState,
  slug,
} from '../catalog/model.js';
import { shareState } from '../catalog/share.js';
import { catalogDir, type LegacyItem, listEntries, listLegacy } from '../catalog/store.js';
import { type SystemEntry, systemEntries } from '../catalog/system.js';
import type { Args } from '../cli/args.js';
import { stripAnsi } from '../core/ansi.js';
import { defaultConfig } from '../core/config.js';
import { resolveGlyphMode } from '../core/glyphs.js';
import { bundleText, presetText, themeDescription } from '../core/i18n/catalog-text.js';
import { formatDateTime } from '../core/i18n/format.js';
import { languageLocale, type MessageId, t, withLanguage } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { ID_RE } from '../core/presets.js';
import { type PreviewSource, renderPreview, scenarioFlag, scenarioListLines } from '../core/preview.js';
import { finalizeLine } from '../core/renderer.js';
import { sanitizeText } from '../core/sanitize.js';
import { parseThemeInput, resolveThemeInput, type Theme } from '../core/themes.js';
import { padVisible, visibleWidth } from '../core/width.js';
import { gsdInstalled } from '../data/gsd.js';
import { type PromptIo, plainOutput, promptIo } from './io.js';

export interface CatalogDeps {
  io?: PromptIo;
  env?: NodeJS.ProcessEnv;
  dir?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  gsd?: boolean;
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
}

interface VersionRow {
  version: number;
  at: string | null;
  note: string;
  restoredFrom: number | null;
  overwrittenAt: string | null;
}

interface Ctx {
  args: Args;
  cfgFile: string;
  io: PromptIo;
  env: NodeJS.ProcessEnv;
  dir: string;
  gsd: boolean;
  fail(msg: string): void;
}

const KINDS: readonly EntryKind[] = ['bundle', 'preset', 'theme'];
const GROUPS: Record<EntryKind, MessageId> = {
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

const clean = (v: unknown): string => sanitizeText(typeof v === 'string' ? v : '');

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

function chip(a: AnyEntry, s: Summary): string {
  if (a.source === 'legacy') return t('catalog.source.legacy');
  if (a.source === 'system') return t('catalog.source.system');
  const version = a.entry.share.remote?.version ?? a.entry.version;
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

function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? clean(at) : formatDateTime(d, languageLocale());
}

function collect(c: Ctx): AnyEntry[] {
  const user: AnyEntry[] = listEntries(c.dir).map((entry) => ({ source: 'user', entry }));
  const legacy: AnyEntry[] = listLegacy({ dir: c.dir }).map((item) => ({ source: 'legacy', item }));
  const system: AnyEntry[] = systemEntries({ gsd: c.gsd }).map((entry) => ({ source: 'system', entry }));
  return [...user, ...legacy, ...system];
}

function find(c: Ctx, ref: string | undefined): AnyEntry | null {
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
  const at = t(hit.source === 'legacy' ? 'catalog.source.legacy' : 'catalog.source.system');
  c.io.log(t('catalog.history.title', { name: s.name }));
  for (const r of rows) {
    const extra: string[] = [];
    if (r.restoredFrom !== null) extra.push(t('catalog.history.restored', { from: r.restoredFrom }));
    if (r.overwrittenAt !== null) extra.push(t('catalog.history.overwritten', { at: when(r.overwrittenAt) }));
    const row = t('catalog.history.row', { version: r.version, at: r.at ? when(r.at) : at, note: r.note });
    c.io.log(`  ${[row.trimEnd(), ...extra].join('  ')}`);
  }
}

const SUBCOMMANDS: Record<string, (c: Ctx) => void> = {
  list: runList,
  show: runShow,
  history: runHistory,
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
  run({ args, cfgFile, io, env, dir, gsd: deps.gsd ?? gsdInstalled(env), fail });
}
