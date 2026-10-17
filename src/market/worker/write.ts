import {
  canonicalJson,
  contentProblems,
  MARKET_LIMITS,
  type MarketEntry,
  parsePublishPayload,
  parseVersionPayload,
} from '../protocol.js';
import { CAPS, fail, fits, IF_MATCH_RE, MAX_VERSIONS, type StoredEntry } from '../rules.js';
import { type D1Database, type Env, intVar, type WorkerDeps } from './env.js';
import { json, readJsonBody } from './http.js';
import {
  publishCounts,
  publishStatements,
  readEntryRow,
  rebuildIndex,
  versionStatements,
  versionText,
  writeConflict,
} from './store.js';
import { authPublisher, type Publisher, sha256Hex } from './tokens.js';

const utf8 = (s: string): number => new TextEncoder().encode(s).length;

const iso = (deps: WorkerDeps): string => new Date(deps.now()).toISOString();

async function writer(db: D1Database, req: Request): Promise<Publisher> {
  const who = await authPublisher(db, req);
  if (!who) throw fail(401, 'unauthorized');
  if (who.banned) throw fail(403, 'banned');
  return who;
}

// canonical text once, for the policy and the hash
async function checkedHash(env: Env, kind: MarketEntry['kind'], content: unknown): Promise<string> {
  const canonical = canonicalJson(content);
  const problem = contentProblems(kind, content, canonical)[0];
  if (problem) throw fail(400, 'invalid', problem);
  const max = intVar(env.MAX_ENTRY_BYTES);
  if (max !== null && max < MARKET_LIMITS.maxEntryBytes && utf8(canonical) > max) {
    throw fail(400, 'invalid', 'too-large');
  }
  return sha256Hex(canonical);
}

function quota(c: { live: number; mine: number }, caps: typeof CAPS): void {
  if (c.live >= caps.entries) throw fail(413, 'over-quota', 'too many entries');
  if (c.mine >= caps.entriesPerPublisher)
    throw fail(413, 'over-quota', 'too many entries for this publisher');
}

export async function publish(db: D1Database, env: Env, deps: WorkerDeps, req: Request): Promise<Response> {
  const raw = await readJsonBody(req, MARKET_LIMITS.maxBodyBytes);
  const who = await writer(db, req);
  const payload = parsePublishPayload(raw);
  if (!payload) throw fail(400, 'invalid');
  const hash = await checkedHash(env, payload.kind, payload.content);
  const caps = { ...CAPS, ...deps.caps };
  const s = payload.slug;
  const count = await publishCounts(db, who.handle, s);
  if (count.taken) throw fail(409, 'conflict');
  quota(count, caps);
  const id = `${who.handle}/${s}`;
  const at = iso(deps);
  const entry: MarketEntry = {
    id,
    kind: payload.kind,
    name: payload.name,
    description: payload.description,
    author: payload.author,
    publisher: who.handle,
    version: 1,
    updatedAt: at,
    hash,
    versions: [{ version: 1, at, note: payload.note, hash }],
  };
  const body = versionText({ version: 1, content: payload.content, hash });
  try {
    await db.batch(publishStatements(db, { entry, state: 'live', body, bytes: utf8(body), caps }));
  } catch (err) {
    const c = writeConflict(err);
    if (c === 'entry') throw fail(409, 'conflict');
    if (c !== 'guard') throw err;
    quota(await publishCounts(db, who.handle, s), caps);
    throw fail(413, 'over-quota', 'too many entries');
  }
  await rebuildIndex(db, at);
  return json(201, { id, version: 1, hash });
}

export async function addVersion(
  db: D1Database,
  env: Env,
  deps: WorkerDeps,
  req: Request,
  p: string,
  s: string,
): Promise<Response> {
  const raw = await readJsonBody(req, MARKET_LIMITS.maxBodyBytes);
  const who = await writer(db, req);
  const row = await readEntryRow(db, p, s);
  if (!row) throw fail(404, 'not-found');
  if (who.handle !== p) throw fail(403, 'forbidden');
  if (row.state === 'withdrawn' || row.state === 'removed') throw fail(410, 'withdrawn');
  const m = IF_MATCH_RE.exec(req.headers.get('if-match') ?? '');
  if (!m || Number(m[1]) !== row.version) throw fail(412, 'stale');
  const payload = parseVersionPayload(raw);
  if (!payload) throw fail(400, 'invalid');
  const entry = row.entry;
  const hash = await checkedHash(env, entry.kind, payload.content);
  if (entry.versions.length >= (deps.caps?.versions ?? MAX_VERSIONS)) {
    throw fail(413, 'over-quota', 'too many versions');
  }
  const version = row.version + 1;
  const at = iso(deps);
  const next: StoredEntry = {
    ...entry,
    name: payload.name ?? entry.name,
    description: payload.description ?? entry.description,
    version,
    updatedAt: at,
    hash,
    versions: [...entry.versions, { version, at, note: payload.note, hash }],
  };
  fits(next);
  const body = versionText({ version, content: payload.content, hash });
  try {
    await db.batch(versionStatements(db, { entry: next, expected: row.version, body, bytes: utf8(body) }));
  } catch (err) {
    const c = writeConflict(err);
    if (c === 'version' || c === 'guard') throw fail(412, 'stale');
    throw err;
  }
  await rebuildIndex(db, at);
  return json(201, { id: entry.id, version, hash });
}
