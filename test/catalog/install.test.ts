import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InstallError,
  type InstallPlan,
  installChanged,
  parseInstallRef,
  planInstall,
  runInstall,
} from '../../src/catalog/install.js';
import { type EntryContent, parseEntry } from '../../src/catalog/model.js';
import { publishPlan, reviewPublish, runPublish } from '../../src/catalog/publish.js';
import { listEntries, readEntry, type SaveInput, saveEntry, updateShare } from '../../src/catalog/store.js';
import { contentHash } from '../../src/market/client.js';
import { startMarketServer } from '../../src/market/server.js';

let root = '';
let dir = '';
let pubDir = '';
let cacheDir = '';
const servers: { close(): Promise<void> }[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-'));
  dir = path.join(root, 'user', 'catalog');
  pubDir = path.join(root, 'publisher', 'catalog');
  cacheDir = path.join(root, 'cache');
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const EP = 'https://market.example.com';

const LINKED: EntryContent = {
  layout: {
    lines: [
      [
        { id: 'm', type: 'model' },
        { id: 'l', type: 'link', options: { url: 'https://example.com/docs', text: 'docs' } },
      ],
    ],
  },
  appearance: { theme: 'nord' },
};

async function server() {
  const s = await startMarketServer({ dataDir: path.join(root, `data-${servers.length}`) });
  servers.push(s);
  return s;
}

const publish = async (env: NodeJS.ProcessEnv, d = pubDir) =>
  runPublish(await reviewPublish(null, { dir: d, env, fetch: globalThis.fetch }), {
    dir: d,
    env,
    fetch: globalThis.fetch,
  });

const save = (over: Partial<SaveInput> = {}, d = pubDir) =>
  saveEntry(
    {
      kind: 'bundle',
      name: 'Links',
      description: 'with a link',
      author: 'Alperen',
      content: LINKED,
      share: true,
      mode: 'new',
      now: at(0),
      ...over,
    },
    d,
  );

// a marketplace answering fixed documents by path
function market(docs: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname);
    const body = docs[url.pathname];
    if (body === undefined)
      return new Response(JSON.stringify({ error: { code: 'not-found', message: 'no' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const preset = (...types: string[]): EntryContent => ({
  layout: { lines: [types.map((type, i) => ({ id: `w${i}`, type }))] },
});

function entryDoc(id: string, hashes: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'preset',
    name: 'Mini',
    description: 'small',
    author: 'Alp',
    publisher: id.split('/')[0],
    version: hashes.length,
    updatedAt: at(0).toISOString(),
    hash: hashes.at(-1),
    versions: hashes.map((hash, i) => ({ version: i + 1, at: at(i).toISOString(), note: '', hash })),
    ...over,
  };
}

const fakeEnv = { CCINFOBAR_MARKETPLACE_URL: EP };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(InstallError);
    return (err as InstallError).code;
  }
  return 'ok';
}

describe('parseInstallRef', () => {
  it('reads publisher/slug with an optional version', () => {
    expect(parseInstallRef('alp/mini')).toEqual({ id: 'alp/mini', version: null });
    expect(parseInstallRef(' alp/mini@3 ')).toEqual({ id: 'alp/mini', version: 3 });
    for (const bad of [
      'alp',
      'alp/mini@0',
      'alp/mini@01',
      'alp/mini@',
      'Alp/mini',
      'a/b/c',
      '../x',
      'alp/mini@1x',
      7,
    ])
      expect(parseInstallRef(bad)).toBeNull();
  });
});

describe('install from the reference marketplace', () => {
  it('plans with targets and hash, then saves an origin-tracked entry that is not shared', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    save();
    expect((await publish(env)).results[0]).toMatchObject({ ok: true, remoteId: 'alperen/links' });
    const plan = await planInstall('alperen/links', { dir, cacheDir, env, fetch: globalThis.fetch });
    expect(plan).toMatchObject({
      id: 'alperen/links',
      version: 1,
      kind: 'bundle',
      name: 'Links',
      author: 'Alperen',
      publisher: 'alperen',
      existing: null,
    });
    expect(plan.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.targets).toEqual([{ kind: 'link', line: 0, index: 1, target: 'https://example.com/docs' }]);
    // planning writes nothing
    expect(fs.existsSync(dir)).toBe(false);
    const done = runInstall(plan, { dir, now: () => at(5) });
    expect(done).toMatchObject({ name: 'Links', result: 'new' });
    const [e] = listEntries(dir);
    expect(e).toMatchObject({ id: done.entryId, kind: 'bundle', name: 'Links', author: 'Alperen' });
    expect(e!.share).toMatchObject({ wanted: false, state: 'local', remote: null });
    expect(e!.origin).toEqual({
      endpoint: s.url,
      id: 'alperen/links',
      version: 1,
      hash: plan.hash,
      installedAt: at(5).toISOString(),
    });
    expect(e!.versions[0]!.note).toBe('installed v1');
    expect(e!.versions[0]!.content.layout?.lines?.[0]?.[1]).toMatchObject({ type: 'link' });
    // config.json is never written
    expect(fs.readdirSync(path.dirname(dir))).toEqual(['catalog']);
  });

  it('re-installs as same, adds newer versions and finds the entry again', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    const pub = save();
    await publish(env);
    const first = runInstall(
      await planInstall('alperen/links', { dir, cacheDir, env, fetch: globalThis.fetch }),
      {
        dir,
      },
    );
    const file = path.join(dir, 'entries', `${first.entryId}.json`);
    const before = { bytes: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs };
    const again = await planInstall('alperen/links', { dir, cacheDir, env, fetch: globalThis.fetch });
    expect(again.existing).toEqual({ entryId: first.entryId, same: true });
    expect(runInstall(again, { dir })).toEqual({ entryId: first.entryId, name: 'Links', result: 'same' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before.bytes);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtime);
    expect(readEntry(first.entryId, dir)!.entry.rev).toBe(1);
    // the publisher ships v2
    saveEntry(
      {
        kind: 'bundle',
        name: 'Links',
        description: 'two links',
        content: { ...LINKED, appearance: { theme: 'dracula' } },
        share: true,
        mode: 'update',
        id: pub.id,
      },
      pubDir,
    );
    expect((await publish(env)).results[0]).toMatchObject({ ok: true, version: 2 });
    const v2 = await planInstall('alperen/links', { dir, cacheDir, env, fetch: globalThis.fetch });
    expect(v2).toMatchObject({ version: 2, existing: { entryId: first.entryId, same: false } });
    expect(runInstall(v2, { dir })).toEqual({ entryId: first.entryId, name: 'Links', result: 'version' });
    const e = readEntry(first.entryId, dir)!.entry;
    expect(e.version).toBe(2);
    expect(e.versions.map((v) => v.note)).toEqual(['installed v1', 'installed v2']);
    expect(e.origin).toMatchObject({ version: 2, hash: v2.hash });
    expect(e.description).toBe('two links');
    expect(listEntries(dir)).toHaveLength(1);
    // an older version on request
    const old = await planInstall('alperen/links@1', { dir, cacheDir, env, fetch: globalThis.fetch });
    expect(old).toMatchObject({ version: 1, existing: { entryId: first.entryId, same: false } });
  });

  it('gives a clashing name a free suffix', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    save();
    await publish(env);
    save({ name: 'Links', description: 'my own', share: false }, dir);
    save({ name: 'Links 2', description: 'my own too', share: false }, dir);
    // another kind does not clash
    save({ kind: 'preset', name: 'Links 3', content: preset('model'), share: false }, dir);
    const done = runInstall(
      await planInstall('alperen/links', { dir, cacheDir, env, fetch: globalThis.fetch }),
      {
        dir,
      },
    );
    expect(done).toMatchObject({ name: 'Links 3', result: 'new' });
    expect(listEntries(dir).filter((e) => e.origin)).toHaveLength(1);
  });
});

describe('install checks', () => {
  const good = preset('model');
  const H = contentHash(good);

  it('refuses content whose hash differs from the history', async () => {
    const other = preset('cwd');
    const m = market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [H]),
      '/v1/entries/alp/mini/1.json': { version: 1, content: other, hash: contentHash(other) },
    });
    expect(await code(planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: m.fetch }))).toBe(
      'hash-mismatch',
    );
    // a summary hash that disagrees with the history
    const bad = market({ '/v1/entries/alp/mini.json': entryDoc('alp/mini', [H], { hash: 'f'.repeat(64) }) });
    expect(await code(planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: bad.fetch }))).toBe(
      'hash-mismatch',
    );
    expect(bad.calls).toEqual(['/v1/entries/alp/mini.json']);
  });

  it('refuses withdrawn entries, unknown versions and executable widgets', async () => {
    const gone = market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [H], { name: '', withdrawn: true }),
    });
    expect(await code(planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: gone.fetch }))).toBe(
      'withdrawn',
    );
    expect(gone.calls).toHaveLength(1);
    const m = market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [H]),
      '/v1/entries/alp/mini/1.json': { version: 1, content: good, hash: H },
    });
    expect(await code(planInstall('alp/mini@99', { dir, cacheDir, env: fakeEnv, fetch: m.fetch }))).toBe(
      'not-found',
    );
    expect(m.calls).toEqual(['/v1/entries/alp/mini.json']);
    const cmd: EntryContent = {
      layout: { lines: [[{ id: 'c', type: 'command', options: { command: 'echo hi' } }]] },
    };
    const evil = market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [contentHash(cmd)]),
      '/v1/entries/alp/mini/1.json': { version: 1, content: cmd, hash: contentHash(cmd) },
    });
    expect(await code(planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: evil.fetch }))).toBe(
      'bad-content',
    );
    const missing = market({});
    expect(await code(planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: missing.fetch }))).toBe(
      'not-found',
    );
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('needs a ref and an endpoint before any request', async () => {
    const m = market({});
    expect(await code(planInstall('nope', { dir, cacheDir, env: fakeEnv, fetch: m.fetch }))).toBe('bad-ref');
    expect(
      await code(planInstall('alp/mini', { dir, cacheDir, env: {}, fetch: m.fetch, defaultEndpoint: null })),
    ).toBe('no-endpoint');
    expect(m.calls).toHaveLength(0);
  });

  it('installChanged compares hash and targets', async () => {
    const m = market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [H]),
      '/v1/entries/alp/mini/1.json': { version: 1, content: good, hash: H },
    });
    const plan = await planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: m.fetch });
    expect(plan.targets).toEqual([]);
    expect(installChanged(plan, { hash: H, targets: [] })).toBe(false);
    expect(installChanged(plan, { hash: 'f'.repeat(64), targets: [] })).toBe(true);
    const link = { kind: 'link' as const, line: 0, index: 0, target: 'https://example.com' };
    expect(installChanged(plan, { hash: H, targets: [link] })).toBe(true);
    expect(installChanged({ ...plan, targets: [link] } as InstallPlan, { hash: H, targets: [link] })).toBe(
      false,
    );
  });
});

describe('installed entries stay the publisher’s', () => {
  async function installed() {
    const good = preset('model');
    const H = contentHash(good);
    const m = market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [H]),
      '/v1/entries/alp/mini/1.json': { version: 1, content: good, hash: H },
    });
    const done = runInstall(await planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: m.fetch }), {
      dir,
    });
    return readEntry(done.entryId, dir)!.entry;
  }

  it('refuses to share and never plans a publish', async () => {
    const e = await installed();
    expect(() => updateShare(e.id, true, e.rev, dir)).toThrow(expect.objectContaining({ code: 'installed' }));
    expect(() =>
      saveEntry(
        {
          kind: 'preset',
          name: e.name,
          description: '',
          content: preset('cwd'),
          share: true,
          shareChange: true,
          mode: 'update',
          id: e.id,
        },
        dir,
      ),
    ).toThrow(expect.objectContaining({ code: 'installed' }));
    expect(readEntry(e.id, dir)!.entry.rev).toBe(e.rev);
    // even a hand-edited share flag publishes nothing
    const file = path.join(dir, 'entries', `${e.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.share = { wanted: true, state: 'pending', remote: null, lastError: null };
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(publishPlan(listEntries(dir), EP)).toEqual([]);
  });

  it('keeps origin and unknown origin keys through a rewrite', async () => {
    const e = await installed();
    const file = path.join(dir, 'entries', `${e.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.origin.future = { keep: true };
    fs.writeFileSync(file, JSON.stringify(raw));
    const next = updateShare(e.id, false, e.rev, dir);
    expect(next.origin).toEqual(e.origin);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.origin).toEqual({ ...e.origin, future: { keep: true } });
    expect(after.rev).toBe(e.rev + 1);
  });

  it('parses origin strictly', async () => {
    const e = await installed();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'entries', `${e.id}.json`), 'utf8'));
    expect(parseEntry(raw)!.origin).toEqual(e.origin);
    for (const bad of [
      { ...raw.origin, id: 'no-slash' },
      { ...raw.origin, version: 0 },
      { ...raw.origin, hash: 'abc' },
      { ...raw.origin, endpoint: '' },
      { ...raw.origin, installedAt: 5 },
      'x',
    ]) {
      const p = parseEntry({ ...raw, origin: bad });
      expect(p).not.toBeNull();
      expect(p!.origin).toBeUndefined();
    }
  });
});

describe('install: cols', () => {
  it('copies the entry cols into the local entry', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    save({ cols: 150 });
    expect((await publish(env)).results[0]).toMatchObject({ ok: true });
    const plan = await planInstall('alperen/links', { dir, cacheDir, env, fetch: globalThis.fetch });
    expect(plan.cols).toBe(150);
    const got = runInstall(plan, { dir, now: () => at(1) });
    expect(readEntry(got.entryId, dir)!.entry.versions.at(-1)!.cols).toBe(150);
  });

  it('leaves cols out when the entry has none', async () => {
    const s = await server();
    const env = { CCINFOBAR_MARKETPLACE_URL: s.url };
    save();
    await publish(env);
    const plan = await planInstall('alperen/links', { dir, cacheDir, env, fetch: globalThis.fetch });
    expect(plan).not.toHaveProperty('cols');
    const got = runInstall(plan, { dir, now: () => at(1) });
    expect(readEntry(got.entryId, dir)!.entry.versions.at(-1)).not.toHaveProperty('cols');
  });
});

describe('install: cols on the same content (WR-03)', () => {
  const good = preset('model');
  const H = contentHash(good);
  const docs = (over: Record<string, unknown> = {}, kind = 'preset') =>
    market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [H], { kind, ...over }),
      '/v1/entries/alp/mini/1.json': { version: 1, content: good, hash: H },
    });
  const install = async (m: ReturnType<typeof market>, min: number) =>
    runInstall(await planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: m.fetch }), {
      dir,
      now: () => at(min),
    });

  it('updates the local cols when only the width differs, also from none', async () => {
    const first = await install(docs(), 0);
    expect(first.result).toBe('new');
    expect(readEntry(first.entryId, dir)!.entry.versions.at(-1)).not.toHaveProperty('cols');
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const again = await install(docs({ cols: 150 }), 1);
    expect(again).toMatchObject({ result: 'same', entryId: first.entryId });
    const e = readEntry(first.entryId, dir)!.entry;
    expect(e.version).toBe(1);
    expect(e.versions.at(-1)!.cols).toBe(150);
    fs.rmSync(cacheDir, { recursive: true, force: true });
    await install(docs({ cols: 90 }), 2);
    expect(readEntry(first.entryId, dir)!.entry.versions.at(-1)!.cols).toBe(90);
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const rev = readEntry(first.entryId, dir)!.entry.rev;
    await install(docs(), 3);
    expect(readEntry(first.entryId, dir)!.entry).toMatchObject({ rev });
    expect(readEntry(first.entryId, dir)!.entry.versions.at(-1)!.cols).toBe(90);
  });

  it('a theme never takes cols', async () => {
    const theme = { appearance: { theme: 'nord' } } as EntryContent;
    const TH = contentHash(theme);
    const m = market({
      '/v1/entries/alp/mini.json': entryDoc('alp/mini', [TH], { kind: 'theme', cols: 150 }),
      '/v1/entries/alp/mini/1.json': { version: 1, content: theme, hash: TH },
    });
    const plan = await planInstall('alp/mini', { dir, cacheDir, env: fakeEnv, fetch: m.fetch });
    expect(plan).not.toHaveProperty('cols');
    const got = runInstall(plan, { dir, now: () => at(0) });
    expect(readEntry(got.entryId, dir)!.entry.versions.at(-1)).not.toHaveProperty('cols');
  });
});
