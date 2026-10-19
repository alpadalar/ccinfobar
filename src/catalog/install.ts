// marketplace entries into the user's catalog; applying is a separate step (D-11)

import { takesCols } from '../core/entry-keys.js';
import { type ImportTarget, importTargets } from '../importers/confirm.js';
import { createMarketClient, MarketError, validateReceived } from '../market/client.js';
import { canonicalJson, isRemoteId } from '../market/protocol.js';
import { cachedEntry, cachedVersion } from './market-cache.js';
import { type CatalogEntry, ENTRY_LIMITS, type EntryContent, type EntryKind, latest, slug } from './model.js';
import {
  catalogDir,
  commitEntry,
  endpointKey,
  listEntries,
  marketEndpoint,
  saveEntry,
  withStoreLock,
} from './store.js';

// or a MarketError code
export type InstallCode =
  | 'no-endpoint'
  | 'bad-ref'
  | 'withdrawn'
  | 'not-found'
  | 'bad-content'
  | 'hash-mismatch';

export class InstallError extends Error {
  readonly code: InstallCode | string;
  readonly status: number | null;
  constructor(code: InstallCode | string, status: number | null = null) {
    super(code);
    this.name = 'InstallError';
    this.code = code;
    this.status = status;
  }
}

export interface InstallRef {
  id: string;
  version: number | null;
}

const REF_RE = /^([^@\s]+)(?:@([1-9]\d{0,8}))?$/;

// publisher/slug or publisher/slug@n
export function parseInstallRef(ref: unknown): InstallRef | null {
  const m = typeof ref === 'string' ? REF_RE.exec(ref.trim()) : null;
  if (!m || !isRemoteId(m[1]!)) return null;
  return { id: m[1]!, version: m[2] === undefined ? null : Number(m[2]) };
}

export interface InstallPlan {
  endpoint: string;
  id: string;
  version: number;
  hash: string;
  kind: EntryKind;
  name: string;
  description: string;
  author: string;
  publisher: string;
  content: EntryContent;
  targets: ImportTarget[];
  existing: { entryId: string; same: boolean } | null;
  cols?: number;
}

export interface InstallDeps {
  fetch: typeof fetch;
  env?: NodeJS.ProcessEnv;
  dir?: string;
  defaultEndpoint?: string | null;
  now?: () => Date;
  cacheDir?: string;
}

export interface Installed {
  entryId: string;
  name: string;
  result: 'new' | 'version' | 'same';
}

function rethrow(err: unknown): never {
  if (err instanceof InstallError) throw err;
  if (err instanceof MarketError) {
    if (err.code === 'bad-hash') throw new InstallError('hash-mismatch');
    throw new InstallError(err.code, err.status);
  }
  throw new InstallError('unknown');
}

const dirOf = (deps: Pick<InstallDeps, 'env' | 'dir'>) => deps.dir ?? catalogDir(deps.env ?? process.env);

function existingOf(plan: Pick<InstallPlan, 'endpoint' | 'id' | 'hash'>, dir: string) {
  const key = endpointKey(plan.endpoint);
  const e = listEntries(dir).find(
    (x) => x.origin && x.origin.id === plan.id && endpointKey(x.origin.endpoint) === key,
  );
  return e ? { entry: e, same: e.origin!.hash === plan.hash } : null;
}

// downloads and checks; writes nothing
export async function planInstall(ref: string, deps: InstallDeps): Promise<InstallPlan> {
  const r = parseInstallRef(ref);
  if (!r) throw new InstallError('bad-ref');
  const env = deps.env ?? process.env;
  const dir = dirOf(deps);
  const endpoint = marketEndpoint(env, dir, deps.defaultEndpoint);
  if (!endpoint) throw new InstallError('no-endpoint');
  try {
    const client = createMarketClient({ endpoint, fetch: deps.fetch });
    const cache = { client, env, now: deps.now, cacheDir: deps.cacheDir };
    // one conditional request when the entry is cached
    const { entry } = await cachedEntry(client.endpoint, r.id, cache);
    if (entry.withdrawn) throw new InstallError('withdrawn');
    const n = r.version ?? entry.version;
    const info = entry.versions.find((v) => v.version === n);
    if (!info) throw new InstallError('not-found');
    // the summary and the history must agree on the latest
    if (n === entry.version && info.hash !== entry.hash) throw new InstallError('hash-mismatch');
    const v = await cachedVersion(client.endpoint, r.id, n, info.hash, {
      ...cache,
      kind: entry.kind,
      // meta only on a cache miss
      immutable: async () => !(await client.meta()).capabilities.overwrite,
    });
    const got = validateReceived(entry.kind, v.content);
    if (!got) throw new InstallError('bad-content');
    const plan = {
      endpoint: client.endpoint,
      id: r.id,
      version: n,
      hash: info.hash,
      kind: entry.kind,
      name: entry.name,
      description: entry.description,
      author: entry.author,
      publisher: entry.publisher,
      content: got.content,
      targets: importTargets(got.content.layout ?? {}),
      ...(entry.cols === undefined || !takesCols(entry.kind) ? {} : { cols: entry.cols }),
    };
    const hit = existingOf(plan, dir);
    return { ...plan, existing: hit && { entryId: hit.entry.id, same: hit.same } };
  } catch (err) {
    if (err instanceof MarketError && err.code === 'invalid') throw new InstallError('bad-content');
    rethrow(err);
  }
}

function cutName(name: string, tail: string): string {
  const room = ENTRY_LIMITS.name - [...tail].length;
  return `${[...name].slice(0, room).join('').trim()}${tail}`;
}

// a free name for this kind: Name, Name 2, Name 3 ...
function freeName(name: string, kind: EntryKind, all: CatalogEntry[]): string {
  const taken = new Set(all.filter((e) => e.kind === kind).map((e) => e.slug));
  const base = name.trim() || 'entry';
  let out = cutName(base, '');
  for (let n = 2; taken.has(slug(out) || 'entry'); n++) out = cutName(base, ` ${n}`);
  return out;
}

export function runInstall(plan: InstallPlan, deps: Omit<InstallDeps, 'fetch'> = {}): Installed {
  const dir = dirOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  const origin = {
    endpoint: endpointKey(plan.endpoint) ?? plan.endpoint,
    id: plan.id,
    version: plan.version,
    hash: plan.hash,
    installedAt: now.toISOString(),
  };
  const base = {
    kind: plan.kind,
    description: plan.description,
    content: plan.content,
    note: `installed v${plan.version}`,
    ...(plan.cols === undefined ? {} : { cols: plan.cols }),
    share: false,
    origin,
    now,
  };
  return withStoreLock(dir, () => {
    // the catalog may have changed since the plan
    const hit = existingOf(plan, dir);
    if (hit?.same) {
      // same content, newer width: metadata only (WR-03)
      if (plan.cols !== undefined && latest(hit.entry).cols !== plan.cols) {
        const next = structuredClone(hit.entry);
        latest(next).cols = plan.cols;
        commitEntry(next, hit.entry.rev, dir, now);
      }
      return { entryId: hit.entry.id, name: hit.entry.name, result: 'same' };
    }
    if (hit) {
      const e = saveEntry(
        { ...base, name: hit.entry.name, mode: 'update', id: hit.entry.id, rev: hit.entry.rev },
        dir,
      );
      return { entryId: e.id, name: e.name, result: 'version' };
    }
    const name = freeName(plan.name, plan.kind, listEntries(dir));
    const e = saveEntry({ ...base, name, author: plan.author, mode: 'new' }, dir);
    return { entryId: e.id, name: e.name, result: 'new' };
  });
}

type Reviewed = { hash: string; targets: readonly Pick<ImportTarget, 'kind' | 'target'>[] };

const shownTargets = (r: Reviewed) => r.targets.map((x) => ({ kind: x.kind, target: x.target }));

// the editor installs only what the user reviewed: the hash and the listed targets
export function installChanged(a: Reviewed, b: Reviewed): boolean {
  return a.hash !== b.hash || canonicalJson(shownTargets(a)) !== canonicalJson(shownTargets(b));
}
