import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { contentHash } from '../../src/market/client.js';
import { MARKET_LIMITS, parseIndex, parseRemoteEntry } from '../../src/market/protocol.js';
import type { D1Database, D1PreparedStatement, Env, WorkerDeps } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { authPublisher, randomToken, sha256Hex } from '../../src/market/worker/tokens.js';
import { START } from './conformance.js';
import { hasSqlite } from './d1-sqlite.js';
import { makeRefTarget } from './ref-target.js';
import { makeEnv } from './worker-env.js';
import { seedEntry, seedPublisher, seedToken } from './worker-seed.js';

const BASE = 'http://w.test';
const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;
const at = (ms: number) => new Date(START + ms).toISOString();
const match = (n: number) => ({ 'if-match': `"${n}"` });

function publishBody(slug: string, content: unknown = preset()) {
  return {
    kind: 'preset',
    slug,
    name: `Name ${slug}`,
    description: 'desc',
    author: 'Alp',
    content,
    note: 'first',
  };
}

// runs a hook once, right before the next content batch (salt and index batches have two statements)
function hooked(db: D1Database): { db: D1Database; before(fn: () => Promise<void>): void } {
  let hook: (() => Promise<void>) | null = null;
  return {
    before: (fn) => {
      hook = fn;
    },
    db: {
      prepare: (s) => db.prepare(s),
      batch: async (list: D1PreparedStatement[]) => {
        const fn = list.length > 2 ? hook : null;
        if (fn) hook = null;
        if (fn) await fn();
        return db.batch(list);
      },
      exec: (s) => db.exec(s),
    },
  };
}

interface Opts {
  caps?: WorkerDeps['caps'];
  vars?: Partial<Env>;
}

async function setup(o: Opts = {}) {
  const { env, clock } = await makeEnv(o.vars);
  const db = env.DB;
  const h = hooked(db);
  const handler = createHandler({ ...env, DB: h.db } as Env, {
    now: clock.now,
    fetch: () => Promise.reject(new Error('no fetch')),
    ...(o.caps ? { caps: o.caps } : {}),
  });
  const call = (
    method: string,
    p: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const body =
      opts.body === undefined
        ? undefined
        : typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body);
    return handler.fetch(new Request(BASE + p, { method, headers, ...(body === undefined ? {} : { body }) }));
  };
  const get = async (p: string) => {
    const r = await handler.fetch(new Request(BASE + p));
    return { status: r.status, json: (await r.json()) as any };
  };
  const account = async (handle: string, githubId: number, extra: { banned?: boolean } = {}) => {
    await seedPublisher(db, { handle, githubId, trusted: true, ...extra });
    return seedToken(db, handle);
  };
  const gen = async () =>
    Number(await db.prepare("SELECT n FROM counters WHERE k = 'gen'").first<number>('n'));
  const versions = async (p: string, s: string) =>
    (
      await db
        .prepare('SELECT version FROM versions WHERE publisher = ?1 AND slug = ?2 ORDER BY version')
        .bind(p, s)
        .all<{ version: number }>()
    ).results.map((r) => Number(r.version));
  return { db, env, clock, call, get, account, gen, versions, before: h.before };
}

async function error(r: Response): Promise<{ status: number; code: string; message: string }> {
  const b = (await r.json()) as { error: { code: string; message: string } };
  return { status: r.status, code: b.error.code, message: b.error.message };
}

describe.skipIf(!hasSqlite)('worker writes', () => {
  it('writes the same bytes as the reference server for the same calls', async () => {
    const ref = await makeRefTarget();
    const w = await setup();
    try {
      const refToken = await ref.signIn('alp');
      const token = await w.account('alp', 7);
      const steps: [string, string, unknown, Record<string, string>][] = [
        ['POST', '/v1/entries', publishBody('mine'), {}],
        ['POST', '/v1/entries', { ...publishBody('two'), description: undefined, author: undefined }, {}],
        [
          'POST',
          '/v1/entries/alp/mine/versions',
          { content: preset('cwd'), note: 'n', name: 'New' },
          match(1),
        ],
      ];
      for (const [method, p, body, headers] of steps) {
        ref.advance(60_000);
        w.clock.advance(60_000);
        const a = await fetch(`${ref.url}${p}`, {
          method,
          headers: { authorization: `Bearer ${refToken}`, 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        const b = await w.call(method, p, { token, body, headers });
        expect([b.status, await b.text()]).toEqual([a.status, await a.text()]);
      }
      for (const p of [
        '/v1/index.json',
        '/v1/entries/alp/mine.json',
        '/v1/entries/alp/two.json',
        '/v1/entries/alp/mine/1.json',
        '/v1/entries/alp/mine/2.json',
      ]) {
        const a = await (await fetch(`${ref.url}${p}`)).text();
        const b = await (await w.call('GET', p)).text();
        expect(`${b}\n`, p).toBe(a);
      }
    } finally {
      await ref.close();
    }
  });

  describe('tokens', () => {
    it('hashes with Web Crypto like node:crypto', async () => {
      for (const s of ['abc', '', 'çğış ünïcode']) {
        expect(await sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
      }
    });

    it('makes 64-hex random tokens', () => {
      const a = randomToken();
      const b = randomToken();
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(b).toMatch(/^[0-9a-f]{64}$/);
      expect(a).not.toBe(b);
    });

    it('looks a bearer token up by its digest', async () => {
      const { db, account } = await setup();
      const token = await account('alp', 7);
      const req = (auth?: string) => new Request(BASE, auth ? { headers: { authorization: auth } } : {});
      expect(await authPublisher(db, req(`Bearer ${token}`))).toEqual({
        handle: 'alp',
        githubId: 7,
        trusted: true,
        banned: false,
        digest: await sha256Hex(token),
      });
      expect(await authPublisher(db, req())).toBeNull();
      expect(await authPublisher(db, req(`Bearer ${'f'.repeat(64)}`))).toBeNull();
      expect(await authPublisher(db, req(`Bearer ${token.toUpperCase()}`))).toBeNull();
      expect(await authPublisher(db, req(`bearer ${token}`))).toBeNull();
      expect(await authPublisher(db, req(`Bearer ${token.slice(1)}`))).toBeNull();
    });
  });

  describe('publish', () => {
    it('publishes v1 with the client hash and lists it', async () => {
      const t = await setup();
      const token = await t.account('alp', 7);
      const content = preset();
      const g = await t.gen();
      const r = await t.call('POST', '/v1/entries', { token, body: publishBody('mine', content) });
      expect(r.status).toBe(201);
      expect(r.headers.get('cache-control')).toBe('no-store');
      const hash = contentHash(content);
      expect(await r.json()).toEqual({ id: 'alp/mine', version: 1, hash });
      expect(await t.gen()).toBe(g + 1);

      const index = await t.get('/v1/index.json');
      expect(parseIndex(index.json)!.entries).toEqual([
        {
          id: 'alp/mine',
          kind: 'preset',
          name: 'Name mine',
          description: 'desc',
          author: 'Alp',
          publisher: 'alp',
          version: 1,
          updatedAt: at(0),
          hash,
        },
      ]);
      const page = await t.db.prepare('SELECT gen FROM index_pages WHERE page = 1').first<number>('gen');
      expect(Number(page)).toBe(g + 1);
      const entry = parseRemoteEntry((await t.get('/v1/entries/alp/mine.json')).json)!;
      expect(entry.versions).toEqual([{ version: 1, at: at(0), note: 'first', hash }]);
      expect((await t.get('/v1/entries/alp/mine/1.json')).json).toEqual({ version: 1, content, hash });

      const rows = (await t.db.prepare('SELECT * FROM tokens').all()).results;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]!.sha256).toBe(createHash('sha256').update(token).digest('hex'));
      const bytes = await t.db.prepare("SELECT bytes FROM publishers WHERE handle = 'alp'").first('bytes');
      const body = (await t.db.prepare('SELECT body FROM versions').first<string>('body'))!;
      expect(bytes).toBe(new TextEncoder().encode(body).length);
    });

    it('stores sanitized content and hashes what it stores', async () => {
      const t = await setup();
      const token = await t.account('alp', 7);
      const dirty = { layout: { lines: [[{ type: 'text', options: { text: 'a\u001b[31mb' } }]] } };
      const r = await t.call('POST', '/v1/entries', { token, body: publishBody('mine', dirty) });
      expect(r.status).toBe(201);
      const { hash } = (await r.json()) as { hash: string };
      const v = (await t.get('/v1/entries/alp/mine/1.json')).json;
      expect(JSON.stringify(v.content)).not.toContain('\u001b');
      expect(hash).toBe(contentHash(v.content));
      expect(v.hash).toBe(hash);
    });

    it('checks the media type, body, token and payload in the reference order', async () => {
      const t = await setup();
      const token = await t.account('alp', 7);
      const body = publishBody('mine');
      expect(await error(await t.call('POST', '/v1/entries', { body }))).toMatchObject({
        status: 401,
        code: 'unauthorized',
      });
      const unknown = await t.call('POST', '/v1/entries', { token: 'f'.repeat(64), body });
      expect((await error(unknown)).status).toBe(401);
      const plain = await t.call('POST', '/v1/entries', { body, headers: { 'content-type': 'text/plain' } });
      expect(await error(plain)).toMatchObject({ status: 415, code: 'unsupported-media' });
      const big = `{"pad":"${'x'.repeat(2 * MARKET_LIMITS.maxBodyBytes)}"}`;
      expect(await error(await t.call('POST', '/v1/entries', { body: big }))).toMatchObject({
        status: 413,
        code: 'too-large',
      });
      expect(await error(await t.call('POST', '/v1/entries', { token, body: '{nope' }))).toMatchObject({
        status: 400,
        code: 'invalid',
        message: 'body is not JSON',
      });
      // a bad body never reaches the token check
      expect((await t.call('POST', '/v1/entries', { body: '{nope' })).status).toBe(400);
      expect((await t.call('POST', '/v1/entries', { token, body: { kind: 'preset' } })).status).toBe(400);
      expect((await t.call('POST', '/v1/entries', { token, body: [] })).status).toBe(400);
      expect(await t.versions('alp', 'mine')).toEqual([]);
    });

    it('rejects executable content with the reference codes', async () => {
      const t = await setup();
      const token = await t.account('alp', 7);
      const cases: [unknown, string][] = [
        [{ layout: { lines: [[{ type: 'command', options: { command: 'echo hi' } }]] } }, 'command-widget'],
        [{ layout: { lines: [[{ type: 'env', options: { name: 'HOME' } }]] } }, 'env-widget'],
        [{ layout: { lines: [[{ type: 'model' }]], budget: { daily: 5 } } }, 'personal-key:budget'],
      ];
      for (const [content, code] of cases) {
        const r = await t.call('POST', '/v1/entries', { token, body: publishBody('bad', content) });
        expect(await error(r)).toEqual({ status: 400, code: 'invalid', message: code });
      }
      expect((await t.get('/v1/entries/alp/bad.json')).status).toBe(404);
      expect(await t.gen()).toBe(0);
    });

    it('honours a lower MAX_ENTRY_BYTES', async () => {
      const t = await setup({ vars: { MAX_ENTRY_BYTES: '200' } });
      const token = await t.account('alp', 7);
      const content = { layout: { lines: [[{ type: 'text', options: { text: 'x'.repeat(300) } }]] } };
      const r = await t.call('POST', '/v1/entries', { token, body: publishBody('big', content) });
      expect(await error(r)).toEqual({ status: 400, code: 'invalid', message: 'too-large' });
      expect((await t.call('POST', '/v1/entries', { token, body: publishBody('small') })).status).toBe(201);
    });

    it('answers 409 for a taken slug and 413 past the caps', async () => {
      const t = await setup({ caps: { entriesPerPublisher: 1, entries: 2 } });
      const alp = await t.account('alp', 7);
      const bob = await t.account('bob', 8);
      const cem = await t.account('cem', 9);
      expect((await t.call('POST', '/v1/entries', { token: alp, body: publishBody('one') })).status).toBe(
        201,
      );
      expect(
        await error(await t.call('POST', '/v1/entries', { token: alp, body: publishBody('one') })),
      ).toEqual({
        status: 409,
        code: 'conflict',
        message: 'already exists',
      });
      expect(
        await error(await t.call('POST', '/v1/entries', { token: alp, body: publishBody('two') })),
      ).toEqual({
        status: 413,
        code: 'over-quota',
        message: 'too many entries for this publisher',
      });
      expect((await t.call('POST', '/v1/entries', { token: bob, body: publishBody('one') })).status).toBe(
        201,
      );
      const full = await t.call('POST', '/v1/entries', { token: cem, body: publishBody('one') });
      expect(await error(full)).toMatchObject({ status: 413, message: 'too many entries' });
      expect(await t.versions('cem', 'one')).toEqual([]);
    });

    it('a taken withdrawn slug stays 409 and tombstones do not count', async () => {
      const t = await setup({ caps: { entriesPerPublisher: 1 } });
      const alp = await t.account('alp', 7);
      await seedEntry(t.db, { id: 'alp/gone', state: 'withdrawn', versions: [{ content: preset() }] });
      expect((await t.call('POST', '/v1/entries', { token: alp, body: publishBody('gone') })).status).toBe(
        409,
      );
      expect((await t.call('POST', '/v1/entries', { token: alp, body: publishBody('new') })).status).toBe(
        201,
      );
    });

    it('a racing publish of the same slug gets 409 and leaves one entry', async () => {
      const t = await setup();
      const alp = await t.account('alp', 7);
      t.before(async () => {
        await seedEntry(t.db, { id: 'alp/mine', versions: [{ content: preset('cwd') }] }, { rebuild: false });
      });
      const r = await t.call('POST', '/v1/entries', { token: alp, body: publishBody('mine') });
      expect((await error(r)).status).toBe(409);
      expect(await t.versions('alp', 'mine')).toEqual([1]);
      const v = (await t.get('/v1/entries/alp/mine/1.json')).json;
      expect(v.content).toEqual(preset('cwd'));
    });

    it('caps are checked again inside the batch', async () => {
      const t = await setup({ caps: { entriesPerPublisher: 1 } });
      const alp = await t.account('alp', 7);
      t.before(async () => {
        await seedEntry(t.db, { id: 'alp/other', versions: [{ content: preset() }] }, { rebuild: false });
      });
      const g = await t.gen();
      const r = await t.call('POST', '/v1/entries', { token: alp, body: publishBody('mine') });
      expect(await error(r)).toMatchObject({ status: 413, message: 'too many entries for this publisher' });
      expect(await t.versions('alp', 'mine')).toEqual([]);
      expect(await t.gen()).toBe(g + 1);
      expect(await t.db.prepare("SELECT bytes FROM publishers WHERE handle = 'alp'").first('bytes')).toBe(0);
    });

    it('a banned publisher cannot write', async () => {
      const t = await setup();
      const token = await t.account('bad', 7, { banned: true });
      const r = await t.call('POST', '/v1/entries', { token, body: publishBody('mine') });
      expect(await error(r)).toEqual({ status: 403, code: 'banned', message: 'publisher is banned' });
      expect(await t.versions('bad', 'mine')).toEqual([]);
    });
  });

  describe('new versions', () => {
    const p = '/v1/entries/alp/mine/versions';

    async function published(o: Opts = {}) {
      const t = await setup(o);
      const token = await t.account('alp', 7);
      expect((await t.call('POST', '/v1/entries', { token, body: publishBody('mine') })).status).toBe(201);
      return { ...t, token };
    }

    it('adds version n+1 with If-Match', async () => {
      const t = await published();
      t.clock.advance(60_000);
      const next = preset('cwd');
      const g = await t.gen();
      const r = await t.call('POST', p, {
        token: t.token,
        headers: match(1),
        body: { content: next, note: 'two' },
      });
      expect(r.status).toBe(201);
      const hash = contentHash(next);
      expect(await r.json()).toEqual({ id: 'alp/mine', version: 2, hash });
      expect(await t.gen()).toBe(g + 1);
      const entry = parseRemoteEntry((await t.get('/v1/entries/alp/mine.json')).json)!;
      expect(entry).toMatchObject({ version: 2, hash, updatedAt: at(60_000), name: 'Name mine' });
      expect(entry.versions).toEqual([
        { version: 1, at: at(0), note: 'first', hash: contentHash(preset()) },
        { version: 2, at: at(60_000), note: 'two', hash },
      ]);
      expect((await t.get('/v1/entries/alp/mine/2.json')).json).toEqual({ version: 2, content: next, hash });
      expect((await t.get('/v1/entries/alp/mine/1.json')).json.content).toEqual(preset());
      const index = parseIndex((await t.get('/v1/index.json')).json)!;
      expect(index.entries[0]).toMatchObject({ id: 'alp/mine', version: 2, hash, updatedAt: at(60_000) });
      const bytes = await t.db.prepare("SELECT bytes FROM publishers WHERE handle = 'alp'").first('bytes');
      const bodies = (await t.db.prepare('SELECT body FROM versions').all<{ body: string }>()).results;
      expect(bytes).toBe(bodies.reduce((n, b) => n + new TextEncoder().encode(b.body).length, 0));
    });

    it('answers 412 stale for a missing or old If-Match', async () => {
      const t = await published();
      const body = { content: preset('cwd'), note: '' };
      expect(await error(await t.call('POST', p, { token: t.token, body }))).toEqual({
        status: 412,
        code: 'stale',
        message: 'not the latest version',
      });
      for (const h of ['1', 'W/"1"', '"01"', '"2"', '*']) {
        const r = await t.call('POST', p, { token: t.token, headers: { 'if-match': h }, body });
        expect(r.status, h).toBe(412);
      }
      expect((await t.call('POST', p, { token: t.token, headers: match(1), body })).status).toBe(201);
      expect((await t.call('POST', p, { token: t.token, headers: match(1), body })).status).toBe(412);
      expect(await t.versions('alp', 'mine')).toEqual([1, 2]);
    });

    it('lets exactly one of two racing versions win', async () => {
      const t = await published();
      const body = { content: preset('cwd'), note: '' };
      expect((await t.call('POST', p, { token: t.token, headers: match(1), body })).status).toBe(201);
      const both = await Promise.all([
        t.call('POST', p, {
          token: t.token,
          headers: match(2),
          body: { content: preset('git-branch'), note: 'a' },
        }),
        t.call('POST', p, {
          token: t.token,
          headers: match(2),
          body: { content: preset('cost'), note: 'b' },
        }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([201, 412]);
      expect(await t.versions('alp', 'mine')).toEqual([1, 2, 3]);
      const entry = parseRemoteEntry((await t.get('/v1/entries/alp/mine.json')).json)!;
      expect(entry.versions.map((v) => v.version)).toEqual([1, 2, 3]);
      const v3 = (await t.get('/v1/entries/alp/mine/3.json')).json;
      expect(v3.hash).toBe(entry.hash);
    });

    it('the versions key stops a twin that read the same entry', async () => {
      const t = await published();
      t.before(async () => {
        await t.db
          .prepare("INSERT INTO versions (publisher, slug, version, body) VALUES ('alp', 'mine', 2, '{}')")
          .run();
      });
      const g = await t.gen();
      const r = await t.call('POST', p, {
        token: t.token,
        headers: match(1),
        body: { content: preset('cwd'), note: '' },
      });
      expect((await error(r)).code).toBe('stale');
      expect(await t.gen()).toBe(g);
      expect(Number(await t.db.prepare('SELECT version FROM entries').first('version'))).toBe(1);
    });

    it('the guarded update rolls the version row back when the entry changed', async () => {
      const t = await published();
      t.before(async () => {
        await t.db.prepare("UPDATE entries SET state = 'withdrawn'").run();
      });
      const bytes = await t.db.prepare("SELECT bytes FROM publishers WHERE handle = 'alp'").first('bytes');
      const g = await t.gen();
      const r = await t.call('POST', p, {
        token: t.token,
        headers: match(1),
        body: { content: preset('cwd'), note: '' },
      });
      expect(await error(r)).toMatchObject({ status: 412, code: 'stale' });
      expect(await t.versions('alp', 'mine')).toEqual([1]);
      expect(await t.gen()).toBe(g);
      expect(await t.db.prepare("SELECT bytes FROM publishers WHERE handle = 'alp'").first('bytes')).toBe(
        bytes,
      );
    });

    it('only the owner writes; missing and withdrawn entries answer 404 and 410', async () => {
      const t = await published();
      const bob = await t.account('bob', 8);
      const body = { content: preset('cwd'), note: '' };
      expect(await error(await t.call('POST', p, { token: bob, headers: match(1), body }))).toMatchObject({
        status: 403,
        code: 'forbidden',
      });
      expect((await t.call('POST', p, { headers: match(1), body })).status).toBe(401);
      const nope = await t.call('POST', '/v1/entries/alp/nope/versions', {
        token: t.token,
        headers: match(1),
        body,
      });
      expect((await error(nope)).status).toBe(404);
      await seedEntry(t.db, { id: 'alp/gone', state: 'withdrawn', versions: [{ content: preset() }] });
      const gone = await t.call('POST', '/v1/entries/alp/gone/versions', {
        token: t.token,
        headers: match(1),
        body,
      });
      expect(await error(gone)).toMatchObject({ status: 410, code: 'withdrawn' });
      await seedEntry(t.db, { id: 'alp/out', state: 'removed', versions: [{ content: preset() }] });
      const out = await t.call('POST', '/v1/entries/alp/out/versions', {
        token: t.token,
        headers: match(1),
        body,
      });
      expect((await error(out)).status).toBe(410);
      const bad = await t.call('POST', '/v1/entries/al%2Fp/mine/versions', {
        token: t.token,
        headers: match(1),
        body,
      });
      expect(await error(bad)).toMatchObject({ status: 400, message: 'invalid id' });
      expect(await t.versions('alp', 'mine')).toEqual([1]);
    });

    it('rejects bad payloads and executable content', async () => {
      const t = await published();
      const send = (body: unknown) => t.call('POST', p, { token: t.token, headers: match(1), body });
      expect((await send({ note: 'x' })).status).toBe(400);
      expect((await send({ content: preset(), name: '' })).status).toBe(400);
      const cmd = { layout: { lines: [[{ type: 'command', options: { command: 'x' } }]] } };
      expect(await error(await send({ content: cmd }))).toEqual({
        status: 400,
        code: 'invalid',
        message: 'command-widget',
      });
      expect(await t.versions('alp', 'mine')).toEqual([1]);
    });

    it('a new name and description update the summary and the index', async () => {
      const t = await published();
      const r = await t.call('POST', p, {
        token: t.token,
        headers: match(1),
        body: { content: preset('cwd'), note: '', name: 'Renamed', description: 'better' },
      });
      expect(r.status).toBe(201);
      const index = parseIndex((await t.get('/v1/index.json')).json)!;
      expect(index.entries[0]).toMatchObject({ name: 'Renamed', description: 'better', author: 'Alp' });
      const entry = parseRemoteEntry((await t.get('/v1/entries/alp/mine.json')).json)!;
      expect(entry).toMatchObject({ name: 'Renamed', description: 'better' });
    });

    it('answers 413 at the version cap', async () => {
      const t = await published({ caps: { versions: 1 } });
      const r = await t.call('POST', p, {
        token: t.token,
        headers: match(1),
        body: { content: preset('cwd') },
      });
      expect(await error(r)).toEqual({ status: 413, code: 'over-quota', message: 'too many versions' });
      expect(await t.versions('alp', 'mine')).toEqual([1]);
    });

    it('a banned owner cannot add versions', async () => {
      const t = await published();
      await t.db
        .prepare("UPDATE publishers SET banned_at = '2026-10-16T12:00:00.000Z' WHERE handle = 'alp'")
        .run();
      const r = await t.call('POST', p, {
        token: t.token,
        headers: match(1),
        body: { content: preset('cwd') },
      });
      expect((await error(r)).code).toBe('banned');
    });

    it('other methods on write paths stay 404', async () => {
      const t = await published();
      for (const [m, path] of [
        ['PATCH', '/v1/entries'],
        ['POST', '/v1/entries/alp/mine'],
        ['POST', '/v1/entries/alp/mine/versions/extra'],
      ] as const) {
        const r = await t.call(m, path, { token: t.token, body: {} });
        expect(r.status, `${m} ${path}`).toBe(404);
      }
    });
  });

  const bytesOf = async (db: D1Database, handle: string) =>
    Number(await db.prepare('SELECT bytes FROM publishers WHERE handle = ?1').bind(handle).first('bytes'));
  const bodies = async (db: D1Database, p: string, s: string) =>
    (
      await db
        .prepare('SELECT body FROM versions WHERE publisher = ?1 AND slug = ?2 ORDER BY version')
        .bind(p, s)
        .all<{ body: string | null }>()
    ).results.map((r) => r.body);
  const sumBytes = (list: (string | null)[]) =>
    list.reduce((n, b) => n + (b === null ? 0 : new TextEncoder().encode(b).length), 0);

  async function withTwo(o: Opts = {}) {
    const t = await setup(o);
    const token = await t.account('alp', 7);
    expect((await t.call('POST', '/v1/entries', { token, body: publishBody('mine') })).status).toBe(201);
    const two = await t.call('POST', '/v1/entries/alp/mine/versions', {
      token,
      headers: match(1),
      body: { content: preset('cwd'), note: 'two' },
    });
    expect(two.status).toBe(201);
    return { ...t, token };
  }

  describe('overwrite', () => {
    const on = { vars: { ALLOW_OVERWRITE: 'true' } };
    const put = '/v1/entries/alp/mine/versions/2';

    it('is refused unless ALLOW_OVERWRITE is true', async () => {
      for (const vars of [{}, { ALLOW_OVERWRITE: 'false' }, { ALLOW_OVERWRITE: '1' }]) {
        const t = await withTwo({ vars });
        const before = await bodies(t.db, 'alp', 'mine');
        const g = await t.gen();
        const r = await t.call('PUT', put, { token: t.token, body: { content: preset('git-branch') } });
        expect(await error(r)).toEqual({
          status: 403,
          code: 'overwrite-disabled',
          message: 'overwrite is disabled on this server',
        });
        expect(await bodies(t.db, 'alp', 'mine')).toEqual(before);
        expect(await t.gen()).toBe(g);
      }
    });

    it('replaces only the latest version and marks it', async () => {
      const t = await withTwo(on);
      t.clock.advance(60_000);
      const next = preset('git-branch');
      const g = await t.gen();
      const v1 = await bodies(t.db, 'alp', 'mine');
      const r = await t.call('PUT', put, {
        token: t.token,
        body: { content: next, note: 'fixed', description: 'better' },
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ id: 'alp/mine', version: 2, hash: contentHash(next) });
      expect((await t.get('/v1/entries/alp/mine/2.json')).json).toEqual({
        version: 2,
        content: next,
        hash: contentHash(next),
      });
      const doc = (await t.get('/v1/entries/alp/mine.json')).json;
      expect(doc).toMatchObject({
        version: 2,
        hash: contentHash(next),
        description: 'better',
        updatedAt: at(60_000),
      });
      expect(doc.versions[1]).toEqual({
        version: 2,
        at: at(0),
        note: 'fixed',
        hash: contentHash(next),
        overwrittenAt: at(60_000),
      });
      expect(parseIndex((await t.get('/v1/index.json')).json)!.entries[0]).toMatchObject({
        version: 2,
        hash: contentHash(next),
        description: 'better',
      });
      const now = await bodies(t.db, 'alp', 'mine');
      expect(now[0]).toBe(v1[0]);
      expect(await bytesOf(t.db, 'alp')).toBe(sumBytes(now));
      expect(await t.gen()).toBe(g + 1);
      for (const n of [1, 3]) {
        const old = await t.call('PUT', `/v1/entries/alp/mine/versions/${n}`, {
          token: t.token,
          body: { content: preset() },
        });
        expect(await error(old)).toEqual({
          status: 409,
          code: 'conflict',
          message: 'only the latest version can be overwritten',
        });
      }
    });

    it('checks owner, entry and payload like the reference', async () => {
      const t = await withTwo(on);
      const bob = await t.account('bob', 8);
      const body = { content: preset() };
      expect((await error(await t.call('PUT', put, { token: bob, body }))).code).toBe('forbidden');
      expect((await error(await t.call('PUT', put, { body }))).code).toBe('unauthorized');
      const nope = await t.call('PUT', '/v1/entries/alp/nope/versions/1', { token: t.token, body });
      expect((await error(nope)).status).toBe(404);
      const zero = await t.call('PUT', '/v1/entries/alp/mine/versions/0', { token: t.token, body });
      expect(await error(zero)).toMatchObject({ status: 400, message: 'invalid version' });
      const media = await t.call('PUT', put, {
        token: t.token,
        body,
        headers: { 'content-type': 'text/plain' },
      });
      expect((await error(media)).status).toBe(415);
      expect((await t.call('PUT', put, { token: t.token, body: { note: 'x' } })).status).toBe(400);
      const cmd = { layout: { lines: [[{ type: 'command', options: { command: 'x' } }]] } };
      expect(
        (await error(await t.call('PUT', put, { token: t.token, body: { content: cmd } }))).message,
      ).toBe('command-widget');
      await seedEntry(t.db, { id: 'alp/gone', state: 'withdrawn', versions: [{ content: preset() }] });
      const gone = await t.call('PUT', '/v1/entries/alp/gone/versions/1', { token: t.token, body });
      expect(await error(gone)).toMatchObject({ status: 410, code: 'withdrawn' });
      expect(parseRemoteEntry((await t.get('/v1/entries/alp/mine.json')).json)!.hash).toBe(
        contentHash(preset('cwd')),
      );
    });

    it('a change between the read and the batch rolls the overwrite back', async () => {
      const t = await withTwo(on);
      const before = await bodies(t.db, 'alp', 'mine');
      const bytes = await bytesOf(t.db, 'alp');
      t.before(async () => {
        const r = await t.call('POST', '/v1/entries/alp/mine/versions', {
          token: t.token,
          headers: match(2),
          body: { content: preset('cost') },
        });
        expect(r.status).toBe(201);
      });
      const r = await t.call('PUT', put, { token: t.token, body: { content: preset('git-branch') } });
      expect((await error(r)).status).toBe(409);
      expect((await bodies(t.db, 'alp', 'mine')).slice(0, 2)).toEqual(before);
      expect(await bytesOf(t.db, 'alp')).toBeGreaterThan(bytes);
      expect(await bytesOf(t.db, 'alp')).toBe(sumBytes(await bodies(t.db, 'alp', 'mine')));

      t.before(async () => {
        expect((await t.call('DELETE', '/v1/entries/alp/mine', { token: t.token })).status).toBe(200);
      });
      const late = await t.call('PUT', '/v1/entries/alp/mine/versions/3', {
        token: t.token,
        body: { content: preset('git-branch') },
      });
      expect(await error(late)).toMatchObject({ status: 410, code: 'withdrawn' });
    });

    it('a racing overwrite makes a stale new version fail', async () => {
      const t = await withTwo(on);
      t.before(async () => {
        const r = await t.call('PUT', put, { token: t.token, body: { content: preset('git-branch') } });
        expect(r.status).toBe(200);
      });
      const r = await t.call('POST', '/v1/entries/alp/mine/versions', {
        token: t.token,
        headers: match(2),
        body: { content: preset('cost') },
      });
      expect((await error(r)).code).toBe('stale');
      const doc = (await t.get('/v1/entries/alp/mine.json')).json;
      expect(doc.versions[1].overwrittenAt).toBe(at(0));
      expect(await t.versions('alp', 'mine')).toEqual([1, 2]);
    });
  });

  describe('withdraw', () => {
    const del = '/v1/entries/alp/mine';

    it('tombstones the entry, nulls the bodies and frees the bytes in one batch', async () => {
      const t = await withTwo();
      expect(await bytesOf(t.db, 'alp')).toBeGreaterThan(0);
      t.clock.advance(60_000);
      const g = await t.gen();
      const r = await t.call('DELETE', del, { token: t.token });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ id: 'alp/mine', withdrawn: true });
      expect(await t.gen()).toBe(g + 1);
      expect(await bodies(t.db, 'alp', 'mine')).toEqual([null, null]);
      expect(await bytesOf(t.db, 'alp')).toBe(0);
      const row = await t.db
        .prepare("SELECT state, summary, doc FROM entries WHERE publisher = 'alp' AND slug = 'mine'")
        .first<{ state: string; summary: string; doc: string }>();
      expect(row!.state).toBe('withdrawn');
      for (const text of [row!.summary, row!.doc])
        expect(text).not.toMatch(/Name mine|"desc"|"Alp"|"first"|"two"/);

      const index = await t.get('/v1/index.json');
      expect(index.json.entries).toEqual([]);
      const doc = (await t.get('/v1/entries/alp/mine.json')).json;
      expect(doc).toMatchObject({
        id: 'alp/mine',
        name: '',
        description: '',
        author: '',
        withdrawn: true,
        withdrawnAt: at(60_000),
      });
      expect(doc.versions.map((v: any) => [v.version, v.note])).toEqual([
        [1, ''],
        [2, ''],
      ]);
      for (const n of [1, 2, 3]) {
        expect(await error(await t.call('GET', `/v1/entries/alp/mine/${n}.json`))).toMatchObject({
          status: 410,
          code: 'withdrawn',
        });
      }
      const again = await t.call('POST', '/v1/entries', { token: t.token, body: publishBody('mine') });
      expect((await error(again)).status).toBe(409);
      expect(await bodies(t.db, 'alp', 'mine')).toEqual([null, null]);
    });

    it('a repeat withdraw is a no-op 200, also for removed entries', async () => {
      const t = await withTwo();
      expect((await t.call('DELETE', del, { token: t.token })).status).toBe(200);
      const g = await t.gen();
      const doc = (await t.get('/v1/entries/alp/mine.json')).json;
      t.clock.advance(60_000);
      expect((await t.call('DELETE', del, { token: t.token })).status).toBe(200);
      expect(await t.gen()).toBe(g);
      expect((await t.get('/v1/entries/alp/mine.json')).json).toEqual(doc);
      await seedEntry(t.db, { id: 'alp/out', state: 'removed', versions: [{ content: preset() }] });
      const out = await t.call('DELETE', '/v1/entries/alp/out', { token: t.token });
      expect(await out.json()).toEqual({ id: 'alp/out', withdrawn: true });
      const state = await t.db.prepare("SELECT state FROM entries WHERE slug = 'out'").first('state');
      expect(state).toBe('removed');
    });

    it('checks the token, the entry and the owner in the reference order', async () => {
      const t = await withTwo();
      const bob = await t.account('bob', 8);
      expect(await error(await t.call('DELETE', del, { token: bob }))).toMatchObject({
        status: 403,
        code: 'forbidden',
      });
      expect((await error(await t.call('DELETE', del))).status).toBe(401);
      expect((await error(await t.call('DELETE', '/v1/entries/bob/nope', { token: bob }))).status).toBe(404);
      expect((await error(await t.call('DELETE', '/v1/entries/ALP/mine', { token: t.token }))).status).toBe(
        400,
      );
      await t.db
        .prepare("UPDATE publishers SET banned_at = '2026-10-16T12:00:00.000Z' WHERE handle = 'alp'")
        .run();
      expect((await error(await t.call('DELETE', del, { token: t.token }))).code).toBe('banned');
      expect(await bodies(t.db, 'alp', 'mine')).not.toContain(null);
    });

    it('a version added between the read and the batch is part of the tombstone', async () => {
      const t = await withTwo();
      t.before(async () => {
        const r = await t.call('POST', '/v1/entries/alp/mine/versions', {
          token: t.token,
          headers: match(2),
          body: { content: preset('cost') },
        });
        expect(r.status).toBe(201);
      });
      expect((await t.call('DELETE', del, { token: t.token })).status).toBe(200);
      const doc = (await t.get('/v1/entries/alp/mine.json')).json;
      expect(doc.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
      expect(await bodies(t.db, 'alp', 'mine')).toEqual([null, null, null]);
      expect(await bytesOf(t.db, 'alp')).toBe(0);
    });

    it('stops publishing at the tombstone caps with the reference messages', async () => {
      const t = await setup({ caps: { tombstonesPerPublisher: 2, tombstones: 3 } });
      const alp = await t.account('alp', 7);
      const bob = await t.account('bob', 8);
      for (const s of ['x0', 'x1']) {
        expect((await t.call('POST', '/v1/entries', { token: alp, body: publishBody(s) })).status).toBe(201);
        expect((await t.call('DELETE', `/v1/entries/alp/${s}`, { token: alp })).status).toBe(200);
      }
      expect(
        await error(await t.call('POST', '/v1/entries', { token: alp, body: publishBody('x2') })),
      ).toEqual({
        status: 413,
        code: 'over-quota',
        message: 'too many withdrawn entries for this publisher',
      });
      expect((await t.call('POST', '/v1/entries', { token: bob, body: publishBody('x0') })).status).toBe(201);
      // withdraw always works at the cap
      expect((await t.call('DELETE', '/v1/entries/bob/x0', { token: bob })).status).toBe(200);
      expect(
        await error(await t.call('POST', '/v1/entries', { token: bob, body: publishBody('x1') })),
      ).toEqual({
        status: 413,
        code: 'over-quota',
        message: 'too many withdrawn entries',
      });
    });

    it('tombstone caps are checked again inside the batch', async () => {
      const t = await setup({ caps: { tombstonesPerPublisher: 1 } });
      const alp = await t.account('alp', 7);
      t.before(async () => {
        await seedEntry(t.db, { id: 'alp/gone', state: 'withdrawn', versions: [{ content: preset() }] });
      });
      const r = await t.call('POST', '/v1/entries', { token: alp, body: publishBody('new') });
      expect(await error(r)).toMatchObject({
        status: 413,
        message: 'too many withdrawn entries for this publisher',
      });
      expect(await t.versions('alp', 'new')).toEqual([]);
    });
  });

  describe('publishers', () => {
    it('refuses anonymous registration: sign in with GitHub', async () => {
      const t = await setup();
      for (const body of [{ handle: 'alp', displayName: 'Alp' }, '{not json', undefined]) {
        const r = await t.call('POST', '/v1/publishers', { body });
        const text = await r.text();
        expect(r.status).toBe(403);
        expect(JSON.parse(text)).toEqual({
          error: { code: 'forbidden', message: 'sign in with GitHub to publish' },
        });
        expect(text).not.toMatch(/[0-9a-f]{64}/);
      }
      expect(Number(await t.db.prepare('SELECT COUNT(*) AS n FROM publishers').first('n'))).toBe(0);
    });
  });

  it('overwrite and withdraw write the same bytes as the reference server', async () => {
    const ref = await makeRefTarget({ allowOverwrite: true });
    const w = await setup({ vars: { ALLOW_OVERWRITE: 'true' } });
    try {
      const refToken = await ref.signIn('alp');
      const token = await w.account('alp', 7);
      const steps: [string, string, unknown, Record<string, string>][] = [
        ['POST', '/v1/entries', publishBody('mine'), {}],
        ['POST', '/v1/entries/alp/mine/versions', { content: preset('cwd'), note: 'n' }, match(1)],
        ['PUT', '/v1/entries/alp/mine/versions/2', { content: preset('cost'), note: 'f', name: 'N' }, {}],
        ['POST', '/v1/entries', publishBody('two'), {}],
        ['DELETE', '/v1/entries/alp/two', undefined, {}],
        ['DELETE', '/v1/entries/alp/two', undefined, {}],
      ];
      for (const [method, p, body, headers] of steps) {
        ref.advance(60_000);
        w.clock.advance(60_000);
        const a = await fetch(`${ref.url}${p}`, {
          method,
          headers: { authorization: `Bearer ${refToken}`, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const b = await w.call(method, p, { token, body, headers });
        expect([b.status, await b.text()], `${method} ${p}`).toEqual([a.status, await a.text()]);
      }
      for (const p of [
        '/v1/index.json',
        '/v1/entries/alp/mine.json',
        '/v1/entries/alp/two.json',
        '/v1/entries/alp/mine/1.json',
        '/v1/entries/alp/mine/2.json',
      ]) {
        const a = await (await fetch(`${ref.url}${p}`)).text();
        const b = await (await w.call('GET', p)).text();
        expect(`${b}\n`, p).toBe(a);
      }
      const a = await fetch(`${ref.url}/v1/entries/alp/two/1.json`);
      const b = await w.call('GET', '/v1/entries/alp/two/1.json');
      expect([b.status, await b.text()]).toEqual([a.status, await a.text()]);
    } finally {
      await ref.close();
    }
  });
});
