import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import '../core/i18n/lazy.js';
import {
  type CatalogEntry,
  ENTRY_ID_RE,
  type EntryContent,
  type EntryKind,
  latest,
} from '../catalog/model.js';
import { shareState } from '../catalog/share.js';
import { contentFromConfig, themeFromConfig } from '../catalog/snapshot.js';
import {
  adoptLegacy,
  CatalogStoreError,
  deleteEntry,
  deleteLegacy,
  installEntryTheme,
  isHandle,
  type LegacyItem,
  listEntries,
  listLegacy,
  marketEndpoint,
  normalizeEntry,
  readCredential,
  readEntry,
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
import { findSystem, type SystemEntry, systemEntries } from '../catalog/system.js';
import { configLanguage, envLanguage } from '../cli/lang.js';
import { hookEntryState } from '../commands/hooks-doctor.js';
import {
  applyHooks,
  DEFAULT_EVENTS,
  detectClaudeCodeAsync,
  HOOK_FLOOR,
  type HookRefusal,
  OPTIONAL_EVENTS,
  planHooks,
  uninstallHooks,
} from '../commands/hooks-install.js';
import {
  applyInstall,
  currentStatusLine,
  defaultCommand,
  InstallNeedsConfirmError,
  planInstall,
  type Setup,
  type StatusLineSetting,
  setupCommandAsync,
} from '../commands/install.js';
import { classifyOwner, deepEqual, findHookEntries, owns, readManifest } from '../commands/manifest.js';
import { openBrowser } from '../commands/open.js';
import { backupsDir, readSettings } from '../commands/settings-file.js';
import {
  compareVersions,
  fetchLatest,
  type InstallKind,
  installKind,
  installVersionAsync,
  localPrefix,
  readUpdateState,
  writeUpdateState,
} from '../commands/update.js';
import { BREW_UPGRADE } from '../core/brew.js';
import { ConfigBrokenError, loadConfig, normalizeConfig, saveConfig } from '../core/config.js';
import {
  applyCatalogContent,
  applyStyle,
  PROGRESS_CHOICES,
  type StyleHistory,
  setProgress,
  upgradeOptions,
} from '../core/edit.js';
import { bundleText, presetLabels, presetText, themeDescription } from '../core/i18n/catalog-text.js';
import { type MessageId, type Params, setLanguage, t, withLanguage } from '../core/i18n/index.js';
import { isLanguageId, type LanguageId } from '../core/i18n/languages.js';
import { availablePresets, loadForUse } from '../core/load.js';
import { claudeSettingsPath, lastPayloadPath, tildify } from '../core/paths.js';
import { deleteUserPreset, listPresets, presetsDir, saveUserPreset } from '../core/presets.js';
import { type PreviewSource, renderPreview, renderPreviewReport } from '../core/preview.js';
import { sanitizeText } from '../core/sanitize.js';
import { getScenario, scenarioList } from '../core/scenarios.js';
import {
  deleteUserTheme,
  listThemes,
  parseThemeInput,
  resolveThemeInput,
  STYLES,
  saveUserTheme,
  type Theme,
  themesDir,
} from '../core/themes.js';
import type { Config, ProgressConfig, WidgetItem } from '../core/types.js';
import { gsdInstalled } from '../data/gsd.js';
import { PROGRESS_EVENTS, progressChannel } from '../data/progress.js';
import { requestClear } from '../data/progress-clear.js';
import { writeAtomic } from '../data/store.js';
import { ID_PART_RE } from '../market/protocol.js';
import { ALL_WIDGETS, CATEGORIES } from '../widgets/index.js';
import type { TerminalColors } from './terminal-colors.js';

declare const __VERSION__: string;
declare const __EDITOR_HTML__: string;

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';
const MAX_BODY = 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEMO_TYPES = ['model', 'cwd', 'git-branch', 'context-bar', 'gsd-phase', 'gsd-plans', 'session-cost'];

export interface EditorOptions {
  configPath: string;
  port?: number | undefined;
  open?: boolean;
  host?: string;
  terminal?: TerminalColors | null;
  setup?: (version: string) => Promise<Setup>;
  claudeVersion?: () => string | null | Promise<string | null>;
  installKind?: () => InstallKind;
  fetchLatest?: (timeoutMs: number) => Promise<string>;
  detached?: { idleMs: number; stateFile: string; checkMs?: number; now?: () => number };
}

export interface HooksInfo {
  installed: string[];
  available: boolean;
  reason?: string;
  reasonId?: MessageId;
  reasonParams?: Params;
  claudeCode?: string;
  events: string[];
  optional: string[];
  progress: string[];
}

export interface EditorHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
    readonly id?: MessageId,
    readonly params?: Params,
  ) {
    super(message);
  }
}

type Text = { id: MessageId; params?: Params };

const english = (m: Text): string => withLanguage('en', () => t(m.id, m.params));

// the browser shows t(errorId, errorParams); error stays English
function httpError(
  status: number,
  id: MessageId,
  params?: Params,
  extra?: Record<string, unknown>,
): HttpError {
  return new HttpError(status, english({ id, ...(params ? { params } : {}) }), extra, id, params);
}

const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>ccinfobar editor</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:3rem">
<h1>Editor bundle not built</h1><p>Run <code>npm run build</code> and start the editor again.</p></body>`;

function editorHtml(): string {
  return (typeof __EDITOR_HTML__ === 'string' && __EDITOR_HTML__) || FALLBACK_HTML;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(httpError(413, 'err.server.tooLarge'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'err.server.badJson'));
      }
    });
    req.on('error', reject);
  });
}

export { openBrowser };

function widgetCatalog() {
  return ALL_WIDGETS.map((w) => ({
    type: w.type,
    name: w.name,
    category: w.category,
    description: w.description,
    label: w.label,
    icon: w.icon,
    color: w.color,
    options: w.options ?? [],
    sample: w.sample,
    hidden: w.hidden ?? false,
    timeBased: w.timeBased === true,
    hideWhenEmpty: w.hideWhenEmpty === true,
  }));
}

// manifest ownership, not a substring
function isInstalled(statusLine: StatusLineSetting | null, command: string | null): boolean {
  if (!statusLine) return false;
  try {
    const m = readManifest();
    const file = claudeSettingsPath();
    return owns(m, file, statusLine) || classifyOwner(m, file, statusLine, command) === 'legacy-ours';
  } catch {
    return false;
  }
}

function claudeInfo(command: string | null) {
  let statusLine: StatusLineSetting | null = null;
  try {
    statusLine = currentStatusLine();
  } catch {}
  return {
    statusLine,
    installed: isInstalled(statusLine, command),
    defaultCommand: command ?? placeholder(),
    settingsFile: tildify(claudeSettingsPath()),
  };
}

// statusLine command when ccinfobar owns it
function activeCommand(command: string | null): string | null {
  try {
    const sl = currentStatusLine();
    return isInstalled(sl, command) && typeof sl?.command === 'string' && sl.command.trim()
      ? sl.command
      : null;
  } catch {
    return null;
  }
}

const ORDER: readonly string[] = [...DEFAULT_EVENTS, ...OPTIONAL_EVENTS, ...PROGRESS_EVENTS];

function installedHooks(progress = false): string[] {
  try {
    const file = claudeSettingsPath();
    const data = readSettings(file).data as Record<string, unknown>;
    return findHookEntries(readManifest(), file)
      .filter((e) => (progress ? e.role === 'progress' : !e.role) && hookEntryState(e, data) === 'ok')
      .map((e) => e.event)
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  } catch {
    return [];
  }
}

function refusalText(refused: HookRefusal, version: string | null): Text {
  return refused === 'unknown-version'
    ? { id: 'hooks.reason.unknownVersion', params: { floor: HOOK_FLOOR.core } }
    : { id: 'hooks.reason.oldVersion', params: { floor: HOOK_FLOOR.core, version: version ?? '' } };
}

function progressRefusalText(refused: HookRefusal, version: string | null): Text {
  const floor = HOOK_FLOOR.terminalSequence;
  return refused === 'unknown-version'
    ? { id: 'progress.refused.unknownVersion', params: { floor } }
    : { id: 'progress.refused.oldVersion', params: { floor, version: version ?? '' } };
}

const NOT_ACTIVE: Text = { id: 'hooks.reason.notActive' };

const reasonOf = (m: Text) => ({
  reason: english(m),
  reasonId: m.id,
  ...(m.params ? { reasonParams: m.params } : {}),
});

const textError = (status: number, m: Text, extra?: Record<string, unknown>): HttpError =>
  httpError(status, m.id, m.params, extra);

const PLACEHOLDER_PREFIX = 'ccinfobar (';
const placeholder = () => `${PLACEHOLDER_PREFIX}installed on first Install)`;

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function previewSourceOf(body: Record<string, unknown>): PreviewSource {
  if (body.source === 'last') return 'last';
  if (body.source === 'scenario' && typeof body.scenario === 'string' && getScenario(body.scenario)) {
    return { scenario: body.scenario };
  }
  return 'sample';
}

type Found =
  | { source: 'user'; entry: CatalogEntry }
  | { source: 'legacy'; item: LegacyItem }
  | { source: 'system'; entry: SystemEntry };

export interface EntrySummary {
  ref: string;
  source: Found['source'];
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  version: number;
  rev: number | null;
  share: { wanted: boolean; state: string } | null;
  remote: { id: string; version: number } | null;
  updatedAt: string | null;
  scenario: string | null;
  content: EntryContent;
}

const KINDS: readonly EntryKind[] = ['bundle', 'preset', 'theme'];
const LEGACY_RE = /^legacy:(?:preset|theme)\/(.*)$/;
const SYSTEM_RE = /^(?:bundle|preset|theme)\/(.*)$/;
const MAX_PREVIEWS = 100;
const MAX_PUBLISH_REFS = 500;

type Market = typeof import('../commands/catalog-market.js');
type PlanItem = ReturnType<Market['publishPlan']>[number];
type Skip = { id: string; reason: 'not-shared' | 'up-to-date' | 'withdrawn' };

// market codes; read failures are a bad gateway
function marketError(code: string | null, id: MessageId, status?: number): HttpError {
  if (code === 'no-endpoint') return httpError(409, 'err.catalog.noEndpoint');
  const http =
    code === 'not-found' ? 404 : code === 'handle-taken' ? 409 : code === 'bad-endpoint' ? 400 : 502;
  return httpError(http, id, status === undefined ? undefined : { status }, { code });
}

const clean = (v: unknown): string => sanitizeText(typeof v === 'string' ? v : '');
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isKind = (v: unknown): v is EntryKind => KINDS.includes(v as EntryKind);

function refType(ref: unknown): Found['source'] | null {
  if (typeof ref !== 'string') return null;
  if (ENTRY_ID_RE.test(ref)) return 'user';
  const legacy = LEGACY_RE.exec(ref);
  if (legacy && ID_RE.test(legacy[1]!)) return 'legacy';
  const system = SYSTEM_RE.exec(ref);
  return system && ID_RE.test(system[1]!) ? 'system' : null;
}

const refOf = (a: Found): string =>
  a.source === 'user' ? a.entry.id : a.source === 'legacy' ? a.item.ref : a.entry.ref;
const entryKind = (a: Found): EntryKind => (a.source === 'legacy' ? a.item.kind : a.entry.kind);

function contentOf(a: Found): EntryContent {
  if (a.source === 'user') return latest(a.entry).content;
  return a.source === 'legacy' ? a.item.content : a.entry.content;
}

function systemText(e: SystemEntry, field: 'name' | 'description'): string {
  if (e.kind === 'bundle') return bundleText(e, field);
  if (e.kind === 'preset') return presetText(e, field);
  return field === 'name' ? e.name : themeDescription(e);
}

function summaryOf(a: Found): EntrySummary {
  const base = { ref: refOf(a), source: a.source, kind: entryKind(a), content: contentOf(a) };
  if (a.source === 'user') {
    const e = a.entry;
    const remote = e.share.remote;
    return {
      ...base,
      id: e.id,
      name: clean(e.name),
      description: clean(e.description),
      author: clean(e.author),
      version: e.version,
      rev: e.rev,
      share: { wanted: e.share.wanted, state: shareState(e) },
      remote: remote ? { id: clean(remote.id), version: remote.version } : null,
      updatedAt: e.updatedAt,
      scenario: null,
    };
  }
  const fixed = { version: 1, rev: null, share: null, remote: null, updatedAt: null };
  if (a.source === 'legacy') {
    const i = a.item;
    return {
      ...base,
      ...fixed,
      id: i.legacyId,
      name: clean(i.name),
      description: clean(i.description),
      author: clean(i.author),
      scenario: null,
    };
  }
  const e = a.entry;
  return {
    ...base,
    ...fixed,
    id: e.id,
    name: clean(systemText(e, 'name')),
    description: clean(systemText(e, 'description')),
    author: e.author,
    scenario: e.scenario ?? null,
  };
}

function versionsOf(a: Found) {
  if (a.source !== 'user')
    return [
      { version: 1, at: null, note: '', restoredFrom: null, overwrittenAt: null, content: contentOf(a) },
    ];
  return a.entry.versions.map((v) => ({
    version: v.version,
    at: v.at,
    note: clean(v.note),
    restoredFrom: v.restoredFrom ?? null,
    overwrittenAt: v.overwrittenAt ?? null,
    content: v.content,
  }));
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

const STORE_ERRORS: Record<StoreCode, [number, MessageId]> = {
  exists: [409, 'err.catalog.exists'],
  changed: [409, 'err.catalog.changed'],
  'too-large': [413, 'err.catalog.tooLarge'],
  'not-found': [404, 'err.catalog.unknownRef'],
  'bad-id': [400, 'err.catalog.badId'],
  'bad-name': [400, 'err.catalog.badName'],
  'bad-content': [400, 'err.catalog.badContent'],
  'bad-endpoint': [400, 'err.catalog.badEndpoint'],
  'no-version': [404, 'err.catalog.noVersion'],
  busy: [409, 'err.catalog.busy'],
  reserved: [409, 'catalog.publish.reserved'],
};

function storeError(err: CatalogStoreError, kind = ''): HttpError {
  const d = err.data;
  const [status, id] = STORE_ERRORS[err.code];
  const ref = clean(d.ref ?? d.id ?? d.name);
  const version = typeof d.version === 'number' ? d.version : undefined;
  if (err.code === 'exists') {
    const name = clean(d.name);
    return httpError(
      status,
      id,
      { kind, name, version: version ?? '' },
      { exists: { id: d.id, version, name } },
    );
  }
  if (err.code === 'not-found') return httpError(status, id, { ref });
  if (err.code === 'no-version') return httpError(status, id, { ref, version: version ?? '' });
  if (err.code === 'reserved') return httpError(status, id, { name: clean(d.name) });
  return httpError(status, id);
}

export async function startEditor(opts: EditorOptions): Promise<EditorHandle> {
  // API text stays English; the browser picks its language from `language`
  const auto = envLanguage();
  // console lines keep the cli language
  const cli = setLanguage('en');
  const host = opts.host ?? '127.0.0.1';
  const token = crypto.randomBytes(16).toString('hex');
  let command = defaultCommand();
  const setup = opts.setup ?? ((v: string) => setupCommandAsync(v));
  const kindOf = opts.installKind ?? installKind;
  const latestOf = opts.fetchLatest ?? fetchLatest;
  // async and once; started after listen, so the first request rarely waits
  const detectAbort = new AbortController();
  let detecting: Promise<string | null> | null = null;
  const claudeVersion = (): Promise<string | null> => {
    detecting ??= Promise.resolve()
      .then(() => (opts.claudeVersion ?? (() => detectClaudeCodeAsync({ signal: detectAbort.signal })))())
      .catch(() => null);
    return detecting;
  };
  const refusalOf = (version: string | null): HookRefusal | null =>
    planHooks({
      settings: {},
      manifest: { version: 1, entries: [] },
      file: '',
      command: '',
      claudeCode: version,
      events: [],
    }).refused;

  async function hooksInfo(cmd: string | null): Promise<HooksInfo> {
    const base = {
      installed: installedHooks(),
      events: [...DEFAULT_EVENTS],
      optional: [...OPTIONAL_EVENTS],
      progress: installedHooks(true),
    };
    if (!activeCommand(cmd)) return { ...base, available: false, ...reasonOf(NOT_ACTIVE) };
    const version = await claudeVersion();
    const refused = refusalOf(version);
    const claudeCode = version ? { claudeCode: version } : {};
    if (refused)
      return { ...base, available: false, ...reasonOf(refusalText(refused, version)), ...claudeCode };
    return { ...base, available: true, ...claudeCode };
  }
  const stylesFile = path.join(path.dirname(opts.configPath), 'styles.json');
  const readStyles = (): StyleHistory => {
    try {
      const v = JSON.parse(fs.readFileSync(stylesFile, 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as StyleHistory) : {};
    } catch {
      return {};
    }
  };
  const gsd = gsdInstalled();
  const presetList = () =>
    availablePresets(gsd).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      source: p.source ?? 'builtin',
      config: p.build(),
    }));

  // the UI language: an explicit hint, the config's own language, else the env
  const uiLang = (hint: unknown, config?: { language?: unknown }): LanguageId =>
    isLanguageId(hint) ? hint : isLanguageId(config?.language) ? config.language : auto.id;
  const diskLang = (hint: unknown): LanguageId => uiLang(hint, configLanguage(opts.configPath));

  function allEntries(): Found[] {
    return [
      ...listEntries().map((entry): Found => ({ source: 'user', entry })),
      ...listLegacy().map((item): Found => ({ source: 'legacy', item })),
      ...systemEntries({ gsd }).map((entry): Found => ({ source: 'system', entry })),
    ];
  }

  function findRef(ref: string): Found | null {
    const type = refType(ref);
    if (type === 'user') {
      const s = readEntry(ref);
      return s ? { source: 'user', entry: normalizeEntry(s.entry) } : null;
    }
    if (type === 'legacy') {
      const item = listLegacy().find((i) => i.ref === ref);
      return item ? { source: 'legacy', item } : null;
    }
    const entry = type === 'system' ? findSystem(ref, { gsd }) : null;
    return entry ? { source: 'system', entry } : null;
  }

  function mustFind(ref: string): Found {
    const hit = findRef(ref);
    if (!hit) throw httpError(404, 'err.catalog.unknownRef', { ref: clean(ref) });
    return hit;
  }

  function catalogBody(lang: LanguageId) {
    return withLanguage(lang, () => {
      const all = allEntries();
      const endpoint = marketEndpoint();
      return {
        system: all.filter((a) => a.source === 'system').map(summaryOf),
        user: all.filter((a) => a.source !== 'system').map(summaryOf),
        profile: { author: readProfile().author },
        endpoint: endpoint === null ? null : clean(endpoint),
        publishable: endpoint !== null,
      };
    });
  }

  const userResult = (e: CatalogEntry, lang: LanguageId) => ({
    ok: true,
    entry: withLanguage(lang, () => summaryOf({ source: 'user', entry: normalizeEntry(e) })),
    catalog: catalogBody(lang),
  });

  // body refs; system entries are read only
  function writableRef(ref: unknown): { type: 'user' | 'legacy'; ref: string } {
    const type = refType(ref);
    if (!type) throw httpError(400, 'err.catalog.badRef');
    if (type === 'system') {
      if (!findSystem(ref as string, { gsd }))
        throw httpError(404, 'err.catalog.unknownRef', { ref: clean(ref) });
      throw httpError(403, 'err.catalog.systemReadOnly');
    }
    return { type, ref: ref as string };
  }

  // the saved config's theme and its parents; an unreadable config keeps the file
  function liveThemes(id: string): string[] {
    const loaded = loadForUse(opts.configPath, () => gsd);
    const linked = readEntry(id)?.entry.legacy?.theme;
    if (loaded.issue || loaded.error) return linked ? [linked] : [];
    return themeChain(loaded.config.theme);
  }

  function currentRev(id: string, rev: unknown): number {
    if (Number.isInteger(rev)) return rev as number;
    const s = readEntry(id);
    if (!s) throw httpError(404, 'err.catalog.unknownRef', { ref: id });
    return s.entry.rev;
  }

  function previewOf(current: Config, a: Found, source: PreviewSource, width: number): string[] {
    const kind = entryKind(a);
    const content = contentOf(a);
    const theme = kind !== 'preset' && content.theme ? draftTheme(content.theme) : undefined;
    try {
      const next = applyCatalogContent(current, content, kind);
      // built-in layouts carry English labels
      const shown = a.source === 'system' && kind !== 'theme' ? presetLabels(next) : next;
      return renderPreview(shown, source, width, theme);
    } catch {
      return [];
    }
  }

  // marketplace code loads only after the endpoint check
  const loadMarket = (): Promise<Market> => import('../commands/catalog-market.js');

  function needEndpoint(): string {
    const endpoint = marketEndpoint();
    if (!endpoint) throw httpError(409, 'err.catalog.noEndpoint');
    return endpoint;
  }

  // explicit refs name user entries; legacy items are never shared
  function publishRefs(refs: unknown): { ids: string[] | null; skipped: Skip[] } {
    if (refs === undefined || refs === null) return { ids: null, skipped: [] };
    if (!Array.isArray(refs) || refs.length > MAX_PUBLISH_REFS)
      throw httpError(400, 'err.catalog.badRequest');
    const ids: string[] = [];
    const skipped: Skip[] = [];
    for (const raw of refs) {
      const { type, ref } = writableRef(raw);
      if (type === 'legacy') {
        if (!listLegacy().some((i) => i.ref === ref))
          throw httpError(404, 'err.catalog.unknownRef', { ref: clean(ref) });
        if (!skipped.some((x) => x.id === ref)) skipped.push({ id: ref, reason: 'not-shared' });
      } else if (!readEntry(ref)) throw httpError(404, 'err.catalog.unknownRef', { ref });
      else if (!ids.includes(ref)) ids.push(ref);
    }
    return { ids, skipped };
  }

  // the review reads server meta, so actions match what the server will do
  async function publishView(endpoint: string, refs: unknown) {
    const { ids, skipped } = publishRefs(refs);
    const m = await loadMarket();
    const review = await m.reviewPublish(ids);
    if (review.code && review.code !== 'read-only')
      throw marketError(review.code, m.reasonId(review.code), review.status);
    const entries = listEntries().filter((e) => ids === null || ids.includes(e.id));
    const plan: PlanItem[] = [];
    for (const item of review.plan) {
      if (m.reserved(item, entries)) skipped.push({ id: item.id, reason: 'withdrawn' });
      else plan.push(item);
    }
    if (ids !== null && !review.code)
      for (const e of entries) {
        if (plan.some((i) => i.id === e.id) || skipped.some((x) => x.id === e.id)) continue;
        skipped.push({ id: e.id, reason: shareState(e) === 'published' ? 'up-to-date' : 'not-shared' });
      }
    const kept = { ...review, endpoint, plan };
    const view = {
      endpoint: clean(endpoint),
      planHash: m.planHash(kept),
      notice: 'catalog.publish.where' as const,
      code: review.code,
      ...(review.submitUrl ? { submitUrl: review.submitUrl } : {}),
      registration: review.registration,
      plan,
      skipped,
    };
    return { m, view, review: kept };
  }

  let port = 0;

  const hostOk = (h: string | undefined) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const originOk = (o: string) => o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;

  // pure: never installs; null means setup is still needed
  function requested(body: Record<string, unknown>): { cmd: string | null; refresh: number | undefined } {
    const asked = typeof body.command === 'string' && body.command.trim() ? body.command.trim() : command;
    const refresh = Number(body.refreshInterval);
    return {
      cmd: !asked || asked.startsWith(PLACEHOLDER_PREFIX) ? null : asked,
      refresh: Number.isFinite(refresh) && refresh > 0 ? refresh : undefined,
    };
  }

  async function resolveCommand(cmd: string | null): Promise<string> {
    if (cmd) return cmd;
    command = (await setup(VERSION)).command;
    if (!command) throw httpError(500, 'err.server.setupFailed');
    return command;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostOk(req.headers.host)) throw new HttpError(403, 'Forbidden host');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname === '/' && method === 'GET') {
      const html = editorHtml();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(html);
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
    if (req.headers['x-ccinfobar-token'] !== token) throw httpError(401, 'err.server.badToken');
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin !== undefined && !originOk(origin)) throw new HttpError(403, 'Forbidden origin');
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/presets/')) {
      let id = '';
      try {
        id = decodeURIComponent(url.pathname.slice('/api/presets/'.length));
      } catch {}
      if (!ID_RE.test(id)) throw httpError(400, 'err.server.badPresetId');
      if (listPresets().find((p) => p.id === id)?.source !== 'user')
        throw httpError(404, 'err.server.notUserPreset');
      deleteUserPreset(id);
      send(res, 200, { ok: true, presets: presetList() });
      return;
    }

    if (method === 'DELETE' && url.pathname.startsWith('/api/themes/')) {
      let id = '';
      try {
        id = decodeURIComponent(url.pathname.slice('/api/themes/'.length));
      } catch {}
      if (!ID_RE.test(id)) throw httpError(400, 'err.server.badThemeId');
      const theme = listThemes().find((t) => t.id === id);
      if (theme?.source !== 'user') throw httpError(404, 'err.server.notUserTheme');
      deleteUserTheme(id);
      send(res, 200, { ok: true, themes: listThemes() });
      return;
    }

    if ((method === 'GET' || method === 'DELETE') && url.pathname.startsWith('/api/catalog/entries/')) {
      let ref = '';
      try {
        ref = decodeURIComponent(url.pathname.slice('/api/catalog/entries/'.length));
      } catch {}
      const type = refType(ref);
      if (!type) throw httpError(400, 'err.catalog.badId');
      const lang = diskLang(url.searchParams.get('lang'));
      if (method === 'GET') {
        const hit = mustFind(ref);
        send(
          res,
          200,
          withLanguage(lang, () => ({ entry: summaryOf(hit), versions: versionsOf(hit) })),
        );
        return;
      }
      if (type === 'system') {
        mustFind(ref);
        throw httpError(403, 'err.catalog.systemReadOnly');
      }
      let kept: string | null = null;
      if (type === 'user')
        kept = deleteEntry(ref, undefined, undefined, { themesInUse: liveThemes(ref) }).kept;
      else if (!deleteLegacy(ref)) throw httpError(404, 'err.catalog.unknownRef', { ref: clean(ref) });
      send(res, 200, { ok: true, kept, catalog: catalogBody(lang) });
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/api/catalog/remote/')) {
      needEndpoint();
      const raw = url.pathname.slice('/api/catalog/remote/'.length).split('/');
      let parts: string[] = [];
      try {
        parts = raw.map((p) => decodeURIComponent(p));
      } catch {}
      if (parts.length !== 2 || !parts.every((p) => ID_PART_RE.test(p)))
        throw httpError(400, 'catalog.remote.badId', { ref: clean(parts.join('/') || raw.join('/')) });
      const m = await loadMarket();
      const out = await m.remoteShow(parts.join('/'));
      if (!out.entry) throw marketError(out.code, m.reasonId(out.code), out.status);
      const v = out.latest;
      send(res, 200, {
        entry: out.entry,
        latest: v && {
          version: v.version,
          content: v.content,
          targets: v.targets.map((x) => ({ kind: x.kind, target: x.target })),
        },
        ...(out.code
          ? {
              code: out.code,
              errorId: m.reasonId(out.code),
              ...(out.status ? { errorParams: { status: out.status } } : {}),
            }
          : {}),
      });
      return;
    }

    const route = `${method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/ping': {
        send(res, 200, { ok: true });
        return;
      }
      case 'GET /api/state': {
        const loaded = loadForUse(opts.configPath, () => gsd);
        const config = upgradeOptions(loaded.config);
        send(res, 200, {
          version: VERSION,
          configPath: tildify(opts.configPath),
          configError: loaded.error ?? null,
          configIssue: loaded.issue ?? null,
          config,
          savedConfig: config,
          widgets: widgetCatalog(),
          categories: CATEGORIES,
          presets: presetList(),
          presetsDir: tildify(presetsDir()),
          styleHistory: readStyles(),
          gsdInstalled: gsd,
          themes: listThemes(),
          styles: STYLES,
          themesDir: tildify(themesDir()),
          claude: claudeInfo(command),
          hooks: await hooksInfo(command),
          hasLastPayload: fs.existsSync(lastPayloadPath()),
          scenarios: scenarioList(),
          terminal: opts.terminal ?? null,
          language: auto,
        });
        return;
      }
      case 'POST /api/preview': {
        const body = asObject(await readBody(req));
        const config = normalizeConfig(body.config);
        if (config.colorLevel === 'auto') config.colorLevel = 3;
        const source = previewSourceOf(body);
        const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 130));
        const draft = body.theme === undefined ? undefined : parseThemeInput(body.theme);
        if (draft?.extends !== undefined && !ID_RE.test(draft.extends)) {
          throw httpError(400, 'err.server.badExtendsId');
        }
        const theme = draft ? resolveThemeInput(draft) : undefined;
        send(
          res,
          200,
          withLanguage(auto.id, () => renderPreviewReport(config, source, width, theme)),
        );
        return;
      }
      case 'POST /api/normalize': {
        const body = asObject(await readBody(req));
        send(res, 200, { config: normalizeConfig(body.config) });
        return;
      }
      case 'POST /api/theme-previews': {
        const body = asObject(await readBody(req));
        const config = normalizeConfig(body.config);
        if (config.colorLevel === 'auto') config.colorLevel = 3;
        const source = previewSourceOf(body);
        const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 100));
        const own = config.lines.find((l) => l.length > 0);
        const plain = own
          ? applyStyle(
              { ...config, lines: [own] },
              own.map((i) => i.id),
              {},
              ['colors', 'text'],
            ).lines[0]
          : null;
        const demo: WidgetItem[] = plain ?? DEMO_TYPES.map((type, i) => ({ id: `${type}-${i + 1}`, type }));
        const previews: Record<string, string[]> = {};
        for (const t of listThemes()) {
          const cfg: Config = {
            ...config,
            theme: t.id,
            lines: [demo],
            style: undefined,
            separator: undefined,
            separatorColor: undefined,
            padding: undefined,
            glyphs: undefined,
            tui: undefined,
          };
          previews[t.id] = withLanguage(auto.id, () => renderPreview(cfg, source, width));
        }
        send(res, 200, { previews });
        return;
      }
      case 'POST /api/themes': {
        const body = asObject(await readBody(req));
        let input = parseThemeInput(body.theme);
        if (body.fromConfig !== undefined && input.id && ID_RE.test(input.id)) {
          input = themeFromConfig(normalizeConfig(body.fromConfig), input.id, {
            name: input.name ?? input.id,
            description: input.description ?? '',
          });
        }
        if (!input.id || !ID_RE.test(input.id)) {
          throw httpError(400, 'err.theme.badId');
        }
        if (input.extends !== undefined && !ID_RE.test(input.extends)) {
          throw httpError(400, 'err.server.badExtendsId');
        }
        saveUserTheme(input);
        send(res, 200, { ok: true, id: input.id, themes: listThemes() });
        return;
      }
      case 'POST /api/presets': {
        const body = asObject(await readBody(req));
        const meta = asObject(body.preset);
        const id = typeof meta.id === 'string' ? meta.id : '';
        if (!ID_RE.test(id)) throw httpError(400, 'err.server.presetIdRule');
        saveUserPreset({
          id,
          name: typeof meta.name === 'string' ? meta.name.slice(0, 64) : id,
          description: typeof meta.description === 'string' ? meta.description.slice(0, 200) : '',
          config: body.config,
        });
        send(res, 200, { ok: true, presets: presetList() });
        return;
      }
      case 'GET /api/catalog': {
        send(res, 200, catalogBody(diskLang(url.searchParams.get('lang'))));
        return;
      }
      case 'POST /api/catalog/previews': {
        const body = asObject(await readBody(req));
        const config = normalizeConfig(body.config);
        if (config.colorLevel === 'auto') config.colorLevel = 3;
        const source = previewSourceOf(body);
        const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 100));
        const byRef = new Map(allEntries().map((a) => [refOf(a), a]));
        const refs = Array.isArray(body.refs)
          ? body.refs.slice(0, MAX_PREVIEWS).filter((r): r is string => typeof r === 'string')
          : [...byRef.keys()].slice(0, MAX_PREVIEWS);
        const previews: Record<string, string[]> = {};
        withLanguage(uiLang(body.lang, config), () => {
          for (const ref of refs) {
            const hit = byRef.get(ref);
            if (hit && !Object.hasOwn(previews, ref)) previews[ref] = previewOf(config, hit, source, width);
          }
        });
        send(res, 200, { previews });
        return;
      }
      case 'POST /api/catalog/save': {
        const body = asObject(await readBody(req));
        const { kind } = body;
        const mode = body.mode ?? 'new';
        if (!isKind(kind) || typeof body.config !== 'object' || body.config === null)
          throw httpError(400, 'err.catalog.badContent');
        if (mode !== 'new' && mode !== 'update' && mode !== 'overwrite')
          throw httpError(400, 'err.catalog.badRequest');
        const config = normalizeConfig(body.config);
        const author = typeof body.author === 'string' ? body.author : undefined;
        let e: CatalogEntry;
        try {
          e = saveEntry({
            kind,
            name: str(body.name),
            description: str(body.description),
            ...(author === undefined ? {} : { author }),
            content: contentFromConfig(config, kind),
            note: str(body.note),
            share: body.share !== false,
            mode,
            ...(mode !== 'new' && typeof body.share === 'boolean' ? { shareChange: body.share } : {}),
            ...(body.id === undefined ? {} : { id: body.id as string }),
            ...(Number.isInteger(body.rev) ? { rev: body.rev as number } : {}),
          });
        } catch (err) {
          throw err instanceof CatalogStoreError ? storeError(err, kind) : err;
        }
        if (author !== undefined && author.trim() !== readProfile().author) writeProfile({ author });
        send(res, 200, userResult(e, uiLang(body.lang, config)));
        return;
      }
      case 'POST /api/catalog/restore': {
        const body = asObject(await readBody(req));
        const target = writableRef(body.id ?? body.ref);
        const version = body.version;
        if (!Number.isInteger(version) || (version as number) < 1)
          throw httpError(400, 'err.catalog.badRequest');
        const lang = diskLang(body.lang);
        let id = target.ref;
        let rev: number;
        if (target.type === 'legacy') {
          if (version !== 1)
            throw httpError(404, 'err.catalog.noVersion', { ref: clean(id), version: version as number });
          const adopted = adoptLegacy(id, new Date());
          id = adopted.id;
          rev = adopted.rev;
        } else {
          if (!Number.isInteger(body.rev)) throw httpError(400, 'err.catalog.badRequest');
          rev = body.rev as number;
        }
        send(res, 200, userResult(restoreEntry(id, version as number, rev, ''), lang));
        return;
      }
      case 'POST /api/catalog/share': {
        const body = asObject(await readBody(req));
        const target = writableRef(body.ref ?? body.id);
        if (typeof body.share !== 'boolean') throw httpError(400, 'err.catalog.badRequest');
        let e: CatalogEntry;
        if (target.type === 'legacy') {
          const adopted = adoptLegacy(target.ref, new Date());
          e = updateShare(adopted.id, body.share, adopted.rev);
        } else e = updateShare(target.ref, body.share, currentRev(target.ref, body.rev));
        send(res, 200, userResult(e, diskLang(body.lang)));
        return;
      }
      case 'POST /api/catalog/publish/plan': {
        const body = asObject(await readBody(req));
        const endpoint = needEndpoint();
        send(res, 200, (await publishView(endpoint, body.refs)).view);
        return;
      }
      // sets the handle a first publish registers, then reviews again
      case 'POST /api/catalog/publisher': {
        const body = asObject(await readBody(req));
        const endpoint = needEndpoint();
        const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
        if (!isHandle(handle)) throw httpError(400, 'err.catalog.badHandle');
        const cur = readPublisher(endpoint);
        if (readCredential(endpoint) !== null && cur !== null && cur !== handle)
          throw httpError(409, 'catalog.publisher.registered', { handle: cur, endpoint: clean(endpoint) });
        writePublisher(endpoint, handle);
        send(res, 200, (await publishView(endpoint, body.refs)).view);
        return;
      }
      case 'POST /api/catalog/publish': {
        const body = asObject(await readBody(req));
        const endpoint = needEndpoint();
        if (body.confirm !== true) throw httpError(400, 'err.catalog.needsConfirm');
        const { m, view, review } = await publishView(endpoint, body.refs);
        // send only what was reviewed; runPublish also checks each entry rev
        if (body.planHash !== view.planHash) throw httpError(409, 'err.catalog.planChanged', undefined, view);
        const out = await m.runPublish(review);
        if (out.code !== null && out.code !== 'read-only')
          throw marketError(out.code, m.reasonId(out.code), out.status);
        send(res, 200, {
          ok: true,
          code: out.code,
          ...(out.submitUrl ? { submitUrl: out.submitUrl } : {}),
          results: out.results.map((r) => ({
            ...r,
            errorId: r.code === null ? null : m.reasonId(r.code),
            ...(r.status ? { errorParams: { status: r.status } } : {}),
          })),
          catalog: catalogBody(diskLang(body.lang)),
        });
        return;
      }
      case 'GET /api/catalog/remote': {
        const endpoint = needEndpoint();
        const m = await loadMarket();
        const out = await m.remoteList();
        if (out.code) throw marketError(out.code, m.reasonId(out.code), out.status);
        send(res, 200, { endpoint: clean(endpoint), entries: out.entries });
        return;
      }
      case 'POST /api/catalog/install-theme': {
        const body = asObject(await readBody(req));
        const ref = body.ref;
        if (!refType(ref)) throw httpError(400, 'err.catalog.badRef');
        const hit = mustFind(ref as string);
        let content = contentOf(hit);
        if (body.version !== undefined) {
          const v = hit.source === 'user' ? hit.entry.versions.find((x) => x.version === body.version) : null;
          if (v) content = v.content;
          else if (hit.source === 'user' || body.version !== 1)
            throw httpError(404, 'err.catalog.noVersion', {
              ref: clean(ref),
              version: typeof body.version === 'number' ? body.version : '',
            });
        }
        const theme = entryKind(hit) === 'preset' ? null : installEntryTheme(content);
        send(res, 200, { ok: true, theme, themes: listThemes() });
        return;
      }
      case 'PUT /api/styles': {
        const body = asObject(await readBody(req));
        const history = asObject(body.history);
        const clean: StyleHistory = {};
        for (const [id, list] of Object.entries(history).slice(0, 500)) {
          if (Array.isArray(list))
            clean[id.slice(0, 80)] = list.filter((s) => s && typeof s === 'object').slice(0, 3);
        }
        writeAtomic(stylesFile, `${JSON.stringify(clean, null, 2)}\n`, { class: 'settings' });
        send(res, 200, { ok: true });
        return;
      }
      case 'PUT /api/config': {
        const body = asObject(await readBody(req));
        const config = upgradeOptions(normalizeConfig(body.config));
        try {
          saveConfig(config, opts.configPath);
        } catch (err) {
          if (!(err instanceof ConfigBrokenError)) throw err;
          const { line, column, message } = err.issue;
          throw httpError(409, 'config.refuseBroken', { file: err.file }, { line, column, message });
        }
        send(res, 200, { ok: true, config });
        return;
      }
      case 'POST /api/install/plan': {
        const body = asObject(await readBody(req));
        const { cmd, refresh } = requested(body);
        send(res, 200, { plan: planInstall({ command: cmd ?? placeholder(), refresh }) });
        return;
      }
      case 'POST /api/install': {
        const body = asObject(await readBody(req));
        const { cmd, refresh } = requested(body);
        const confirmed = body.confirm === true;
        if (confirmed && !('current' in body)) throw httpError(400, 'install.confirmNeedsCurrent');
        const draft = planInstall({ command: cmd ?? placeholder(), refresh });
        if (confirmed && !deepEqual(body.current ?? null, draft.current))
          throw httpError(409, 'install.stale', { file: tildify(draft.file) }, { plan: draft });
        if (draft.needsConfirm && !confirmed)
          throw httpError(409, 'install.needsConfirm', undefined, { plan: draft });
        const plan = cmd ? draft : planInstall({ command: await resolveCommand(cmd), refresh });
        if (plan !== draft && confirmed && !deepEqual(body.current ?? null, plan.current))
          throw httpError(409, 'install.stale', { file: tildify(plan.file) }, { plan });
        let backup: string | null;
        try {
          backup = applyInstall(plan, { confirmed, adoptLegacy: confirmed }).backup;
        } catch (err) {
          if (err instanceof InstallNeedsConfirmError)
            throw httpError(409, 'install.needsConfirm', undefined, { plan: err.plan });
          throw err;
        }
        if (!fs.existsSync(opts.configPath))
          saveConfig(loadForUse(opts.configPath, () => gsd, { persist: true }).config, opts.configPath);
        send(res, 200, { ok: true, backup, backupsDir: backupsDir(), claude: claudeInfo(command) });
        return;
      }
      case 'POST /api/hooks': {
        const body = asObject(await readBody(req));
        const { enabled, permission } = body;
        if (typeof enabled !== 'boolean' || (permission !== undefined && typeof permission !== 'boolean'))
          throw httpError(400, 'hooks.badBody');
        const file = claudeSettingsPath();
        let backup: string | null = null;
        if (enabled) {
          const active = activeCommand(command);
          if (!active) throw textError(409, NOT_ACTIVE, { hooks: await hooksInfo(command) });
          const claudeCode = await claudeVersion();
          const plan = planHooks({
            settings: readSettings(file).data as Record<string, unknown>,
            manifest: readManifest(),
            file,
            command: active,
            claudeCode,
            events: permission ? [...DEFAULT_EVENTS, ...OPTIONAL_EVENTS] : DEFAULT_EVENTS,
          });
          if (plan.refused)
            throw textError(409, refusalText(plan.refused, claudeCode), { hooks: await hooksInfo(command) });
          backup = applyHooks(file, plan, process.env, permission === false ? OPTIONAL_EVENTS : []).backup;
        } else {
          backup = uninstallHooks(file).backup;
        }
        send(res, 200, { ok: true, hooks: await hooksInfo(command), backup });
        return;
      }
      case 'POST /api/progress': {
        const { enabled, channel } = asObject(await readBody(req));
        if (typeof enabled !== 'boolean') throw httpError(400, 'hooks.badBody');
        if (channel !== undefined && !(PROGRESS_CHOICES.channel as readonly unknown[]).includes(channel))
          throw httpError(400, 'hooks.badBody');
        // config and handlers change together (WR-03)
        const loaded = loadConfig(opts.configPath);
        if (loaded.error) throw httpError(409, 'config.refuseBroken', { file: tildify(opts.configPath) });
        const file = claudeSettingsPath();
        let backup: string | null = null;
        let held = false;
        const next = setProgress(loaded.config, {
          enabled,
          ...(channel === undefined ? {} : { channel: channel as ProgressConfig['channel'] }),
        });
        // the tty channel needs no handlers (WR-02)
        if (enabled && progressChannel(next.progress, process.platform) === 'tty') {
          saveConfig(next, opts.configPath);
          if (installedHooks(true).length)
            backup = uninstallHooks(file, process.env, undefined, 'progress').backup;
        } else if (enabled) {
          const active = activeCommand(command);
          if (!active) throw textError(409, NOT_ACTIVE, { hooks: await hooksInfo(command) });
          const claudeCode = await claudeVersion();
          const plan = planHooks({
            settings: readSettings(file).data as Record<string, unknown>,
            manifest: readManifest(),
            file,
            command: active,
            claudeCode,
            events: [],
            progress: true,
          });
          if (plan.progressRefused)
            throw textError(409, progressRefusalText(plan.progressRefused, claudeCode), {
              hooks: await hooksInfo(command),
            });
          backup = applyHooks(file, plan).backup;
          saveConfig(next, opts.configPath);
        } else {
          saveConfig(next, opts.configPath);
          // a showing bar needs one more hook event (D-36)
          held = requestClear(process.env) > 0 && installedHooks(true).length > 0;
          if (!held) backup = uninstallHooks(file, process.env, undefined, 'progress').backup;
        }
        const progress = normalizeConfig(next).progress ?? null;
        send(res, 200, { ok: true, hooks: await hooksInfo(command), backup, progress, held });
        return;
      }
      case 'GET /api/system': {
        send(res, 200, {
          version: VERSION,
          kind: kindOf(),
          update: readUpdateState(),
          claude: claudeInfo(command),
          hooks: await hooksInfo(command),
        });
        return;
      }
      case 'POST /api/update': {
        const body = asObject(await readBody(req));
        let latest: string;
        try {
          latest = await latestOf(8000);
        } catch (err) {
          throw httpError(502, 'err.server.github', { error: (err as Error).message });
        }
        const newer = compareVersions(latest, VERSION) > 0;
        const kind = kindOf();
        if (body.install === true && newer) {
          if (kind === 'brew') throw httpError(409, 'update.brewRefused', { command: BREW_UPGRADE });
          if (kind !== 'npm-global' && kind !== 'local') {
            throw httpError(409, 'err.server.cannotUpdate', { kind });
          }
          try {
            await installVersionAsync(latest, kind === 'local' ? localPrefix() : undefined);
          } catch (err) {
            throw httpError(500, 'err.server.npmFailed', { error: (err as Error).message });
          }
          writeUpdateState({ checkedAt: Date.now(), latest, installed: latest });
          send(res, 200, { current: VERSION, latest, newer, installed: latest, kind });
          return;
        }
        writeUpdateState({ checkedAt: Date.now(), latest });
        send(res, 200, { current: VERSION, latest, newer, kind });
        return;
      }
      case 'POST /api/shutdown': {
        send(res, 200, { ok: true });
        setTimeout(() => void close(), 50);
        return;
      }
      default:
        throw new HttpError(404, 'Not found');
    }
  }

  const now = opts.detached?.now ?? Date.now;
  let lastRequest = now();
  const server = http.createServer((req, res) => {
    lastRequest = now();
    handle(req, res).catch((caught: unknown) => {
      if (res.headersSent) return res.end();
      const err = caught instanceof CatalogStoreError ? storeError(caught) : caught;
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 413) res.setHeader('connection', 'close');
      const e = err instanceof HttpError ? err : undefined;
      send(res, status, {
        ...e?.extra,
        error: (err as Error).message,
        ...(e?.id ? { errorId: e.id } : {}),
        ...(e?.params ? { errorParams: e.params } : {}),
      });
    });
  });

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    detectAbort.abort();
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  void claudeVersion();

  function startDetached(d: NonNullable<EditorOptions['detached']>, url: string): void {
    const pid = process.pid;
    writeAtomic(
      d.stateFile,
      JSON.stringify({ url, pid, startedAt: now(), config: path.resolve(opts.configPath) }),
      { mode: 0o600 },
    );
    const timer = setInterval(() => {
      if (now() - lastRequest > d.idleMs) void close();
    }, d.checkMs ?? 60_000);
    timer.unref();
    const onSigterm = () => void close();
    process.once('SIGTERM', onSigterm);
    server.on('close', () => {
      clearInterval(timer);
      process.off('SIGTERM', onSigterm);
      try {
        const held = JSON.parse(fs.readFileSync(d.stateFile, 'utf8')) as { pid?: unknown };
        if (held.pid === pid) fs.unlinkSync(d.stateFile);
      } catch {}
    });
  }

  const url = `http://127.0.0.1:${port}/?t=${token}`;
  if (opts.detached) startDetached(opts.detached, url);
  const say = (line: () => string) => console.log(withLanguage(cli, line));
  const onSigint = () => {
    say(() => t('edit.stopping'));
    void close();
  };
  process.once('SIGINT', onSigint);
  server.on('close', () => process.off('SIGINT', onSigint));

  say(() => t('edit.running', { url }));
  say(() => t('edit.stopHint'));
  if (opts.open) openBrowser(url);

  return { url, token, close };
}
