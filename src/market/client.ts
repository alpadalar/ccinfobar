import { createHash } from 'node:crypto';
import { APPEARANCE_KEYS, LAYOUT_KEYS, pick } from '../catalog/model.js';
import { normalizeConfig } from '../core/config.js';
import type { EntryContent, EntryKind } from '../core/edit.js';
import { deepSanitize } from '../core/sanitize.js';
import { parseThemeInput } from '../core/themes.js';
import type { Config } from '../core/types.js';
import { CAP_BYTES, errorCode, JobFetchError, type JsonResponse, requestJson } from '../data/jobs/fetch.js';
import { type ImportTarget, importTargets } from '../importers/confirm.js';
import { checkEndpoint } from './endpoint.js';
import {
  adminActionPath,
  adminEntryPath,
  adminPendingPath,
  adminPublisherPath,
  adminReportsPath,
  adminResolvePath,
  authGithubPath,
  canonicalJson,
  contentProblems,
  ERROR_CODES,
  entriesPath,
  entryPath,
  ID_PART_RE,
  indexPath,
  isRemoteId,
  logoutPath,
  MAX_INDEX,
  type MarketEntry,
  type MarketIndex,
  type MarketMeta,
  type MarketReport,
  type MarketReview,
  type MarketVersion,
  type MeResult,
  mePath,
  metaPath,
  type PendingSummary,
  type PublishPayload,
  parseIndex,
  parseMe,
  parseMeta,
  parsePending,
  parseRemoteEntry,
  parseRemoteVersion,
  parseReports,
  parseReview,
  parseSignIn,
  publishersPath,
  RESPONSE_CAPS,
  reportPath,
  type SignInResult,
  type VersionPayload,
  versionPath,
  versionPutPath,
  versionsPath,
  withdrawPath,
} from './protocol.js';

export { checkEndpoint };

const TIMEOUT_MS = 10_000;
const HASH_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,512}$/;
const GITHUB_TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const ETAG_RE = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/;

// fetch codes callers can map; anything else is unknown
const FETCH_CODES: Record<string, string> = {
  timeout: 'timeout',
  network: 'network',
  dns: 'network',
  tls: 'network',
  'too-large': 'too-large',
  'too-many-redirects': 'too-many-redirects',
  redirect: 'redirect',
  'bad-redirect': 'redirect',
  'cross-origin-redirect': 'redirect',
  'bad-json': 'bad-json',
};

const STATUS_CODES: Record<number, string> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  410: 'withdrawn',
  412: 'stale',
  413: 'too-large',
  415: 'unsupported-media',
  429: 'rate-limited',
};

export class MarketError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(code: string, status: number | null = null, retryAfter: number | null = null) {
    super(code);
    this.name = 'MarketError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfter;
  }
}

export function contentHash(content: EntryContent): string {
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export interface Received {
  content: EntryContent;
  targets: ImportTarget[];
  problems: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanPart(part: Partial<Config>, keys: readonly (keyof Config)[]): Partial<Config> {
  return pick(
    normalizeConfig(part),
    keys.filter((k) => Object.hasOwn(part, k)),
  );
}

const widgetCount = (lines: unknown): number =>
  Array.isArray(lines) ? lines.reduce((n: number, l) => n + (Array.isArray(l) ? l.length : 0), 0) : 0;

export function validateReceived(kind: EntryKind, content: unknown): Received | null {
  try {
    if (!isObject(content)) return null;
    const clean = deepSanitize(content) as EntryContent;
    if (contentProblems(kind, clean).length) return null;
    const out: EntryContent = {};
    const problems: string[] = [];
    if (clean.layout) {
      out.layout = cleanPart(clean.layout, LAYOUT_KEYS);
      if (widgetCount(out.layout.lines) < widgetCount(clean.layout.lines)) problems.push('dropped-widgets');
    }
    if (clean.appearance) out.appearance = cleanPart(clean.appearance, APPEARANCE_KEYS);
    if (clean.theme) out.theme = parseThemeInput(clean.theme);
    return { content: out, targets: out.layout ? importTargets(out.layout) : [], problems };
  } catch {
    return null;
  }
}

export interface MarketClientOpts {
  endpoint: string;
  fetch: typeof fetch;
  token?: string | null;
  timeoutMs?: number;
  capBytes?: number;
  now?: number;
}

// fixed codes and status only: messages could echo urls or tokens
function toMarketError(err: unknown): MarketError {
  if (err instanceof MarketError) return err;
  if (err instanceof JobFetchError && err.status !== null) {
    const remote = err.remoteCode;
    const known = remote && (ERROR_CODES as readonly string[]).includes(remote) ? remote : null;
    return new MarketError(known ?? STATUS_CODES[err.status] ?? 'http', err.status, err.retryAfterMs);
  }
  return new MarketError(FETCH_CODES[errorCode(err)] ?? 'unknown');
}

function need<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new MarketError('bad-json');
  return v;
}

function route(build: () => string): string {
  try {
    return build();
  } catch {
    throw new MarketError('invalid');
  }
}

const isVersionNo = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

export interface Written {
  version: number;
  hash: string;
  pending?: true;
}

function written(body: unknown): Written {
  const b = isObject(body) ? body : {};
  if (!isVersionNo(b.version) || typeof b.hash !== 'string' || !HASH_RE.test(b.hash)) {
    throw new MarketError('bad-json');
  }
  return { version: b.version, hash: b.hash, ...(b.pending === true ? { pending: true as const } : {}) };
}

const etagOf = (h: Headers): string | null => {
  const v = h.get('etag');
  return v !== null && ETAG_RE.test(v) ? v : null;
};

// a bad tag means no tag: the read is unconditional
const ifTag = (etag: string | null): { ifNoneMatch?: string } =>
  etag !== null && ETAG_RE.test(etag) ? { ifNoneMatch: etag } : {};

const noteBody = (note?: string): { note: string } | undefined => (note === undefined ? undefined : { note });

export type Changed<K extends string, T> =
  | { changed: false }
  | ({ changed: true; etag: string | null } & {
      [k in K]: T;
    });

interface CallOpts {
  // undefined: writes only; true: required; false: never
  auth?: boolean;
  ifNoneMatch?: string;
  extra?: Record<string, string>;
  cap?: number;
}

export function createMarketClient(opts: MarketClientOpts) {
  const base = checkEndpoint(opts.endpoint);
  if (!base) throw new MarketError('bad-endpoint');
  const endpoint = `${base.origin}${base.pathname.replace(/\/$/, '')}`;
  const token = opts.token ?? null;

  async function send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    p: string,
    body?: unknown,
    o: CallOpts = {},
  ): Promise<JsonResponse> {
    try {
      const headers: Record<string, string> = { ...o.extra };
      const auth = o.auth ?? method !== 'GET';
      if (o.auth === true && token === null) throw new MarketError('unauthorized');
      if (auth && token !== null) {
        if (!TOKEN_RE.test(token)) throw new MarketError('unauthorized');
        headers.authorization = `Bearer ${token}`;
      }
      return await requestJson(new URL(`${endpoint}${p}`), {
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
        capBytes: opts.capBytes ?? o.cap ?? CAP_BYTES,
        headers,
        method,
        body,
        errorBody: true,
        ...(o.ifNoneMatch === undefined ? {} : { ifNoneMatch: o.ifNoneMatch }),
        ...(opts.now === undefined ? {} : { now: opts.now }),
      });
    } catch (err) {
      throw toMarketError(err);
    }
  }

  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    p: string,
    body?: unknown,
    o: CallOpts = {},
  ): Promise<unknown> => (await send(method, p, body, o)).body;

  const page = async (n: number, o: CallOpts = {}) => {
    const res = await send('GET', indexPath(n), undefined, { ...o, cap: RESPONSE_CAPS.index });
    return res.status === 304 ? null : { index: need(parseIndex(res.body, n)), etag: etagOf(res.headers) };
  };

  // follows next pages up to MAX_INDEX entries
  async function walk(first: MarketIndex): Promise<MarketIndex> {
    const seen = new Set<string>();
    const entries: MarketIndex['entries'] = [];
    let cur: MarketIndex | null = first;
    for (let n = 1; cur; n++) {
      for (const e of cur.entries) {
        if (entries.length >= MAX_INDEX || seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push(e);
      }
      cur = cur.next && entries.length < MAX_INDEX ? need(await page(n + 1)).index : null;
    }
    return { entries, generatedAt: first.generatedAt };
  }

  async function entryIfChanged(id: string, etag: string | null): Promise<Changed<'entry', MarketEntry>> {
    const p = route(() => entryPath(id));
    const res = await send('GET', p, undefined, { ...ifTag(etag), cap: RESPONSE_CAPS.document });
    if (res.status === 304) return { changed: false };
    const e = need(parseRemoteEntry(res.body));
    if (e.id !== id) throw new MarketError('bad-json');
    return { changed: true, entry: e, etag: etagOf(res.headers) };
  }

  const act = (id: string, action: 'approve' | 'reject' | 'remove', note?: string, extra = {}) =>
    call(
      'POST',
      route(() => adminActionPath(id, action)),
      noteBody(note),
      { auth: true, extra },
    );

  const ban = async (handle: string, action: 'ban' | 'unban', note?: string): Promise<void> => {
    await call(
      'POST',
      route(() => adminPublisherPath(handle, action)),
      noteBody(note),
      { auth: true },
    );
  };

  return {
    endpoint,
    async meta(): Promise<MarketMeta> {
      return need(parseMeta(await call('GET', metaPath())));
    },
    async index(): Promise<MarketIndex> {
      return walk(need(await page(1)).index);
    },
    // one conditional request; a 304 sends nothing more
    async indexIfChanged(etag: string | null): Promise<Changed<'index', MarketIndex>> {
      const first = await page(1, ifTag(etag));
      if (!first) return { changed: false };
      return { changed: true, index: await walk(first.index), etag: first.etag };
    },
    async entry(id: string): Promise<MarketEntry> {
      const r = await entryIfChanged(id, null);
      if (!r.changed) throw new MarketError('bad-json');
      return r.entry;
    },
    entryIfChanged,
    // expected comes from the entry history, fetched on its own
    async version(
      id: string,
      n: number,
      kind: EntryKind,
      expected: string,
    ): Promise<MarketVersion & Received> {
      const p = route(() => versionPath(id, n));
      const v = need(parseRemoteVersion(await call('GET', p, undefined, { cap: RESPONSE_CAPS.document })));
      if (v.version !== n) throw new MarketError('bad-json');
      // the hash covers the parsed content, as on the server
      if (contentHash(v.content) !== v.hash || v.hash !== expected) throw new MarketError('bad-hash');
      const r = validateReceived(kind, v.content);
      if (!r) throw new MarketError('invalid');
      return { version: v.version, hash: v.hash, ...r };
    },
    async register(handle: string, displayName: string): Promise<{ handle: string; token: string }> {
      const b = await call('POST', publishersPath(), { handle, displayName });
      const o = isObject(b) ? b : {};
      if (typeof o.handle !== 'string' || !ID_PART_RE.test(o.handle)) throw new MarketError('bad-json');
      if (typeof o.token !== 'string' || !TOKEN_RE.test(o.token)) throw new MarketError('bad-json');
      return { handle: o.handle, token: o.token };
    },
    async publish(payload: PublishPayload): Promise<Written & { id: string }> {
      const b = await call('POST', entriesPath(), payload);
      const id = isObject(b) ? b.id : undefined;
      if (typeof id !== 'string' || !isRemoteId(id)) throw new MarketError('bad-json');
      return { id, ...written(b) };
    },
    async addVersion(id: string, latest: number, payload: VersionPayload): Promise<Written> {
      if (!isVersionNo(latest)) throw new MarketError('invalid');
      const p = route(() => versionsPath(id));
      return written(await call('POST', p, payload, { extra: { 'if-match': `"${latest}"` } }));
    },
    async overwrite(id: string, n: number, payload: VersionPayload): Promise<Written> {
      return written(
        await call(
          'PUT',
          route(() => versionPutPath(id, n)),
          payload,
        ),
      );
    },
    async withdraw(id: string): Promise<void> {
      await call(
        'DELETE',
        route(() => withdrawPath(id)),
      );
    },
    // the GitHub token goes out once in the body and is not kept
    async signIn(githubToken: string): Promise<SignInResult> {
      if (typeof githubToken !== 'string' || !GITHUB_TOKEN_RE.test(githubToken)) {
        throw new MarketError('invalid');
      }
      return need(parseSignIn(await call('POST', authGithubPath(), { token: githubToken }, { auth: false })));
    },
    async logout(): Promise<void> {
      await call('POST', logoutPath(), undefined, { auth: true });
    },
    async me(): Promise<MeResult> {
      return need(parseMe(await call('GET', mePath(), undefined, { auth: true })));
    },
    // the server checks the reason
    async report(id: string, reason: string): Promise<{ id: number }> {
      const p = route(() => reportPath(id));
      const b = await call('POST', p, { reason });
      const n = isObject(b) ? b.id : undefined;
      if (!isVersionNo(n)) throw new MarketError('bad-json');
      return { id: n };
    },
    admin: {
      async pending(): Promise<PendingSummary[]> {
        return need(parsePending(await call('GET', adminPendingPath(), undefined, { auth: true }))).entries;
      },
      // approve sends the tag back, pinning what was reviewed
      async review(id: string): Promise<MarketReview & { etag: string | null }> {
        const p = route(() => adminEntryPath(id));
        // the entry document plus its content
        const res = await send('GET', p, undefined, { auth: true, cap: RESPONSE_CAPS.index });
        const r = need(parseReview(res.body));
        if (r.entry.id !== id) throw new MarketError('bad-json');
        return { ...r, etag: etagOf(res.headers) };
      },
      async approve(id: string, etag: string, note?: string): Promise<void> {
        if (typeof etag !== 'string' || !ETAG_RE.test(etag)) throw new MarketError('invalid');
        await act(id, 'approve', note, { 'if-match': etag });
      },
      async reject(id: string, note?: string): Promise<void> {
        await act(id, 'reject', note);
      },
      async remove(id: string, note?: string): Promise<void> {
        await act(id, 'remove', note);
      },
      ban: (handle: string, note?: string) => ban(handle, 'ban', note),
      unban: (handle: string, note?: string) => ban(handle, 'unban', note),
      async reports(): Promise<MarketReport[]> {
        return need(parseReports(await call('GET', adminReportsPath(), undefined, { auth: true }))).reports;
      },
      async resolve(reportId: number): Promise<void> {
        await call(
          'POST',
          route(() => adminResolvePath(reportId)),
          undefined,
          { auth: true },
        );
      },
    },
  };
}

export type MarketClient = ReturnType<typeof createMarketClient>;
