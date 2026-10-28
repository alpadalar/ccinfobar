import { createHash } from 'node:crypto';
import { takesCols } from '../core/entry-keys.js';
import {
  createMarketClient,
  type MarketClient,
  type Received,
  validateReceived,
  type Written,
} from '../market/client.js';
import {
  canonicalJson,
  isRemoteId,
  LIST_CAP,
  type MarketEntry,
  type MarketMeta,
  type MarketSummary,
  type MarketVersion,
  type MeResult,
  type PublishPayload,
  type VersionPayload,
} from '../market/protocol.js';
import { cachedEntry, cachedIndex, cachedVersion } from './market-cache.js';
import {
  type CatalogEntry,
  clearReview,
  type EntryContent,
  type EntryKind,
  latest,
  markDropped,
  markError,
  marketSlug,
  markPublished,
  markWithdrawn,
  type RemoteRef,
  restoreLive,
  setShare,
  shareView,
} from './model.js';
import { entryHash, sendable } from './share.js';
import {
  CatalogStoreError,
  catalogDir,
  commitEntry,
  endpointKey,
  listEntries,
  marketEndpoint,
  normalizeEntry,
  readCredential,
  readEntry,
  readProfile,
  readPublisher,
  writeCredential,
  writePublisher,
} from './store.js';

export { entryHash };

export type PublishAction = 'publish' | 'version' | 'overwrite' | 'withdraw';

export interface PublishItem {
  id: string;
  rev: number;
  name: string;
  kind: EntryKind;
  action: PublishAction;
  remoteId: string | null;
  payload: PublishPayload | VersionPayload | null;
}

export interface PublishResult {
  id: string;
  ok: boolean;
  code: string | null;
  remoteId: string | null;
  version: number | null;
  status?: number;
  // held for review by a marketplace admin
  pending?: true;
  reason?: 'new-link';
  links?: string[];
  // linked to an entry an earlier try already created
  adopted?: true;
  // the slug was taken: published under another
  retried?: { from: string; to: string };
}

export interface PublishDeps {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  displayName?: string;
  defaultEndpoint?: string | null;
  cacheDir?: string;
}

export interface Registration {
  handle: string;
  displayName: string;
}

// what the user reviews; runPublish sends exactly this
export interface PublishReview {
  code: string | null;
  status?: number;
  submitUrl?: string;
  endpoint: string;
  overwrite: boolean;
  // the server keeps cols
  cols?: boolean;
  registration: Registration | null;
  plan: PublishItem[];
  // remote slugs already used under the handle
  taken: string[];
  renamed: { id: string; from: string; to: string }[];
}

const tailed = (base: string, tail: string) =>
  `${base.slice(0, 38 - tail.length).replace(/-+$/, '')}-${tail}`;

// names that map to one slug get the kind, then a number, oldest first
export function marketSlugs(
  all: CatalogEntry[],
  taken: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const groups = new Map<string, CatalogEntry[]>();
  for (const e of all) {
    const base = marketSlug(e.name);
    groups.set(base, [...(groups.get(base) ?? []), e]);
  }
  const out = new Map<string, string>();
  const used = new Set<string>(taken);
  for (const [base, g] of groups) if (g.length === 1) used.add(base);
  for (const [base, g] of groups) {
    if (g.length === 1) {
      let s = base;
      if (taken.has(base)) {
        s = tailed(base, '2');
        for (let n = 3; used.has(s); n++) s = tailed(base, String(n));
        used.add(s);
      }
      out.set(g[0]!.id, s);
      continue;
    }
    const order = [...g].sort((a, b) =>
      a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? -1 : 1) : a.id < b.id ? -1 : 1,
    );
    for (const e of order) {
      let s = tailed(base, e.kind);
      for (let n = 2; used.has(s); n++) s = tailed(base, `${e.kind}-${n}`);
      used.add(s);
      out.set(e.id, s);
    }
  }
  return out;
}

export function publishPlan(
  entries: CatalogEntry[],
  endpoint: string,
  opts: { overwrite: boolean; cols?: boolean } = { overwrite: true },
  all: CatalogEntry[] = entries,
  taken: ReadonlySet<string> = new Set(),
): PublishItem[] {
  const key = endpointKey(endpoint);
  const slugs = marketSlugs(all, taken);
  const out: PublishItem[] = [];
  for (const e of entries) {
    // installed entries belong to their publisher
    if (e.origin) continue;
    const content = sendable(e);
    const state = shareView(e, entryHash(content));
    if (state !== 'pending' && state !== 'outdated' && state !== 'withdraw-pending') continue;
    const r = e.share.remote;
    const remote = r && key !== null && endpointKey(r.endpoint) === key ? r : null;
    const base = { id: e.id, rev: e.rev, name: e.name, kind: e.kind, remoteId: remote?.id ?? null };
    if (state === 'withdraw-pending') {
      // nothing to withdraw here
      if (remote) out.push({ ...base, action: 'withdraw', payload: null });
      continue;
    }
    const v = latest(e);
    // older servers never see cols
    const cols =
      opts.cols === true && takesCols(e.kind) && typeof v.cols === 'number' ? { cols: v.cols } : {};
    if (!remote) {
      out.push({
        ...base,
        action: 'publish',
        payload: {
          kind: e.kind,
          slug: slugs.get(e.id) ?? marketSlug(e.name),
          name: e.name,
          description: e.description,
          author: e.author,
          content,
          note: v.note,
          ...cols,
        },
      });
      continue;
    }
    const overwrite = opts.overwrite && v.version === remote.version && entryHash(content) !== remote.hash;
    out.push({
      ...base,
      action: overwrite ? 'overwrite' : 'version',
      payload: { content, note: v.note, name: e.name, description: e.description, ...cols },
    });
  }
  return out;
}

// what was shown is what is sent
export function planHash(review: Pick<PublishReview, 'endpoint' | 'plan' | 'registration'>): string {
  const { endpoint, plan, registration } = review;
  return createHash('sha256').update(canonicalJson({ endpoint, plan, registration })).digest('hex');
}

function codeOf(err: unknown): string {
  if (err instanceof CatalogStoreError) return err.code;
  const e = err as { name?: unknown; code?: unknown } | null;
  return e && e.name === 'MarketError' && typeof e.code === 'string' ? e.code : 'unknown';
}

// an unmapped answer keeps its HTTP status for the message
function statusOf(err: unknown): { status?: number } {
  const e = err as { name?: unknown; code?: unknown; status?: unknown } | null;
  return e && e.name === 'MarketError' && e.code === 'http' && typeof e.status === 'number'
    ? { status: e.status }
    : {};
}

function envOf(deps: PublishDeps) {
  const env = deps.env ?? process.env;
  const dir = deps.dir ?? catalogDir(env);
  return { env, dir, endpoint: marketEndpoint(env, dir, deps.defaultEndpoint) };
}

// on a rev conflict the remote is merged into the newer rev
function record(
  id: string,
  rev: number,
  apply: (e: CatalogEntry) => CatalogEntry,
  dir: string,
  now: Date,
): { saved: boolean; code: string | null } {
  try {
    const cur = readEntry(id, dir);
    if (!cur || cur.entry.rev !== rev) throw new CatalogStoreError('changed', { id });
    commitEntry(apply(cur.entry), rev, dir, now);
    return { saved: true, code: null };
  } catch (err) {
    if (codeOf(err) !== 'changed') return { saved: false, code: codeOf(err) };
  }
  try {
    const fresh = readEntry(id, dir);
    if (fresh) commitEntry(apply(fresh.entry), fresh.entry.rev, dir, now);
    return { saved: !!fresh, code: 'changed' };
  } catch {
    return { saved: false, code: 'changed' };
  }
}

const published = (remote: RemoteRef) => (e: CatalogEntry) => {
  const next = markPublished(e, remote);
  return e.share.wanted ? next : setShare(next, false);
};

const withdrawn = (e: CatalogEntry) => {
  const next = markWithdrawn(e);
  return e.share.wanted ? setShare(next, true) : next;
};

// publishers come only from GitHub sign-in there
export const signInOnly = (meta: MarketMeta): boolean =>
  meta.auth.includes('github-device') && !meta.auth.includes('token');

// the handle set for this endpoint, else the author as a slug
function registrationOf(
  endpoint: string,
  plan: PublishItem[],
  entries: CatalogEntry[],
  deps: PublishDeps,
  dir: string,
) {
  const author = readProfile(dir).author || entries.find((e) => e.id === plan[0]?.id)?.author || '';
  return {
    handle: readPublisher(endpoint, dir) ?? marketSlug(author || 'publisher'),
    displayName: deps.displayName ?? author,
  };
}

// reads meta, so the plan shows what the server will really do
export async function reviewPublish(ids: string[] | null, deps: PublishDeps = {}): Promise<PublishReview> {
  const { dir, endpoint: found } = envOf(deps);
  const endpoint = found ?? '';
  const none = { endpoint, overwrite: true, registration: null, plan: [], taken: [], renamed: [] };
  if (!endpoint) return { code: 'no-endpoint', ...none };
  const every = listEntries(dir);
  const entries = every.filter((e) => ids === null || ids.includes(e.id));
  // nothing waits: no request at all
  if (!publishPlan(entries, endpoint).length) return { code: null, ...none };
  let anon: MarketClient;
  try {
    anon = createMarketClient({ endpoint, fetch: deps.fetch ?? globalThis.fetch });
  } catch {
    return { code: 'bad-endpoint', ...none };
  }
  let meta: MarketMeta;
  try {
    meta = await anon.meta();
    if (!meta.capabilities.write)
      return { code: 'read-only', ...(meta.submitUrl ? { submitUrl: meta.submitUrl } : {}), ...none };
  } catch (err) {
    return { code: codeOf(err), ...statusOf(err), ...none };
  }
  const overwrite = meta.capabilities.overwrite;
  const cols = meta.capabilities.cols === true;
  const token = readCredential(anon.endpoint, dir);
  if (!token && signInOnly(meta)) return { code: 'sign-in', ...none };
  const opts = { overwrite, cols };
  const first = publishPlan(entries, endpoint, opts, every);
  const taken = await remoteTaken(anon, token, signInOnly(meta), first, every, deps, dir);
  const plan = taken.size ? publishPlan(entries, endpoint, opts, every, taken) : first;
  const registration = token ? null : registrationOf(anon.endpoint, plan, entries, deps, dir);
  const renamed = plan.flatMap((it, i) => {
    const from = (first[i]?.payload as PublishPayload | null)?.slug;
    const to = (it.payload as PublishPayload | null)?.slug;
    return it.action === 'publish' && from && to && from !== to ? [{ id: it.id, from, to }] : [];
  });
  return { code: null, endpoint, overwrite, cols, registration, plan, taken: [...taken].sort(), renamed };
}

const slugOf = (id: string) => id.split('/')[1] ?? '';

// remote slugs this handle holds, minus claims a planned publish could adopt (18-08)
async function remoteTaken(
  anon: MarketClient,
  token: string | null,
  github: boolean,
  plan: PublishItem[],
  every: CatalogEntry[],
  deps: PublishDeps,
  dir: string,
): Promise<Set<string>> {
  const waiting = plan.filter((it) => it.action === 'publish');
  const out = new Set<string>();
  if (!waiting.length) return out;
  const key = endpointKey(anon.endpoint);
  for (const e of every) {
    const r = e.share.remote;
    if (r && key !== null && endpointKey(r.endpoint) === key) out.add(slugOf(r.id));
  }
  let handle = readPublisher(anon.endpoint, dir);
  const claims = new Map<string, string | null>();
  let pending = new Set<string>();
  if (token && github) {
    try {
      const me = await createMarketClient({
        endpoint: anon.endpoint,
        fetch: deps.fetch ?? globalThis.fetch,
        token,
      }).me();
      handle = handle ?? me.handle;
      for (const x of me.entries) if (x.state === 'pending') pending.add(slugOf(x.id));
      for (const x of me.entries) claims.set(slugOf(x.id), null);
    } catch {
      pending = new Set();
    }
  }
  if (handle) {
    try {
      const { index } = await cachedIndex(anon.endpoint, { ...cacheOf(anon, deps), refresh: true });
      for (const x of index.entries) if (x.publisher === handle) claims.set(slugOf(x.id), x.hash);
    } catch {
      // an unreadable index claims nothing
    }
  }
  for (const [slug, hash] of claims) {
    const mine = waiting.some((it) => {
      const p = it.payload as PublishPayload;
      const h = entryHash(p.content);
      const a = every.find((x) => x.id === it.id)?.share.attempt;
      const marked = !!a && a.endpoint === anon.endpoint && a.slug === slug && a.hash === h;
      if (hash !== null) return hash === h && (p.slug === slug || marked);
      return pending.has(slug) && marked;
    });
    if (!mine) out.add(slug);
  }
  return out;
}

// the server has no such id: rejected, never public, so the id is free (WR-04)
const DROPPED = 'dropped';

async function sendItem(
  client: MarketClient,
  item: PublishItem,
  remote: RemoteRef | null,
): Promise<(Written & { id: string }) | typeof DROPPED | null> {
  if (item.action === 'publish') return client.publish(item.payload as PublishPayload);
  const id = remote!.id;
  if (item.action === 'withdraw') {
    try {
      await client.withdraw(id);
    } catch (err) {
      const c = codeOf(err);
      if (c === 'not-found') return DROPPED;
      // already gone counts as withdrawn
      if (c !== 'withdrawn') throw err;
    }
    return null;
  }
  const payload = item.payload as VersionPayload;
  // a reviewed overwrite never turns into a new public version
  if (item.action === 'overwrite') return { id, ...(await client.overwrite(id, remote!.version, payload)) };
  return { id, ...(await client.addVersion(id, remote!.version, payload)) };
}

const TRANSPORT = new Set(['timeout', 'network', 'unknown', 'bad-json']);

type Sent = Written & { id: string };

// a 409 on publish: our own lost try is adopted, anything else moves to <slug>-2 once
async function recoverConflict(
  client: MarketClient,
  e: CatalogEntry,
  payload: PublishPayload,
  dir: string,
  taken: ReadonlySet<string>,
): Promise<{ sent: Sent; adopted?: true; retried?: { from: string; to: string } }> {
  const hash = entryHash(payload.content);
  const handle = readPublisher(client.endpoint, dir) ?? (await client.me().catch(() => null))?.handle;
  const a = e.share.attempt;
  const marked = a && a.endpoint === client.endpoint && a.hash === hash ? a : null;
  const slugs = [payload.slug, ...(marked && marked.slug !== payload.slug ? [marked.slug] : [])];
  if (handle) {
    for (const slug of slugs) {
      const id = `${handle}/${slug}`;
      try {
        const live = await client.entry(id);
        if (!live.withdrawn && live.hash === hash)
          return { sent: { id, version: live.version, hash }, adopted: true };
      } catch (err) {
        if (codeOf(err) === 'not-found' && marked?.slug === slug) {
          const mine = (await client.me().catch(() => null))?.entries.find(
            (x) => x.id === id && x.state === 'pending',
          );
          if (mine) return { sent: { id, version: mine.version, hash, pending: true }, adopted: true };
        }
      }
    }
  }
  let to = tailed(payload.slug, '2');
  for (let n = 3; taken.has(to); n++) to = tailed(payload.slug, String(n));
  try {
    return { sent: await client.publish({ ...payload, slug: to }), retried: { from: payload.slug, to } };
  } catch (err) {
    if (err instanceof Error) Object.assign(err, { sentSlug: to });
    throw err;
  }
}

const notSent = (item: PublishItem): PublishResult => ({
  id: item.id,
  ok: false,
  code: 'unreviewed',
  remoteId: item.remoteId,
  version: null,
});

// sends the reviewed items only, each only while its plan is unchanged
export async function runPublish(
  review: PublishReview,
  deps: PublishDeps = {},
): Promise<{ code: string | null; status?: number; submitUrl?: string; results: PublishResult[] }> {
  if (review.code)
    return {
      code: review.code,
      ...(review.status ? { status: review.status } : {}),
      ...(review.submitUrl ? { submitUrl: review.submitUrl } : {}),
      results: [],
    };
  const { dir, endpoint } = envOf(deps);
  if (!endpoint) return { code: 'no-endpoint', results: [] };
  if (endpointKey(endpoint) !== endpointKey(review.endpoint)) return { code: 'unreviewed', results: [] };
  const items = review.plan;
  if (!items.length) return { code: null, results: [] };
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  let anon: MarketClient;
  try {
    anon = createMarketClient({ endpoint, fetch: fetchFn });
  } catch {
    return { code: 'bad-endpoint', results: [] };
  }
  let token = readCredential(anon.endpoint, dir);
  if (!token) {
    // only the reviewed registration is sent
    const asked = review.registration;
    if (!asked) return { code: 'unreviewed', results: [] };
    try {
      const reg = await anon.register(asked.handle, asked.displayName);
      writeCredential(anon.endpoint, reg.token, dir);
      writePublisher(anon.endpoint, reg.handle, dir);
      token = reg.token;
    } catch (err) {
      const c = codeOf(err);
      return { code: c === 'conflict' ? 'handle-taken' : c, ...statusOf(err), results: [] };
    }
  }
  const client = createMarketClient({ endpoint, fetch: fetchFn, token });
  const results: PublishResult[] = [];
  const every = listEntries(dir);
  const taken = new Set(review.taken);
  for (const item of items) {
    const cur = readEntry(item.id, dir)?.entry;
    const e = cur && normalizeEntry(cur);
    const again =
      e &&
      publishPlan(
        [e],
        endpoint,
        { overwrite: review.overwrite, cols: review.cols === true },
        every,
        taken,
      )[0];
    if (!e || !again || canonicalJson(again) !== canonicalJson(item)) {
      results.push(notSent(item));
      continue;
    }
    const remote = item.remoteId ? e.share.remote : null;
    let res: PublishResult;
    try {
      let got: Awaited<ReturnType<typeof sendItem>>;
      let recovered: { adopted?: true; retried?: { from: string; to: string } } = {};
      try {
        got = await sendItem(client, item, remote);
      } catch (err) {
        if (item.action !== 'publish' || codeOf(err) !== 'conflict') throw err;
        const r = await recoverConflict(client, e, item.payload as PublishPayload, dir, taken);
        got = r.sent;
        recovered = r;
      }
      if (got === DROPPED) {
        const r = record(item.id, item.rev, (x) => markDropped(x, null), dir, now());
        results.push({ id: item.id, ok: r.saved, code: r.code, remoteId: item.remoteId, version: null });
        continue;
      }
      const sent = got;
      const ref: RemoteRef | null = sent && {
        endpoint: client.endpoint,
        id: sent.id,
        version: sent.version,
        hash: sent.hash,
        publishedAt: now().toISOString(),
        ...(sent.pending ? { review: 'pending' as const } : {}),
        ...(sent.pending && sent.reason && sent.links ? { reason: sent.reason, links: sent.links } : {}),
      };
      const r = record(item.id, item.rev, ref ? published(ref) : withdrawn, dir, now());
      res = {
        id: item.id,
        ok: r.saved,
        code: r.code,
        remoteId: sent?.id ?? item.remoteId,
        version: sent?.version ?? null,
        ...(sent?.pending ? { pending: true as const } : {}),
        ...(sent?.pending && sent.reason && sent.links ? { reason: sent.reason, links: sent.links } : {}),
        ...(recovered.adopted ? { adopted: true as const } : {}),
        ...(recovered.retried ? { retried: recovered.retried } : {}),
      };
    } catch (err) {
      let code = codeOf(err);
      // our own id is gone: rejected (404), or removed or withdrawn elsewhere (410, stays reserved)
      const own = item.action === 'version' || item.action === 'overwrite';
      if (own && code === 'not-found') code = 'rejected';
      const mark = code;
      const payload = item.payload as PublishPayload | null;
      const sentSlug = (err as { sentSlug?: string } | null)?.sentSlug ?? payload?.slug;
      const attempt =
        item.action === 'publish' && payload && sentSlug && TRANSPORT.has(code)
          ? { endpoint: client.endpoint, slug: sentSlug, hash: entryHash(payload.content) }
          : undefined;
      const apply =
        mark === 'rejected'
          ? (x: CatalogEntry) => markDropped(x, mark)
          : own && mark === 'withdrawn'
            ? (x: CatalogEntry) => markError(markWithdrawn(x), mark)
            : (x: CatalogEntry) => markError(x, mark, attempt);
      record(item.id, item.rev, apply, dir, now());
      res = { id: item.id, ok: false, code, remoteId: item.remoteId, version: null, ...statusOf(err) };
    }
    results.push(res);
  }
  return { code: null, results };
}

export interface ReviewCheck {
  code: string | null;
  status?: number;
  me: MeResult | null;
  // local entries that waited, cleared now, rejected, still waiting on the server
  checked: number;
  cleared: number;
  rejected: number;
  waiting: number;
}

// asks /v1/me; only on an explicit check (D-08)
export async function refreshReview(deps: PublishDeps = {}): Promise<ReviewCheck> {
  const none = { me: null, checked: 0, cleared: 0, rejected: 0, waiting: 0 };
  const { dir, endpoint } = envOf(deps);
  if (!endpoint) return { code: 'no-endpoint', ...none };
  const fetchFn = deps.fetch ?? globalThis.fetch;
  let anon: MarketClient;
  try {
    anon = createMarketClient({ endpoint, fetch: fetchFn });
  } catch {
    return { code: 'bad-endpoint', ...none };
  }
  let me: MeResult;
  try {
    if (!(await anon.meta()).auth.includes('github-device')) return { code: 'not-github', ...none };
    const token = readCredential(anon.endpoint, dir);
    if (!token) return { code: 'sign-in', ...none };
    me = await createMarketClient({ endpoint, fetch: fetchFn, token }).me();
  } catch (err) {
    return { code: codeOf(err), ...statusOf(err), ...none };
  }
  const key = endpointKey(endpoint);
  const byId = new Map(me.entries.map((x) => [x.id, x]));
  const listed = new Set(me.entries.map((x) => x.id));
  // a full list may leave entries out, so a missing id proves nothing then
  const complete = me.entries.length < LIST_CAP;
  const now = deps.now ?? (() => new Date());
  let checked = 0;
  let cleared = 0;
  let rejected = 0;
  for (const e of listEntries(dir)) {
    const r = e.share.remote;
    if (r?.review !== 'pending' || endpointKey(r.endpoint) !== key) continue;
    checked++;
    const m = byId.get(r.id);
    const isLive = m?.state === 'live';
    if (isLive && m.held === undefined && m.version >= r.version) {
      if (record(e.id, e.rev, clearReview, dir, now()).saved) cleared++;
    } else if (isLive && m.held === undefined && complete) {
      // held version gone: rejected, the older live version stays
      if (record(e.id, e.rev, (x) => restoreLive(x, m.version), dir, now()).saved) rejected++;
    }
    // no longer waiting and not live: an admin rejected it (WR-04)
    else if (complete && !listed.has(r.id)) {
      if (record(e.id, e.rev, (x) => markDropped(x, 'rejected'), dir, now()).saved) rejected++;
    }
  }
  const waiting = me.entries.filter((x) => x.state === 'pending' || x.held !== undefined).length;
  return { code: null, me, checked, cleared, rejected, waiting };
}

async function reader(deps: PublishDeps): Promise<{ client: MarketClient | null; code: string | null }> {
  const { endpoint } = envOf(deps);
  if (!endpoint) return { client: null, code: 'no-endpoint' };
  try {
    return {
      client: createMarketClient({ endpoint, fetch: deps.fetch ?? globalThis.fetch }),
      code: null,
    };
  } catch {
    return { client: null, code: 'bad-endpoint' };
  }
}

const cacheOf = (client: MarketClient, deps: PublishDeps) => ({
  client,
  env: deps.env ?? process.env,
  ...(deps.now ? { now: deps.now } : {}),
  ...(deps.cacheDir ? { cacheDir: deps.cacheDir } : {}),
});

export interface RemoteList {
  code: string | null;
  status?: number;
  entries: MarketSummary[];
  // the last time the server confirmed the index
  checkedAt?: string;
  stale?: true;
  partial?: true;
}

// R-12: a day from the cache; refresh sends one conditional request
export async function remoteList(deps: PublishDeps & { refresh?: boolean } = {}): Promise<RemoteList> {
  const { client, code } = await reader(deps);
  if (!client) return { code, entries: [] };
  try {
    const r = await cachedIndex(client.endpoint, {
      ...cacheOf(client, deps),
      refresh: deps.refresh === true,
    });
    return {
      code: null,
      entries: r.index.entries.filter((e) => !e.withdrawn),
      checkedAt: r.checkedAt,
      ...(r.stale ? { stale: true } : {}),
      ...(r.partial ? { partial: true } : {}),
    };
  } catch (err) {
    return { code: codeOf(err), ...statusOf(err), entries: [] };
  }
}

export async function remoteShow(
  id: string,
  deps: PublishDeps = {},
): Promise<{
  code: string | null;
  status?: number;
  entry: MarketEntry | null;
  latest: (MarketVersion & Received) | null;
}> {
  const { client, code } = await reader(deps);
  if (!client) return { code, entry: null, latest: null };
  if (!isRemoteId(id)) return { code: 'invalid', entry: null, latest: null };
  const cache = cacheOf(client, deps);
  let entry: MarketEntry;
  try {
    entry = (await cachedEntry(client.endpoint, id, cache)).entry;
  } catch (err) {
    return { code: codeOf(err), ...statusOf(err), entry: null, latest: null };
  }
  if (entry.withdrawn) return { code: null, entry, latest: null };
  const want = entry.versions.find((v) => v.version === entry.version)?.hash;
  if (!want || want !== entry.hash) return { code: 'bad-hash', entry, latest: null };
  try {
    const v = await cachedVersion(client.endpoint, id, entry.version, want, {
      ...cache,
      kind: entry.kind,
      // meta only on a cache miss
      immutable: async () => !(await client.meta()).capabilities.overwrite,
    });
    const got = validateReceived(entry.kind, v.content);
    if (!got) return { code: 'invalid', entry, latest: null };
    return { code: null, entry, latest: { version: v.version, hash: v.hash, ...got } };
  } catch (err) {
    return { code: codeOf(err), ...statusOf(err), entry, latest: null };
  }
}

export const MAX_REMOTE_PREVIEWS = 24;
export const REMOTE_PREVIEW_CONCURRENCY = 4;

export interface RemotePreviewItem {
  id: string;
  kind: EntryKind;
  version: number;
  content: EntryContent;
  cols?: number;
}

export async function remotePreviewContents(
  ids: unknown[],
  deps: PublishDeps = {},
): Promise<{ code: string | null; status?: number; items: RemotePreviewItem[] }> {
  const { client, code } = await reader(deps);
  if (!client) return { code, items: [] };
  const valid = ids.filter((id): id is string => typeof id === 'string' && isRemoteId(id));
  const want = [...new Set(valid)].slice(0, MAX_REMOTE_PREVIEWS);
  const cache = cacheOf(client, deps);
  let entries: MarketSummary[];
  try {
    entries = (await cachedIndex(client.endpoint, { ...cache, refresh: false })).index.entries;
  } catch (err) {
    return { code: codeOf(err), ...statusOf(err), items: [] };
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const queue = want.map((id) => byId.get(id)).filter((e): e is MarketSummary => !!e && !e.withdrawn);
  let meta: Promise<boolean> | null = null;
  const immutable = () => {
    meta ??= client.meta().then((m) => !m.capabilities.overwrite);
    return meta;
  };
  const got = new Map<string, RemotePreviewItem>();
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const s = queue[next++]!;
      try {
        // render only: the hash is checked against the index summary
        const v = await cachedVersion(client.endpoint, s.id, s.version, s.hash, {
          ...cache,
          kind: s.kind,
          immutable,
        });
        const r = validateReceived(s.kind, v.content);
        const cols = s.cols === undefined ? {} : { cols: s.cols };
        if (r) got.set(s.id, { id: s.id, kind: s.kind, version: v.version, content: r.content, ...cols });
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(REMOTE_PREVIEW_CONCURRENCY, queue.length) }, worker));
  return { code: null, items: queue.flatMap((s) => got.get(s.id) ?? []) };
}
