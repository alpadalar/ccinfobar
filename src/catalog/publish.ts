import { createHash } from 'node:crypto';
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
}

const tailed = (base: string, tail: string) =>
  `${base.slice(0, 38 - tail.length).replace(/-+$/, '')}-${tail}`;

// names that map to one slug get the kind, then a number, oldest first
export function marketSlugs(all: CatalogEntry[]): Map<string, string> {
  const groups = new Map<string, CatalogEntry[]>();
  for (const e of all) {
    const base = marketSlug(e.name);
    groups.set(base, [...(groups.get(base) ?? []), e]);
  }
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const [base, g] of groups) if (g.length === 1) used.add(base);
  for (const [base, g] of groups) {
    if (g.length === 1) {
      out.set(g[0]!.id, base);
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
): PublishItem[] {
  const key = endpointKey(endpoint);
  const slugs = marketSlugs(all);
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
    const cols = opts.cols === true && typeof v.cols === 'number' ? { cols: v.cols } : {};
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
  const none = { endpoint, overwrite: true, registration: null, plan: [] };
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
  const plan = publishPlan(entries, endpoint, { overwrite, cols }, every);
  const registration = token ? null : registrationOf(anon.endpoint, plan, entries, deps, dir);
  return { code: null, endpoint, overwrite, cols, registration, plan };
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
  for (const item of items) {
    const cur = readEntry(item.id, dir)?.entry;
    const e = cur && normalizeEntry(cur);
    const again =
      e && publishPlan([e], endpoint, { overwrite: review.overwrite, cols: review.cols === true }, every)[0];
    if (!e || !again || canonicalJson(again) !== canonicalJson(item)) {
      results.push(notSent(item));
      continue;
    }
    const remote = item.remoteId ? e.share.remote : null;
    let res: PublishResult;
    try {
      const got = await sendItem(client, item, remote);
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
      };
      const r = record(item.id, item.rev, ref ? published(ref) : withdrawn, dir, now());
      res = {
        id: item.id,
        ok: r.saved,
        code: r.code,
        remoteId: sent?.id ?? item.remoteId,
        version: sent?.version ?? null,
        ...(sent?.pending ? { pending: true as const } : {}),
      };
    } catch (err) {
      let code = codeOf(err);
      // our own id is gone: rejected (404), or removed or withdrawn elsewhere (410, stays reserved)
      const own = item.action === 'version' || item.action === 'overwrite';
      if (own && code === 'not-found') code = 'rejected';
      const mark = code;
      const apply =
        mark === 'rejected'
          ? (x: CatalogEntry) => markDropped(x, mark)
          : own && mark === 'withdrawn'
            ? (x: CatalogEntry) => markError(markWithdrawn(x), mark)
            : (x: CatalogEntry) => markError(x, mark);
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
  const live = new Set(me.entries.filter((x) => x.state === 'live').map((x) => x.id));
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
    if (live.has(r.id) && record(e.id, e.rev, clearReview, dir, now()).saved) cleared++;
    // no longer waiting and not live: an admin rejected it (WR-04)
    else if (complete && !listed.has(r.id)) {
      if (record(e.id, e.rev, (x) => markDropped(x, 'rejected'), dir, now()).saved) rejected++;
    }
  }
  const waiting = me.entries.filter((x) => x.state === 'pending').length;
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
