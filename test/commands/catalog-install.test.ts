import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EntryContent } from '../../src/catalog/model.js';
import { reviewPublish, runPublish } from '../../src/catalog/publish.js';
import { listEntries, saveEntry } from '../../src/catalog/store.js';
import { parseArgs } from '../../src/cli/args.js';
import { runCatalog, when } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
import { shellArg } from '../../src/commands/manage.js';
import { contentHash } from '../../src/market/client.js';
import { startMarketServer } from '../../src/market/server.js';
import { withLangAsync } from '../helpers.js';

let root = '';
let cat = '';
let pub = '';
let cache = '';
let cfg = '';
const servers: { close(): Promise<void> }[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-install-'));
  cat = path.join(root, 'user', 'catalog');
  pub = path.join(root, 'publisher', 'catalog');
  cache = path.join(root, 'cache');
  cfg = path.join(root, 'config.json');
  fs.writeFileSync(cfg, `${JSON.stringify({ lines: [[{ id: 'm', type: 'model' }]] }, null, 2)}\n`);
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const T0 = Date.parse('2026-10-17T10:00:00.000Z');
const HOUR = 3_600_000;
const at = (ms = 0) => new Date(T0 + ms);
const CONTROL = /[\u0000-\u001f\u007f-\u009f‮]/;

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
const PLAIN: EntryContent = { layout: { lines: [[{ id: 'm', type: 'model' }]] } };

interface RunOpts {
  env?: Record<string, string>;
  tty?: boolean;
  answers?: boolean[];
  fetch?: typeof fetch;
  now?: Date;
  defaultEndpoint?: string | null;
}

async function run(argv: string[], opts: RunOpts = {}) {
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
  await runCatalog(parseArgs(['catalog', ...argv]), cfg, {
    io,
    dir: cat,
    env: opts.env ?? {},
    gsd: true,
    now: () => opts.now ?? at(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.defaultEndpoint !== undefined ? { defaultEndpoint: opts.defaultEndpoint } : {}),
  });
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, asked, code, text: [...out, ...err].join('\n') };
}

// the Worker's ETag and 304 in front of the reference server; counts requests
function counted() {
  const seen: { path: string; status: number }[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await globalThis.fetch(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const where = new URL(url).pathname;
    if ((init?.method ?? 'GET') !== 'GET' || res.status !== 200) {
      seen.push({ path: where, status: res.status });
      return res;
    }
    const body = await res.text();
    const tag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
    if (new Headers(init?.headers).get('if-none-match') === tag) {
      seen.push({ path: where, status: 304 });
      return new Response(null, { status: 304, headers: { etag: tag } });
    }
    seen.push({ path: where, status: 200 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', etag: tag } });
  }) as typeof fetch;
  return { fetch: fn, seen };
}

async function market(opts: { allowOverwrite?: boolean } = {}) {
  const s = await startMarketServer({ dataDir: path.join(root, `data-${servers.length}`), ...opts });
  servers.push(s);
  const env = { CCINFOBAR_MARKETPLACE_URL: s.url, CCINFOBAR_CACHE_DIR: cache };
  // the publisher's own computer
  const send = async (
    name: string,
    content: EntryContent,
    kind: 'bundle' | 'preset' = 'bundle',
    cols?: number,
  ) => {
    const hit = listEntries(pub).find((e) => e.name === name);
    saveEntry(
      {
        kind,
        name,
        description: `${name} layout`,
        author: 'Alice',
        content,
        share: true,
        now: at(),
        ...(cols === undefined ? {} : { cols }),
        ...(hit ? { mode: 'update' as const, id: hit.id, rev: hit.rev } : { mode: 'new' as const }),
      },
      pub,
    );
    const penv = { CCINFOBAR_MARKETPLACE_URL: s.url };
    const deps = { dir: pub, env: penv, fetch: globalThis.fetch };
    const res = await runPublish(await reviewPublish(null, deps), deps);
    expect(res.code).toBeNull();
  };
  return { url: s.url, env, send };
}

// a marketplace answering fixed documents by path
function docs(map: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname);
    const body = map[url.pathname];
    const status = body === undefined ? 404 : 200;
    const doc = body === undefined ? { error: { code: 'not-found', message: 'no' } } : body;
    return new Response(JSON.stringify(doc), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const FAKE = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };

function entryDoc(id: string, hash: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'preset',
    name: 'Mini',
    description: 'small',
    author: 'Alice',
    publisher: id.split('/')[0],
    version: 1,
    updatedAt: at().toISOString(),
    hash,
    versions: [{ version: 1, at: at().toISOString(), note: '', hash }],
    ...over,
  };
}

const hint = (name: string) => `Apply it with: ccinfobar catalog apply ${shellArg(name)}`;

describe('catalog install', () => {
  it('lists the links, installs with --yes and prints how to apply it (D-11)', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const before = fs.readFileSync(cfg, 'utf8');
    const r = await run(['install', 'alice/cockpit', '--yes'], { env: m.env });
    expect(r.code).toBeUndefined();
    expect(r.out).toEqual([
      'Cockpit  alice/cockpit',
      'Bundle · v1 · by Alice (alice)',
      'Cockpit layout',
      '',
      'This layout runs commands or opens URLs:',
      '  link: https://example.com/docs',
      'Installed alice/cockpit v1 as Cockpit',
      hint('Cockpit'),
    ]);
    const [e] = listEntries(cat);
    expect(e).toMatchObject({ kind: 'bundle', name: 'Cockpit', author: 'Alice' });
    expect(e!.origin).toMatchObject({ endpoint: m.url, id: 'alice/cockpit', version: 1 });
    expect(e!.share.wanted).toBe(false);
    // applying stays a separate step
    expect(fs.readFileSync(cfg, 'utf8')).toBe(before);
    const list = await run(['list', '--user'], { env: m.env });
    const row = list.out.find((l) => l.includes('Cockpit'));
    expect(row).toMatch(/From the marketplace$/);
    expect(list.text).not.toContain('Not shared');
    const shown = await run(['show', e!.id], { env: m.env });
    expect(shown.text).toContain('Bundle · v1 · by Alice · From the marketplace');
    const all = await run(['list'], { env: m.env });
    const mine = all.out.indexOf('Your entries');
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(all.out.slice(mine, all.out.indexOf('Built in')).join('\n')).toContain('Cockpit');
  });

  it('asks on a terminal; no saves nothing and exits 1', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const no = await run(['install', 'alice/cockpit'], { env: m.env, tty: true, answers: [false] });
    expect(no.asked).toEqual(['Install Cockpit with these commands and URLs?']);
    expect(no.code).toBe(1);
    expect(no.err).toEqual(['Nothing was installed.']);
    expect(listEntries(cat)).toEqual([]);
    const yes = await run(['install', 'alice/cockpit'], { env: m.env, tty: true, answers: [true] });
    expect(yes.code).toBeUndefined();
    expect(yes.out).toContain('Installed alice/cockpit v1 as Cockpit');
    expect(listEntries(cat)).toHaveLength(1);
  });

  it('refuses without a terminal and without --yes when there are links (T-12-20-01)', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const r = await run(['install', 'alice/cockpit'], { env: m.env });
    expect(r.code).toBe(1);
    expect(r.asked).toEqual([]);
    expect(r.out).toContain('  link: https://example.com/docs');
    expect(r.err).toEqual([
      'Nothing was installed. Run again with --yes to install it with these commands and URLs.',
    ]);
    expect(listEntries(cat)).toEqual([]);
    const j = await run(['install', 'alice/cockpit', '--json'], { env: m.env });
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out[0]!)).toMatchObject({ result: null, entry: null, code: 'needs-yes' });
    expect(listEntries(cat)).toEqual([]);
  });

  it('installs an entry without links without asking', async () => {
    const m = await market();
    await m.send('Mini', PLAIN, 'preset');
    const r = await run(['install', 'alice/mini'], { env: m.env, tty: true });
    expect(r.asked).toEqual([]);
    expect(r.code).toBeUndefined();
    expect(r.out).toContain('It runs no commands and opens no URLs.');
    expect(r.out).toContain('Installed alice/mini v1 as Mini');
    expect(listEntries(cat)).toHaveLength(1);
  });

  it('--dry-run shows the install and writes nothing', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const r = await run(['install', 'alice/cockpit', '--dry-run'], { env: m.env });
    expect(r.code).toBeUndefined();
    expect(r.out).toContain('  link: https://example.com/docs');
    expect(r.out.at(-1)).toBe(
      'Dry run: nothing was written. This would install alice/cockpit v1 into your catalog.',
    );
    expect(fs.existsSync(cat)).toBe(false);
    const j = await run(['install', 'alice/cockpit', '--dry-run', '--json'], { env: m.env });
    expect(JSON.parse(j.out[0]!)).toMatchObject({ id: 'alice/cockpit', result: 'dry-run', entry: null });
    expect(fs.existsSync(cat)).toBe(false);
  });

  it('--json prints English JSON: new, then same, then a new version', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const first = await withLangAsync('tr', () =>
      run(['install', 'alice/cockpit', '--yes', '--json'], { env: m.env }),
    );
    expect(first.out).toHaveLength(1);
    const a = JSON.parse(first.out[0]!);
    expect(a).toEqual({
      schema: 1,
      id: 'alice/cockpit',
      version: 1,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      entry: listEntries(cat)[0]!.id,
      result: 'new',
      targets: [{ kind: 'link', target: 'https://example.com/docs' }],
    });
    const second = await run(['install', 'alice/cockpit', '--json'], { env: m.env });
    expect(second.code).toBeUndefined();
    expect(JSON.parse(second.out[0]!)).toMatchObject({ result: 'same', entry: a.entry, hash: a.hash });
    // the same version again: nothing to agree to
    const text = await run(['install', 'alice/cockpit'], { env: m.env });
    expect(text.code).toBeUndefined();
    expect(text.out).toContain('You already have alice/cockpit v1 as Cockpit.');
    expect(text.out.at(-1)).toBe(hint('Cockpit'));
    await m.send('Cockpit', { ...LINKED, appearance: { theme: 'dracula' } });
    const v2 = await run(['install', 'alice/cockpit', '--yes'], { env: m.env });
    expect(v2.out).toContain('Installing adds v2 to your entry Cockpit.');
    expect(v2.out).toContain('Added alice/cockpit v2 to Cockpit');
    const [e] = listEntries(cat);
    expect(e!.version).toBe(2);
    expect(e!.origin).toMatchObject({ version: 2 });
    const pinned = await run(['install', 'alice/cockpit@1', '--yes', '--json'], { env: m.env });
    expect(JSON.parse(pinned.out[0]!)).toMatchObject({ version: 1, result: 'version' });
  });

  it('needs publisher/slug and an endpoint before it sends anything', async () => {
    const f = docs({});
    for (const argv of [
      ['install'],
      ['install', 'alice'],
      ['install', 'alice/x', 'more'],
      ['install', 'a/b@0'],
    ]) {
      const r = await run(argv, { env: FAKE, fetch: f.fetch });
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err[0]).toMatch(/^Usage: ccinfobar catalog list/);
    }
    const none = await run(['install', 'alice/x', '--yes'], { fetch: f.fetch, defaultEndpoint: null });
    expect(none.code).toBe(1);
    expect(none.err).toEqual(['No marketplace endpoint set; entries stay waiting to publish']);
    const off = await run(['install', 'alice/x', '--yes'], {
      env: { CCINFOBAR_MARKETPLACE_URL: 'off' },
      fetch: f.fetch,
    });
    expect(off.code).toBe(1);
    expect(off.err).toEqual(['No marketplace endpoint set; entries stay waiting to publish']);
    expect(f.calls).toEqual([]);
  });

  it('reports withdrawn, missing, unknown versions and bad hashes', async () => {
    const content = PLAIN;
    const hash = contentHash(content);
    const f = docs({
      '/v1/entries/alice/gone.json': entryDoc('alice/gone', hash, { name: '', withdrawn: true }),
      '/v1/entries/alice/mini.json': entryDoc('alice/mini', hash),
      '/v1/entries/alice/bad.json': entryDoc('alice/bad', 'b'.repeat(64)),
      '/v1/entries/alice/bad/1.json': { version: 1, content, hash: 'b'.repeat(64) },
      '/v1/meta.json': { schema: 1 },
    });
    const env = { ...FAKE, CCINFOBAR_CACHE_DIR: cache };
    const gone = await run(['install', 'alice/gone', '--yes'], { env, fetch: f.fetch });
    expect(gone.code).toBe(1);
    expect(gone.err).toEqual(['alice/gone was withdrawn from the marketplace']);
    const missing = await run(['install', 'alice/none', '--yes'], { env, fetch: f.fetch });
    expect(missing.err).toEqual(['alice/none is not on the marketplace']);
    const v9 = await run(['install', 'alice/mini@9', '--yes'], { env, fetch: f.fetch });
    expect(v9.err).toEqual(['alice/mini has no version 9']);
    const bad = await run(['install', 'alice/bad', '--yes'], { env, fetch: f.fetch });
    expect(bad.err).toEqual([
      'The download of alice/bad does not match its published hash; nothing was installed',
    ]);
    const j = await run(['install', 'alice/gone', '--json'], { env, fetch: f.fetch });
    expect(JSON.parse(j.out[0]!)).toMatchObject({ id: 'alice/gone', result: null, code: 'withdrawn' });
    expect(listEntries(cat)).toEqual([]);
  });

  it('cleans remote text before printing it (T-12-20-02)', async () => {
    const content: EntryContent = {
      layout: { lines: [[{ id: 'l', type: 'link', options: { url: 'https://example.com/x' } }]] },
    };
    const hash = contentHash(content);
    const f = docs({
      '/v1/entries/evil/x.json': entryDoc('evil/x', hash, {
        name: 'Ev\u001b[31mil‮',
        description: 'de\u0007sc',
        author: 'Real\u0007 Name',
      }),
      '/v1/entries/evil/x/1.json': { version: 1, content, hash },
      '/v1/meta.json': { schema: 1 },
    });
    const r = await run(['install', 'evil/x', '--dry-run'], {
      env: { ...FAKE, CCINFOBAR_CACHE_DIR: cache },
      fetch: f.fetch,
    });
    expect(r.code).toBeUndefined();
    for (const line of [...r.out, ...r.err]) expect(line).not.toMatch(CONTROL);
    expect(r.text).toContain('evil/x');
  });

  it('speaks Turkish', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const no = await withLangAsync('tr', () => run(['install', 'alice/cockpit'], { env: m.env }));
    expect(no.out).toContain('Bu düzen komut çalıştırıyor veya URL açıyor:');
    expect(no.err).toEqual([
      "Hiçbir şey yüklenmedi. Bu komut ve URL'lerle yüklemek için --yes ile tekrar çalıştırın.",
    ]);
    const r = await withLangAsync('tr', () => run(['install', 'alice/cockpit', '--yes'], { env: m.env }));
    expect(r.out[1]).toBe('Paket · v1 · Alice (alice) tarafından');
    expect(r.out).toContain('alice/cockpit v1, Cockpit olarak yüklendi');
    expect(r.out.at(-1)).toBe(`Uygulamak için: ccinfobar catalog apply ${shellArg('Cockpit')}`);
    const list = await withLangAsync('tr', () => run(['list', '--user'], { env: m.env }));
    expect(list.out.find((l) => l.includes('Cockpit'))).toMatch(/Marketplace'ten$/);
    const gone = await withLangAsync('tr', () => run(['install', 'alice/none', '--yes'], { env: m.env }));
    expect(gone.err).toEqual(["alice/none marketplace'te yok"]);
  });
});

describe('catalog remote cols', () => {
  it('list --remote and show --remote print cols when set, install keeps it', async () => {
    const m = await market();
    await m.send('Wide', LINKED, 'bundle', 150);
    await m.send('Plain', PLAIN, 'preset');
    const list = await run(['list', '--remote'], { env: m.env });
    expect(list.out.find((l) => l.includes('Wide'))).toContain('v1  150 cols');
    expect(list.out.find((l) => l.includes('Plain'))).not.toContain('cols');
    const id = listEntries(pub).find((e) => e.name === 'Wide')!.share.remote!.id;
    const show = await run(['show', id, '--remote'], { env: m.env });
    expect(show.out[1]).toContain('v1 · 150 cols · by');
    const json = JSON.parse((await run(['show', id, '--remote', '--json'], { env: m.env })).out[0]!);
    expect(json.entry.cols).toBe(150);
    expect((await run(['install', id, '--yes'], { env: m.env })).code).toBeUndefined();
    const got = listEntries(cat).find((e) => e.origin?.id === id)!;
    expect(got.versions.at(-1)!.cols).toBe(150);
  });
});

describe('catalog list --remote cache (R-12)', () => {
  it('sends nothing within 24 hours and says when it last checked', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const f = counted();
    const first = await run(['list', '--remote'], { env: m.env, fetch: f.fetch });
    expect(first.code).toBeUndefined();
    expect(f.seen.length).toBeGreaterThan(0);
    expect(first.out.at(-1)).toBe(
      `Last checked ${when(at().toISOString())}; run with --refresh to check again`,
    );
    const sent = f.seen.length;
    const later = await run(['list', '--remote'], { env: m.env, fetch: f.fetch, now: at(23 * HOUR) });
    expect(f.seen).toHaveLength(sent);
    expect(later.out.join('\n')).toContain('alice/cockpit');
    expect(later.out.at(-1)).toBe(first.out.at(-1));
  });

  it('--refresh sends one conditional request; 304 sends nothing more', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const f = counted();
    await run(['list', '--remote'], { env: m.env, fetch: f.fetch });
    f.seen.length = 0;
    const r = await run(['list', '--remote', '--refresh'], { env: m.env, fetch: f.fetch, now: at(HOUR) });
    expect(r.code).toBeUndefined();
    expect(f.seen).toEqual([{ path: '/v1/index.json', status: 304 }]);
    expect(r.out.at(-1)).toBe(
      `Last checked ${when(at(HOUR).toISOString())}; run with --refresh to check again`,
    );
    // twice within 10 s: still one request
    const again = await run(['list', '--refresh', '--remote'], {
      env: m.env,
      fetch: f.fetch,
      now: at(HOUR + 10_000),
    });
    expect(again.code).toBeUndefined();
    expect(f.seen).toHaveLength(1);
  });

  it('--refresh fetches the pages when the index changed', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    const f = counted();
    await run(['list', '--remote'], { env: m.env, fetch: f.fetch });
    await m.send('Mini', PLAIN, 'preset');
    const cached = await run(['list', '--remote'], { env: m.env, fetch: f.fetch, now: at(HOUR) });
    expect(cached.out.join('\n')).not.toContain('alice/mini');
    f.seen.length = 0;
    const r = await run(['list', '--remote', '--refresh'], { env: m.env, fetch: f.fetch, now: at(HOUR) });
    expect(f.seen[0]).toEqual({ path: '/v1/index.json', status: 200 });
    expect(r.out.join('\n')).toContain('alice/mini');
    const j = await run(['list', '--remote', '--json'], { env: m.env, fetch: f.fetch, now: at(2 * HOUR) });
    const parsed = JSON.parse(j.out[0]!);
    expect(Object.keys(parsed)).toEqual(['schema', 'endpoint', 'entries', 'checkedAt']);
    expect(parsed.endpoint).toBe(m.url);
    expect(parsed.checkedAt).toBe(at(HOUR).toISOString());
    expect(parsed.entries.map((e: { id: string }) => e.id).sort()).toEqual(['alice/cockpit', 'alice/mini']);
  });

  it('shows the saved list when the marketplace cannot be reached', async () => {
    const m = await market();
    await m.send('Cockpit', LINKED);
    await run(['list', '--remote'], { env: m.env });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await run(['list', '--remote'], { env: m.env, fetch: down, now: at(25 * HOUR) });
    expect(r.code).toBeUndefined();
    expect(r.out.join('\n')).toContain('alice/cockpit');
    expect(r.out.slice(-2)).toEqual([
      'The marketplace could not be reached, so this is the saved list.',
      `Last checked ${when(at().toISOString())}; run with --refresh to check again`,
    ]);
    const tr = await withLangAsync('tr', () =>
      run(['list', '--remote'], { env: m.env, fetch: down, now: at(25 * HOUR) }),
    );
    expect(tr.out.slice(-2)).toEqual([
      "Marketplace'e ulaşılamadı, bu yüzden kayıtlı liste gösteriliyor.",
      `Son kontrol: ${await withLangAsync('tr', async () => when(at().toISOString()))}; yeniden kontrol etmek için --refresh ile çalıştırın`,
    ]);
    const bad = await run(['list', '--remote', '--refresh', '5'], { env: m.env, fetch: down });
    expect(bad.code).toBe(1);
  });

  it('show --remote revalidates the entry and keeps the version (R-12)', async () => {
    const m = await market({ allowOverwrite: false });
    await m.send('Cockpit', LINKED);
    const f = counted();
    const first = await run(['show', 'alice/cockpit', '--remote'], { env: m.env, fetch: f.fetch });
    expect(first.out.at(-1)).toBe('Install it with: ccinfobar catalog install alice/cockpit');
    f.seen.length = 0;
    const again = await run(['show', 'alice/cockpit', '--remote'], { env: m.env, fetch: f.fetch });
    expect(again.out).toEqual(first.out);
    expect(f.seen).toEqual([{ path: '/v1/entries/alice/cockpit.json', status: 304 }]);
    // install reads the same caches
    f.seen.length = 0;
    await run(['install', 'alice/cockpit', '--yes'], { env: m.env, fetch: f.fetch });
    expect(f.seen).toEqual([{ path: '/v1/entries/alice/cockpit.json', status: 304 }]);
  });
});
