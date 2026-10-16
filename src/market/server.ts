import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { sanitizeText } from '../core/sanitize.js';
import { writeAtomic } from '../data/store.js';
import {
  canonicalJson,
  contentProblems,
  entriesPath,
  ID_PART_RE,
  indexPath,
  MARKET_LIMITS,
  type MarketEntry,
  type MarketMeta,
  type MarketSummary,
  type MarketVersion,
  type MarketVersionInfo,
  metaPath,
  PROTOCOL_VERSION,
  parsePublishPayload,
  parseRemoteEntry,
  parseVersionPayload,
  publishersPath,
} from './protocol.js';

export interface MarketServerOpts {
  dataDir: string;
  host?: string;
  port?: number;
  allowOverwrite?: boolean;
  rateLimit?: { perMinute: number; readsPerMinute?: number; registersPerMinute?: number };
  caps?: { publishers?: number; entries?: number; entriesPerPublisher?: number };
  maxConnections?: number;
  name?: string;
  now?: () => number;
}

const MAX_VERSIONS = 5000;
const WINDOW_MS = 60_000;
const MAX_KEYS = 50_000;
const READS_FACTOR = 20;
const DRAIN_LIMIT = 4 * MARKET_LIMITS.maxBodyBytes;
const CAPS = { publishers: 10_000, entries: 5000, entriesPerPublisher: 200 };
const REGISTERS_PER_MINUTE = 5;
const TOKEN_RE = /^Bearer ([0-9a-f]{64})$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[1-9][0-9]{0,15}$/;
const IF_MATCH_RE = /^"([1-9][0-9]{0,15})"$/;
const ENTRY_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\.json$/;
const VERSION_FILE_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/([^/]+)\.json$/;
const VERSIONS_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/versions$/;
const PUT_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/versions\/([^/]+)$/;
const WITHDRAW_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/;

// fixed English, never echoes input
const MESSAGES: Record<string, string> = {
  invalid: 'invalid request',
  'too-large': 'request too large',
  conflict: 'already exists',
  stale: 'not the latest version',
  forbidden: 'not your entry',
  'not-found': 'not found',
  withdrawn: 'entry withdrawn',
  unauthorized: 'missing or unknown token',
  'overwrite-disabled': 'overwrite is disabled on this server',
  'unsupported-media': 'content-type must be application/json',
  'rate-limited': 'too many requests',
  internal: 'internal error',
};

class MarketHttpError extends Error {
  retryAfter: number | null = null;
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? MESSAGES[code] ?? code);
  }
}

const fail = (status: number, code: string, message?: string) => new MarketHttpError(status, code, message);

type StoredVersionInfo = MarketVersionInfo & { overwrittenAt?: string };
type StoredEntry = MarketEntry & { versions: StoredVersionInfo[] };

// fixed one-minute windows; returns retry-after seconds when over
export function fixedWindow(
  perMinute: number,
  now: () => number,
  maxKeys = MAX_KEYS,
): (key: string) => number | null {
  const counts = new Map<string, number>();
  let start = Number.NaN;
  return (key) => {
    const t = now();
    const w = Math.floor(t / WINDOW_MS) * WINDOW_MS;
    if (w !== start) {
      start = w;
      counts.clear();
    }
    const wait = Math.max(1, Math.ceil((w + WINDOW_MS - t) / 1000));
    const n = counts.get(key);
    // full table fails closed
    if (n === undefined && counts.size >= maxKeys) return wait;
    if ((n ?? 0) >= perMinute) return wait;
    counts.set(key, (n ?? 0) + 1);
    return null;
  };
}

function limited(seconds: number): MarketHttpError {
  const e = fail(429, 'rate-limited');
  e.retryAfter = seconds;
  return e;
}

function isJsonType(v: string | undefined): boolean {
  return (v ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function send(res: http.ServerResponse, status: number, body: unknown): void {
  sendText(res, status, JSON.stringify(body), 'no-store');
}

function sendText(res: http.ServerResponse, status: number, text: string, cache: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': cache,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > DRAIN_LIMIT) return reject(fail(413, 'too-large'));
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    // small overflows are drained so the 413 reply arrives
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT) {
        req.destroy();
        reject(fail(413, 'too-large'));
        return;
      }
      if (failed) return;
      if (size > MARKET_LIMITS.maxBodyBytes) {
        failed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return reject(fail(413, 'too-large'));
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(fail(400, 'invalid', 'body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

// decode in try, then the id regex, before any path.join
function part(raw: string): string {
  let v = '';
  try {
    v = decodeURIComponent(raw);
  } catch {}
  if (!ID_PART_RE.test(v)) throw fail(400, 'invalid', 'invalid id');
  return v;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function toSummary(e: MarketEntry): MarketSummary {
  const s: MarketSummary = {
    id: e.id,
    kind: e.kind,
    name: e.name,
    description: e.description,
    author: e.author,
    publisher: e.publisher,
    version: e.version,
    updatedAt: e.updatedAt,
    hash: e.hash,
  };
  if (e.withdrawn) s.withdrawn = true;
  return s;
}

export async function startMarketServer(
  opts: MarketServerOpts,
): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(opts.dataDir);
  const host = opts.host ?? '127.0.0.1';
  const now = opts.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const pub = (...parts: string[]) => path.join(root, 'v1', ...parts);
  const priv = (...parts: string[]) => path.join(root, 'private', ...parts);
  const entryFile = (p: string, s: string) => pub('entries', p, `${s}.json`);
  const ownerFile = (p: string, s: string) => priv('owners', p, `${s}.json`);
  const publisherFile = (h: string) => priv('publishers', `${h}.json`);
  const tokens = new Map<string, string>();

  function writeJson(file: string, data: unknown, secret = false): void {
    writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`, {
      class: 'settings',
      ...(secret ? { mode: 0o600 } : {}),
    });
  }

  const meta: MarketMeta = {
    protocol: PROTOCOL_VERSION,
    name: opts.name ?? 'ccinfobar reference marketplace',
    capabilities: { write: true, overwrite: opts.allowOverwrite ?? true, withdraw: true, submit: 'api' },
    auth: ['token'],
    limits: { ...MARKET_LIMITS },
  };

  const summaries = new Map<string, MarketSummary>();
  const byPublisher = new Map<string, number>();
  const caps = { ...CAPS, ...opts.caps };

  // ids compare as (publisher, slug), like the dir walk
  const order = (a: MarketSummary, b: MarketSummary): number => {
    const [ap, as] = a.id.split('/') as [string, string];
    const [bp, bs] = b.id.split('/') as [string, string];
    if (ap !== bp) return ap < bp ? -1 : 1;
    return as < bs ? -1 : as > bs ? 1 : 0;
  };

  function writeIndex(): void {
    const entries = [...summaries.values()].sort(order);
    writeJson(pub('index.json'), { entries, generatedAt: iso() });
  }

  // only the changed entry is updated, nothing is re-read
  function indexEntry(e: MarketEntry): void {
    if (!summaries.has(e.id)) byPublisher.set(e.publisher, (byPublisher.get(e.publisher) ?? 0) + 1);
    summaries.set(e.id, toSummary(e));
    writeIndex();
  }

  function loadIndex(): void {
    const base = pub('entries');
    let pubs: string[] = [];
    try {
      pubs = fs.readdirSync(base).sort();
    } catch {}
    for (const p of pubs) {
      if (!ID_PART_RE.test(p)) continue;
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(base, p)).sort();
      } catch {
        continue;
      }
      for (const f of files) {
        const s = f.endsWith('.json') ? f.slice(0, -5) : '';
        if (!ID_PART_RE.test(s)) continue;
        const e = parseRemoteEntry(readJson(entryFile(p, s)));
        if (!e || e.id !== `${p}/${s}`) continue;
        summaries.set(e.id, toSummary(e));
        byPublisher.set(p, (byPublisher.get(p) ?? 0) + 1);
      }
    }
    writeIndex();
  }

  function loadTokens(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(priv('publishers'));
    } catch {}
    for (const n of names) {
      const h = n.endsWith('.json') ? n.slice(0, -5) : '';
      if (!ID_PART_RE.test(h)) continue;
      const rec = readJson(publisherFile(h));
      const digest = isObject(rec) ? own(rec, 'tokenSha256') : undefined;
      if (isObject(rec) && own(rec, 'handle') === h && typeof digest === 'string' && DIGEST_RE.test(digest)) {
        tokens.set(digest, h);
      }
    }
  }

  function publisherOf(req: http.IncomingMessage): string {
    const m = TOKEN_RE.exec(req.headers.authorization ?? '');
    const handle = m ? tokens.get(sha256(m[1]!)) : undefined;
    if (!handle) throw fail(401, 'unauthorized');
    return handle;
  }

  function loadEntry(p: string, s: string): StoredEntry {
    const file = entryFile(p, s);
    if (!fs.existsSync(file)) throw fail(404, 'not-found');
    const raw = readJson(file);
    const e = parseRemoteEntry(raw);
    if (!e || e.id !== `${p}/${s}`) throw fail(500, 'internal');
    // parse drops overwrittenAt; keep it from the stored rows
    const rows = isObject(raw) ? own(raw, 'versions') : undefined;
    const versions: StoredVersionInfo[] = e.versions.map((v, i) => {
      const row = Array.isArray(rows) ? rows[i] : undefined;
      const at = isObject(row) ? own(row, 'overwrittenAt') : undefined;
      return typeof at === 'string' && STAMP_RE.test(at) ? { ...v, overwrittenAt: at } : v;
    });
    return { ...e, versions };
  }

  function checkOwner(handle: string, p: string, s: string): void {
    const rec = readJson(ownerFile(p, s));
    if (handle !== p || !isObject(rec) || own(rec, 'publisher') !== handle) throw fail(403, 'forbidden');
  }

  function checkContent(kind: MarketEntry['kind'], content: unknown): void {
    const problem = contentProblems(kind, content)[0];
    if (problem) throw fail(400, 'invalid', problem);
  }

  // history rows are never rewritten here
  function writeVersion(p: string, s: string, v: MarketVersion): void {
    writeJson(pub('entries', p, s, `${v.version}.json`), v);
  }

  function overwrite(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
    p: string,
    s: string,
    n: number,
  ): void {
    const handle = publisherOf(req);
    if (!meta.capabilities.overwrite) throw fail(403, 'overwrite-disabled');
    const entry = loadEntry(p, s);
    checkOwner(handle, p, s);
    if (entry.withdrawn) throw fail(410, 'withdrawn');
    if (n !== entry.version) throw fail(409, 'conflict', 'only the latest version can be overwritten');
    const payload = parseVersionPayload(body);
    if (!payload) throw fail(400, 'invalid');
    checkContent(entry.kind, payload.content);
    const at = iso();
    const hash = sha256(canonicalJson(payload.content));
    writeJson(pub('entries', p, s, `${n}.json`), { version: n, content: payload.content, hash });
    const last = entry.versions.at(-1)!;
    const next: StoredEntry = {
      ...entry,
      name: payload.name ?? entry.name,
      description: payload.description ?? entry.description,
      updatedAt: at,
      hash,
      versions: [...entry.versions.slice(0, -1), { ...last, note: payload.note, hash, overwrittenAt: at }],
    };
    writeJson(entryFile(p, s), next);
    indexEntry(next);
    send(res, 200, { id: entry.id, version: n, hash });
  }

  function withdraw(req: http.IncomingMessage, res: http.ServerResponse, p: string, s: string): void {
    const handle = publisherOf(req);
    const entry = loadEntry(p, s);
    checkOwner(handle, p, s);
    if (!entry.withdrawn) {
      // tombstone first, so a failed delete still answers 410
      const tomb = { ...entry, withdrawn: true, withdrawnAt: iso() };
      writeJson(entryFile(p, s), tomb);
      indexEntry(tomb);
    }
    for (const v of entry.versions) {
      try {
        fs.rmSync(pub('entries', p, s, `${v.version}.json`), { force: true, maxRetries: 3 });
      } catch {}
    }
    try {
      fs.rmdirSync(pub('entries', p, s));
    } catch {}
    send(res, 200, { id: entry.id, withdrawn: true });
  }

  function serveFile(res: http.ServerResponse, file: string): void {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw fail(404, 'not-found');
    }
    sendText(res, 200, text, 'no-cache');
  }

  // request path to a file under v1/, ids checked first
  function readPath(p: string): string {
    if (p === metaPath()) return pub('meta.json');
    if (p === indexPath()) return pub('index.json');
    const e = ENTRY_RE.exec(p);
    if (e) return entryFile(part(e[1]!), part(e[2]!));
    const v = VERSION_FILE_RE.exec(p);
    if (!v) throw fail(404, 'not-found');
    const [pp, s] = [part(v[1]!), part(v[2]!)];
    const n = versionNo(v[3]!);
    if (parseRemoteEntry(readJson(entryFile(pp, s)))?.withdrawn) throw fail(410, 'withdrawn');
    return pub('entries', pp, s, `${n}.json`);
  }

  function versionNo(raw: string): number {
    if (!VERSION_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw fail(400, 'invalid', 'invalid version');
    }
    return Number(raw);
  }

  function register(res: http.ServerResponse, body: unknown): void {
    const b = isObject(body) ? body : {};
    const handle = own(b, 'handle');
    const dn = own(b, 'displayName');
    if (typeof handle !== 'string' || !ID_PART_RE.test(handle)) throw fail(400, 'invalid', 'invalid handle');
    if (dn !== undefined && typeof dn !== 'string') throw fail(400, 'invalid', 'invalid displayName');
    const name = [...sanitizeText(dn ?? '').trim()].slice(0, MARKET_LIMITS.displayName).join('').trim();
    if (fs.existsSync(publisherFile(handle))) throw fail(409, 'conflict');
    if (tokens.size >= caps.publishers) throw fail(413, 'too-large', 'too many publishers');
    const token = randomBytes(32).toString('hex');
    const tokenSha256 = sha256(token);
    writeJson(
      publisherFile(handle),
      { handle, displayName: name || handle, tokenSha256, createdAt: iso() },
      true,
    );
    tokens.set(tokenSha256, handle);
    send(res, 201, { handle, token });
  }

  function publish(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
    const handle = publisherOf(req);
    const payload = parsePublishPayload(body);
    if (!payload) throw fail(400, 'invalid');
    checkContent(payload.kind, payload.content);
    const s = payload.slug;
    if (fs.existsSync(entryFile(handle, s))) throw fail(409, 'conflict');
    if (summaries.size >= caps.entries) throw fail(413, 'too-large', 'too many entries');
    if ((byPublisher.get(handle) ?? 0) >= caps.entriesPerPublisher) {
      throw fail(413, 'too-large', 'too many entries for this publisher');
    }
    const id = `${handle}/${s}`;
    const at = iso();
    const hash = sha256(canonicalJson(payload.content));
    writeVersion(handle, s, { version: 1, content: payload.content, hash });
    writeJson(ownerFile(handle, s), { id, publisher: handle, createdAt: at }, true);
    const entry: MarketEntry = {
      id,
      kind: payload.kind,
      name: payload.name,
      description: payload.description,
      author: payload.author,
      publisher: handle,
      version: 1,
      updatedAt: at,
      hash,
      versions: [{ version: 1, at, note: payload.note, hash }],
    };
    writeJson(entryFile(handle, s), entry);
    indexEntry(entry);
    send(res, 201, { id, version: 1, hash });
  }

  function addVersion(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
    p: string,
    s: string,
  ): void {
    const handle = publisherOf(req);
    const entry = loadEntry(p, s);
    checkOwner(handle, p, s);
    if (entry.withdrawn) throw fail(410, 'withdrawn');
    const m = IF_MATCH_RE.exec(String(req.headers['if-match'] ?? ''));
    if (!m || Number(m[1]) !== entry.version) throw fail(412, 'stale');
    const payload = parseVersionPayload(body);
    if (!payload) throw fail(400, 'invalid');
    checkContent(entry.kind, payload.content);
    if (entry.versions.length >= MAX_VERSIONS) throw fail(413, 'too-large', 'too many versions');
    const version = entry.version + 1;
    const at = iso();
    const hash = sha256(canonicalJson(payload.content));
    writeVersion(p, s, { version, content: payload.content, hash });
    const next: MarketEntry = {
      ...entry,
      name: payload.name ?? entry.name,
      description: payload.description ?? entry.description,
      version,
      updatedAt: at,
      hash,
      versions: [...entry.versions, { version, at, note: payload.note, hash }],
    };
    writeJson(entryFile(p, s), next);
    indexEntry(next);
    send(res, 201, { id: entry.id, version, hash });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      throw fail(400, 'invalid');
    }
    const p = url.pathname;
    const ip = req.socket.remoteAddress ?? '';
    if (req.method === 'GET') {
      const wait = reads(`ip:${ip}`);
      if (wait !== null) throw limited(wait);
      return serveFile(res, readPath(p));
    }
    const m = TOKEN_RE.exec(req.headers.authorization ?? '');
    const wait = writes(`ip:${ip}`) ?? (m ? writes(`token:${sha256(m[1]!)}`) : null);
    if (wait !== null) throw limited(wait);
    if (req.method === 'POST' && p === publishersPath()) {
      const r = registers(`ip:${ip}`);
      if (r !== null) throw limited(r);
    }
    if (req.method === 'DELETE') {
      const w = WITHDRAW_RE.exec(p);
      if (!w) throw fail(404, 'not-found');
      return withdraw(req, res, part(w[1]!), part(w[2]!));
    }
    let route: (body: unknown) => void;
    const versions = VERSIONS_RE.exec(p);
    const put = PUT_RE.exec(p);
    if (req.method === 'POST' && p === publishersPath()) route = (b) => register(res, b);
    else if (req.method === 'POST' && p === entriesPath()) route = (b) => publish(req, res, b);
    else if (req.method === 'POST' && versions) {
      const [pp, s] = [part(versions[1]!), part(versions[2]!)];
      route = (b) => addVersion(req, res, b, pp, s);
    } else if (req.method === 'PUT' && put) {
      const [pp, s, n] = [part(put[1]!), part(put[2]!), versionNo(put[3]!)];
      route = (b) => overwrite(req, res, b, pp, s, n);
    } else throw fail(404, 'not-found');
    if (!isJsonType(req.headers['content-type'])) throw fail(415, 'unsupported-media');
    // writes run without an await, so they never interleave
    const body = await readBody(req);
    return route(body);
  }

  const perMinute = opts.rateLimit?.perMinute ?? 30;
  const writes = fixedWindow(perMinute, now);
  const reads = fixedWindow(opts.rateLimit?.readsPerMinute ?? perMinute * READS_FACTOR, now);
  const registers = fixedWindow(
    opts.rateLimit?.registersPerMinute ?? Math.min(perMinute, REGISTERS_PER_MINUTE),
    now,
  );

  fs.mkdirSync(root, { recursive: true });
  writeJson(pub('meta.json'), meta);
  loadIndex();
  loadTokens();

  function answer(res: http.ServerResponse, err: unknown): void {
    try {
      if (res.headersSent) return void res.end();
      const e = err instanceof MarketHttpError ? err : fail(500, 'internal');
      if (e.status === 413) res.setHeader('connection', 'close');
      if (e.retryAfter !== null) res.setHeader('retry-after', String(e.retryAfter));
      send(res, e.status, { error: { code: e.code, message: e.message } });
    } catch {
      res.destroy();
    }
  }

  // slow or idle sockets cannot hold the server open
  const server = http.createServer(
    { requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5000 },
    (req, res) => {
      req.on('error', () => {});
      res.on('error', () => {});
      handle(req, res).catch((err: unknown) => answer(res, err));
    },
  );
  server.maxConnections = opts.maxConnections ?? 256;
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else socket.destroy();
  });

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
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
      server.on('error', () => {});
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(':') ? `[${host}]` : host;
  return { url: `http://${shown}:${port}`, close };
}
