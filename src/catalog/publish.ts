import { createHash } from 'node:crypto';
import { createMarketClient, type MarketClient, type Received } from '../market/client.js';
import {
  canonicalJson,
  isRemoteId,
  type MarketEntry,
  type MarketSummary,
  type MarketVersion,
  type PublishPayload,
  type VersionPayload,
} from '../market/protocol.js';
import {
  type CatalogEntry,
  type EntryKind,
  latest,
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
  listEntries,
  marketEndpoint,
  readCredential,
  readEntry,
  readProfile,
  writeCredential,
  writeProfile,
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
}

export interface PublishDeps {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
  displayName?: string;
}

function endpointKey(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function publishPlan(
  entries: CatalogEntry[],
  endpoint: string,
  opts: { overwrite: boolean } = { overwrite: true },
): PublishItem[] {
  const key = endpointKey(endpoint);
  const out: PublishItem[] = [];
  for (const e of entries) {
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
    if (!remote) {
      out.push({
        ...base,
        action: 'publish',
        payload: {
          kind: e.kind,
          slug: marketSlug(e.name),
          name: e.name,
          description: e.description,
          author: e.author,
          content,
          note: v.note,
        },
      });
      continue;
    }
    const overwrite = opts.overwrite && v.version === remote.version && entryHash(content) !== remote.hash;
    out.push({
      ...base,
      action: overwrite ? 'overwrite' : 'version',
      payload: { content, note: v.note, name: e.name, description: e.description },
    });
  }
  return out;
}

// what was shown is what is sent
export function planHash(endpoint: string, plan: PublishItem[]): string {
  return createHash('sha256').update(canonicalJson({ endpoint, plan })).digest('hex');
}

function codeOf(err: unknown): string {
  if (err instanceof CatalogStoreError) return err.code;
  const e = err as { name?: unknown; code?: unknown } | null;
  return e && e.name === 'MarketError' && typeof e.code === 'string' ? e.code : 'unknown';
}

function envOf(deps: PublishDeps) {
  const env = deps.env ?? process.env;
  return { env, dir: deps.dir ?? catalogDir(env) };
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

async function sendItem(
  client: MarketClient,
  item: PublishItem,
  remote: RemoteRef | null,
): Promise<{ id: string; version: number; hash: string } | null> {
  if (item.action === 'publish') return client.publish(item.payload as PublishPayload);
  const id = remote!.id;
  if (item.action === 'withdraw') {
    try {
      await client.withdraw(id);
    } catch (err) {
      // already gone counts as withdrawn
      const c = codeOf(err);
      if (c !== 'not-found' && c !== 'withdrawn') throw err;
    }
    return null;
  }
  const payload = item.payload as VersionPayload;
  if (item.action === 'overwrite') {
    try {
      return { id, ...(await client.overwrite(id, remote!.version, payload)) };
    } catch (err) {
      if (codeOf(err) !== 'overwrite-disabled') throw err;
    }
  }
  return { id, ...(await client.addVersion(id, remote!.version, payload)) };
}

export async function runPublish(
  ids: string[] | null,
  deps: PublishDeps = {},
): Promise<{ code: string | null; submitUrl?: string; results: PublishResult[] }> {
  const { env, dir } = envOf(deps);
  const endpoint = marketEndpoint(env, dir);
  if (!endpoint) return { code: 'no-endpoint', results: [] };
  const entries = listEntries(dir).filter((e) => ids === null || ids.includes(e.id));
  if (!publishPlan(entries, endpoint).length) return { code: null, results: [] };
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  let anon: MarketClient;
  try {
    anon = createMarketClient({ endpoint, fetch: fetchFn });
  } catch {
    return { code: 'bad-endpoint', results: [] };
  }
  let overwrite: boolean;
  try {
    const meta = await anon.meta();
    if (!meta.capabilities.write) {
      return { code: 'read-only', ...(meta.submitUrl ? { submitUrl: meta.submitUrl } : {}), results: [] };
    }
    overwrite = meta.capabilities.overwrite;
  } catch (err) {
    return { code: codeOf(err), results: [] };
  }
  const items = publishPlan(entries, endpoint, { overwrite });
  const origin = new URL(anon.endpoint).origin;
  let token = readCredential(origin, dir);
  if (!token) {
    const profile = readProfile(dir);
    const author = profile.author || entries.find((e) => e.id === items[0]?.id)?.author || '';
    try {
      const reg = await anon.register(
        marketSlug(profile.publisher ?? (author || 'publisher')),
        deps.displayName ?? author,
      );
      writeCredential(origin, reg.token, dir);
      writeProfile({ publisher: reg.handle }, dir);
      token = reg.token;
    } catch (err) {
      const c = codeOf(err);
      return { code: c === 'conflict' ? 'handle-taken' : c, results: [] };
    }
  }
  const client = createMarketClient({ endpoint, fetch: fetchFn, token });
  const results: PublishResult[] = [];
  for (const item of items) {
    const e = entries.find((x) => x.id === item.id)!;
    const remote = item.remoteId ? e.share.remote : null;
    let res: PublishResult;
    try {
      const sent = await sendItem(client, item, remote);
      const ref: RemoteRef | null = sent && {
        endpoint: client.endpoint,
        id: sent.id,
        version: sent.version,
        hash: sent.hash,
        publishedAt: now().toISOString(),
      };
      const r = record(item.id, item.rev, ref ? published(ref) : withdrawn, dir, now());
      res = {
        id: item.id,
        ok: r.saved,
        code: r.code,
        remoteId: sent?.id ?? item.remoteId,
        version: sent?.version ?? null,
      };
    } catch (err) {
      const code = codeOf(err);
      record(item.id, item.rev, (x) => markError(x, code), dir, now());
      res = { id: item.id, ok: false, code, remoteId: item.remoteId, version: null };
    }
    results.push(res);
  }
  return { code: null, results };
}

async function reader(deps: PublishDeps): Promise<{ client: MarketClient | null; code: string | null }> {
  const { env, dir } = envOf(deps);
  const endpoint = marketEndpoint(env, dir);
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

export async function remoteList(
  deps: PublishDeps = {},
): Promise<{ code: string | null; entries: MarketSummary[] }> {
  const { client, code } = await reader(deps);
  if (!client) return { code, entries: [] };
  try {
    return { code: null, entries: (await client.index()).entries.filter((e) => !e.withdrawn) };
  } catch (err) {
    return { code: codeOf(err), entries: [] };
  }
}

export async function remoteShow(
  id: string,
  deps: PublishDeps = {},
): Promise<{ code: string | null; entry: MarketEntry | null; latest: (MarketVersion & Received) | null }> {
  const { client, code } = await reader(deps);
  if (!client) return { code, entry: null, latest: null };
  if (!isRemoteId(id)) return { code: 'invalid', entry: null, latest: null };
  let entry: MarketEntry;
  try {
    entry = await client.entry(id);
  } catch (err) {
    return { code: codeOf(err), entry: null, latest: null };
  }
  if (entry.withdrawn) return { code: null, entry, latest: null };
  try {
    return { code: null, entry, latest: await client.version(id, entry.version, entry.kind) };
  } catch (err) {
    return { code: codeOf(err), entry, latest: null };
  }
}
