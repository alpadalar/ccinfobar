import '../core/i18n/lazy.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { CatalogEntry, EntryContent, EntryKind } from '../catalog/model.js';
import { shareState } from '../catalog/share.js';
import { contentFromConfig } from '../catalog/snapshot.js';
import {
  adoptLegacy,
  CatalogStoreError,
  DEFAULT_MARKETPLACE,
  deleteEntry,
  deleteLegacy,
  installEntryTheme,
  isHandle,
  listEntries,
  listLegacy,
  marketEndpointInfo,
  normalizeEntry,
  readCredential,
  readEntry,
  readProfile,
  readPublisher,
  restoreEntry,
  saveEntry,
  themeChain,
  updateShare,
  writeProfile,
  writePublisher,
} from '../catalog/store.js';
import { findSystem, systemEntries } from '../catalog/system.js';
import { configLanguage, envLanguage } from '../cli/lang.js';
import {
  applyHooks,
  DEFAULT_EVENTS,
  detectClaudeCodeAsync,
  type HookRefusal,
  OPTIONAL_EVENTS,
  planHooks,
  uninstallHooks,
} from '../commands/hooks-install.js';
import {
  applyInstall,
  defaultCommand,
  InstallNeedsConfirmError,
  planInstall,
  setupCommandAsync,
} from '../commands/install.js';
import { deepEqual, readManifest } from '../commands/manifest.js';
import { openBrowser } from '../commands/open.js';
import { backupsDir, readSettings } from '../commands/settings-file.js';
import {
  compareVersions,
  fetchLatest,
  installKind,
  installVersionAsync,
  localPrefix,
  readUpdateState,
  writeUpdateState,
} from '../commands/update.js';
import { BREW_UPGRADE } from '../core/brew.js';
import { loadConfig, normalizeConfig, saveConfig } from '../core/config.js';
import { applyCatalogContent, PROGRESS_CHOICES, type StyleHistory, setProgress } from '../core/edit.js';
import { parseCols } from '../core/entry-keys.js';
import { presetLabels } from '../core/i18n/catalog-text.js';
import { type MessageId, setLanguage, t, withLanguage } from '../core/i18n/index.js';
import { isLanguageId, type LanguageId } from '../core/i18n/languages.js';
import { availablePresets, loadForUse } from '../core/load.js';
import { claudeSettingsPath, tildify } from '../core/paths.js';
import { type PreviewSource, renderPreview } from '../core/preview.js';
import { withoutRotation } from '../core/rotation.js';
import { listThemes } from '../core/themes.js';
import type { Config, ProgressConfig } from '../core/types.js';
import { gsdInstalled } from '../data/gsd.js';
import { progressChannel } from '../data/progress.js';
import { requestClear } from '../data/progress-clear.js';
import { type InstallOutcome, installChecked, verifyInstall } from '../data/self-update.js';
import { writeAtomic } from '../data/store.js';
import type { ImportTarget } from '../importers/confirm.js';
import { ID_PART_RE, isRemoteId, REPORT_REASON_MAX } from '../market/protocol.js';
import { createRouter, type Handler } from './router.js';
import type {
  EditorCtx,
  EditorOptions,
  EditorState,
  Found,
  HooksInfo,
  InstallPlan,
  LoginFlows,
  Market,
  PlanItem,
  Skip,
} from './routes/ctx.js';
import { exact as shareExact } from './routes/share.js';
import { exact as stateExact } from './routes/state.js';
import { exact as styleExact } from './routes/styles.js';
import { exact as themeExact, prefix as themePrefix } from './routes/themes.js';
import {
  activeCommand,
  asObject,
  claudeInfo,
  clean,
  colsOf,
  contentOf,
  draftTheme,
  entryKind,
  HttpError,
  httpError,
  installedHooks,
  KINDS,
  MAX_PUBLISH_REFS,
  marketError,
  NOT_ACTIVE,
  PLACEHOLDER_PREFIX,
  placeholder,
  previewSourceOf,
  progressRefusalText,
  readBody,
  reasonOf,
  refOf,
  refType,
  refusalText,
  send,
  storeError,
  summaryOf,
  textError,
  VERSION,
  versionsOf,
} from './routes/util.js';

declare const __EDITOR_HTML__: string;
declare const __EDITOR_SCRIPT_HASH__: string;

export interface EditorHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

const SCRIPT_SRC =
  typeof __EDITOR_SCRIPT_HASH__ === 'string' && __EDITOR_SCRIPT_HASH__
    ? `'sha256-${__EDITOR_SCRIPT_HASH__}'`
    : "'none'";
// style-src: innerHTML style attributes
const CSP = `default-src 'none'; script-src ${SCRIPT_SRC}; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>ccinfobar editor</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:3rem">
<h1>Editor bundle not built</h1><p>Run <code>npm run build</code> and start the editor again.</p></body>`;

function editorHtml(): string {
  return (typeof __EDITOR_HTML__ === 'string' && __EDITOR_HTML__) || FALLBACK_HTML;
}

export { openBrowser };

const MAX_PREVIEWS = 100;

const MAX_TARGETS = 1000;
const TARGET_KINDS: readonly ImportTarget['kind'][] = ['command', 'http', 'link'];
const FLOW_PATH = '/api/catalog/login/';

// install codes; a pinned version that is missing has no HTTP status
function installError(m: Market, err: unknown, id: string, version: number | null): HttpError {
  const e = err instanceof m.InstallError ? err : new m.InstallError('unknown');
  const vars = { id: clean(id), version: version ?? '' };
  const code = { code: e.code };
  if (e.code === 'no-endpoint') return httpError(409, 'err.catalog.noEndpoint');
  if (e.code === 'bad-ref') return httpError(400, 'catalog.remote.badId', { ref: clean(id) });
  if (e.code === 'not-found' && e.status === null && version !== null)
    return httpError(404, 'err.catalog.install.noVersion', vars, code);
  if (e.code === 'withdrawn') return httpError(410, 'err.catalog.install.withdrawn', vars, code);
  if (e.code === 'not-found') return httpError(404, 'err.catalog.install.not-found', vars, code);
  if (e.code === 'bad-content' || e.code === 'hash-mismatch')
    return httpError(502, `err.catalog.install.${e.code}`, vars, code);
  return marketError(e.code, m.reasonId(e.code), e.status ?? undefined);
}

function installView(p: InstallPlan) {
  return {
    id: p.id,
    version: p.version,
    hash: p.hash,
    kind: p.kind,
    name: clean(p.name),
    description: clean(p.description),
    author: clean(p.author),
    publisher: clean(p.publisher),
    targets: p.targets.map((x) => ({ kind: x.kind, target: x.target })),
    existing: p.existing,
    cols: p.cols ?? null,
  };
}

// what the browser reviewed; anything else is not a review
function reviewedTargets(v: unknown): { kind: ImportTarget['kind']; target: string }[] | null {
  if (!Array.isArray(v) || v.length > MAX_TARGETS) return null;
  const out: { kind: ImportTarget['kind']; target: string }[] = [];
  for (const x of v) {
    const o = asObject(x);
    if (!TARGET_KINDS.includes(o.kind as ImportTarget['kind']) || typeof o.target !== 'string') return null;
    out.push({ kind: o.kind as ImportTarget['kind'], target: o.target });
  }
  return out;
}

// publisher/slug with an optional pinned version
function installRef(body: Record<string, unknown>): { id: string; version: number | null; ref: string } {
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!isRemoteId(id)) throw httpError(400, 'catalog.remote.badId', { ref: clean(id) });
  const v = body.version;
  if (v !== undefined && v !== null && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) < 1e9))
    throw httpError(400, 'err.catalog.badRequest');
  const version = typeof v === 'number' ? v : null;
  return { id, version, ref: version === null ? id : `${id}@${version}` };
}

const SIGN_IN_ERRORS: Record<string, [number, MessageId]> = {
  'no-endpoint': [409, 'err.catalog.noEndpoint'],
  'bad-endpoint': [400, 'err.catalog.badEndpoint'],
  'not-github': [409, 'err.catalog.signIn.notGithub'],
  disabled: [409, 'err.catalog.signIn.disabled'],
  failed: [502, 'err.catalog.signIn.failed'],
};

function signInError(m: Market, err: unknown): HttpError {
  const e = err instanceof m.SignInError ? err : new m.SignInError('failed');
  const known = Object.hasOwn(SIGN_IN_ERRORS, e.code) ? SIGN_IN_ERRORS[e.code]! : null;
  if (known)
    return httpError(known[0], known[1], undefined, {
      code: e.code,
      ...(e.tokenMode ? { tokenMode: true } : {}),
    });
  return marketError(e.code, m.reasonId(e.code), e.status ?? undefined);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isKind = (v: unknown): v is EntryKind => KINDS.includes(v as EntryKind);

// match order: prefixes first, then exact; handlers are keyed 'METHOD /path'
const ROUTE_DEFS = {
  prefix: [
    { methods: ['GET', 'DELETE'], path: '/api/catalog/entries/' },
    { methods: ['GET'], path: '/api/catalog/remote/' },
    { methods: ['GET', 'DELETE'], path: FLOW_PATH },
  ],
  exact: [
    { method: 'GET', path: '/api/catalog' },
    { method: 'POST', path: '/api/catalog/previews' },
    { method: 'POST', path: '/api/catalog/save' },
    { method: 'POST', path: '/api/catalog/restore' },
    { method: 'POST', path: '/api/catalog/share' },
    { method: 'POST', path: '/api/catalog/publish/plan' },
    { method: 'POST', path: '/api/catalog/publisher' },
    { method: 'POST', path: '/api/catalog/publish' },
    { method: 'POST', path: '/api/catalog/remote/previews' },
    { method: 'GET', path: '/api/catalog/remote' },
    { method: 'POST', path: '/api/catalog/login' },
    { method: 'POST', path: '/api/catalog/logout' },
    { method: 'POST', path: '/api/catalog/install/plan' },
    { method: 'POST', path: '/api/catalog/install' },
    { method: 'POST', path: '/api/catalog/report' },
    { method: 'POST', path: '/api/catalog/install-theme' },
    { method: 'POST', path: '/api/install/plan' },
    { method: 'POST', path: '/api/install' },
    { method: 'POST', path: '/api/hooks' },
    { method: 'POST', path: '/api/progress' },
    { method: 'GET', path: '/api/system' },
    { method: 'POST', path: '/api/update' },
  ],
} as const;
const ROUTE_COUNT = ROUTE_DEFS.prefix.length + ROUTE_DEFS.exact.length;
const moved = {
  prefix: [...themePrefix],
  exact: [...stateExact, ...themeExact, ...styleExact, ...shareExact],
};

function pickHandler(table: Record<string, Handler<EditorCtx>>, key: string): Handler<EditorCtx> {
  const h = table[key];
  if (!h) throw new Error(`route-handler-missing:${key}`);
  return h;
}

export function routeTable() {
  const noop: Handler<EditorCtx> = () => {};
  return createRouter<EditorCtx>({
    prefix: [...moved.prefix, ...ROUTE_DEFS.prefix.map((d) => ({ ...d, handler: noop }))],
    exact: [...moved.exact, ...ROUTE_DEFS.exact.map((d) => ({ ...d, handler: noop }))],
  }).table();
}

export async function startEditor(opts: EditorOptions): Promise<EditorHandle> {
  // API text stays English; the browser picks its language from `language`
  const auto = envLanguage();
  // console lines keep the cli language
  const cli = setLanguage('en');
  const host = opts.host ?? '127.0.0.1';
  const token = crypto.randomBytes(16).toString('hex');
  const tokenBuf = Buffer.from(token, 'utf8');
  const state: EditorState = { command: defaultCommand(), flows: null };
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
      const info = endpointInfo();
      const endpoint = info.url;
      const handle = endpoint === null ? null : readPublisher(endpoint);
      return {
        system: all.filter((a) => a.source === 'system').map(summaryOf),
        user: all.filter((a) => a.source !== 'system').map(summaryOf),
        profile: { author: readProfile().author },
        endpoint: endpoint === null ? null : clean(endpoint),
        publishable: endpoint !== null,
        // local files only (R-11)
        market: {
          endpoint: endpoint === null ? null : clean(endpoint),
          source: info.source,
          signedIn: endpoint !== null && readCredential(endpoint) !== null,
          handle: handle === null ? null : clean(handle),
        },
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

  function previewContent(
    current: Config,
    kind: EntryKind,
    content: EntryContent,
    system: boolean,
    source: PreviewSource,
    width: number,
  ): string[] {
    try {
      const theme = kind !== 'preset' && content.theme ? draftTheme(content.theme) : undefined;
      const next = applyCatalogContent(current, content, kind);
      // built-in layouts carry English labels
      const shown = system && kind !== 'theme' ? presetLabels(next) : next;
      return renderPreview(withoutRotation(shown), source, width, theme);
    } catch {
      return [];
    }
  }

  function previewOf(current: Config, a: Found, source: PreviewSource, width: number): string[] {
    return previewContent(current, entryKind(a), contentOf(a), a.source === 'system', source, width);
  }

  // marketplace code loads only after the endpoint check
  const loadMarket = (): Promise<Market> => import('../commands/catalog-market.js');
  const fallback =
    opts.market?.defaultEndpoint !== undefined ? opts.market.defaultEndpoint : DEFAULT_MARKETPLACE;
  function endpointInfo() {
    return marketEndpointInfo(process.env, undefined, fallback);
  }
  // read at call time, so the global fetch can change
  const marketFetch = (): typeof fetch => opts.market?.fetch ?? globalThis.fetch;
  const marketNow = (): number => (opts.market?.now ?? Date.now)();
  const marketDeps = () => ({
    fetch: marketFetch(),
    now: () => new Date(marketNow()),
    defaultEndpoint: fallback,
  });
  // created on the first sign-in; holds device codes in memory only
  const loginFlows = (m: Market): LoginFlows => {
    state.flows ??= m.createLoginFlows({
      fetch: (input, init) => marketFetch()(input, init),
      now: marketNow,
      defaultEndpoint: fallback,
    });
    return state.flows;
  };

  function needEndpoint(): string {
    const endpoint = endpointInfo().url;
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
    const review = await m.reviewPublish(ids, marketDeps());
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
      renamed: review.renamed.filter((r) => plan.some((i) => i.id === r.id)),
      skipped,
    };
    return { m, view, review: kept };
  }

  let port = 0;

  const hostOk = (h: string | undefined) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const originOk = (o: string) => o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;

  // pure: never installs; null means setup is still needed
  function requested(body: Record<string, unknown>): {
    cmd: string | null;
    refresh: number | undefined;
    subagents: boolean | undefined;
  } {
    if (body.subagents !== undefined && typeof body.subagents !== 'boolean')
      throw httpError(400, 'install.badSubagents');
    const asked =
      typeof body.command === 'string' && body.command.trim() ? body.command.trim() : state.command;
    const refresh = Number(body.refreshInterval);
    return {
      cmd: !asked || asked.startsWith(PLACEHOLDER_PREFIX) ? null : asked,
      refresh: Number.isFinite(refresh) && refresh > 0 ? refresh : undefined,
      subagents: body.subagents,
    };
  }

  async function resolveCommand(cmd: string | null): Promise<string> {
    if (cmd) return cmd;
    state.command = (await setup(VERSION)).command;
    if (!state.command) throw httpError(500, 'err.server.setupFailed');
    return state.command;
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
        'content-security-policy': CSP,
      });
      res.end(html);
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
    const raw = req.headers['x-ccinfobar-token'];
    const a = Buffer.from(typeof raw === 'string' ? raw : '', 'utf8');
    if (a.length !== tokenBuf.length || !crypto.timingSafeEqual(a, tokenBuf)) {
      throw httpError(401, 'err.server.badToken');
    }
    // only the authenticated tab keeps a detached server alive
    lastRequest = now();
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin !== undefined && !originOk(origin)) throw new HttpError(403, 'Forbidden origin');
    }

    const h = router.match(method, url.pathname);
    if (!h) throw new HttpError(404, 'Not found');
    await h(ctx, req, res, url);
  }

  const prefixHandlers: Record<string, Handler<EditorCtx>> = {
    'GET|DELETE /api/catalog/entries/': async (_ctx, req, res, url) => {
      const method = req.method ?? 'GET';
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
    },
    'GET /api/catalog/remote/': async (_ctx, _req, res, url) => {
      needEndpoint();
      const raw = url.pathname.slice('/api/catalog/remote/'.length).split('/');
      let parts: string[] = [];
      try {
        parts = raw.map((p) => decodeURIComponent(p));
      } catch {}
      if (parts.length !== 2 || !parts.every((p) => ID_PART_RE.test(p)))
        throw httpError(400, 'catalog.remote.badId', { ref: clean(parts.join('/') || raw.join('/')) });
      const m = await loadMarket();
      const out = await m.remoteShow(parts.join('/'), marketDeps());
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
    },
    [`GET|DELETE ${FLOW_PATH}`]: async (ctx, req, res, url) => {
      const method = req.method ?? 'GET';
      const flow = url.pathname.slice(FLOW_PATH.length);
      const m = await loadMarket();
      if (!m.isFlowId(flow)) throw httpError(400, 'err.catalog.badRequest');
      // no flow was ever started: nothing to ask GitHub
      if (method === 'DELETE' || !ctx.state.flows) {
        ctx.state.flows?.cancel(flow);
        send(res, 200, { status: 'cancelled' });
        return;
      }
      const s = await ctx.state.flows.status(flow);
      const failed =
        s.status === 'failed' && s.code
          ? {
              code: s.code,
              errorId: Object.hasOwn(SIGN_IN_ERRORS, s.code)
                ? SIGN_IN_ERRORS[s.code]![1]
                : m.reasonId(s.code),
              ...(s.httpStatus ? { errorParams: { status: s.httpStatus } } : {}),
            }
          : {};
      send(res, 200, {
        status: s.status,
        ...(s.status === 'ok' ? { handle: clean(s.handle), admin: s.admin === true } : {}),
        ...failed,
      });
      return;
    },
  };

  const exactHandlers: Record<string, Handler<EditorCtx>> = {
    'GET /api/catalog': async (_ctx, _req, res, url) => {
      send(res, 200, catalogBody(diskLang(url.searchParams.get('lang'))));
      return;
    },
    'POST /api/catalog/previews': async (_ctx, req, res) => {
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
          if (hit && !Object.hasOwn(previews, ref))
            previews[ref] = previewOf(config, hit, source, colsOf(hit) ?? width);
        }
      });
      send(res, 200, { previews });
      return;
    },
    'POST /api/catalog/save': async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      const { kind } = body;
      const mode = body.mode ?? 'new';
      if (!isKind(kind) || typeof body.config !== 'object' || body.config === null)
        throw httpError(400, 'err.catalog.badContent');
      if (mode !== 'new' && mode !== 'update' && mode !== 'overwrite')
        throw httpError(400, 'err.catalog.badRequest');
      const config = normalizeConfig(body.config);
      const author = typeof body.author === 'string' ? body.author : undefined;
      const cols = parseCols(body.cols);
      let e: CatalogEntry;
      try {
        e = saveEntry({
          kind,
          name: str(body.name),
          description: str(body.description),
          ...(author === undefined ? {} : { author }),
          content: contentFromConfig(config, kind),
          note: str(body.note),
          ...(cols === undefined ? {} : { cols }),
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
    },
    'POST /api/catalog/restore': async (_ctx, req, res) => {
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
    },
    'POST /api/catalog/share': async (_ctx, req, res) => {
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
    },
    'POST /api/catalog/publish/plan': async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      const endpoint = needEndpoint();
      send(res, 200, (await publishView(endpoint, body.refs)).view);
      return;
    },
    // sets the handle a first publish registers, then reviews again
    'POST /api/catalog/publisher': async (_ctx, req, res) => {
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
    },
    'POST /api/catalog/publish': async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      const endpoint = needEndpoint();
      if (body.confirm !== true) throw httpError(400, 'err.catalog.needsConfirm');
      const { m, view, review } = await publishView(endpoint, body.refs);
      // send only what was reviewed; runPublish also checks each entry rev
      if (body.planHash !== view.planHash) throw httpError(409, 'err.catalog.planChanged', undefined, view);
      const out = await m.runPublish(review, marketDeps());
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
    },
    'POST /api/catalog/remote/previews': async (_ctx, req, res) => {
      needEndpoint();
      const body = asObject(await readBody(req));
      if (!Array.isArray(body.ids)) throw httpError(400, 'err.catalog.badRequest');
      const config = normalizeConfig(body.config);
      if (config.colorLevel === 'auto') config.colorLevel = 3;
      const source = previewSourceOf(body);
      const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 100));
      const m = await loadMarket();
      const out = await m.remotePreviewContents(body.ids, marketDeps());
      if (out.code) throw marketError(out.code, m.reasonId(out.code), out.status);
      const previews: Record<string, string[]> = {};
      withLanguage(uiLang(body.lang, config), () => {
        for (const it of out.items)
          previews[it.id] = previewContent(config, it.kind, it.content, false, source, it.cols ?? width);
      });
      send(res, 200, { previews });
      return;
    },
    'GET /api/catalog/remote': async (_ctx, _req, res, url) => {
      const endpoint = needEndpoint();
      const m = await loadMarket();
      const out = await m.remoteList({ ...marketDeps(), refresh: url.searchParams.get('refresh') === '1' });
      if (out.code) throw marketError(out.code, m.reasonId(out.code), out.status);
      send(res, 200, {
        endpoint: clean(endpoint),
        entries: out.entries,
        checkedAt: out.checkedAt ?? null,
        ...(out.stale ? { stale: true } : {}),
        ...(out.partial ? { partial: true } : {}),
      });
      return;
    },
    // D-07: the device code stays here; the browser gets the user code only
    'POST /api/catalog/login': async (_ctx, _req, res) => {
      needEndpoint();
      const m = await loadMarket();
      let started: Awaited<ReturnType<LoginFlows['start']>>;
      try {
        started = await loginFlows(m).start();
      } catch (err) {
        throw signInError(m, err);
      }
      send(res, 200, {
        flow: started.flow,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresIn: started.expiresIn,
        interval: started.interval,
      });
      return;
    },
    'POST /api/catalog/logout': async (_ctx, _req, res, url) => {
      const endpoint = needEndpoint();
      const m = await loadMarket();
      const signedOut = await m.signOut(endpoint, marketFetch());
      send(res, 200, { ok: true, signedOut, catalog: catalogBody(diskLang(url.searchParams.get('lang'))) });
      return;
    },
    // D-11: shows what would be installed; nothing is written
    'POST /api/catalog/install/plan': async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      needEndpoint();
      const { id, version, ref } = installRef(body);
      const m = await loadMarket();
      let plan: InstallPlan;
      try {
        plan = await m.planInstall(ref, marketDeps());
      } catch (err) {
        throw installError(m, err, id, version);
      }
      send(res, 200, installView(plan));
      return;
    },
    // downloads again and installs only what was reviewed
    'POST /api/catalog/install': async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      needEndpoint();
      const { id, version, ref } = installRef(body);
      const targets = reviewedTargets(body.targets);
      if (version === null || typeof body.hash !== 'string' || !targets)
        throw httpError(400, 'err.catalog.badRequest');
      const m = await loadMarket();
      let plan: InstallPlan;
      try {
        plan = await m.planInstall(ref, marketDeps());
      } catch (err) {
        throw installError(m, err, id, version);
      }
      if (m.installChanged(plan, { hash: body.hash, targets }))
        throw httpError(
          409,
          'err.catalog.install.changed',
          { id: clean(id) },
          { code: 'changed', plan: installView(plan) },
        );
      const done = m.runInstall(plan, { now: () => new Date(marketNow()) });
      send(res, 200, {
        ok: true,
        entryId: done.entryId,
        name: clean(done.name),
        result: done.result,
        catalog: catalogBody(diskLang(body.lang)),
      });
      return;
    },
    'POST /api/catalog/report': async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      const endpoint = needEndpoint();
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const m = await loadMarket();
      const reason = m.reportReason(body.reason);
      if (!isRemoteId(id)) throw httpError(400, 'catalog.remote.badId', { ref: clean(id) });
      if (reason === null) throw httpError(400, 'err.catalog.report.badReason', { max: REPORT_REASON_MAX });
      const out = await m.reportEntry(endpoint, id, reason, marketFetch());
      if (out.reported) {
        send(res, 201, { reported: true, report: out.report });
        return;
      }
      if ('already' in out) {
        send(res, 200, { reported: false, already: true });
        return;
      }
      if (out.code === 'sign-in' || out.code === 'unauthorized')
        throw httpError(401, 'err.catalog.signInFirst', undefined, { code: out.code });
      if (out.code === 'not-found')
        throw httpError(404, 'err.catalog.install.not-found', { id: clean(id) }, { code: out.code });
      throw marketError(out.code, m.reasonId(out.code), out.status);
    },
    'POST /api/catalog/install-theme': async (_ctx, req, res) => {
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
    },
    'POST /api/install/plan': async (_ctx, req, res) => {
      const body = asObject(await readBody(req));
      const { cmd, refresh, subagents } = requested(body);
      send(res, 200, { plan: planInstall({ command: cmd ?? placeholder(), refresh, subagents }) });
      return;
    },
    'POST /api/install': async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const { cmd, refresh, subagents } = requested(body);
      const confirmed = body.confirm === true;
      if (confirmed && !('current' in body)) throw httpError(400, 'install.confirmNeedsCurrent');
      const draft = planInstall({ command: cmd ?? placeholder(), refresh, subagents });
      if (confirmed && !deepEqual(body.current ?? null, draft.current))
        throw httpError(409, 'install.stale', { file: tildify(draft.file) }, { plan: draft });
      if (draft.needsConfirm && !confirmed)
        throw httpError(409, 'install.needsConfirm', undefined, { plan: draft });
      const plan = cmd ? draft : planInstall({ command: await resolveCommand(cmd), refresh, subagents });
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
      send(res, 200, { ok: true, backup, backupsDir: backupsDir(), claude: claudeInfo(ctx.state.command) });
      return;
    },
    'POST /api/hooks': async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const { enabled, permission } = body;
      if (typeof enabled !== 'boolean' || (permission !== undefined && typeof permission !== 'boolean'))
        throw httpError(400, 'hooks.badBody');
      const file = claudeSettingsPath();
      let backup: string | null = null;
      if (enabled) {
        const active = activeCommand(ctx.state.command);
        if (!active) throw textError(409, NOT_ACTIVE, { hooks: await hooksInfo(ctx.state.command) });
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
          throw textError(409, refusalText(plan.refused, claudeCode), {
            hooks: await hooksInfo(ctx.state.command),
          });
        backup = applyHooks(file, plan, process.env, permission === false ? OPTIONAL_EVENTS : []).backup;
      } else {
        backup = uninstallHooks(file).backup;
      }
      send(res, 200, { ok: true, hooks: await hooksInfo(ctx.state.command), backup });
      return;
    },
    'POST /api/progress': async (ctx, req, res) => {
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
        const active = activeCommand(ctx.state.command);
        if (!active) throw textError(409, NOT_ACTIVE, { hooks: await hooksInfo(ctx.state.command) });
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
            hooks: await hooksInfo(ctx.state.command),
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
      send(res, 200, { ok: true, hooks: await hooksInfo(ctx.state.command), backup, progress, held });
      return;
    },
    'GET /api/system': async (ctx, _req, res) => {
      send(res, 200, {
        version: VERSION,
        kind: kindOf(),
        update: readUpdateState(),
        claude: claudeInfo(ctx.state.command),
        hooks: await hooksInfo(ctx.state.command),
      });
      return;
    },
    'POST /api/update': async (_ctx, req, res) => {
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
        let out: InstallOutcome;
        try {
          out = await installChecked(
            latest,
            VERSION,
            kind === 'local' ? localPrefix() : undefined,
            process.env,
            {
              install: opts.update?.install ?? ((v, p, sig) => installVersionAsync(v, p, sig)),
              verify: opts.update?.verify ?? verifyInstall,
              recordRejected: (r) => writeUpdateState({ checkedAt: Date.now(), ...r }),
            },
          );
        } catch (err) {
          if ((err as Error).message === 'digest-unavailable') {
            throw httpError(500, 'err.server.digestUnavailable');
          }
          throw httpError(500, 'err.server.npmFailed', { error: (err as Error).message });
        }
        if ('rejected' in out) {
          writeUpdateState({
            checkedAt: Date.now(),
            latest,
            rejected: latest,
            rollback: out.rollback,
            reason: out.reason,
          });
          const id =
            out.rollback === 'ok'
              ? 'err.server.updateRejected.ok'
              : out.rollback === 'failed'
                ? 'err.server.updateRejected.failed'
                : 'err.server.updateRejected.unverified';
          throw httpError(500, id, { version: latest, reason: out.reason, current: VERSION });
        }
        writeUpdateState({ checkedAt: Date.now(), latest, installed: latest });
        send(res, 200, {
          current: VERSION,
          latest,
          newer,
          installed: latest,
          kind,
          ...(out.inconclusive ? { inconclusive: out.inconclusive } : {}),
        });
        return;
      }
      writeUpdateState({ checkedAt: Date.now(), latest });
      send(res, 200, { current: VERSION, latest, newer, kind });
      return;
    },
  };

  const now = opts.detached?.now ?? Date.now;
  let lastRequest = now();
  const ctx: EditorCtx = {
    opts,
    state,
    gsd,
    auto,
    now,
    setup,
    close,
    claudeVersion,
    hooksInfo,
    stylesFile,
    readStyles,
    presetList,
    uiLang,
    diskLang,
    allEntries,
    findRef,
    mustFind,
    catalogBody,
    userResult,
    writableRef,
    liveThemes,
    currentRev,
    previewContent,
    previewOf,
    marketFetch,
    marketNow,
    kindOf,
    latestOf,
    loadMarket,
    needEndpoint,
    marketDeps,
    loginFlows,
    publishRefs,
    publishView,
    requested,
    resolveCommand,
  };
  const router = createRouter<EditorCtx>({
    prefix: [
      ...moved.prefix,
      ...ROUTE_DEFS.prefix.map((d) => ({
        ...d,
        handler: pickHandler(prefixHandlers, `${d.methods.join('|')} ${d.path}`),
      })),
    ],
    exact: [
      ...moved.exact,
      ...ROUTE_DEFS.exact.map((d) => ({
        ...d,
        handler: pickHandler(exactHandlers, `${d.method} ${d.path}`),
      })),
    ],
  });
  if (Object.keys(prefixHandlers).length + Object.keys(exactHandlers).length !== ROUTE_COUNT) {
    throw new Error('route-handler-count');
  }
  const server = http.createServer((req, res) => {
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

  const base = `http://127.0.0.1:${port}/?t=${token}`;
  if (opts.detached) startDetached(opts.detached, base);
  const url = opts.share ? `${base}#c=${opts.share}` : base;
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
