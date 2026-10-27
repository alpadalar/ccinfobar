import { describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/core/edit.js';
import { createMarketClient, MarketError } from '../../src/market/client.js';
import type { Env } from '../../src/market/worker/env.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { skipSqlite } from './d1-sqlite.js';
import { type FakeUser, fakeGitHub } from './fake-github.js';
import { makeEnv } from './worker-env.js';

const URL_ = 'http://127.0.0.1:8787';
const CLIENT_ID = 'Ov23liVCN9Nf6VlLv3St';
const SECRET = 'test-client-secret-0000';
// fixtures only; never shaped like real provider tokens
const GH = {
  user: 'test_github_token_user_aaaaaaaa',
  admin: 'test_github_token_admin_bbbbbbb',
  reporter: 'test_github_token_rep_cccccccc',
};
const user = (id: number, login: string): FakeUser => ({ id, login, name: `${login} Name`, type: 'User' });
const USERS: Record<string, FakeUser> = {
  [GH.user]: user(7, 'pub'),
  [GH.admin]: user(65018489, 'alpadalar'),
  [GH.reporter]: user(8, 'reader'),
};
const content = { layout: { lines: [[{ type: 'model' }]] } } as unknown as EntryContent;

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MarketError);
    return (err as MarketError).code;
  }
  throw new Error('expected a rejection');
}

async function worker(vars: Partial<Env>) {
  const { env, db, clock } = await makeEnv({ ADMIN_GITHUB_IDS: '65018489', ...vars });
  const gh = fakeGitHub({ users: USERS, checkToken: { clientId: CLIENT_ID, secret: SECRET } });
  const handler = createHandler(env, { now: clock.now, fetch: gh.fetch });
  const seen: { method: string; url: string; auth: string | null }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ method: req.method, url: req.url, auth: req.headers.get('authorization') });
    return handler.fetch(req);
  }) as typeof fetch;
  const client = (token?: string) =>
    createMarketClient({ endpoint: URL_, fetch: fetchFn, ...(token ? { token } : {}) });
  return { db, gh, seen, client };
}

describe.skipIf(skipSqlite)('market client against the Worker', () => {
  it('signs in, publishes for review, approves, reports, resolves and withdraws', async () => {
    const w = await worker({ GITHUB_CLIENT_SECRET: SECRET });
    const anon = w.client();
    const first = await anon.indexIfChanged(null);
    expect(first.changed).toBe(true);
    const oldTag = first.changed ? first.etag : null;
    expect(oldTag).not.toBeNull();

    const signed = await anon.signIn(GH.user);
    expect(signed).toMatchObject({ handle: 'pub', admin: false });
    const pub = w.client(signed.token);
    const out = await pub.publish({
      kind: 'preset',
      slug: 'mini',
      name: 'Mini',
      description: 'small',
      author: 'Pub',
      content,
      note: 'first',
    });
    expect(out).toMatchObject({ id: 'pub/mini', version: 1, pending: true });
    expect((await pub.me()).entries).toEqual([{ id: 'pub/mini', state: 'pending', version: 1 }]);
    expect(await pub.indexIfChanged(oldTag)).toEqual({ changed: false });

    const adminIn = await anon.signIn(GH.admin);
    expect(adminIn.admin).toBe(true);
    const admin = w.client(adminIn.token);
    expect((await admin.admin.pending()).map((e) => e.id)).toEqual(['pub/mini']);
    expect(await failure(pub.admin.pending())).toBe('not-admin');
    const review = await admin.admin.review('pub/mini');
    expect(review.content).toEqual(content);
    expect(review.entry.state).toBe('pending');
    expect(await failure(admin.admin.approve('pub/mini', `"${'0'.repeat(64)}-1"`))).toBe('stale');
    await admin.admin.approve('pub/mini', review.etag!, 'ok');

    const changed = await anon.indexIfChanged(oldTag);
    expect(changed.changed).toBe(true);
    if (!changed.changed) return;
    expect(changed.index.entries.map((e) => e.id)).toEqual(['pub/mini']);
    const before = w.seen.length;
    expect(await anon.indexIfChanged(changed.etag)).toEqual({ changed: false });
    expect(w.seen.length).toBe(before + 1);
    const e = await anon.entry('pub/mini');
    expect(await anon.entryIfChanged('pub/mini', null)).toMatchObject({ changed: true });
    const hash = e.versions[0]!.hash;
    expect((await anon.version('pub/mini', 1, 'preset', hash)).content).toMatchObject(content);

    expect(await admin.admin.reports()).toEqual([]);
    const reporter = w.client((await anon.signIn(GH.reporter)).token);
    const rep = await reporter.report('pub/mini', 'looks like spam');
    expect(await failure(reporter.report('pub/mini', 'again'))).toBe('conflict');
    const reports = await admin.admin.reports();
    expect(reports.map((r) => [r.id, r.entry, r.reporter, r.reason])).toEqual([
      [rep.id, 'pub/mini', 'reader', 'looks like spam'],
    ]);
    await admin.admin.resolve(rep.id);
    expect(await admin.admin.reports()).toEqual([]);

    await pub.withdraw('pub/mini');
    expect(await failure(anon.version('pub/mini', 1, 'preset', hash))).toBe('withdrawn');
    await pub.logout();
    expect(await failure(pub.me())).toBe('unauthorized');

    // tokens only on writes, /v1/me and /v1/admin/*
    for (const s of w.seen) {
      const path = new URL(s.url).pathname;
      const account = path === '/v1/me' || path.startsWith('/v1/admin/');
      if (s.method === 'GET' && !account) expect(s.auth, s.url).toBeNull();
      if (account) expect(s.auth, s.url).not.toBeNull();
      if (path === '/v1/auth/github') expect(s.auth).toBeNull();
    }
    // GitHub verified each token with our client id, then revoked it
    const app = w.gh.calls.filter((c) => c.url.endsWith(`/applications/${CLIENT_ID}/token`));
    expect(app.map((c) => c.method)).toEqual(['POST', 'DELETE', 'POST', 'DELETE', 'POST', 'DELETE']);

    const tables = (await w.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()) as unknown as { results: { name: string }[] };
    expect(tables.results.length).toBeGreaterThan(5);
    for (const { name } of tables.results) {
      const rows = JSON.stringify((await w.db.prepare(`SELECT * FROM "${name}"`).all()).results);
      for (const secret of [...Object.values(GH), SECRET]) expect(rows, name).not.toContain(secret);
    }
    w.db.close();
  });

  it('sign-in on a Worker without the client secret is unavailable and asks GitHub nothing', async () => {
    const w = await worker({});
    expect(await failure(w.client().signIn(GH.user))).toBe('unavailable');
    expect(w.gh.calls).toHaveLength(0);
    w.db.close();
  });
});
