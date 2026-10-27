import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredential, writePublisher } from '../../src/catalog/store.js';
import { parseArgs } from '../../src/cli/args.js';
import { help } from '../../src/cli/help.js';
import { runCatalog } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
import type { EntryContent } from '../../src/core/edit.js';
import { createMarketClient } from '../../src/market/client.js';
import { createHandler } from '../../src/market/worker/handler.js';
import { withLang, withLangAsync } from '../helpers.js';
import { skipSqlite } from '../market/d1-sqlite.js';
import { type FakeUser, fakeGitHub } from '../market/fake-github.js';
import { makeEnv } from '../market/worker-env.js';

const URL_ = 'http://127.0.0.1:8787';
const CLIENT_ID = 'Ov23liVCN9Nf6VlLv3St';
const SECRET = 'test-client-secret-0000';
// fixtures only; never shaped like real provider tokens
const GH = {
  pub: 'test_github_token_pub_aaaaaaaaa',
  admin: 'test_github_token_admin_bbbbbbb',
  reader: 'test_github_token_rep_cccccccc',
  bob: 'test_github_token_bob_ddddddddd',
};
const user = (id: number, login: string): FakeUser => ({ id, login, name: `${login} Name`, type: 'User' });
const USERS: Record<string, FakeUser> = {
  [GH.pub]: user(7, 'pub'),
  [GH.admin]: user(65018489, 'alpadalar'),
  [GH.reader]: user(8, 'reader'),
  [GH.bob]: user(9, 'bob'),
};
const CONTENT = { layout: { lines: [[{ id: 'm', type: 'model' }]] } } as unknown as EntryContent;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‮]/;

let root = '';
let cfg = '';
let step = 0;
const T0 = Date.parse('2026-10-17T10:00:00.000Z');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-admin-'));
  cfg = path.join(root, 'config.json');
  fs.writeFileSync(cfg, `${JSON.stringify({ lines: [[{ id: 'm', type: 'model' }]] }, null, 2)}\n`);
  step = 0;
});
afterEach(() => {
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const dirOf = (who: string) => path.join(root, who, 'catalog');

interface RunOpts {
  tty?: boolean;
  answers?: boolean[];
  fetch?: typeof fetch;
}

// each run is a minute later, past the 30 s refresh floor
async function run(who: string, argv: string[], opts: RunOpts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const io: PromptIo = {
    tty: opts.tty ?? false,
    columns: 100,
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? false;
    },
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  };
  process.exitCode = undefined;
  step += 1;
  await runCatalog(parseArgs(['catalog', ...argv]), cfg, {
    io,
    dir: dirOf(who),
    env: { CCINFOBAR_MARKETPLACE_URL: URL_, CCINFOBAR_CACHE_DIR: path.join(root, who, 'cache') },
    gsd: true,
    now: () => new Date(T0 + step * 60_000),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, asked, code, text: [...out, ...err].join('\n') };
}

async function market() {
  const { env, db, clock } = await makeEnv({ ADMIN_GITHUB_IDS: '65018489', GITHUB_CLIENT_SECRET: SECRET });
  const gh = fakeGitHub({ users: USERS, checkToken: { clientId: CLIENT_ID, secret: SECRET } });
  const handler = createHandler(env, { now: clock.now, fetch: gh.fetch });
  const seen: { method: string; path: string; status: number }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const res = await handler.fetch(req);
    seen.push({ method: req.method, path: new URL(req.url).pathname, status: res.status });
    return res;
  }) as typeof fetch;
  const tokens: Record<string, string> = {};
  // signs in like catalog login and stores the token in that user's catalog
  const signIn = async (who: keyof typeof GH) => {
    const s = await createMarketClient({ endpoint: URL_, fetch: fetchFn }).signIn(GH[who]);
    writeCredential(URL_, s.token, dirOf(who));
    writePublisher(URL_, s.handle, dirOf(who));
    tokens[who] = s.token;
    return s;
  };
  const client = (who: string) => createMarketClient({ endpoint: URL_, fetch: fetchFn, token: tokens[who]! });
  const publish = (who: string, slug: string, name = slug) =>
    client(who).publish({
      kind: 'preset',
      slug,
      name,
      description: `${name} layout`,
      author: who,
      content: CONTENT,
      note: 'first',
    });
  const cli = (who: string, argv: string[], opts: RunOpts = {}) =>
    run(who, argv, { fetch: fetchFn, ...opts });
  return { db, seen, fetch: fetchFn, signIn, client, publish, cli };
}

type Market = Awaited<ReturnType<typeof market>>;

// a pending pub/mini, an admin, a reader and a live report on it
async function seeded(): Promise<Market> {
  const m = await market();
  await m.signIn('pub');
  await m.signIn('admin');
  await m.signIn('reader');
  await m.publish('pub', 'mini', 'Mini');
  return m;
}

async function live(m: Market, id: string): Promise<void> {
  const admin = m.client('admin');
  const review = await admin.admin.review(id);
  await admin.admin.approve(id, review.etag!);
}

describe('catalog admin usage', () => {
  it('prints its own usage and stays out of the main help', async () => {
    const r = await run('admin', ['admin']);
    expect(r.code).toBeUndefined();
    expect(r.out.join('\n')).toContain('ccinfobar catalog admin pending');
    expect(r.out.join('\n')).toContain('ccinfobar catalog admin ban <handle>');
    const bad = await run('admin', ['admin', 'nope']);
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).toContain('ccinfobar catalog admin pending');
    const main = withLang('en', () => help());
    expect(main).toContain('catalog login');
    expect(main).not.toContain('catalog admin');
    expect(main).not.toContain('catalog report');
  });

  it('lists report in the catalog usage but not the admin commands', async () => {
    const r = await run('admin', ['nope']);
    expect(r.err.join('\n')).toContain('ccinfobar catalog report <publisher/slug> --reason <text>');
    expect(r.err.join('\n')).not.toContain('catalog admin');
  });

  it('needs an argument and a sign-in before any request', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new Error('no request expected');
    }) as typeof fetch;
    const usage = await run('admin', ['admin', 'show'], { fetch: fetchFn });
    expect(usage.code).toBe(1);
    expect(usage.err.join('\n')).toContain('Usage:');
    const bad = await run('admin', ['admin', 'show', 'nope'], { fetch: fetchFn });
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).toContain('nope is not a marketplace id');
    const out = await run('admin', ['admin', 'pending'], { fetch: fetchFn });
    expect(out.code).toBe(1);
    expect(out.err.join('\n')).toContain('Sign in first: ccinfobar catalog login');
    const json = await run('admin', ['admin', 'pending', '--json'], { fetch: fetchFn });
    expect(JSON.parse(json.out[0]!)).toMatchObject({ endpoint: URL_, code: 'sign-in' });
    expect(calls).toBe(0);
  });
});

describe('catalog report', () => {
  it('checks the reason and the sign-in before any request', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      throw new Error('no request expected');
    }) as typeof fetch;
    for (const argv of [
      ['report', 'alice/x'],
      ['report', 'alice/x', '--reason', '   '],
      ['report', 'alice/x', '--reason', 'x'.repeat(201)],
      ['report', 'alice/x', '--reason'],
    ]) {
      const r = await run('reader', argv, { fetch: fetchFn });
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n')).toContain('Give a reason of 1 to 200 characters with --reason');
    }
    const id = await run('reader', ['report', 'nope', '--reason', 'spam'], { fetch: fetchFn });
    expect(id.err.join('\n')).toContain('nope is not a marketplace id');
    const out = await run('reader', ['report', 'alice/x', '--reason', 'spam'], { fetch: fetchFn });
    expect(out.code).toBe(1);
    expect(out.err.join('\n')).toContain('Sign in first: ccinfobar catalog login');
    expect(calls).toBe(0);
  });
});

describe.skipIf(skipSqlite)('catalog report and admin against the Worker', () => {
  it('reports an entry once', async () => {
    const m = await seeded();
    await live(m, 'pub/mini');
    const r = await m.cli('reader', ['report', 'pub/mini', '--reason', '  spam  ']);
    expect(r.code).toBeUndefined();
    expect(r.out).toEqual(['Reported pub/mini to the marketplace admins.']);
    const again = await m.cli('reader', ['report', 'pub/mini', '--reason', 'spam']);
    expect(again.code).toBeUndefined();
    expect(again.out).toEqual(['You already reported pub/mini.']);
    const reports = await m.client('admin').admin.reports();
    expect(reports.map((x) => [x.entry, x.reporter, x.reason])).toEqual([['pub/mini', 'reader', 'spam']]);
    const json = await m.cli('reader', ['report', 'pub/mini', '--reason', 'spam', '--json']);
    expect(JSON.parse(json.out[0]!)).toEqual({
      schema: 1,
      endpoint: URL_,
      entry: 'pub/mini',
      reported: false,
      already: true,
    });
    const gone = await m.cli('reader', ['report', 'pub/none', '--reason', 'spam']);
    expect(gone.code).toBe(1);
    expect(gone.err.join('\n')).toContain('pub/none is not on the marketplace');
    m.db.close();
  });

  it('lists pending entries, shows one and lists reports for an admin', async () => {
    const m = await seeded();
    await m.signIn('bob');
    await m.publish('bob', 'live', 'Bob Live');
    await live(m, 'bob/live');
    await m.cli('reader', ['report', 'bob/live', '--reason', 'looks like spam']);

    const pending = await m.cli('admin', ['admin', 'pending']);
    expect(pending.code).toBeUndefined();
    const text = pending.out.join('\n');
    expect(text).toContain(`Waiting for review on ${URL_}`);
    expect(text).toMatch(/pub\/mini\s+Preset\s+Mini\s+@pub\s+v1\s+/);
    expect(text).not.toContain('bob/live');
    expect(text).toContain('Review one with: ccinfobar catalog admin show <publisher/slug>');
    const pj = JSON.parse((await m.cli('admin', ['admin', 'pending', '--json'])).out[0]!);
    expect(pj.endpoint).toBe(URL_);
    expect(pj.entries.map((e: { id: string }) => e.id)).toEqual(['pub/mini']);
    expect(pj.entries[0].createdAt).toEqual(expect.any(String));

    const show = await m.cli('admin', ['admin', 'show', 'pub/mini']);
    expect(show.code).toBeUndefined();
    const shown = show.out.join('\n');
    expect(show.out[0]).toBe('Mini  pub/mini');
    expect(shown).toContain('Preset · v1 · by pub (pub) · Waiting for review');
    expect(shown).toContain('Mini layout');
    expect(shown).toContain('"type": "model"');
    expect(shown).toMatch(/Review tag: [0-9a-f]{64}-\d+/);
    expect(shown).toMatch(/ccinfobar catalog admin approve pub\/mini --tag [0-9a-f]{64}-\d+/);
    const sj = JSON.parse((await m.cli('admin', ['admin', 'show', 'pub/mini', '--json'])).out[0]!);
    expect(sj).toMatchObject({
      endpoint: URL_,
      entry: { id: 'pub/mini', state: 'pending' },
      content: CONTENT,
    });
    expect(sj.etag).toMatch(/^"[0-9a-f]{64}-\d+"$/);

    const reports = await m.cli('admin', ['admin', 'reports']);
    expect(reports.code).toBeUndefined();
    const rt = reports.out.join('\n');
    expect(rt).toContain(`Open reports on ${URL_}`);
    expect(rt).toMatch(/#1\s+bob\/live\s+@reader/);
    expect(rt).toContain('looks like spam');
    expect(rt).toContain('Close one with: ccinfobar catalog admin resolve <number>');
    const rj = JSON.parse((await m.cli('admin', ['admin', 'reports', '--json'])).out[0]!);
    expect(rj.reports.map((x: { reason: string }) => x.reason)).toEqual(['looks like spam']);
    m.db.close();
  });

  it('says when nothing waits and nothing is reported', async () => {
    const m = await market();
    await m.signIn('admin');
    expect((await m.cli('admin', ['admin', 'pending'])).out).toContain(
      '  No entries are waiting for review.',
    );
    expect((await m.cli('admin', ['admin', 'reports'])).out).toContain('  No open reports.');
    m.db.close();
  });

  it('tells a non-admin that only admins can do this', async () => {
    const m = await seeded();
    for (const argv of [
      ['admin', 'pending'],
      ['admin', 'reports'],
      ['admin', 'show', 'pub/mini'],
    ]) {
      const r = await m.cli('pub', argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n')).toContain('Only marketplace admins can do this');
    }
    const json = await m.cli('pub', ['admin', 'pending', '--json']);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ code: 'not-admin' });
    m.db.close();
  });

  it('asks to sign in again when the token is no longer valid', async () => {
    const m = await seeded();
    await m.client('admin').logout();
    const r = await m.cli('admin', ['admin', 'pending']);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('Sign in first: ccinfobar catalog login');
    m.db.close();
  });

  it('prints reviewed content as text without terminal sequences', async () => {
    const m = await seeded();
    const evil = {
      entry: {
        id: 'pub/mini',
        kind: 'preset',
        name: 'Mi\u001b]8;;https://example.com\u0007ni',
        description: 'a\u001b[31mred‮',
        author: 'pub',
        publisher: 'pub',
        version: 1,
        updatedAt: '2026-10-17T10:00:00.000Z',
        hash: 'a'.repeat(64),
        state: 'pending',
        versions: [{ version: 1, at: '2026-10-17T10:00:00.000Z', note: 'n\u001b[2J', hash: 'a'.repeat(64) }],
      },
      content: {
        layout: { lines: [[{ id: 't', type: 'text', options: { text: 'x\u001b[31my\u009b' } }]] },
      },
      hash: 'a'.repeat(64),
    };
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(new Request(input, init).url);
      if (u.pathname === '/v1/admin/entries/pub/mini.json' || u.pathname === '/v1/admin/entries/pub/mini')
        return new Response(JSON.stringify(evil), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: `"${'a'.repeat(64)}-1"` },
        });
      return m.fetch(input, init);
    }) as typeof fetch;
    const r = await m.cli('admin', ['admin', 'show', 'pub/mini'], { fetch: fetchFn });
    expect(r.code).toBeUndefined();
    expect(r.text).not.toMatch(CONTROL);
    expect(r.text).toContain('"type": "text"');
    m.db.close();
  });

  it('speaks Turkish', async () => {
    const m = await seeded();
    await live(m, 'pub/mini');
    const r = await withLangAsync('tr', () => m.cli('reader', ['report', 'pub/mini', '--reason', 'spam']));
    expect(r.out).toEqual(['pub/mini marketplace yöneticilerine bildirildi.']);
    const p = await withLangAsync('tr', () => m.cli('pub', ['admin', 'pending']));
    expect(p.err.join('\n')).toContain('Bunu yalnızca marketplace yöneticileri yapabilir');
    const u = await withLangAsync('tr', () => run('admin', ['admin']));
    expect(u.out.join('\n')).toMatch(/^Kullanım: ccinfobar catalog admin pending/);
    m.db.close();
  });
});

const ids = (text: string) => [...text.matchAll(/\b([a-z0-9-]+\/[a-z0-9-]+)\b/g)].map((x) => x[1]);

async function remoteIds(m: Market): Promise<string[]> {
  const r = await m.cli('reader', ['list', '--remote', '--refresh', '--json']);
  expect(r.code).toBeUndefined();
  return JSON.parse(r.out[0]!).entries.map((e: { id: string }) => e.id);
}

const writes = (m: Market) => m.seen.filter((s) => s.method !== 'GET').length;

describe.skipIf(skipSqlite)('catalog admin moderation against the Worker', () => {
  it('approves the reviewed version so it shows in the remote list', async () => {
    const m = await seeded();
    expect(await remoteIds(m)).toEqual([]);
    // without --tag and without a terminal it needs --yes (WR-01)
    const no = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--note', 'ok']);
    expect(no.code).toBe(1);
    expect(no.err.join('\n')).toContain('Review it with ccinfobar catalog admin show pub/mini');
    expect(await remoteIds(m)).toEqual([]);
    const nj = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--json']);
    expect(JSON.parse(nj.out[0]!)).toMatchObject({ id: 'pub/mini', code: 'needs-yes' });
    const r = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--note', 'ok', '--yes']);
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toMatch(/^This goes live: Mini \(pub\/mini\) v1, content hash [0-9a-f]{12}…$/);
    expect(r.out[1]).toBe('Approved pub/mini v1; it is live now.');
    expect(await remoteIds(m)).toEqual(['pub/mini']);
    const again = await m.cli('admin', ['admin', 'approve', 'pub/mini']);
    expect(again.code).toBe(1);
    expect(again.err.join('\n')).toContain('pub/mini is not waiting for review');
    const log = (await m.db.prepare('SELECT action, note FROM moderation').all()).results;
    expect(log).toEqual([{ action: 'approve', note: 'ok' }]);
    m.db.close();
  });

  it('without --tag in a terminal, shows what goes live and asks first (WR-01)', async () => {
    const m = await seeded();
    const no = await m.cli('admin', ['admin', 'approve', 'pub/mini'], { tty: true, answers: [false] });
    expect(no.out[0]).toMatch(/^This goes live: Mini \(pub\/mini\) v1, content hash [0-9a-f]{12}…$/);
    expect(no.asked).toEqual(['Approve pub/mini as shown? Its publisher becomes trusted.']);
    expect(no.out.at(-1)).toBe('Nothing was changed.');
    expect(await remoteIds(m)).toEqual([]);
    const yes = await m.cli('admin', ['admin', 'approve', 'pub/mini'], { tty: true, answers: [true] });
    expect(yes.out.at(-1)).toBe('Approved pub/mini v1; it is live now.');
    expect(await remoteIds(m)).toEqual(['pub/mini']);
    const tr = await m.cli('admin', ['admin', 'approve', 'pub/none'], { tty: true });
    expect(tr.code).toBe(1);
    m.db.close();
  });

  it('approves only the tag that was reviewed', async () => {
    const m = await seeded();
    const shown = (await m.cli('admin', ['admin', 'show', 'pub/mini'])).out.join('\n');
    const tag = /--tag (\S+)/.exec(shown)![1]!;
    await m.client('pub').addVersion('pub/mini', 1, { content: CONTENT, note: 'second', name: 'Mini 2' });
    const before = writes(m);
    const stale = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--tag', tag]);
    expect(stale.code).toBe(1);
    expect(stale.err.join('\n')).toContain(
      'pub/mini changed since it was reviewed; run ccinfobar catalog admin show pub/mini again',
    );
    expect(writes(m)).toBe(before);
    const bad = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--tag', 'nope']);
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).toContain('nope is not a review tag');
    const fresh = /--tag (\S+)/.exec(
      (await m.cli('admin', ['admin', 'show', 'pub/mini'])).out.join('\n'),
    )![1]!;
    const ok = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--tag', `"${fresh}"`, '--json']);
    expect(ok.code).toBeUndefined();
    expect(JSON.parse(ok.out[0]!)).toEqual({ schema: 1, endpoint: URL_, id: 'pub/mini', approved: true });
    expect(await remoteIds(m)).toEqual(['pub/mini']);
    m.db.close();
  });

  it('approves with the shown tag when Cloudflare weakens the ETag', async () => {
    const m = await seeded();
    // compressed answers come back with W/ tags through Cloudflare
    const weak = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await m.fetch(input, init);
      const tag = res.headers.get('etag');
      if (!tag || tag.startsWith('W/')) return res;
      const headers = new Headers(res.headers);
      headers.set('etag', `W/${tag}`);
      return new Response(await res.text(), { status: res.status, headers });
    }) as typeof fetch;
    const shown = (await m.cli('admin', ['admin', 'show', 'pub/mini'], { fetch: weak })).out.join('\n');
    const tag = /--tag (\S+)/.exec(shown)![1]!;
    expect(tag).toMatch(/^[0-9a-f]{64}-\d+$/);
    const ok = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--tag', tag, '--json'], {
      fetch: weak,
    });
    expect(ok.code).toBeUndefined();
    expect(JSON.parse(ok.out[0]!)).toMatchObject({ id: 'pub/mini', approved: true });
    expect(await remoteIds(m)).toEqual(['pub/mini']);
    m.db.close();
  });

  it('approves without a tag when Cloudflare weakens the ETag', async () => {
    const m = await seeded();
    const weak = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await m.fetch(input, init);
      const tag = res.headers.get('etag');
      if (!tag || tag.startsWith('W/')) return res;
      const headers = new Headers(res.headers);
      headers.set('etag', `W/${tag}`);
      return new Response(await res.text(), { status: res.status, headers });
    }) as typeof fetch;
    const ok = await m.cli('admin', ['admin', 'approve', 'pub/mini', '--yes', '--json'], { fetch: weak });
    expect(ok.code).toBeUndefined();
    expect(await remoteIds(m)).toEqual(['pub/mini']);
    m.db.close();
  });

  it('rejects after confirmation', async () => {
    const m = await seeded();
    const before = m.seen.length;
    const no = await m.cli('admin', ['admin', 'reject', 'pub/mini']);
    expect(no.code).toBe(1);
    expect(no.err.join('\n')).toContain('Nothing was changed. Run again with --yes to confirm.');
    const json = await m.cli('admin', ['admin', 'reject', 'pub/mini', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ id: 'pub/mini', code: 'needs-yes' });
    const kept = await m.cli('admin', ['admin', 'reject', 'pub/mini'], { tty: true, answers: [false] });
    expect(kept.code).toBeUndefined();
    expect(kept.asked).toEqual(['Reject pub/mini? Its pending versions are deleted.']);
    expect(kept.out).toEqual(['Nothing was changed.']);
    expect(m.seen.length).toBe(before);
    const yes = await m.cli('admin', ['admin', 'reject', 'pub/mini'], { tty: true, answers: [true] });
    expect(yes.out).toEqual(['Rejected pub/mini; its pending versions were deleted.']);
    expect((await m.cli('admin', ['admin', 'pending', '--json'])).out[0]).toContain('"entries":[]');
    m.db.close();
  });

  it('removes a live entry so its versions answer 410', async () => {
    const m = await seeded();
    await live(m, 'pub/mini');
    const r = await m.cli('admin', ['admin', 'remove', 'pub/mini', '--yes', '--note', 'spam']);
    expect(r.code).toBeUndefined();
    expect(r.out).toEqual([
      "Removed pub/mini from the marketplace; its publisher's next entry needs review.",
    ]);
    expect((await m.fetch(`${URL_}/v1/entries/pub/mini/1.json`)).status).toBe(410);
    expect(await remoteIds(m)).toEqual([]);
    const again = await m.cli('admin', ['admin', 'remove', 'pub/mini', '--yes']);
    expect(again.err.join('\n')).toContain('pub/mini is already withdrawn or removed');
    const json = await m.cli('admin', ['admin', 'remove', 'pub/none', '--yes', '--json']);
    expect(JSON.parse(json.out[0]!)).toMatchObject({ id: 'pub/none', code: 'not-found' });
    expect(json.err.join('\n')).toContain('pub/none is not on the marketplace');
    m.db.close();
  });

  it('bans and unbans a publisher', async () => {
    const m = await seeded();
    await m.signIn('bob');
    await m.publish('bob', 'live', 'Bob Live');
    await live(m, 'bob/live');
    expect(await remoteIds(m)).toEqual(['bob/live']);
    const no = await m.cli('admin', ['admin', 'ban', 'bob']);
    expect(no.code).toBe(1);
    const asked = await m.cli('admin', ['admin', 'ban', '@bob'], { tty: true, answers: [true] });
    expect(asked.asked).toEqual([
      'Ban @bob? Their entries leave the marketplace list, their entries waiting for review are deleted, and they can no longer publish or report.',
    ]);
    expect(asked.out).toEqual([
      'Banned @bob; their entries left the marketplace list and their entries waiting for review were deleted.',
    ]);
    expect(await remoteIds(m)).toEqual([]);
    const un = await m.cli('admin', ['admin', 'unban', 'bob', '--json']);
    expect(JSON.parse(un.out[0]!)).toEqual({ schema: 1, endpoint: URL_, handle: 'bob', banned: false });
    expect(await remoteIds(m)).toEqual(['bob/live']);
    const text = await m.cli('admin', ['admin', 'unban', 'bob']);
    expect(text.out).toEqual(['Unbanned @bob; their live entries are back in the marketplace list.']);
    const self = await m.cli('admin', ['admin', 'ban', 'alpadalar', '--yes']);
    expect(self.err.join('\n')).toContain('@alpadalar is an admin and cannot be banned');
    const nobody = await m.cli('admin', ['admin', 'ban', 'ghost', '--yes']);
    expect(nobody.err.join('\n')).toContain('There is no publisher @ghost on the marketplace');
    const bad = await m.cli('admin', ['admin', 'ban', 'Bad_Name', '--yes']);
    expect(bad.code).toBe(1);
    expect(bad.err.join('\n')).toContain('A publisher handle is 1 to 39 lowercase letters');
    m.db.close();
  });

  it('resolves a report', async () => {
    const m = await seeded();
    await live(m, 'pub/mini');
    await m.cli('reader', ['report', 'pub/mini', '--reason', 'spam']);
    const r = await m.cli('admin', ['admin', 'resolve', '1']);
    expect(r.code).toBeUndefined();
    expect(r.out).toEqual(['Closed report #1.']);
    expect((await m.cli('admin', ['admin', 'reports'])).out).toContain('  No open reports.');
    const json = await m.cli('admin', ['admin', 'resolve', '1', '--json']);
    expect(JSON.parse(json.out[0]!)).toEqual({ schema: 1, endpoint: URL_, id: 1, resolved: true });
    const unknown = await m.cli('admin', ['admin', 'resolve', '99']);
    expect(unknown.err.join('\n')).toContain('There is no report #99');
    const bad = await m.cli('admin', ['admin', 'resolve', 'x1']);
    expect(bad.err.join('\n')).toContain('x1 is not a report number');
    m.db.close();
  });

  it('keeps JSON English and the text Turkish under tr', async () => {
    const m = await seeded();
    const json = await withLangAsync('tr', () =>
      m.cli('admin', ['admin', 'approve', 'pub/mini', '--yes', '--json']),
    );
    expect(JSON.parse(json.out[0]!)).toEqual({ schema: 1, endpoint: URL_, id: 'pub/mini', approved: true });
    const no = await withLangAsync('tr', () => m.cli('admin', ['admin', 'remove', 'pub/mini']));
    expect(no.err.join('\n')).toContain(
      'Hiçbir şey değiştirilmedi. Onaylamak için --yes ile tekrar çalıştırın.',
    );
    const r = await withLangAsync('tr', () => m.cli('admin', ['admin', 'remove', 'pub/mini', '--yes']));
    expect(r.out).toEqual([
      "pub/mini marketplace'ten kaldırıldı; yayıncısının sonraki girdisi yeniden incelenir.",
    ]);
    const nope = await withLangAsync('tr', () =>
      m.cli('admin', ['admin', 'remove', 'pub/mini', '--yes', '--json']),
    );
    expect(JSON.parse(nope.out[0]!)).toMatchObject({ code: 'conflict' });
    expect(ids(nope.err.join('\n'))).toEqual(['pub/mini']);
    m.db.close();
  });
});
