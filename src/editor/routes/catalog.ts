import '../../core/i18n/lazy.js';
import type { CatalogEntry, EntryKind } from '../../catalog/model.js';
import { contentFromConfig } from '../../catalog/snapshot.js';
import {
  adoptLegacy,
  CatalogStoreError,
  deleteEntry,
  deleteLegacy,
  installEntryTheme,
  isHandle,
  readCredential,
  readProfile,
  readPublisher,
  restoreEntry,
  saveEntry,
  updateShare,
  writeProfile,
  writePublisher,
} from '../../catalog/store.js';
import { normalizeConfig } from '../../core/config.js';
import { parseCols } from '../../core/entry-keys.js';
import { type MessageId, withLanguage } from '../../core/i18n/index.js';
import { listThemes } from '../../core/themes.js';
import type { ImportTarget } from '../../importers/confirm.js';
import { ID_PART_RE, isRemoteId, REPORT_REASON_MAX } from '../../market/protocol.js';
import type { ExactRoute, PrefixRoute } from '../router.js';
import type { EditorCtx, InstallPlan, LoginFlows, Market } from './ctx.js';
import {
  asObject,
  clean,
  colsOf,
  contentOf,
  entryKind,
  type HttpError,
  httpError,
  KINDS,
  marketError,
  previewSourceOf,
  readBody,
  refOf,
  refType,
  send,
  storeError,
  summaryOf,
  versionsOf,
} from './util.js';

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

export const prefix: PrefixRoute<EditorCtx>[] = [
  {
    methods: ['GET', 'DELETE'],
    path: '/api/catalog/entries/',
    handler: async (ctx, req, res, url) => {
      const method = req.method ?? 'GET';
      let ref = '';
      try {
        ref = decodeURIComponent(url.pathname.slice('/api/catalog/entries/'.length));
      } catch {}
      const type = refType(ref);
      if (!type) throw httpError(400, 'err.catalog.badId');
      const lang = ctx.diskLang(url.searchParams.get('lang'));
      if (method === 'GET') {
        const hit = ctx.mustFind(ref);
        send(
          res,
          200,
          withLanguage(lang, () => ({ entry: summaryOf(hit), versions: versionsOf(hit) })),
        );
        return;
      }
      if (type === 'system') {
        ctx.mustFind(ref);
        throw httpError(403, 'err.catalog.systemReadOnly');
      }
      let kept: string | null = null;
      if (type === 'user')
        kept = deleteEntry(ref, undefined, undefined, { themesInUse: ctx.liveThemes(ref) }).kept;
      else if (!deleteLegacy(ref)) throw httpError(404, 'err.catalog.unknownRef', { ref: clean(ref) });
      send(res, 200, { ok: true, kept, catalog: ctx.catalogBody(lang) });
      return;
    },
  },
  {
    methods: ['GET'],
    path: '/api/catalog/remote/',
    handler: async (ctx, _req, res, url) => {
      ctx.needEndpoint();
      const raw = url.pathname.slice('/api/catalog/remote/'.length).split('/');
      let parts: string[] = [];
      try {
        parts = raw.map((p) => decodeURIComponent(p));
      } catch {}
      if (parts.length !== 2 || !parts.every((p) => ID_PART_RE.test(p)))
        throw httpError(400, 'catalog.remote.badId', { ref: clean(parts.join('/') || raw.join('/')) });
      const m = await ctx.loadMarket();
      const out = await m.remoteShow(parts.join('/'), ctx.marketDeps());
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
  },
  {
    methods: ['GET', 'DELETE'],
    path: FLOW_PATH,
    handler: async (ctx, req, res, url) => {
      const method = req.method ?? 'GET';
      const flow = url.pathname.slice(FLOW_PATH.length);
      const m = await ctx.loadMarket();
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
  },
];

export const exact: ExactRoute<EditorCtx>[] = [
  {
    method: 'GET',
    path: '/api/catalog',
    handler: async (ctx, _req, res, url) => {
      send(res, 200, ctx.catalogBody(ctx.diskLang(url.searchParams.get('lang'))));
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/previews',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const config = normalizeConfig(body.config);
      if (config.colorLevel === 'auto') config.colorLevel = 3;
      const source = previewSourceOf(body);
      const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 100));
      const byRef = new Map(ctx.allEntries().map((a) => [refOf(a), a]));
      const refs = Array.isArray(body.refs)
        ? body.refs.slice(0, MAX_PREVIEWS).filter((r): r is string => typeof r === 'string')
        : [...byRef.keys()].slice(0, MAX_PREVIEWS);
      const previews: Record<string, string[]> = {};
      withLanguage(ctx.uiLang(body.lang, config), () => {
        for (const ref of refs) {
          const hit = byRef.get(ref);
          if (hit && !Object.hasOwn(previews, ref))
            previews[ref] = ctx.previewOf(config, hit, source, colsOf(hit) ?? width);
        }
      });
      send(res, 200, { previews });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/save',
    handler: async (ctx, req, res) => {
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
      send(res, 200, ctx.userResult(e, ctx.uiLang(body.lang, config)));
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/restore',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const target = ctx.writableRef(body.id ?? body.ref);
      const version = body.version;
      if (!Number.isInteger(version) || (version as number) < 1)
        throw httpError(400, 'err.catalog.badRequest');
      const lang = ctx.diskLang(body.lang);
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
      send(res, 200, ctx.userResult(restoreEntry(id, version as number, rev, ''), lang));
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/share',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const target = ctx.writableRef(body.ref ?? body.id);
      if (typeof body.share !== 'boolean') throw httpError(400, 'err.catalog.badRequest');
      let e: CatalogEntry;
      if (target.type === 'legacy') {
        const adopted = adoptLegacy(target.ref, new Date());
        e = updateShare(adopted.id, body.share, adopted.rev);
      } else e = updateShare(target.ref, body.share, ctx.currentRev(target.ref, body.rev));
      send(res, 200, ctx.userResult(e, ctx.diskLang(body.lang)));
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/publish/plan',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const endpoint = ctx.needEndpoint();
      send(res, 200, (await ctx.publishView(endpoint, body.refs)).view);
      return;
    },
  },
  {
    // sets the handle a first publish registers, then reviews again
    method: 'POST',
    path: '/api/catalog/publisher',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const endpoint = ctx.needEndpoint();
      const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
      if (!isHandle(handle)) throw httpError(400, 'err.catalog.badHandle');
      const cur = readPublisher(endpoint);
      if (readCredential(endpoint) !== null && cur !== null && cur !== handle)
        throw httpError(409, 'catalog.publisher.registered', { handle: cur, endpoint: clean(endpoint) });
      writePublisher(endpoint, handle);
      send(res, 200, (await ctx.publishView(endpoint, body.refs)).view);
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/publish',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const endpoint = ctx.needEndpoint();
      if (body.confirm !== true) throw httpError(400, 'err.catalog.needsConfirm');
      const { m, view, review } = await ctx.publishView(endpoint, body.refs);
      // send only what was reviewed; runPublish also checks each entry rev
      if (body.planHash !== view.planHash) throw httpError(409, 'err.catalog.planChanged', undefined, view);
      const out = await m.runPublish(review, ctx.marketDeps());
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
        catalog: ctx.catalogBody(ctx.diskLang(body.lang)),
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/remote/previews',
    handler: async (ctx, req, res) => {
      ctx.needEndpoint();
      const body = asObject(await readBody(req));
      if (!Array.isArray(body.ids)) throw httpError(400, 'err.catalog.badRequest');
      const config = normalizeConfig(body.config);
      if (config.colorLevel === 'auto') config.colorLevel = 3;
      const source = previewSourceOf(body);
      const width = Math.max(20, Math.min(400, Math.floor(Number(body.width)) || 100));
      const m = await ctx.loadMarket();
      const out = await m.remotePreviewContents(body.ids, ctx.marketDeps());
      if (out.code) throw marketError(out.code, m.reasonId(out.code), out.status);
      const previews: Record<string, string[]> = {};
      withLanguage(ctx.uiLang(body.lang, config), () => {
        for (const it of out.items)
          previews[it.id] = ctx.previewContent(config, it.kind, it.content, false, source, it.cols ?? width);
      });
      send(res, 200, { previews });
      return;
    },
  },
  {
    method: 'GET',
    path: '/api/catalog/remote',
    handler: async (ctx, _req, res, url) => {
      const endpoint = ctx.needEndpoint();
      const m = await ctx.loadMarket();
      const out = await m.remoteList({
        ...ctx.marketDeps(),
        refresh: url.searchParams.get('refresh') === '1',
      });
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
  },
  {
    // D-07: the device code stays here; the browser gets the user code only
    method: 'POST',
    path: '/api/catalog/login',
    handler: async (ctx, _req, res) => {
      ctx.needEndpoint();
      const m = await ctx.loadMarket();
      let started: Awaited<ReturnType<LoginFlows['start']>>;
      try {
        started = await ctx.loginFlows(m).start();
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
  },
  {
    method: 'POST',
    path: '/api/catalog/logout',
    handler: async (ctx, _req, res, url) => {
      const endpoint = ctx.needEndpoint();
      const m = await ctx.loadMarket();
      const signedOut = await m.signOut(endpoint, ctx.marketFetch());
      send(res, 200, {
        ok: true,
        signedOut,
        catalog: ctx.catalogBody(ctx.diskLang(url.searchParams.get('lang'))),
      });
      return;
    },
  },
  {
    // D-11: shows what would be installed; nothing is written
    method: 'POST',
    path: '/api/catalog/install/plan',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      ctx.needEndpoint();
      const { id, version, ref } = installRef(body);
      const m = await ctx.loadMarket();
      let plan: InstallPlan;
      try {
        plan = await m.planInstall(ref, ctx.marketDeps());
      } catch (err) {
        throw installError(m, err, id, version);
      }
      send(res, 200, installView(plan));
      return;
    },
  },
  {
    // downloads again and installs only what was reviewed
    method: 'POST',
    path: '/api/catalog/install',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      ctx.needEndpoint();
      const { id, version, ref } = installRef(body);
      const targets = reviewedTargets(body.targets);
      if (version === null || typeof body.hash !== 'string' || !targets)
        throw httpError(400, 'err.catalog.badRequest');
      const m = await ctx.loadMarket();
      let plan: InstallPlan;
      try {
        plan = await m.planInstall(ref, ctx.marketDeps());
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
      const done = m.runInstall(plan, { now: () => new Date(ctx.marketNow()) });
      send(res, 200, {
        ok: true,
        entryId: done.entryId,
        name: clean(done.name),
        result: done.result,
        catalog: ctx.catalogBody(ctx.diskLang(body.lang)),
      });
      return;
    },
  },
  {
    method: 'POST',
    path: '/api/catalog/report',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const endpoint = ctx.needEndpoint();
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const m = await ctx.loadMarket();
      const reason = m.reportReason(body.reason);
      if (!isRemoteId(id)) throw httpError(400, 'catalog.remote.badId', { ref: clean(id) });
      if (reason === null) throw httpError(400, 'err.catalog.report.badReason', { max: REPORT_REASON_MAX });
      const out = await m.reportEntry(endpoint, id, reason, ctx.marketFetch());
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
  },
  {
    method: 'POST',
    path: '/api/catalog/install-theme',
    handler: async (ctx, req, res) => {
      const body = asObject(await readBody(req));
      const ref = body.ref;
      if (!refType(ref)) throw httpError(400, 'err.catalog.badRef');
      const hit = ctx.mustFind(ref as string);
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
  },
];
