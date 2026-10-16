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
  rateLimit?: { perMinute: number };
  name?: string;
  now?: () => number;
}

const MAX_VERSIONS = 5000;
const TOKEN_RE = /^Bearer ([0-9a-f]{64})$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[1-9][0-9]{0,15}$/;
const IF_MATCH_RE = /^"([1-9][0-9]{0,15})"$/;
const ENTRY_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\.json$/;
const VERSION_FILE_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/([^/]+)\.json$/;
const VERSIONS_RE = /^\/v1\/entries\/([^/]+)\/([^/]+)\/versions$/;

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
  internal: 'internal error',
};

class MarketHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? MESSAGES[code] ?? code);
  }
}

const fail = (status: number, code: string, message?: string) => new MarketHttpError(status, code, message);

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
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MARKET_LIMITS.maxBodyBytes) {
        failed = true;
        reject(fail(413, 'too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
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

  function rebuildIndex(): void {
    const entries: MarketSummary[] = [];
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
        if (e && e.id === `${p}/${s}`) entries.push(toSummary(e));
      }
    }
    writeJson(pub('index.json'), { entries, generatedAt: iso() });
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

  function loadEntry(p: string, s: string): MarketEntry {
    const file = entryFile(p, s);
    if (!fs.existsSync(file)) throw fail(404, 'not-found');
    const e = parseRemoteEntry(readJson(file));
    if (!e || e.id !== `${p}/${s}`) throw fail(500, 'internal');
    return e;
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
    if (!VERSION_RE.test(v[3]!) || !Number.isSafeInteger(Number(v[3]))) {
      throw fail(400, 'invalid', 'invalid version');
    }
    return pub('entries', pp, s, `${Number(v[3])}.json`);
  }

  function register(res: http.ServerResponse, body: unknown): void {
    const b = isObject(body) ? body : {};
    const handle = own(b, 'handle');
    const dn = own(b, 'displayName');
    if (typeof handle !== 'string' || !ID_PART_RE.test(handle)) throw fail(400, 'invalid', 'invalid handle');
    if (dn !== undefined && typeof dn !== 'string') throw fail(400, 'invalid', 'invalid displayName');
    const name = [...sanitizeText(dn ?? '').trim()].slice(0, MARKET_LIMITS.displayName).join('').trim();
    if (fs.existsSync(publisherFile(handle))) throw fail(409, 'conflict');
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
    rebuildIndex();
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
    rebuildIndex();
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
    if (req.method === 'GET') return serveFile(res, readPath(p));
    if (req.method !== 'POST') throw fail(404, 'not-found');
    const versions = VERSIONS_RE.exec(p);
    if (p !== publishersPath() && p !== entriesPath() && !versions) throw fail(404, 'not-found');
    const ids = versions ? [part(versions[1]!), part(versions[2]!)] : null;
    // writes run without an await, so they never interleave
    const body = await readBody(req);
    if (p === publishersPath()) return register(res, body);
    if (p === entriesPath()) return publish(req, res, body);
    return addVersion(req, res, body, ids![0]!, ids![1]!);
  }

  fs.mkdirSync(root, { recursive: true });
  writeJson(pub('meta.json'), meta);
  rebuildIndex();
  loadTokens();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      const e = err instanceof MarketHttpError ? err : fail(500, 'internal');
      if (e.status === 413) res.setHeader('connection', 'close');
      send(res, e.status, { error: { code: e.code, message: e.message } });
    });
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
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(':') ? `[${host}]` : host;
  return { url: `http://${shown}:${port}`, close };
}
