import {
  canonicalJson,
  contentLinks,
  contentProblems,
  MARKET_LIMITS,
  type MarketEntry,
  parsePublishPayload,
  parseVersionPayload,
} from '../protocol.js';
import { CAPS, fail, fits, IF_MATCH_RE, MAX_VERSIONS, type StoredEntry, tombOf } from '../rules.js';
import {
  type D1Database,
  type Env,
  intVar,
  maxDbBytes,
  overwriteOn,
  pendingCaps,
  publisherBytes,
  type WorkerDeps,
} from './env.js';
import { json, readJsonBody } from './http.js';
import { buckets, check } from './rate.js';
import { settleIndex } from './settle.js';
import {
  type Counts,
  dropPendingStatements,
  type EntryState,
  entryDocText,
  entrySummaryText,
  heldStatements,
  needsReview,
  noteSize,
  overwriteStatements,
  type PublishCaps,
  publishCounts,
  publishStatements,
  type Room,
  readEntryRow,
  readVersionBody,
  requireWriter,
  storageUse,
  versionStatements,
  versionText,
  withdrawStatements,
  writeConflict,
} from './store.js';
import { authPublisher, type Publisher, sha256Hex } from './tokens.js';

const utf8 = (s: string): number => new TextEncoder().encode(s).length;

const iso = (deps: WorkerDeps): string => new Date(deps.now()).toISOString();

const gone = (state: EntryState): boolean => state === 'withdrawn' || state === 'removed';

const LATEST_ONLY = 'only the latest version can be overwritten';
const REVIEW_FIRST = 'new content waits until an admin approves your next entry';
const HELD_WAIT = 'a version is waiting for review';
const NEW_LINK = 'a new link needs review: publish it as a new version';

// links the new content has that the live version did not
async function addedLinks(db: D1Database, p: string, s: string, version: number, content: unknown) {
  let before: string[] = [];
  try {
    const body = await readVersionBody(db, p, s, version);
    if (body !== null) before = contentLinks((JSON.parse(body) as { content?: unknown }).content);
  } catch {}
  return contentLinks(content).filter((l) => !before.includes(l));
}

// each publisher has its own write window too
async function writer(db: D1Database, env: Env, deps: WorkerDeps, req: Request): Promise<Publisher> {
  const who = await authPublisher(db, req);
  if (!who) throw fail(401, 'unauthorized');
  if (who.banned) throw fail(403, 'banned');
  await check(db, `t:${who.handle}`, buckets(env).write, deps.now());
  return who;
}

// after a failed gate: the token or the ban changed meanwhile
async function stillWriter(db: D1Database, req: Request): Promise<void> {
  const who = await authPublisher(db, req);
  if (!who) throw fail(401, 'unauthorized');
  if (who.banned) throw fail(403, 'banned');
}

const MINE_FULL = 'publisher storage limit reached';
const REVIEW_FULL = 'publisher review storage limit reached';

const roomOf = (env: Env): Room => ({
  live: publisherBytes(env),
  pending: pendingCaps(env).bytes,
  db: maxDbBytes(env),
});

// the shared Free database and each publisher stay under their caps (R-01); pending content apart (WR-02)
async function room(db: D1Database, env: Env, handle: string, bytes: number, pending: boolean) {
  const use = await storageUse(db, handle);
  if (use.total >= maxDbBytes(env)) throw fail(413, 'over-quota', 'marketplace storage is full');
  const r = roomOf(env);
  if (pending && use.pending + bytes > r.pending) throw fail(413, 'over-quota', REVIEW_FULL);
  if (!pending && use.mine + bytes > r.live) throw fail(413, 'over-quota', MINE_FULL);
}

// the batch found the cap passed: a racing write took the room
async function roomGone(db: D1Database, env: Env, handle: string, bytes: number, pending: boolean) {
  await room(db, env, handle, bytes, pending);
  return fail(413, 'over-quota', pending ? REVIEW_FULL : MINE_FULL);
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

export const capsOf = (env: Env, deps: WorkerDeps): PublishCaps => {
  const p = pendingCaps(env);
  return { ...CAPS, pending: p.total, pendingPerPublisher: p.perPublisher, ...deps.caps };
};

// withdrawn slugs stay reserved and count against the tombstone caps; pending entries have their own
function quota(c: Counts, caps: PublishCaps): void {
  if (c.trusted && c.live >= caps.entries) throw fail(413, 'over-quota', 'too many entries');
  if (c.trusted && c.mine >= caps.entriesPerPublisher)
    throw fail(413, 'over-quota', 'too many entries for this publisher');
  if (!c.trusted && c.pending >= caps.pending) {
    throw fail(413, 'over-quota', 'too many entries waiting for review');
  }
  if (!c.trusted && c.myPending >= caps.pendingPerPublisher) {
    throw fail(413, 'over-quota', 'too many entries waiting for review for this publisher');
  }
  if (c.tombs >= caps.tombstones) throw fail(413, 'over-quota', 'too many withdrawn entries');
  if (c.myTombs >= caps.tombstonesPerPublisher) {
    throw fail(413, 'over-quota', 'too many withdrawn entries for this publisher');
  }
}

export async function publish(db: D1Database, env: Env, deps: WorkerDeps, req: Request): Promise<Response> {
  const raw = await readJsonBody(req, MARKET_LIMITS.maxBodyBytes);
  const who = await writer(db, env, deps, req);
  const payload = parsePublishPayload(raw);
  if (!payload) throw fail(400, 'invalid');
  const hash = await checkedHash(env, payload.kind, payload.content);
  const caps = capsOf(env, deps);
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
  if (payload.cols !== undefined) entry.cols = payload.cols;
  const body = versionText({ version: 1, content: payload.content, hash });
  const bytes = utf8(body);
  await room(db, env, who.handle, bytes, !count.trusted);
  let state: unknown;
  try {
    const done = await db.batch([
      requireWriter(db, who.digest, who.handle),
      ...publishStatements(db, { entry, body, caps, room: roomOf(env) }),
    ]);
    // a new publisher waits for review (D-09)
    state = (done[1]?.results[0] as { state?: unknown } | undefined)?.state;
    await noteSize(db, done);
  } catch (err) {
    const c = writeConflict(err);
    if (c === 'entry') throw fail(409, 'conflict');
    if (c === 'quota') throw await roomGone(db, env, who.handle, bytes, !count.trusted);
    if (c !== 'guard') throw err;
    await stillWriter(db, req);
    const again = await publishCounts(db, who.handle, s);
    quota(again, caps);
    throw fail(413, 'over-quota', again.trusted ? 'too many entries' : 'too many entries waiting for review');
  }
  // a pending write still heals an index an earlier write left stale
  await settleIndex(db, env, deps.now());
  return json(201, state === 'live' ? { id, version: 1, hash } : { id, version: 1, hash, pending: true });
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
  const who = await writer(db, env, deps, req);
  // another publisher's id answers 403 before any lookup, so hidden pending ids stay hidden (IN-01)
  if (who.handle !== p) throw fail(403, 'forbidden');
  const row = await readEntryRow(db, p, s);
  if (!row) throw fail(404, 'not-found');
  if (gone(row.state)) throw fail(410, 'withdrawn');
  const m = IF_MATCH_RE.exec(req.headers.get('if-match') ?? '');
  if (!m || Number(m[1]) !== row.version) throw fail(412, 'stale');
  const payload = parseVersionPayload(raw);
  if (!payload) throw fail(400, 'invalid');
  const entry = row.entry;
  const hash = await checkedHash(env, entry.kind, payload.content);
  if (entry.versions.length >= (deps.caps?.versions ?? MAX_VERSIONS)) {
    throw fail(413, 'over-quota', 'too many versions');
  }
  const review = row.state === 'live' && who.trusted;
  if (review && row.held) throw fail(409, 'conflict', HELD_WAIT);
  const added = review ? await addedLinks(db, p, s, row.version, payload.content) : [];
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
  if (payload.cols !== undefined) next.cols = payload.cols;
  fits(next);
  const body = versionText({ version, content: payload.content, hash });
  const bytes = utf8(body);
  await room(db, env, who.handle, bytes, row.state === 'pending');
  if (added.length > 0) {
    try {
      const done = await db.batch([
        requireWriter(db, who.digest, who.handle),
        ...heldStatements(db, {
          entry: next,
          expected: row.version,
          expectedHash: entry.hash,
          body,
          room: roomOf(env),
          held: {
            version,
            hash,
            at,
            reason: 'new-link',
            links: added,
            summary: entrySummaryText(next),
            doc: entryDocText(next),
          },
        }),
      ]);
      await noteSize(db, done);
    } catch (err) {
      const c = writeConflict(err);
      if (c === 'quota') throw await roomGone(db, env, who.handle, bytes, false);
      if (c === 'guard') await stillWriter(db, req);
      if (c === 'version' || c === 'guard') throw fail(412, 'stale');
      throw err;
    }
    return json(202, { id: entry.id, version, hash, pending: true, reason: 'new-link', links: added });
  }
  try {
    const done = await db.batch([
      requireWriter(db, who.digest, who.handle),
      ...versionStatements(db, {
        entry: next,
        expected: row.version,
        expectedHash: entry.hash,
        body,
        room: roomOf(env),
      }),
    ]);
    await noteSize(db, done);
  } catch (err) {
    const c = writeConflict(err);
    if (c === 'quota') throw await roomGone(db, env, who.handle, bytes, row.state === 'pending');
    if (c === 'guard') await stillWriter(db, req);
    if (c === 'guard' && (await needsReview(db, p, s))) throw fail(403, 'forbidden', REVIEW_FIRST);
    if (c === 'version' || c === 'guard') throw fail(412, 'stale');
    throw err;
  }
  await settleIndex(db, env, deps.now());
  return json(201, { id: entry.id, version, hash });
}

export async function overwrite(
  db: D1Database,
  env: Env,
  deps: WorkerDeps,
  req: Request,
  p: string,
  s: string,
  n: number,
): Promise<Response> {
  const raw = await readJsonBody(req, MARKET_LIMITS.maxBodyBytes);
  const who = await writer(db, env, deps, req);
  if (!overwriteOn(env)) throw fail(403, 'overwrite-disabled');
  if (who.handle !== p) throw fail(403, 'forbidden');
  const row = await readEntryRow(db, p, s);
  if (!row) throw fail(404, 'not-found');
  if (gone(row.state)) throw fail(410, 'withdrawn');
  if (row.held) throw fail(409, 'conflict', HELD_WAIT);
  if (n !== row.version) throw fail(409, 'conflict', LATEST_ONLY);
  const payload = parseVersionPayload(raw);
  if (!payload) throw fail(400, 'invalid');
  const entry = row.entry;
  const hash = await checkedHash(env, entry.kind, payload.content);
  if (row.state === 'live' && who.trusted) {
    if ((await addedLinks(db, p, s, row.version, payload.content)).length > 0) {
      throw fail(403, 'forbidden', NEW_LINK);
    }
  }
  const at = iso(deps);
  const last = entry.versions.at(-1)!;
  const next: StoredEntry = {
    ...entry,
    name: payload.name ?? entry.name,
    description: payload.description ?? entry.description,
    updatedAt: at,
    hash,
    versions: [...entry.versions.slice(0, -1), { ...last, note: payload.note, hash, overwrittenAt: at }],
  };
  if (payload.cols !== undefined) next.cols = payload.cols;
  fits(next);
  const body = versionText({ version: n, content: payload.content, hash });
  const bytes = utf8(body);
  await room(db, env, who.handle, bytes, row.state === 'pending');
  try {
    const done = await db.batch([
      requireWriter(db, who.digest, who.handle),
      ...overwriteStatements(db, { entry: next, expectedHash: entry.hash, body, room: roomOf(env) }),
    ]);
    await noteSize(db, done);
  } catch (err) {
    const c = writeConflict(err);
    if (c === 'quota') throw await roomGone(db, env, who.handle, bytes, row.state === 'pending');
    if (c !== 'guard') throw err;
    await stillWriter(db, req);
    if (await needsReview(db, p, s)) throw fail(403, 'forbidden', REVIEW_FIRST);
    const now = await readEntryRow(db, p, s);
    if (now && gone(now.state)) throw fail(410, 'withdrawn');
    throw fail(409, 'conflict', LATEST_ONLY);
  }
  await settleIndex(db, env, deps.now());
  return json(200, { id: entry.id, version: n, hash });
}

// a racing new version is retried into the tombstone
export async function withdraw(
  db: D1Database,
  env: Env,
  deps: WorkerDeps,
  req: Request,
  p: string,
  s: string,
): Promise<Response> {
  const who = await writer(db, env, deps, req);
  const done = () => json(200, { id: `${p}/${s}`, withdrawn: true });
  const gate = () => requireWriter(db, who.digest, who.handle);
  if (who.handle !== p) throw fail(403, 'forbidden');
  for (let i = 0; i < 3; i++) {
    const row = await readEntryRow(db, p, s);
    if (!row) throw fail(404, 'not-found');
    if (gone(row.state)) return done();
    const at = iso(deps);
    // never public, so nothing to keep
    if (row.state === 'pending') {
      const log = {
        at,
        admin: who.handle,
        action: 'withdraw-pending',
        target: `${p}/${s}`,
        note: '',
        actor: 'publisher' as const,
      };
      try {
        await noteSize(db, await db.batch(dropPendingStatements(db, gate(), p, s, log)));
      } catch (err) {
        if (writeConflict(err) !== 'guard') throw err;
        await stillWriter(db, req);
        continue;
      }
      return done();
    }
    try {
      // a withdraw also refreshes the size, so a full database can recover
      const tomb = tombOf(row.entry, at);
      await noteSize(db, await db.batch([gate(), ...withdrawStatements(db, tomb, row.version)]));
    } catch (err) {
      if (writeConflict(err) !== 'guard') throw err;
      await stillWriter(db, req);
      continue;
    }
    await settleIndex(db, env, deps.now());
    return done();
  }
  throw fail(409, 'conflict');
}
