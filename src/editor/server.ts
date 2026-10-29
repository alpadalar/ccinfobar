import '../core/i18n/lazy.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { CatalogEntry, EntryContent, EntryKind } from '../catalog/model.js';
import { shareState } from '../catalog/share.js';
import {
  CatalogStoreError,
  DEFAULT_MARKETPLACE,
  listEntries,
  listLegacy,
  marketEndpointInfo,
  normalizeEntry,
  readCredential,
  readEntry,
  readProfile,
  readPublisher,
  themeChain,
} from '../catalog/store.js';
import { findSystem, systemEntries } from '../catalog/system.js';
import { configLanguage, envLanguage } from '../cli/lang.js';
import {
  DEFAULT_EVENTS,
  detectClaudeCodeAsync,
  type HookRefusal,
  OPTIONAL_EVENTS,
  planHooks,
} from '../commands/hooks-install.js';
import { defaultCommand, setupCommandAsync } from '../commands/install.js';
import { openBrowser } from '../commands/open.js';
import { fetchLatest, installKind } from '../commands/update.js';
import { applyCatalogContent, type StyleHistory } from '../core/edit.js';
import { presetLabels } from '../core/i18n/catalog-text.js';
import { setLanguage, t, withLanguage } from '../core/i18n/index.js';
import { isLanguageId, type LanguageId } from '../core/i18n/languages.js';
import { availablePresets, loadForUse } from '../core/load.js';
import { type PreviewSource, renderPreview } from '../core/preview.js';
import { withoutRotation } from '../core/rotation.js';
import type { Config } from '../core/types.js';
import { gsdInstalled } from '../data/gsd.js';
import { writeAtomic } from '../data/store.js';
import { createRouter } from './router.js';
import { exact as catalogExact, prefix as catalogPrefix } from './routes/catalog.js';
import type {
  EditorCtx,
  EditorOptions,
  EditorState,
  Found,
  HooksInfo,
  LoginFlows,
  Market,
  PlanItem,
  Skip,
} from './routes/ctx.js';
import { exact as installExact } from './routes/install.js';
import { exact as shareExact } from './routes/share.js';
import { exact as stateExact } from './routes/state.js';
import { exact as styleExact } from './routes/styles.js';
import { exact as themeExact, prefix as themePrefix } from './routes/themes.js';
import {
  activeCommand,
  clean,
  contentOf,
  draftTheme,
  entryKind,
  HttpError,
  httpError,
  installedHooks,
  MAX_PUBLISH_REFS,
  marketError,
  NOT_ACTIVE,
  PLACEHOLDER_PREFIX,
  reasonOf,
  refType,
  refusalText,
  send,
  storeError,
  summaryOf,
  VERSION,
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

// match order: prefixes first, then exact
const ROUTE_DEFS = {
  prefix: [...themePrefix, ...catalogPrefix],
  exact: [...stateExact, ...themeExact, ...styleExact, ...shareExact, ...installExact, ...catalogExact],
};

export const routeTable = () => createRouter<EditorCtx>(ROUTE_DEFS).table();

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
  const router = createRouter<EditorCtx>(ROUTE_DEFS);
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
