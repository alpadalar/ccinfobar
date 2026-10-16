import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendVersion,
  type CatalogEntry,
  type EntryContent,
  latest,
  markPublished,
  newEntry,
  overwriteVersion,
  setShare,
  shareView,
} from '../../src/catalog/model.js';
import {
  entryHash,
  type PublishDeps,
  publishPlan,
  remoteList,
  remoteShow,
  reviewPublish,
  runPublish,
} from '../../src/catalog/publish.js';
import { shareState } from '../../src/catalog/share.js';
import {
  commitEntry,
  listEntries,
  readCredential,
  readEntry,
  readProfile,
  type SaveInput,
  saveEntry,
  updateShare,
  writeCredential,
  writePublisher,
} from '../../src/catalog/store.js';
import { contentHash } from '../../src/market/client.js';
import { startMarketServer } from '../../src/market/server.js';
import { fakeFetch, json } from '../fake-fetch.js';

let root = '';
let dir = '';
const servers: { close(): Promise<void> }[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-publish-'));
  dir = path.join(root, 'cfg', 'catalog');
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const EP = 'http://127.0.0.1:9';

const preset = (...types: string[]): EntryContent => ({
  layout: { lines: [types.map((type, i) => ({ id: `w${i}`, type }))] },
});

function entry(n: number, over: Partial<CatalogEntry> = {}, share = true): CatalogEntry {
  const e = newEntry({
    id: `u-${String(n).padStart(12, '0')}`,
    kind: 'preset',
    name: `Entry ${n}`,
    description: `desc ${n}`,
    author: 'Alp',
    content: preset('model'),
    share,
    now: at(0).toISOString(),
  });
  return { ...e, ...over };
}

const remote = (e: CatalogEntry, version: number, hash: string, endpoint = EP) => ({
  endpoint,
  id: `alp/entry-${e.id.slice(-1)}`,
  version,
  hash,
  publishedAt: at(1).toISOString(),
});

async function server(opts: { allowOverwrite?: boolean } = {}) {
  const s = await startMarketServer({ dataDir: path.join(root, `data-${servers.length}`), ...opts });
  servers.push(s);
  return s;
}

function counted() {
  let calls = 0;
  const fn = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    return globalThis.fetch(input, init);
  }) as typeof fetch;
  return { fetch: fn, calls: () => calls };
}

const save = (over: Partial<SaveInput> = {}) =>
  saveEntry(
    {
      kind: 'preset',
      name: 'Mine',
      description: 'first',
      author: 'Alperen',
      content: preset('model'),
      share: true,
      mode: 'new',
      now: at(0),
      ...over,
    },
    dir,
  );

const fileOf = (id: string) => path.join(dir, 'entries', `${id}.json`);

// review, then send what was reviewed
const send = async (ids: string[] | null, deps: PublishDeps) =>
  runPublish(await reviewPublish(ids, deps), deps);

function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(d, f)] = fs.readFileSync(f).toString('base64');
    }
  };
  walk(d);
  return out;
}

describe('entryHash', () => {
  it('matches the client content hash', () => {
    const c = preset('model', 'cwd');
    expect(entryHash(c)).toBe(contentHash(c));
    expect(entryHash(c)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('publishPlan', () => {
  it('lists only what an explicit publish would send', () => {
    const local = entry(1, {}, false);
    const pending = entry(2);
    const same = markPublished(entry(3), remote(entry(3), 1, entryHash(latest(entry(3)).content)));
    let changed = entry(4);
    changed = appendVersion(changed, preset('cwd'), 'v2', at(1).toISOString());
    changed = markPublished(changed, remote(changed, 2, entryHash(preset('cwd'))));
    changed = appendVersion(changed, preset('cwd', 'git-branch'), 'v3', at(2).toISOString());
    let over = appendVersion(entry(5), preset('cwd'), 'v2', at(1).toISOString());
    over = markPublished(over, remote(over, 2, entryHash(preset('cwd'))));
    over = overwriteVersion(over, preset('cost'), 'v2 fixed', at(2).toISOString());
    const gone = setShare(markPublished(entry(6), remote(entry(6), 1, entryHash(preset('model')))), false);
    expect(gone.share.state).toBe('withdraw-pending');

    const plan = publishPlan([local, pending, same, changed, over, gone], `${EP}/`);
    expect(plan.map((p) => [p.id, p.action])).toEqual([
      [pending.id, 'publish'],
      [changed.id, 'version'],
      [over.id, 'overwrite'],
      [gone.id, 'withdraw'],
    ]);
    expect(plan[0]).toMatchObject({ rev: 0, name: 'Entry 2', kind: 'preset', remoteId: null });
    expect(plan[1]).toMatchObject({ remoteId: 'alp/entry-4' });
    expect(plan[3]).toMatchObject({ remoteId: 'alp/entry-6', payload: null });
    expect(plan[1]!.payload).toEqual({
      content: preset('cwd', 'git-branch'),
      note: 'v3',
      name: 'Entry 4',
      description: 'desc 4',
    });
    expect(plan[2]!.payload).toMatchObject({ content: preset('cost'), note: 'v2 fixed' });

    const noOverwrite = publishPlan([over], EP, { overwrite: false });
    expect(noOverwrite.map((p) => p.action)).toEqual(['version']);
  });

  it('treats a remote on another endpoint as not published', () => {
    const other = 'https://market.example.com';
    let moved = appendVersion(entry(7), preset('cwd'), '', at(1).toISOString());
    moved = { ...moved, share: { ...moved.share, state: 'pending' } };
    moved = {
      ...moved,
      share: { ...moved.share, remote: remote(moved, 1, entryHash(preset('model')), other) },
    };
    const gone = setShare(markPublished(entry(8), remote(entry(8), 1, 'f'.repeat(64), other)), false);
    const plan = publishPlan([moved, gone], EP);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: moved.id, action: 'publish', remoteId: null });
    expect(plan[0]!.payload).toMatchObject({ slug: 'entry-7' });
  });

  it('sends whitelisted fields only', () => {
    const e = save({
      kind: 'bundle',
      name: 'Çalışma Düzeni',
      content: {
        layout: { lines: [[{ id: 'm', type: 'model' }]] },
        appearance: { theme: 'nord' },
      },
    });
    // a hand-edited file with personal keys
    const raw = JSON.parse(fs.readFileSync(fileOf(e.id), 'utf8'));
    raw.versions[0].content.layout.budget = { daily: 5 };
    raw.versions[0].content.layout.profiles = { work: {} };
    raw.versions[0].content.appearance.language = 'tr';
    raw.versions[0].content.extra = { secret: 1 };
    fs.writeFileSync(fileOf(e.id), JSON.stringify(raw));
    for (const list of [listEntries(dir), [readEntry(e.id, dir)!.entry]]) {
      const [item] = publishPlan(list, EP);
      const payload = item!.payload as unknown as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'author',
        'content',
        'description',
        'kind',
        'name',
        'note',
        'slug',
      ]);
      expect(payload.slug).toBe('calisma-duzeni');
      expect(payload.author).toBe('Alperen');
      const text = JSON.stringify(payload);
      for (const bad of ['budget', 'profiles', 'language', 'secret', e.id, root, os.homedir()])
        expect(text).not.toContain(bad);
      expect(Object.keys((payload.content as EntryContent).layout!)).toEqual(['lines']);
      expect(Object.keys((payload.content as EntryContent).appearance!)).toEqual(['theme']);
    }
  });
});

describe('runPublish', () => {
  it('sends nothing and changes nothing without an endpoint', async () => {
    const a = save();
    const b = save({ name: 'Other', share: false });
    updateShare(b.id, true, b.rev, dir);
    const before = snapshot(root);
    const f = fakeFetch([]);
    const out = await send(null, { dir, env: {}, fetch: f.fetch });
    expect(out).toEqual({ code: 'no-endpoint', results: [] });
    expect(f.calls).toHaveLength(0);
    expect(snapshot(root)).toEqual(before);
    expect(listEntries(dir).map((e) => e.share.state)).toEqual(['pending', 'pending']);
    expect(a.share.state).toBe('pending');
    expect((await remoteList({ dir, env: {}, fetch: f.fetch })).code).toBe('no-endpoint');
    expect(await remoteShow('alp/mine', { dir, env: {}, fetch: f.fetch })).toEqual({
      code: 'no-endpoint',
      entry: null,
      latest: null,
    });
    expect(f.calls).toHaveLength(0);
  });

  it('makes no call when nothing waits to publish', async () => {
    save({ share: false });
    const f = fakeFetch([]);
    const out = await send(null, { dir, env: { CCINFOBAR_MARKETPLACE_URL: EP }, fetch: f.fetch });
    expect(out).toEqual({ code: null, results: [] });
    expect(f.calls).toHaveLength(0);
  });

  it('reports a bad endpoint without a call', async () => {
    save();
    const f = fakeFetch([]);
    const env = { CCINFOBAR_MARKETPLACE_URL: 'http://market.example.com' };
    expect(await send(null, { dir, env, fetch: f.fetch })).toEqual({
      code: 'bad-endpoint',
      results: [],
    });
    expect(f.calls).toHaveLength(0);
  });

  it('publishes, versions and withdraws against the reference server', async () => {
    const s = await server();
    const f = counted();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const deps = { dir, env, fetch: f.fetch, now: () => at(5) };
    const a = save({ now: at(2) });
    const b = save({ name: 'Second', content: preset('cwd'), now: at(1) });
    save({ name: 'Private', share: false });

    const first = await send(null, deps);
    expect(first.code).toBeNull();
    expect(first.results).toEqual([
      { id: a.id, ok: true, code: null, remoteId: 'alperen/mine', version: 1 },
      { id: b.id, ok: true, code: null, remoteId: 'alperen/second', version: 1 },
    ]);
    const origin = new URL(s.url).origin;
    expect(readCredential(origin, dir)).toMatch(/^[0-9a-f]{64}$/);
    expect(readProfile(dir).publishers).toEqual({ [origin]: 'alperen' });
    const cred = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
    expect(Object.keys(cred)).toEqual([origin]);
    const pub = readEntry(a.id, dir)!.entry;
    expect(pub.share).toEqual({
      wanted: true,
      state: 'published',
      lastError: null,
      remote: {
        endpoint: s.url,
        id: 'alperen/mine',
        version: 1,
        hash: entryHash(preset('model')),
        publishedAt: at(5).toISOString(),
      },
    });
    expect(shareView(pub, entryHash(latest(listEntries(dir).find((e) => e.id === a.id)!).content))).toBe(
      'published',
    );

    // second run: one update, registration not repeated
    const calls = f.calls();
    const cur = readEntry(a.id, dir)!.entry;
    saveEntry(
      {
        kind: 'preset',
        name: 'Mine',
        description: 'second',
        author: 'Alperen',
        content: preset('model', 'cost'),
        share: true,
        mode: 'update',
        id: a.id,
        rev: cur.rev,
        note: 'more',
      },
      dir,
    );
    const view = listEntries(dir).find((e) => e.id === a.id)!;
    expect(shareView(view, entryHash(latest(view).content))).toBe('outdated');
    const second = await send(null, deps);
    expect(second.results).toEqual([
      { id: a.id, ok: true, code: null, remoteId: 'alperen/mine', version: 2 },
    ]);
    expect(f.calls() - calls).toBe(2);
    const anon = await remoteShow('alperen/mine', deps);
    expect(anon.code).toBeNull();
    expect(anon.entry!.versions.map((v) => [v.version, v.note])).toEqual([
      [1, ''],
      [2, 'more'],
    ]);
    expect(anon.entry!.description).toBe('second');

    // unshare sends a withdraw
    const now = readEntry(a.id, dir)!.entry;
    updateShare(a.id, false, now.rev, dir);
    const third = await send([a.id], deps);
    expect(third.results).toEqual([
      { id: a.id, ok: true, code: null, remoteId: 'alperen/mine', version: null },
    ]);
    const w = readEntry(a.id, dir)!.entry;
    expect(w.share).toMatchObject({ wanted: false, state: 'withdrawn', lastError: null });
    expect((await remoteShow('alperen/mine', deps)).entry!.withdrawn).toBe(true);
    expect((await remoteList(deps)).entries.map((e) => e.id)).toEqual(['alperen/second']);
  });

  it('stays published when the content has tab, newline, ESC or bidi controls (WR-01)', async () => {
    const s = await server();
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: s.url }, now: () => at(5) };
    const text = (t: string) => ({ id: 't', type: 'text', options: { text: t } });
    const raw = ['a\tb', 'two\nlines', '\u001b[31mred\u001b[0m', '\u202eevil', 'x\u200fy'];
    const e = save({ content: { layout: { lines: [raw.map(text)] } } });
    const plan = publishPlan(listEntries(dir), s.url);
    const sent = JSON.stringify(plan[0]!.payload);
    expect(sent).not.toMatch(/\\t|\\n|\\u001b|\\u202e|\\u200f/);
    const first = await send(null, deps);
    expect(first.results).toMatchObject([{ id: e.id, ok: true, version: 1 }]);
    const after = listEntries(dir).find((x) => x.id === e.id)!;
    expect(shareState(after)).toBe('published');
    const local = readEntry(e.id, dir)!.entry;
    expect(latest(local).content.layout!.lines![0]![0]!.options!.text).toBe('a\tb');
    const shown = await remoteShow(local.share.remote!.id, deps);
    expect(shown.latest!.hash).toBe(local.share.remote!.hash);
    expect(publishPlan(listEntries(dir), s.url)).toEqual([]);
    expect((await send(null, deps)).results).toEqual([]);
  });

  it('keeps going after one item fails', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    const bad = save({ name: 'Bad', content: preset('command'), now: at(1) });
    const good = save({ name: 'Good', now: at(0) });
    const out = await send(null, { dir, env, fetch: globalThis.fetch });
    expect(out.results).toEqual([
      { id: bad.id, ok: false, code: 'invalid', remoteId: null, version: null },
      { id: good.id, ok: true, code: null, remoteId: 'alperen/good', version: 1 },
    ]);
    expect(readEntry(bad.id, dir)!.entry.share).toMatchObject({ state: 'pending', lastError: 'invalid' });
    expect(readEntry(good.id, dir)!.entry.share.state).toBe('published');
  });

  it('turns an overwrite into a version when the server does not allow it', async () => {
    for (const allowOverwrite of [true, false]) {
      const s = await server({ allowOverwrite });
      const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
      const sub = path.join(root, `cat-${allowOverwrite}`);
      const e = saveEntry(
        {
          kind: 'preset',
          name: 'Mine',
          description: '',
          author: 'Alp',
          content: preset('model'),
          share: true,
          mode: 'new',
        },
        sub,
      );
      await send(null, { dir: sub, env, fetch: globalThis.fetch });
      const cur = readEntry(e.id, sub)!.entry;
      saveEntry(
        {
          kind: 'preset',
          name: 'Mine',
          description: '',
          author: 'Alp',
          content: preset('cost'),
          share: true,
          mode: 'overwrite',
          id: e.id,
          rev: cur.rev,
        },
        sub,
      );
      const [item] = publishPlan(listEntries(sub), s.url, { overwrite: allowOverwrite });
      expect(item!.action).toBe(allowOverwrite ? 'overwrite' : 'version');
      const out = await send(null, { dir: sub, env, fetch: globalThis.fetch });
      expect(out.results[0]).toMatchObject({ ok: true, version: allowOverwrite ? 1 : 2 });
      const shown = await remoteShow('alp/mine', { dir: sub, env, fetch: globalThis.fetch });
      expect(shown.entry!.versions).toHaveLength(allowOverwrite ? 1 : 2);
      expect(shown.latest!.hash).toBe(entryHash(preset('cost')));
      expect(readEntry(e.id, sub)!.entry.share.remote!.hash).toBe(entryHash(preset('cost')));
    }
  });

  it('the review shows the action the server will do, from its meta (WR-12)', async () => {
    const s = await server({ allowOverwrite: false });
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: s.url }, now: () => at(5) };
    const e = save();
    await send(null, deps);
    save({ mode: 'overwrite', content: preset('cost'), id: e.id, rev: readEntry(e.id, dir)!.entry.rev });
    const review = await reviewPublish(null, deps);
    expect(review).toMatchObject({ code: null, overwrite: false, registration: null });
    expect(review.plan.map((i) => i.action)).toEqual(['version']);
  });

  it('sends only what was reviewed: a later change is not sent (CR-02)', async () => {
    const s = await server();
    const f = counted();
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: s.url }, fetch: f.fetch, now: () => at(5) };
    const a = save();
    const b = save({ name: 'Second', content: preset('cwd') });
    const review = await reviewPublish(null, deps);
    expect(review.registration).toEqual({ handle: 'alperen', displayName: 'Alperen' });
    expect(review.plan.map((i) => [i.id, i.action])).toEqual(
      expect.arrayContaining([
        [a.id, 'publish'],
        [b.id, 'publish'],
      ]),
    );
    // the CLI or editor saves a v2 of a while the review is open
    save({ mode: 'update', content: preset('git'), id: a.id, rev: a.rev, note: 'unseen' });
    const out = await runPublish(review, deps);
    expect(out.results.find((r) => r.id === a.id)).toEqual({
      id: a.id,
      ok: false,
      code: 'unreviewed',
      remoteId: null,
      version: null,
    });
    expect(out.results.find((r) => r.id === b.id)).toMatchObject({ ok: true, version: 1 });
    expect((await remoteList(deps)).entries.map((e) => e.id)).toEqual(['alperen/second']);
    expect(readEntry(a.id, dir)!.entry.share.state).toBe('pending');
  });

  it('refuses a review for another endpoint or a registration that was not reviewed', async () => {
    const s = await server();
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: s.url } };
    save();
    const review = await reviewPublish(null, deps);
    expect((await runPublish({ ...review, endpoint: 'https://other.example' }, deps)).code).toBe(
      'unreviewed',
    );
    expect((await runPublish({ ...review, registration: null }, deps)).code).toBe('unreviewed');
    expect(readCredential(new URL(s.url).origin, dir)).toBeNull();
  });

  it('a reviewed overwrite never becomes a new version when the server stops allowing it', async () => {
    const s = await server();
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: s.url } };
    const e = save();
    await send(null, deps);
    save({ mode: 'overwrite', content: preset('cost'), id: e.id, rev: readEntry(e.id, dir)!.entry.rev });
    const review = await reviewPublish(null, deps);
    expect(review.plan[0]!.action).toBe('overwrite');
    // the server turned overwrite off after the review
    const f = fakeFetch([json({ error: { code: 'overwrite-disabled', message: 'x' } }, 403)]);
    const out = await runPublish(review, { ...deps, fetch: f.fetch });
    expect(out.results).toEqual([
      { id: e.id, ok: false, code: 'overwrite-disabled', remoteId: 'alperen/mine', version: null },
    ]);
    expect(f.calls.map((c) => c.method)).toEqual(['PUT']);
    const shown = await remoteShow('alperen/mine', deps);
    expect(shown.entry!.versions).toHaveLength(1);
  });

  it('records the remote on the newer rev when the entry changed meanwhile', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    const e = save();
    let edited = false;
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await globalThis.fetch(input, init);
      if (!edited && init?.method === 'POST' && String(input).endsWith('/v1/entries')) {
        edited = true;
        const cur = readEntry(e.id, dir)!.entry;
        saveEntry(
          {
            kind: 'preset',
            name: 'Mine',
            description: 'edited',
            author: 'Alperen',
            content: preset('cwd'),
            share: true,
            mode: 'update',
            id: e.id,
            rev: cur.rev,
          },
          dir,
        );
      }
      return res;
    }) as typeof fetch;
    const out = await send(null, { dir, env, fetch: fetchFn });
    expect(out.results).toEqual([
      { id: e.id, ok: true, code: 'changed', remoteId: 'alperen/mine', version: 1 },
    ]);
    const after = readEntry(e.id, dir)!.entry;
    expect(after.version).toBe(2);
    expect(after.description).toBe('edited');
    expect(after.share.remote).toMatchObject({
      id: 'alperen/mine',
      version: 1,
      hash: entryHash(preset('model')),
    });
    const view = listEntries(dir)[0]!;
    expect(shareView(view, entryHash(latest(view).content))).toBe('outdated');
    expect(publishPlan(listEntries(dir), s.url).map((p) => p.action)).toEqual(['version']);
  });

  it('keeps an unshare made while publishing', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    const e = save();
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const res = await globalThis.fetch(input, init);
      if (init?.method === 'POST' && String(input).endsWith('/v1/entries')) {
        updateShare(e.id, false, readEntry(e.id, dir)!.entry.rev, dir);
      }
      return res;
    }) as typeof fetch;
    const out = await send(null, { dir, env, fetch: fetchFn });
    expect(out.results[0]).toMatchObject({ ok: true, code: 'changed' });
    expect(readEntry(e.id, dir)!.entry.share).toMatchObject({
      wanted: false,
      state: 'withdraw-pending',
      remote: { id: 'alperen/mine' },
    });
    expect(publishPlan(listEntries(dir), s.url).map((p) => p.action)).toEqual(['withdraw']);
  });

  it('reuses a saved token and the saved publisher', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    const e = save();
    await send(null, { dir, env, fetch: globalThis.fetch });
    const token = readCredential(s.url, dir);
    const next = save({ name: 'Two', now: at(9) });
    const f = counted();
    const out = await send([next.id, e.id], { dir, env, fetch: f.fetch });
    expect(out.results).toEqual([{ id: next.id, ok: true, code: null, remoteId: 'alperen/two', version: 1 }]);
    expect(f.calls()).toBe(2);
    expect(readCredential(s.url, dir)).toBe(token);
  });

  it('reports a taken publisher handle without writing entries', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    await fetch(`${s.url}/v1/publishers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alperen' }),
    });
    const e = save();
    const before = fs.readFileSync(fileOf(e.id));
    const out = await send(null, { dir, env, fetch: globalThis.fetch });
    expect(out).toEqual({ code: 'handle-taken', results: [] });
    expect(fs.readFileSync(fileOf(e.id))).toEqual(before);
    expect(readCredential(s.url, dir)).toBeNull();
  });

  it('never sends one marketplace token to another path on the same host (WR-05)', async () => {
    const A = 'https://m.example.com/team-a';
    const B = 'https://m.example.com/team-b';
    writeCredential(A, 'a'.repeat(64), dir);
    writePublisher(A, 'alp', dir);
    save();
    const meta = { protocol: 1, name: 'B', capabilities: { write: true, overwrite: true } };
    const f = fakeFetch([
      json(meta),
      json({ handle: 'alperen', token: 'b'.repeat(64) }, 201),
      json({ id: 'alperen/mine', version: 1, hash: 'c'.repeat(64) }, 201),
    ]);
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: B }, fetch: f.fetch, now: () => at(5) };
    const review = await reviewPublish(null, deps);
    // team-a's handle is not reused either (WR-06)
    expect(review.registration).toEqual({ handle: 'alperen', displayName: 'Alperen' });
    const out = await runPublish(review, deps);
    expect(out.results).toMatchObject([{ ok: true, remoteId: 'alperen/mine' }]);
    expect(f.calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${B}/v1/meta.json`],
      ['POST', `${B}/v1/publishers`],
      ['POST', `${B}/v1/entries`],
    ]);
    expect(f.calls[1]!.headers.authorization).toBeUndefined();
    expect(f.calls[2]!.headers.authorization).toBe(`Bearer ${'b'.repeat(64)}`);
    expect(readCredential(A, dir)).toBe('a'.repeat(64));
    expect(readCredential(B, dir)).toBe('b'.repeat(64));
    expect(readProfile(dir).publishers).toEqual({ [A]: 'alp', [B]: 'alperen' });
  });

  it('registers the handle set for this endpoint (WR-06)', async () => {
    const s = await server();
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: s.url } };
    writePublisher(s.url, 'my-handle', dir);
    save();
    const review = await reviewPublish(null, deps);
    expect(review.registration).toEqual({ handle: 'my-handle', displayName: 'Alperen' });
    expect((await runPublish(review, deps)).results).toMatchObject([
      { ok: true, remoteId: 'my-handle/mine' },
    ]);
  });

  it('gives entries that share a marketplace slug the kind, then a number (WR-07)', async () => {
    const s = await server();
    const deps = { dir, env: { CCINFOBAR_MARKETPLACE_URL: s.url } };
    const theme = { appearance: { theme: 'nord' } } as EntryContent;
    const p = save({ name: 'Nord', now: at(1) });
    const t = save({ name: 'Nord', kind: 'theme', content: theme, now: at(2) });
    const dot = save({ name: 'Nord.', now: at(3) });
    const solo = save({ name: 'Solo', now: at(4) });
    const review = await reviewPublish(null, deps);
    const slugOf = (id: string) => (review.plan.find((i) => i.id === id)!.payload as { slug: string }).slug;
    expect([slugOf(p.id), slugOf(t.id), slugOf(dot.id), slugOf(solo.id)]).toEqual([
      'nord-preset',
      'nord-theme',
      'nord-preset-2',
      'solo',
    ]);
    // a partial publish uses the same slugs
    expect(slugOf(t.id)).toBe(
      ((await reviewPublish([t.id], deps)).plan[0]!.payload as { slug: string }).slug,
    );
    const out = await runPublish(review, deps);
    expect(out.results.map((r) => [r.ok, r.remoteId])).toEqual(
      expect.arrayContaining([
        [true, 'alperen/nord-preset'],
        [true, 'alperen/nord-theme'],
        [true, 'alperen/nord-preset-2'],
        [true, 'alperen/solo'],
      ]),
    );
  });

  it('marks every item when a saved token is refused', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    writeCredential(s.url, 'a'.repeat(64), dir);
    const e = save();
    const out = await send(null, { dir, env, fetch: globalThis.fetch });
    expect(out.results).toEqual([
      { id: e.id, ok: false, code: 'unauthorized', remoteId: null, version: null },
    ]);
    expect(readEntry(e.id, dir)!.entry.share).toMatchObject({ state: 'pending', lastError: 'unauthorized' });
  });

  it('stops at a read-only marketplace', async () => {
    const e = save();
    const before = fs.readFileSync(fileOf(e.id));
    const f = fakeFetch([
      json({
        protocol: 1,
        name: 'Pages',
        capabilities: { write: false, submit: 'pull-request' },
        submitUrl: 'https://market.example.com/submit',
      }),
    ]);
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const out = await send(null, { dir, env, fetch: f.fetch });
    expect(out).toEqual({ code: 'read-only', submitUrl: 'https://market.example.com/submit', results: [] });
    expect(f.calls.map((c) => c.method)).toEqual(['GET']);
    expect(fs.readFileSync(fileOf(e.id))).toEqual(before);
    expect(fs.existsSync(path.join(dir, 'credentials.json'))).toBe(false);
  });

  it('sends exactly the planned payload', async () => {
    const e = save({ description: 'shown first' });
    const [item] = publishPlan(listEntries(dir), 'https://market.example.com');
    const hash = entryHash(preset('model'));
    const f = fakeFetch([
      json({ protocol: 1, name: 'M', capabilities: { write: true, overwrite: true, withdraw: true } }),
      json({ handle: 'alperen', token: 'c'.repeat(64) }, 201),
      json({ id: 'alperen/mine', version: 1, hash }, 201),
    ]);
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const out = await send(null, { dir, env, fetch: f.fetch, displayName: 'Alp A.' });
    expect(out.results[0]).toMatchObject({ id: e.id, ok: true });
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/meta.json',
      'POST /v1/publishers',
      'POST /v1/entries',
    ]);
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ handle: 'alperen', displayName: 'Alp A.' });
    expect(JSON.parse(f.calls[2]!.body!)).toEqual(item!.payload);
    expect(f.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('returns the meta failure code without touching entries', async () => {
    const e = save();
    const before = fs.readFileSync(fileOf(e.id));
    const f = fakeFetch([Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })]);
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const out = await send(null, { dir, env, fetch: f.fetch });
    expect(out).toEqual({ code: 'network', results: [] });
    expect(fs.readFileSync(fileOf(e.id))).toEqual(before);
  });

  it('withdraws an entry the server no longer has', async () => {
    const e = save();
    const stored = readEntry(e.id, dir)!.entry;
    const pub = markPublished(stored, {
      endpoint: 'https://market.example.com',
      id: 'alp/mine',
      version: 1,
      hash: entryHash(preset('model')),
      publishedAt: at(1).toISOString(),
    });
    const c = commitEntry(pub, stored.rev, dir);
    updateShare(e.id, false, c.rev, dir);
    writeCredential('https://market.example.com', 'b'.repeat(64), dir);
    const f = fakeFetch([
      json({ protocol: 1, name: 'M', capabilities: { write: true, overwrite: true, withdraw: true } }),
      json({ error: { code: 'not-found', message: 'not found' } }, 404),
    ]);
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const out = await send(null, { dir, env, fetch: f.fetch });
    expect(out.results).toEqual([{ id: e.id, ok: true, code: null, remoteId: 'alp/mine', version: null }]);
    expect(f.calls[1]).toMatchObject({
      method: 'DELETE',
      url: 'https://market.example.com/v1/entries/alp/mine',
    });
    expect(f.calls[1]!.headers.authorization).toBe(`Bearer ${'b'.repeat(64)}`);
    expect(readEntry(e.id, dir)!.entry.share.state).toBe('withdrawn');
  });
});

describe('remote browse', () => {
  it('lists and shows sanitized entries with consent targets', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    save({
      name: 'Links',
      description: 'with a link',
      content: {
        layout: { lines: [[{ id: 'l', type: 'link', options: { url: 'https://example.com/docs' } }]] },
      },
    });
    await send(null, { dir, env, fetch: globalThis.fetch });
    const f = counted();
    const list = await remoteList({ dir, env, fetch: f.fetch });
    expect(list.code).toBeNull();
    expect(list.entries).toEqual([
      expect.objectContaining({ id: 'alperen/links', kind: 'preset', name: 'Links', author: 'Alperen' }),
    ]);
    const shown = await remoteShow('alperen/links', { dir, env, fetch: f.fetch });
    expect(shown.code).toBeNull();
    expect(shown.entry).toMatchObject({ id: 'alperen/links', publisher: 'alperen', version: 1 });
    expect(shown.entry!.versions).toHaveLength(1);
    expect(shown.latest!.targets).toEqual([
      { kind: 'link', line: 0, index: 0, target: 'https://example.com/docs' },
    ]);
    expect(f.calls()).toBe(3);
    // GETs carry no token
    const f2 = fakeFetch([json({ entries: [], generatedAt: '' })]);
    await remoteList({
      dir,
      env: { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' },
      fetch: f2.fetch,
    });
    expect(f2.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('refuses a version file that does not match the entry history (WR-10)', async () => {
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const good = preset('model');
    const evil = preset('cwd');
    const entryDoc = (hash: string, history = hash) => ({
      id: 'alp/x',
      kind: 'preset',
      name: 'X',
      description: '',
      author: '',
      publisher: 'alp',
      version: 1,
      updatedAt: '',
      hash,
      versions: [{ version: 1, at: '2026-10-16T10:00:00.000Z', note: '', hash: history }],
    });
    const swapped = fakeFetch([
      json(entryDoc(entryHash(good))),
      json({ version: 1, content: evil, hash: entryHash(evil) }),
    ]);
    const a = await remoteShow('alp/x', { dir, env, fetch: swapped.fetch });
    expect(a).toMatchObject({ code: 'bad-hash', latest: null });
    expect(a.entry!.id).toBe('alp/x');
    const split = fakeFetch([json(entryDoc(entryHash(good), entryHash(evil)))]);
    expect(await remoteShow('alp/x', { dir, env, fetch: split.fetch })).toMatchObject({
      code: 'bad-hash',
      latest: null,
    });
    expect(split.calls).toHaveLength(1);
  });

  it('sanitizes remote text and reports failures as codes', async () => {
    const ESC = '\u001b';
    const hash = 'a'.repeat(64);
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const f = fakeFetch([
      json({
        entries: [
          {
            id: 'x/y',
            kind: 'preset',
            name: `Bad${ESC}[31m name`,
            description: '',
            author: '',
            version: 1,
            updatedAt: '',
            hash,
          },
        ],
      }),
      json({ error: { code: 'not-found', message: 'gone' } }, 404),
    ]);
    const list = await remoteList({ dir, env, fetch: f.fetch });
    expect(list.entries[0]!.name).not.toContain(ESC);
    expect(await remoteShow('x/y', { dir, env, fetch: f.fetch })).toEqual({
      code: 'not-found',
      entry: null,
      latest: null,
    });
    expect((await remoteShow('../etc', { dir, env, fetch: f.fetch })).code).toBe('invalid');
    expect(f.calls).toHaveLength(2);
  });
});
