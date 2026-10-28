import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import {
  INDEX_PAGE,
  type MarketSummary,
  parseIndex,
  parseRemoteEntry,
  parseRemoteVersion,
} from '../../src/market/protocol.js';
import { MESSAGES, order, tombOf, toSummary } from '../../src/market/rules.js';
import type { D1Database, Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import {
  EMPTY_INDEX,
  entryDocText,
  indexEtag,
  pageStatements,
  readEntryDoc,
  readIndexPage,
  readVersionDoc,
  rebuildIndex,
  summaryText,
} from '../../src/market/worker/store.js';
import { START } from './conformance.js';
import { skipSqlite } from './d1-sqlite.js';
import { makeRefTarget } from './ref-target.js';
import { makeEnv } from './worker-env.js';
import { ISO, seedEntry, seedPublisher, seedToken, storedEntry } from './worker-seed.js';

const BASE = 'http://w.test';
const preset = (type = 'model') => ({ layout: { lines: [[{ type }]] } }) as unknown as EntryContent;
const at = (ms: number) => new Date(START + ms).toISOString();

async function gen(db: D1Database): Promise<number> {
  return Number(await db.prepare("SELECT n FROM counters WHERE k = 'gen'").first<number>('n'));
}

// counts statements and keeps their SQL
function counted(db: D1Database): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    db: {
      prepare: (s) => {
        sql.push(s);
        return db.prepare(s);
      },
      batch: (list) => db.batch(list),
      exec: (s) => db.exec(s),
    },
  };
}

async function setup() {
  const { env, clock } = await makeEnv();
  const c = counted(env.DB);
  const h = createHandler({ ...env, DB: c.db } as Env, {
    now: clock.now,
    fetch: () => Promise.reject(new Error('no fetch')),
  });
  const get = (p: string, headers: Record<string, string> = {}) => {
    c.sql.length = 0;
    return h.fetch(new Request(BASE + p, { headers }));
  };
  return { db: env.DB, sql: c.sql, get };
}

describe.skipIf(skipSqlite)('worker store', () => {
  it('serves an empty index before any rebuild', async () => {
    const { env } = await makeEnv();
    const page = await readIndexPage(env.DB, 1);
    expect(page).toEqual({ body: EMPTY_INDEX, etag: '"g0"' });
    expect(parseIndex(JSON.parse(page!.body))!.entries).toEqual([]);
    expect(await indexEtag(env.DB)).toBe('"g0"');
    expect(await readIndexPage(env.DB, 2)).toBeNull();
    expect(await indexEtag(env.DB, 2)).toBeNull();
  });

  it('seeds publishers and sha256 tokens', async () => {
    const { env } = await makeEnv();
    await seedPublisher(env.DB, { handle: 'alp', githubId: 7, trusted: true, banned: true });
    const token = await seedToken(env.DB, 'alp');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const digest = createHash('sha256').update(token).digest('hex');
    expect(
      await env.DB.prepare('SELECT handle FROM tokens WHERE sha256 = ?1').bind(digest).first('handle'),
    ).toBe('alp');
    expect(await env.DB.prepare('SELECT trusted, banned_at FROM publishers').first()).toEqual({
      trusted: 1,
      banned_at: ISO,
    });
  });

  it('builds page 1 for an empty marketplace', async () => {
    const { env } = await makeEnv();
    await rebuildIndex(env.DB, ISO);
    const page = await readIndexPage(env.DB, 1);
    expect(page!.body).toBe(JSON.stringify({ entries: [], generatedAt: ISO, gen: 0 }));
    expect(page!.etag).toBe('"g0"');
  });

  it('pages 501 entries at INDEX_PAGE in publisher, slug order', async () => {
    const { env } = await makeEnv();
    const ids: string[] = [];
    for (let i = 0; i < 501; i++) ids.push(`p${(i * 7) % 13}/s${i}`);
    for (const id of ids)
      await seedEntry(env.DB, { id, versions: [{ content: preset() }] }, { rebuild: false });
    await rebuildIndex(env.DB, ISO);
    const g = await gen(env.DB);
    expect(g).toBe(501);
    const one = (await readIndexPage(env.DB, 1))!;
    const two = (await readIndexPage(env.DB, 2))!;
    expect([one.etag, two.etag]).toEqual(['"g501"', '"g501"']);
    const p1 = parseIndex(JSON.parse(one.body))!;
    const p2 = parseIndex(JSON.parse(two.body), 2)!;
    expect(p1.entries).toHaveLength(INDEX_PAGE);
    expect(p1.next).toBe('index-2.json');
    expect(p2.entries).toHaveLength(1);
    expect(p2.next).toBeUndefined();
    expect(JSON.parse(two.body)).not.toHaveProperty('next');
    const got = [...p1.entries, ...p2.entries].map((e) => e.id);
    const want = ids
      .map((id) => ({ id }) as MarketSummary)
      .sort(order)
      .map((s) => s.id);
    expect(got).toEqual(want);
    expect(await readIndexPage(env.DB, 3)).toBeNull();
  });

  it('keeps pending, banned and withdrawn entries out of the index', async () => {
    const { env } = await makeEnv();
    await seedPublisher(env.DB, { handle: 'alp', githubId: 1, trusted: true });
    await seedPublisher(env.DB, { handle: 'bad', githubId: 2, banned: true });
    await seedEntry(env.DB, { id: 'alp/live', versions: [{ content: preset() }] });
    await seedEntry(env.DB, { id: 'alp/wait', state: 'pending', versions: [{ content: preset() }] });
    await seedEntry(env.DB, { id: 'bad/one', versions: [{ content: preset() }] });
    await seedEntry(env.DB, {
      id: 'alp/gone',
      state: 'withdrawn',
      versions: [{ content: preset(), note: 'first' }],
    });
    await seedEntry(env.DB, { id: 'alp/out', state: 'removed', versions: [{ content: preset() }] });
    const page = (await readIndexPage(env.DB, 1))!;
    expect(parseIndex(JSON.parse(page.body))!.entries.map((e) => e.id)).toEqual(['alp/live']);
    expect(page.body).not.toMatch(/wait|bad\/one|gone|alp\/out/);
    const tomb = (await readEntryDoc(env.DB, 'alp', 'gone'))!;
    expect(tomb.state).toBe('withdrawn');
    const e = parseRemoteEntry(JSON.parse(tomb.doc))!;
    expect(e).toMatchObject({ withdrawn: true, name: '', description: '', author: '' });
    expect(e.versions.map((v) => v.note)).toEqual(['']);
    expect(tomb.doc).not.toMatch(/Name gone|"desc"|"Alp"|"first"/);
    expect((await readEntryDoc(env.DB, 'bad', 'one'))!.banned).toBe(true);
    expect((await readEntryDoc(env.DB, 'alp', 'wait'))!.state).toBe('pending');
    expect(await readEntryDoc(env.DB, 'alp', 'nope')).toBeNull();
    const v = (await readVersionDoc(env.DB, 'alp', 'gone', 1))!;
    expect(v).toMatchObject({ state: 'withdrawn', found: true, body: null, hash: null });
  });

  it('never lets an older rebuild replace or add pages', async () => {
    const { env } = await makeEnv();
    for (let i = 0; i < 501; i++) {
      await seedEntry(
        env.DB,
        { id: `alp/s${String(i).padStart(3, '0')}`, versions: [{ content: preset() }] },
        { rebuild: false },
      );
    }
    await rebuildIndex(env.DB, ISO);
    const g = await gen(env.DB);
    const before = (await readIndexPage(env.DB, 1))!.body;
    await env.DB.batch(pageStatements(env.DB, ['{"entries":[]}', '{"entries":[]}', '{"entries":[]}'], g - 1));
    expect((await readIndexPage(env.DB, 1))!.body).toBe(before);
    expect((await readIndexPage(env.DB, 1))!.etag).toBe(`"g${g}"`);
    expect(await readIndexPage(env.DB, 3)).toBeNull();
    // a newer rebuild with fewer pages drops the old ones
    await env.DB.batch([
      env.DB.prepare("UPDATE entries SET state = 'removed' WHERE slug >= ?1").bind('s010'),
      env.DB.prepare("UPDATE counters SET n = n + 1 WHERE k = 'gen'"),
    ]);
    await rebuildIndex(env.DB, at(60_000));
    expect(await readIndexPage(env.DB, 2)).toBeNull();
    const now = (await readIndexPage(env.DB, 1))!;
    expect(now.etag).toBe(`"g${g + 1}"`);
    expect(parseIndex(JSON.parse(now.body))!.entries).toHaveLength(10);
  });

  it('stores the summary and entry text the reference shapes give', async () => {
    const { env } = await makeEnv();
    const spec = {
      id: 'alp/mine',
      versions: [
        { content: preset(), note: 'first' },
        { content: preset('cwd'), note: 'two', at: at(60_000) },
      ],
    };
    const doc = await seedEntry(env.DB, spec);
    const entry = storedEntry(spec);
    expect(doc).toEqual(entry);
    expect(summaryText(toSummary(entry))).toBe(JSON.stringify(toSummary(entry)));
    expect(entryDocText(entry)).toBe(JSON.stringify(entry));
    const row = (await readEntryDoc(env.DB, 'alp', 'mine'))!;
    expect(row.doc).toBe(JSON.stringify(entry));
    expect(row.etag).toBe(`"${entry.hash}-1"`);
    expect(parseRemoteEntry(JSON.parse(row.doc))).toEqual(parseRemoteEntry(entry));
    const index = parseIndex(JSON.parse((await readIndexPage(env.DB, 1))!.body))!;
    expect(index.entries).toEqual([toSummary(entry)]);
    const v2 = (await readVersionDoc(env.DB, 'alp', 'mine', 2))!;
    expect(v2.hash).toBe(entry.versions[1]!.hash);
    expect(parseRemoteVersion(JSON.parse(v2.body!))!.hash).toBe(v2.hash);
    const tomb = await seedEntry(env.DB, {
      ...spec,
      id: 'alp/old',
      state: 'withdrawn',
      withdrawnAt: at(120_000),
    });
    expect(tomb).toEqual(tombOf(storedEntry({ ...spec, id: 'alp/old' }), at(120_000)));
  });

  it('serves the same bytes as the reference server for the same calls', async () => {
    const t = await makeRefTarget();
    try {
      const token = await t.signIn('alp');
      const send = (method: string, p: string, body: unknown, extra: Record<string, string> = {}) =>
        fetch(`${t.url}${p}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
          body: JSON.stringify(body),
        });
      const base = { kind: 'preset', name: 'Name mine', description: 'desc', author: 'Alp' };
      expect(
        (await send('POST', '/v1/entries', { ...base, slug: 'mine', content: preset(), note: 'first' }))
          .status,
      ).toBe(201);
      expect(
        (await send('POST', '/v1/entries', { ...base, slug: 'old', content: preset(), note: 'first' }))
          .status,
      ).toBe(201);
      t.advance(60_000);
      const r = await send(
        'POST',
        '/v1/entries/alp/mine/versions',
        { content: preset('cwd'), note: 'two' },
        { 'if-match': '"1"' },
      );
      expect(r.status).toBe(201);
      t.advance(60_000);
      const w = await fetch(`${t.url}/v1/entries/alp/old`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(w.status).toBe(200);
      const ref = async (p: string) => (await (await fetch(`${t.url}${p}`)).text()).trimEnd();

      const { env } = await makeEnv();
      await seedEntry(env.DB, {
        id: 'alp/mine',
        versions: [
          { content: preset(), note: 'first' },
          { content: preset('cwd'), note: 'two', at: at(60_000) },
        ],
      });
      await seedEntry(env.DB, {
        id: 'alp/old',
        state: 'withdrawn',
        versions: [{ content: preset(), note: 'first' }],
        withdrawnAt: at(120_000),
      });
      expect((await readEntryDoc(env.DB, 'alp', 'mine'))!.doc).toBe(await ref('/v1/entries/alp/mine.json'));
      expect((await readEntryDoc(env.DB, 'alp', 'old'))!.doc).toBe(await ref('/v1/entries/alp/old.json'));
      expect((await readVersionDoc(env.DB, 'alp', 'mine', 2))!.body).toBe(
        await ref('/v1/entries/alp/mine/2.json'),
      );
      expect((await readVersionDoc(env.DB, 'alp', 'mine', 1))!.body).toBe(
        await ref('/v1/entries/alp/mine/1.json'),
      );
      // each server counts its own index builds (WR-08)
      const noGen = (text: string) => text.replace(/"gen":\d+/, '"gen":0');
      expect(noGen((await readIndexPage(env.DB, 1))!.body)).toBe(noGen(await ref('/v1/index.json')));
    } finally {
      await t.close();
    }
  });
});

describe.skipIf(skipSqlite)('worker public reads', () => {
  async function seeded() {
    const s = await setup();
    await seedPublisher(s.db, { handle: 'alp', githubId: 1, trusted: true });
    await seedPublisher(s.db, { handle: 'bad', githubId: 2, banned: true });
    const mine = await seedEntry(s.db, {
      id: 'alp/mine',
      versions: [
        { content: preset(), note: 'first' },
        { content: preset('cwd'), at: at(60_000) },
      ],
    });
    await seedEntry(s.db, { id: 'alp/wait', state: 'pending', versions: [{ content: preset() }] });
    await seedEntry(s.db, { id: 'bad/one', versions: [{ content: preset() }] });
    await seedEntry(s.db, { id: 'alp/gone', state: 'withdrawn', versions: [{ content: preset() }] });
    return { ...s, mine };
  }

  const error = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

  it('serves index.json with a generation ETag and answers 304', async () => {
    const { get, db } = await seeded();
    const g = await gen(db);
    const r = await get('/v1/index.json');
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe(`"g${g}"`);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(parseIndex(await r.json())!.entries.map((e) => e.id)).toEqual(['alp/mine']);
    for (const inm of [`"g${g}"`, `W/"g${g}"`, `"x", "g${g}"`]) {
      const n = await get('/v1/index.json', { 'if-none-match': inm });
      expect(n.status, inm).toBe(304);
      expect(n.headers.get('etag')).toBe(`"g${g}"`);
      expect(n.headers.get('cache-control')).toBe('no-cache');
      expect(await n.text()).toBe('');
    }
    const stale = await get('/v1/index.json', { 'if-none-match': `"g${g - 1}"` });
    expect(stale.status).toBe(200);
    expect(parseIndex(await stale.json())!.entries).toHaveLength(1);
  });

  it('answers a matching index check with one small row read', async () => {
    const { get, sql, db } = await seeded();
    const g = await gen(db);
    expect((await get('/v1/index.json', { 'if-none-match': `"g${g}"` })).status).toBe(304);
    expect(sql).toHaveLength(1);
    expect(sql[0]).not.toMatch(/body/);
    expect((await get('/v1/index.json', { 'if-none-match': '"g0"' })).status).toBe(200);
    expect(sql).toHaveLength(2);
  });

  it('serves later index pages and 404s pages out of range', async () => {
    const { get, db } = await setup();
    for (let i = 0; i < 501; i++) {
      await seedEntry(
        db,
        { id: `alp/s${String(i).padStart(3, '0')}`, versions: [{ content: preset() }] },
        { rebuild: false },
      );
    }
    await rebuildIndex(db, ISO);
    const two = await get('/v1/index-2.json');
    expect(two.status).toBe(200);
    expect(two.headers.get('etag')).toBe('"g501"');
    expect(parseIndex(await two.json(), 2)!.entries.map((e) => e.id)).toEqual(['alp/s500']);
    expect((await get('/v1/index-2.json', { 'if-none-match': '"g501"' })).status).toBe(304);
    for (const p of [
      '/v1/index-0.json',
      '/v1/index-1.json',
      '/v1/index-3.json',
      '/v1/index-11.json',
      '/v1/index-99999.json',
    ]) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(await error(r)).toBe('not-found');
    }
  });

  it('serves entry and version documents with ETags', async () => {
    const { get, mine } = await seeded();
    const e = await get('/v1/entries/alp/mine.json');
    expect(e.status).toBe(200);
    expect(e.headers.get('etag')).toBe(`"${mine.hash}-1"`);
    expect(e.headers.get('cache-control')).toBe('no-cache');
    expect(await e.text()).toBe(JSON.stringify(mine));
    expect((await get('/v1/entries/alp/mine.json', { 'if-none-match': `"${mine.hash}-1"` })).status).toBe(
      304,
    );
    const v = await get('/v1/entries/alp/mine/1.json');
    expect(v.status).toBe(200);
    expect(v.headers.get('etag')).toBe(`"${mine.versions[0]!.hash}"`);
    expect(parseRemoteVersion(await v.json())!.hash).toBe(mine.versions[0]!.hash);
    const n = await get('/v1/entries/alp/mine/1.json', { 'if-none-match': `"${mine.versions[0]!.hash}"` });
    expect(n.status).toBe(304);
    expect(await n.text()).toBe('');
    expect((await get('/v1/entries/alp/mine/3.json')).status).toBe(404);
  });

  it('hides pending and banned entries and 410s withdrawn versions', async () => {
    const { get } = await seeded();
    for (const p of [
      '/v1/entries/alp/wait.json',
      '/v1/entries/alp/wait/1.json',
      '/v1/entries/bad/one.json',
      '/v1/entries/bad/one/1.json',
      '/v1/entries/alp/nope.json',
      '/v1/entries/alp/nope/1.json',
    ]) {
      const r = await get(p);
      expect(r.status, p).toBe(404);
      expect(await error(r)).toBe('not-found');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
    const tomb = await get('/v1/entries/alp/gone.json');
    expect(tomb.status).toBe(200);
    expect(parseRemoteEntry(await tomb.json())).toMatchObject({ withdrawn: true, name: '' });
    for (const p of ['/v1/entries/alp/gone/1.json', '/v1/entries/alp/gone/7.json']) {
      const r = await get(p);
      expect(r.status, p).toBe(410);
      expect(await r.json()).toEqual({ error: { code: 'withdrawn', message: MESSAGES.withdrawn } });
    }
  });

  it('rejects bad ids before any SQL', async () => {
    const { get, sql } = await seeded();
    for (const [p, message] of [
      ['/v1/entries/..%2F/x.json', 'invalid id'],
      ['/v1/entries/A/b.json', 'invalid id'],
      ['/v1/entries/alp/%E0.json', 'invalid id'],
      ['/v1/entries/alp/mine/0.json', 'invalid version'],
      ['/v1/entries/alp/mine/x.json', 'invalid version'],
      ['/v1/entries/a%20b/mine/1.json', 'invalid id'],
    ] as const) {
      const r = await get(p);
      expect(r.status, p).toBe(400);
      expect(await r.json()).toEqual({ error: { code: 'invalid', message } });
      expect(sql, p).toEqual([]);
    }
  });

  it('never serves a version above the entry version (17-D-17)', async () => {
    const { get, db } = await seeded();
    const before = await indexEtag(db);
    await db
      .prepare('INSERT INTO versions (publisher, slug, version, body) VALUES (?1, ?2, ?3, ?4)')
      .bind('alp', 'mine', 3, JSON.stringify({ version: 3, content: preset('cwd'), hash: 'x'.repeat(64) }))
      .run();
    expect((await get('/v1/entries/alp/mine/3.json')).status).toBe(404);
    expect((await get('/v1/entries/alp/mine/2.json')).status).toBe(200);
    const entry = (await (await get('/v1/entries/alp/mine.json')).json()) as { version: number };
    expect(entry.version).toBe(2);
    expect(await indexEtag(db)).toBe(before);
  });

  it('runs at most two statements per GET', async () => {
    const { get, sql, mine } = await seeded();
    for (const [p, inm] of [
      ['/v1/index.json', null],
      ['/v1/index.json', '"g1"'],
      ['/v1/index-2.json', '"g1"'],
      ['/v1/entries/alp/mine.json', null],
      ['/v1/entries/alp/mine.json', `"${mine.hash}-1"`],
      ['/v1/entries/alp/mine/2.json', null],
      ['/v1/entries/alp/gone/1.json', null],
      ['/v1/entries/bad/one.json', null],
    ] as const) {
      await get(p, inm ? { 'if-none-match': inm } : {});
      expect(sql.length, p).toBeGreaterThan(0);
      expect(sql.length, p).toBeLessThanOrEqual(2);
      for (const s of sql) expect(s).not.toMatch(/alp|mine|gone/);
    }
  });
});
