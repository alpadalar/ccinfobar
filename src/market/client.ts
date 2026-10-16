import { createHash } from 'node:crypto';
import { APPEARANCE_KEYS, LAYOUT_KEYS, pick } from '../catalog/model.js';
import { normalizeConfig } from '../core/config.js';
import type { EntryContent, EntryKind } from '../core/edit.js';
import { deepSanitize } from '../core/sanitize.js';
import { parseThemeInput } from '../core/themes.js';
import type { Config } from '../core/types.js';
import { CAP_BYTES, errorCode, JobFetchError, requestJson } from '../data/jobs/fetch.js';
import { type ImportTarget, importTargets } from '../importers/confirm.js';
import { checkEndpoint } from './endpoint.js';
import {
  canonicalJson,
  contentProblems,
  ERROR_CODES,
  entriesPath,
  entryPath,
  ID_PART_RE,
  indexPath,
  isRemoteId,
  type MarketEntry,
  type MarketIndex,
  type MarketMeta,
  type MarketVersion,
  metaPath,
  type PublishPayload,
  parseIndex,
  parseMeta,
  parseRemoteEntry,
  parseRemoteVersion,
  publishersPath,
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

function written(body: unknown): { version: number; hash: string } {
  const b = isObject(body) ? body : {};
  if (!isVersionNo(b.version) || typeof b.hash !== 'string' || !HASH_RE.test(b.hash)) {
    throw new MarketError('bad-json');
  }
  return { version: b.version, hash: b.hash };
}

export function createMarketClient(opts: MarketClientOpts) {
  const base = checkEndpoint(opts.endpoint);
  if (!base) throw new MarketError('bad-endpoint');
  const endpoint = `${base.origin}${base.pathname.replace(/\/$/, '')}`;
  const token = opts.token ?? null;

  async function call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    p: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<unknown> {
    try {
      const headers: Record<string, string> = { ...extra };
      if (token !== null && method !== 'GET') {
        if (!TOKEN_RE.test(token)) throw new MarketError('unauthorized');
        headers.authorization = `Bearer ${token}`;
      }
      const res = await requestJson(new URL(`${endpoint}${p}`), {
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
        capBytes: opts.capBytes ?? CAP_BYTES,
        headers,
        method,
        body,
        errorBody: true,
        ...(opts.now === undefined ? {} : { now: opts.now }),
      });
      return res.body;
    } catch (err) {
      throw toMarketError(err);
    }
  }

  return {
    endpoint,
    async meta(): Promise<MarketMeta> {
      return need(parseMeta(await call('GET', metaPath())));
    },
    async index(): Promise<MarketIndex> {
      return need(parseIndex(await call('GET', indexPath())));
    },
    async entry(id: string): Promise<MarketEntry> {
      const p = route(() => entryPath(id));
      const e = need(parseRemoteEntry(await call('GET', p)));
      if (e.id !== id) throw new MarketError('bad-json');
      return e;
    },
    async version(id: string, n: number, kind: EntryKind): Promise<MarketVersion & Received> {
      const p = route(() => versionPath(id, n));
      const v = need(parseRemoteVersion(await call('GET', p)));
      if (v.version !== n) throw new MarketError('bad-json');
      // the hash covers the parsed content, as on the server
      if (contentHash(v.content) !== v.hash) throw new MarketError('bad-hash');
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
    async publish(payload: PublishPayload): Promise<{ id: string; version: number; hash: string }> {
      const b = await call('POST', entriesPath(), payload);
      const id = isObject(b) ? b.id : undefined;
      if (typeof id !== 'string' || !isRemoteId(id)) throw new MarketError('bad-json');
      return { id, ...written(b) };
    },
    async addVersion(id: string, latest: number, payload: VersionPayload) {
      if (!isVersionNo(latest)) throw new MarketError('invalid');
      const p = route(() => versionsPath(id));
      return written(await call('POST', p, payload, { 'if-match': `"${latest}"` }));
    },
    async overwrite(id: string, n: number, payload: VersionPayload) {
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
  };
}

export type MarketClient = ReturnType<typeof createMarketClient>;
