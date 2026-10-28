import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shareState } from '../../src/catalog/share.js';
import {
  listEntries,
  readCredential,
  readEntry,
  readProfile,
  saveEntry,
  writeCredential,
} from '../../src/catalog/store.js';
import { parseArgs } from '../../src/cli/args.js';
import { runCatalog } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
import { startMarketServer } from '../../src/market/server.js';
import { fakeFetch, json } from '../fake-fetch.js';
import { GH_ENDPOINT, GH_TOKEN, githubMarket } from '../github-market.js';
import { withLangAsync } from '../helpers.js';

let root = '';
let cat = '';
let cfg = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCINFOBAR_CONFIG_DIR', 'HOME', 'USERPROFILE', 'CCINFOBAR_MARKETPLACE_URL'];
const servers: { close(): Promise<void> }[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-publish-'));
  cat = path.join(root, 'catalog');
  cfg = path.join(root, 'config.json');
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCINFOBAR_CONFIG_DIR = root;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.CCINFOBAR_MARKETPLACE_URL;
  writeCfg([[{ id: 'm', type: 'model' }]]);
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const NOW = new Date('2026-10-16T10:00:00.000Z');
const WHERE = 'even if CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set';

function writeCfg(lines: object[][]) {
  fs.writeFileSync(cfg, `${JSON.stringify({ lines }, null, 2)}\n`);
}

interface RunOpts {
  env?: Record<string, string>;
  tty?: boolean;
  answers?: boolean[];
  fetch?: typeof fetch;
}

const outputs: string[] = [];

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
    now: () => NOW,
    defaultEndpoint: null,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const code = process.exitCode;
  process.exitCode = undefined;
  outputs.push(...out, ...err);
  return { out, err, asked, code, text: [...out, ...err].join('\n') };
}

async function server(opts: { allowOverwrite?: boolean } = {}) {
  const s = await startMarketServer({ dataDir: path.join(root, `data-${servers.length}`), ...opts });
  servers.push(s);
  return { url: s.url, env: { CCINFOBAR_MARKETPLACE_URL: s.url } };
}

function counted() {
  let calls = 0;
  const fn = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    return globalThis.fetch(input, init);
  }) as typeof fetch;
  return { fetch: fn, calls: () => calls };
}

const saveMine = (name = 'Mine', kind = 'preset') =>
  run(['save', name, '--kind', kind, '--author', 'Alperen', '--description', 'my layout']);

const entryOf = (name: string) => listEntries(cat).find((e) => e.name === name)!;
const stateOf = (name: string) => readEntry(entryOf(name).id, cat)!.entry.share.state;

describe('catalog publish', () => {
  it('sends nothing without an endpoint and keeps entries waiting (D-09)', async () => {
    await saveMine();
    const f = fakeFetch([]);
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await run(['publish', '--yes'], { fetch: f.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['No marketplace endpoint set; entries stay waiting to publish']);
    expect(f.calls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
    expect(stateOf('Mine')).toBe('pending');
  });

  it('re-plans after the answer: a change made meanwhile is shown, not sent (CR-02)', async () => {
    await saveMine();
    const s = await server();
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    let n = 0;
    const io: PromptIo = {
      tty: true,
      columns: 100,
      ask: async (q) => {
        asked.push(q);
        // another window saves v2 while the first prompt is open
        if (n++ === 0) {
          const e = entryOf('Mine');
          saveEntry(
            {
              kind: 'preset',
              name: 'Mine',
              description: 'changed meanwhile',
              author: 'Alperen',
              content: { layout: { lines: [[{ id: 'g', type: 'git-branch' }]] } },
              share: true,
              mode: 'update',
              id: e.id,
              rev: e.rev,
            },
            cat,
          );
        }
        return true;
      },
      log: (l) => void out.push(l),
      error: (l) => void err.push(l),
    };
    await runCatalog(parseArgs(['catalog', 'publish']), cfg, {
      io,
      dir: cat,
      env: s.env,
      gsd: true,
      now: () => NOW,
      defaultEndpoint: null,
    });
    expect(asked).toHaveLength(2);
    expect(out).toContain(
      'The entries changed since this list was shown, so nothing was sent. The new list:',
    );
    expect(out.filter((l) => l === 'These entries will be sent:')).toHaveLength(2);
    expect(out.join('\n')).toContain('"description": "changed meanwhile"');
    expect(out).toContain('Published Mine v1 as alperen/mine');
    const shown = await run(['show', 'alperen/mine', '--remote', '--json'], { env: s.env });
    expect(JSON.parse(shown.out[0]!).entry.description).toBe('changed meanwhile');
  });

  it('stops without sending when the plan changed and there is no terminal to ask again', async () => {
    await saveMine();
    const s = await server();
    let calls = 0;
    const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // the entry changes between the review and the re-plan
      if (calls++ === 0) {
        const e = entryOf('Mine');
        saveEntry(
          {
            kind: 'preset',
            name: 'Mine',
            description: 'later',
            author: 'Alperen',
            content: { layout: { lines: [] } },
            share: true,
            mode: 'update',
            id: e.id,
            rev: e.rev,
          },
          cat,
        );
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const r = await run(['publish', '--yes'], { env: s.env, fetch: f });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['Nothing was sent. Run the command again to send the new list.']);
    expect(stateOf('Mine')).toBe('pending');
    // nothing changes now, so the next run sends the new list
    const j = await run(['publish', '--yes', '--json'], { env: s.env, fetch: f });
    expect(j.code).toBeUndefined();
    expect(JSON.parse(j.out[0]!).results).toMatchObject([{ ok: true, version: 1 }]);
  });

  it('shows the exact payload and the endpoint, then needs --yes without a terminal (D-25)', async () => {
    await saveMine();
    const s = await server();
    const f = counted();
    const r = await run(['publish'], { env: s.env, fetch: f.fetch });
    expect(r.code).toBe(1);
    expect(r.out[0]).toBe('These entries will be sent:');
    expect(r.out).toContain('  Publish Mine (preset)');
    const body = r.out.join('\n');
    for (const part of ['"kind": "preset"', '"slug": "mine"', '"name": "Mine"', '"description": "my layout"'])
      expect(body).toContain(part);
    expect(body).toContain('"author": "Alperen"');
    expect(body).toContain('"content": {');
    expect(body).toContain('"type": "model"');
    expect(r.out).toContain(`This sends the entries above to ${s.url}. It runs because you asked, ${WHERE}.`);
    expect(r.err).toEqual(['Nothing was sent. Run again with --yes to send it.']);
    // the review reads meta.json only
    expect(f.calls()).toBe(1);
    expect(stateOf('Mine')).toBe('pending');
    const list = await run(['list', '--remote'], { env: s.env });
    expect(list.out).toContain('  The marketplace has no entries yet.');
  });

  it('prints the plan and sends nothing on --dry-run', async () => {
    await saveMine();
    const s = await server();
    const f = counted();
    const r = await run(['publish', '--dry-run', '--yes'], { env: s.env, fetch: f.fetch });
    expect(r.code).toBeUndefined();
    expect(r.out).toContain('  Publish Mine (preset)');
    expect(r.out.at(-1)).toBe('Dry run: nothing was sent.');
    // the review reads meta.json only
    expect(f.calls()).toBe(1);
  });

  it('asks in a terminal and keeps everything on no', async () => {
    await saveMine();
    const s = await server();
    const f = counted();
    const r = await run(['publish'], { env: s.env, fetch: f.fetch, tty: true, answers: [false] });
    expect(r.asked).toEqual(['Send this entry?']);
    expect(r.out.at(-1)).toBe('Nothing was sent.');
    // the review reads meta.json only
    expect(f.calls()).toBe(1);
    const yes = await run(['publish'], { env: s.env, tty: true, answers: [true] });
    expect(yes.out.at(-1)).toBe('Published Mine v1 as alperen/mine');
  });

  it('publishes with --yes, then sends a new version after save --update', async () => {
    await saveMine();
    const s = await server();
    const r = await run(['publish', '--yes'], { env: s.env });
    expect(r.code).toBeUndefined();
    expect(r.out.at(-1)).toBe('Published Mine v1 as alperen/mine');
    expect(stateOf('Mine')).toBe('published');
    expect(entryOf('Mine').share.remote).toMatchObject({ id: 'alperen/mine', version: 1 });
    const again = await run(['publish'], { env: s.env });
    expect(again.out).toEqual(['Nothing is waiting to publish.']);
    writeCfg([
      [
        { id: 'm', type: 'model' },
        { id: 'c', type: 'cost' },
      ],
    ]);
    await run(['save', 'Mine', '--kind', 'preset', '--update']);
    expect(shareState(entryOf('Mine'))).toBe('outdated');
    const v2 = await run(['publish', '--yes'], { env: s.env });
    expect(v2.out).toContain('  Publish a new version of Mine (preset) to alperen/mine');
    expect(v2.out.at(-1)).toBe('Published Mine v2 as alperen/mine');
    const show = await run(['show', 'alperen/mine', '--remote'], { env: s.env });
    expect(show.out[1]).toBe('Preset · v2 · by Alperen (alperen)');
  });

  it('withdraws an unshared entry', async () => {
    await saveMine();
    const s = await server();
    await run(['publish', '--yes'], { env: s.env });
    await run(['unshare', entryOf('Mine').id]);
    const r = await run(['publish', '--yes'], { env: s.env });
    expect(r.out).toContain('  Withdraw Mine (preset) from alperen/mine');
    expect(r.out).toContain('    Only the withdraw request is sent.');
    expect(r.out.at(-1)).toBe('Withdrew Mine (alperen/mine)');
    expect(stateOf('Mine')).toBe('withdrawn');
    const show = await run(['show', 'alperen/mine', '--remote', '--json'], { env: s.env });
    expect(JSON.parse(show.out[0]!).entry.withdrawn).toBe(true);
    const list = await run(['list', '--remote'], { env: s.env });
    expect(list.out).toContain('  The marketplace has no entries yet.');
  });

  it('refuses to share a withdrawn entry again: withdrawn ids stay reserved (WR-04)', async () => {
    await saveMine();
    const s = await server();
    await run(['publish', '--yes'], { env: s.env });
    await run(['unshare', entryOf('Mine').id]);
    await run(['publish', '--yes'], { env: s.env });
    const msg =
      'Mine was withdrawn from the marketplace, and withdrawn ids stay reserved. Save it under a new name to publish it again.';
    for (const extra of [[], ['--dry-run']]) {
      const r = await run(['share', entryOf('Mine').id, ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toEqual([msg]);
    }
    expect(stateOf('Mine')).toBe('withdrawn');
    const up = await run(['save', 'Mine', '--kind', 'preset', '--update', '--share']);
    expect(up.err).toEqual([msg]);
    expect(entryOf('Mine').version).toBe(1);
    const f = counted();
    const r = await run(['publish', '--yes'], { env: s.env, fetch: f.fetch });
    expect(r.out).toEqual(['Nothing is waiting to publish.']);
    expect(f.calls()).toBe(0);
    const tr = await withLangAsync('tr', () => run(['share', entryOf('Mine').id]));
    expect(tr.err[0]).toBe(
      "Mine marketplace'ten geri çekildi ve geri çekilen kimlikler ayrılmış kalır. Yeniden yayımlamak için farklı bir adla kaydedin.",
    );
    const copy = await run(['save', 'Mine again', '--kind', 'preset']);
    expect(copy.code).toBeUndefined();
    expect((await run(['publish', '--yes'], { env: s.env })).out.at(-1)).toBe(
      'Published Mine again v1 as alperen/mine-again',
    );
  });

  it('catalog publisher shows, sets and forgets the handle per endpoint (WR-06)', async () => {
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://m.example.com/team-a' };
    const ep = 'https://m.example.com/team-a';
    // a token server: setting a handle reads meta, showing and forgetting send nothing
    const t = githubMarket({ auth: ['token'] });
    const fetch = t.fetch;
    const viaMeta = ((input: string | URL, init?: RequestInit) =>
      fetch(String(input).replace(ep, GH_ENDPOINT), init)) as unknown as typeof globalThis.fetch;
    expect((await run(['publisher'])).err).toEqual([
      'No marketplace endpoint set; entries stay waiting to publish',
    ]);
    await run(['author', 'Alperen Adalar']);
    expect((await run(['publisher'], { env })).out).toEqual([
      `No publisher handle set for ${ep}. The first publish registers @alperen-adalar; set another with ccinfobar catalog publisher <handle>.`,
    ]);
    const bad = await run(['publisher', 'Not Valid'], { env, fetch: viaMeta });
    expect(bad.code).toBe(1);
    expect(bad.err).toEqual([
      'A publisher handle is 1 to 39 lowercase letters, digits or hyphens and starts with a letter or digit',
    ]);
    const dry = await run(['publisher', 'alp', '--dry-run', '--json'], { env, fetch: viaMeta });
    expect(JSON.parse(dry.out[0]!)).toEqual({
      schema: 1,
      endpoint: ep,
      publisher: 'alp',
      registered: false,
      dryRun: true,
    });
    expect(readProfile(cat).publishers).toEqual({});
    expect((await run(['publisher', 'alp'], { env, fetch: viaMeta })).out).toEqual([
      `Publisher handle on ${ep} is now @alp. Nothing is sent until you publish.`,
    ]);
    expect((await run(['publisher'], { env })).out).toEqual([
      `Publisher handle on ${ep}: @alp (not registered yet)`,
    ]);
    // another path on the same host has its own handle
    expect(
      (await run(['publisher'], { env: { CCINFOBAR_MARKETPLACE_URL: 'https://m.example.com/b' } })).out[0],
    ).toMatch(/^No publisher handle set/);
    writeCredential(ep, 't'.repeat(64), cat);
    expect((await run(['publisher'], { env })).out).toEqual([`Publisher handle on ${ep}: @alp (registered)`]);
    const taken = await run(['publisher', 'bob'], { env, fetch: viaMeta });
    expect(taken.code).toBe(1);
    expect(taken.err[0]).toMatch(
      /^You are already registered as @alp on https:\/\/m\.example\.com\/team-a\. /,
    );
    expect((await run(['publisher', '--forget'], { env, fetch: viaMeta })).out).toEqual([
      `Forgot the publisher handle and token for ${ep}. The next publish registers again.`,
    ]);
    expect(readCredential(ep, cat)).toBeNull();
    expect(readProfile(cat).publishers).toEqual({});
    const tr = await withLangAsync('tr', () => run(['publisher', 'alp'], { env, fetch: viaMeta }));
    expect(tr.out).toEqual([
      `${ep} üzerindeki yayıncı adı artık @alp. Siz yayımlayana kadar hiçbir şey gönderilmez.`,
    ]);
    // only the four handle arguments that passed the shape check read meta
    expect(t.calls.map((c) => `${c.method} ${c.url}`)).toEqual(
      Array(4).fill(`GET ${GH_ENDPOINT}/v1/meta.json`),
    );
  });

  it('names the HTTP status of an answer it has no message for (IN-06)', async () => {
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const f = fakeFetch([new Response('down', { status: 503 })]);
    const r = await run(['list', '--remote'], { env, fetch: f.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['Could not read the marketplace: The marketplace answered with HTTP 503']);
    await saveMine();
    const g = fakeFetch([new Response('teapot', { status: 418 })]);
    const p = await run(['publish', '--yes'], { env, fetch: g.fetch });
    expect(p.err).toEqual(['Publishing failed: The marketplace answered with HTTP 418']);
    const tr = await withLangAsync('tr', () =>
      run(['list', '--remote'], { env, fetch: fakeFetch([new Response('', { status: 503 })]).fetch }),
    );
    expect(tr.err).toEqual(['Marketplace okunamadı: Marketplace HTTP 503 ile yanıt verdi']);
  });

  it('publishes even with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set', async () => {
    await saveMine();
    const s = await server();
    const env = { ...s.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const r = await run(['publish', '--yes'], { env });
    expect(r.out.some((l) => l.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))).toBe(true);
    expect(r.out.at(-1)).toBe('Published Mine v1 as alperen/mine');
  });

  it('prints the reason of a failed item in English and Turkish', async () => {
    // WR-07: the same name with two kinds publishes both
    await saveMine('Mine', 'preset');
    await saveMine('Mine', 'theme');
    const s = await server();
    const both = await run(['publish', '--yes'], { env: s.env });
    expect(both.code).toBeUndefined();
    expect(both.out).toContain('Published Mine v1 as alperen/mine-preset');
    expect(both.out).toContain('Published Mine v1 as alperen/mine-theme');
    // a new local entry whose slug is taken on the marketplace fails on its own
    for (const e of listEntries(cat)) await run(['delete', e.id, '--yes']);
    await saveMine('Mine', 'preset');
    await saveMine('Mine', 'theme');
    await saveMine('Other', 'preset');
    const r = await run(['publish', '--yes'], { env: s.env });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Published Other v1 as alperen/other');
    expect(r.err).toEqual([
      'Mine: The marketplace already has an entry with this name',
      'Mine: The marketplace already has an entry with this name',
    ]);
    for (const e of listEntries(cat).filter((x) => x.name === 'Mine')) await run(['delete', e.id, '--yes']);
    await saveMine('Mine', 'preset');
    await saveMine('Mine', 'theme');
    const tr = await withLangAsync('tr', () => run(['publish', '--yes'], { env: s.env }));
    expect(tr.err).toEqual([
      "Mine: Marketplace'te bu adla bir girdi zaten var",
      "Mine: Marketplace'te bu adla bir girdi zaten var",
    ]);
  });

  it('names a read-only marketplace and its submit page', async () => {
    await saveMine();
    const meta = () =>
      json({
        protocol: 1,
        name: 'Pages',
        capabilities: { write: false, submit: 'pull-request' },
        submitUrl: 'https://market.example.com/submit',
      });
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const r = await run(['publish', '--yes'], { env, fetch: fakeFetch([meta()]).fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      'This marketplace is read-only. Submit your entries at https://market.example.com/submit instead.',
    ]);
    const tr = await withLangAsync('tr', () =>
      run(['publish', '--yes'], {
        env,
        fetch: fakeFetch([json({ protocol: 1, name: 'x', capabilities: { write: false } })]).fetch,
      }),
    );
    expect(tr.err).toEqual(['Yayımlama başarısız oldu: Bu marketplace salt okunur ve yükleme kabul etmiyor']);
    const down = await run(['publish', '--yes'], {
      env,
      fetch: fakeFetch([new TypeError('fetch failed')]).fetch,
    });
    expect(down.err).toEqual(['Publishing failed: Could not reach the marketplace']);
  });

  it('only sends the named refs and explains skipped ones', async () => {
    await saveMine('Mine');
    await run(['save', 'Local', '--kind', 'preset', '--no-share']);
    const s = await server();
    const local = entryOf('Local').id;
    const r = await run(['publish', local, '--yes'], { env: s.env });
    expect(r.out).toEqual([
      `Local is not shared, so it is not sent. Share it with ccinfobar catalog share ${local}.`,
      'Nothing is waiting to publish.',
    ]);
    const sys = await run(['publish', 'bundle/nord-minimal'], { env: s.env });
    expect(sys.code).toBe(1);
    expect(sys.err).toEqual(['Built-in entries cannot be changed']);
    const one = await run(['publish', 'preset/mine', '--yes'], { env: s.env });
    expect(one.out.at(-1)).toBe('Published Mine v1 as alperen/mine');
    const done = await run(['publish', 'preset/mine'], { env: s.env });
    expect(done.out[0]).toBe('Mine is already published as v1');
  });

  it('prints English JSON with the plan and the results', async () => {
    await saveMine();
    const s = await server();
    const dry = await withLangAsync('tr', () => run(['publish', '--json', '--dry-run'], { env: s.env }));
    expect(dry.out).toHaveLength(1);
    const plan = JSON.parse(dry.out[0]!);
    expect(plan).toMatchObject({ schema: 1, endpoint: s.url, results: null, dryRun: true });
    expect(plan.plan).toHaveLength(1);
    expect(plan.plan[0]).toMatchObject({ name: 'Mine', kind: 'preset', action: 'publish', remoteId: null });
    expect(plan.plan[0].payload).toMatchObject({ slug: 'mine', author: 'Alperen', description: 'my layout' });
    const noYes = await run(['publish', '--json'], { env: s.env });
    expect(noYes.code).toBe(1);
    expect(JSON.parse(noYes.out[0]!).results).toBeNull();
    const r = await withLangAsync('tr', () => run(['publish', '--json', '--yes'], { env: s.env }));
    const out = JSON.parse(r.out[0]!);
    expect(out.results).toEqual([
      { id: entryOf('Mine').id, ok: true, code: null, remoteId: 'alperen/mine', version: 1 },
    ]);
    expect(out.code).toBeNull();
  });

  it('never prints the publisher token', async () => {
    outputs.length = 0;
    await saveMine();
    const s = await server();
    await run(['publish', '--yes'], { env: s.env });
    await run(['publish', '--json', '--dry-run'], { env: s.env });
    await run(['list', '--remote', '--json'], { env: s.env });
    await run(['show', 'alperen/mine', '--remote'], { env: s.env });
    const token = readCredential(new URL(s.url).origin, cat);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(outputs.join('\n')).not.toContain(token!);
  });
});

describe('catalog on a GitHub-backed marketplace (D-07, D-09, D-16)', () => {
  const env = { CCINFOBAR_MARKETPLACE_URL: GH_ENDPOINT };

  it('publish without sign-in says to sign in and sends no write', async () => {
    const m = githubMarket();
    await saveMine();
    const r = await run(['publish', '--yes'], { env, fetch: m.fetch });
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toEqual(['Sign in first: ccinfobar catalog login']);
    expect(m.calls.map((c) => c.url)).toEqual([`${GH_ENDPOINT}/v1/meta.json`]);
    const tr = await withLangAsync('tr', () => run(['publish', '--yes'], { env, fetch: m.fetch }));
    expect(tr.err).toEqual(['Önce giriş yapın: ccinfobar catalog login']);
    const j = await withLangAsync('tr', () => run(['publish', '--yes', '--json'], { env, fetch: m.fetch }));
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out[0]!)).toMatchObject({ code: 'sign-in', plan: [], registration: null });
    expect(stateOf('Mine')).toBe('pending');
  });

  it('shows the review wait after publish and in list and show', async () => {
    const m = githubMarket();
    writeCredential(GH_ENDPOINT, GH_TOKEN, cat);
    await saveMine();
    const r = await run(['publish', '--yes'], { env, fetch: m.fetch });
    expect(r.code).toBeUndefined();
    expect(r.out.slice(-2)).toEqual([
      'Published Mine v1 as octo/mine',
      'Waiting for review by a marketplace admin',
    ]);
    expect(r.text).not.toContain('register');
    const id = entryOf('Mine').id;
    const list = await run(['list', '--user']);
    expect(list.out.find((l) => l.includes(id))).toMatch(/ {2}Waiting for review$/);
    const show = await run(['show', id]);
    expect(show.out[1]).toContain(' · Waiting for review');
    const tr = await withLangAsync('tr', () => run(['list', '--user']));
    expect(tr.out.find((l) => l.includes(id))).toMatch(/ {2}İnceleme bekliyor$/);
    const data = JSON.parse((await withLangAsync('tr', () => run(['list', '--user', '--json']))).out[0]!);
    expect(data.user[0]).toMatchObject({ ref: id, share: 'published', review: 'pending' });
    const shown = JSON.parse((await run(['show', id, '--json'])).out[0]!);
    expect(shown.entry.review).toBe('pending');
    // a Turkish publish line
    await run(['save', 'Two', '--kind', 'preset']);
    const two = await withLangAsync('tr', () => run(['publish', '--yes'], { env, fetch: m.fetch }));
    expect(two.out.at(-1)).toBe('Bir marketplace yöneticisinin incelemesi bekleniyor');
    await run(['save', 'Three', '--kind', 'preset']);
    const j = await withLangAsync('tr', () => run(['publish', '--yes', '--json'], { env, fetch: m.fetch }));
    expect(JSON.parse(j.out[0]!).results).toEqual([
      { id: entryOf('Three').id, ok: true, code: null, remoteId: 'octo/three', version: 1, pending: true },
    ]);
  });

  it('says why a held version waits, with the hosts, in en and tr', async () => {
    const m = githubMarket({ trusted: true });
    writeCredential(GH_ENDPOINT, GH_TOKEN, cat);
    await saveMine();
    await run(['publish', '--yes'], { env, fetch: m.fetch });
    m.entries.get('octo/mine')!.holdNext = ['example.com/x', 'a.org/y'];
    writeCfg([
      [
        { id: 'm', type: 'model' },
        { id: 'c', type: 'cost' },
      ],
    ]);
    await run(['save', 'Mine', '--kind', 'preset', '--update']);
    const r = await run(['publish', '--yes'], { env, fetch: m.fetch });
    expect(r.out.at(-1)).toBe(
      'Version 2 waits for review by a marketplace admin because it adds links to example.com/x, a.org/y',
    );
    m.entries.get('octo/mine')!.held = undefined;
    m.entries.get('octo/mine')!.holdNext = ['example.com/x'];
    writeCfg([
      [
        { id: 'm', type: 'model' },
        { id: 'g', type: 'git-branch' },
      ],
    ]);
    await run(['save', 'Mine', '--kind', 'preset', '--update']);
    const tr = await withLangAsync('tr', () => run(['publish', '--yes'], { env, fetch: m.fetch }));
    expect(tr.out.at(-1)).toBe(
      'Sürüm 2, example.com/x bağlantıları eklediği için bir marketplace yöneticisinin incelemesini bekliyor',
    );
    expect(tr.text).not.toContain('pazar yeri');
  });

  it('refuses a hand-set handle on a GitHub-only marketplace', async () => {
    const m = githubMarket();
    const r = await run(['publisher', 'alice'], { env, fetch: m.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual([
      'This marketplace takes your publisher handle from GitHub sign-in, so it cannot be set by hand. Run ccinfobar catalog login.',
    ]);
    expect(readProfile(cat).publishers).toEqual({});
    const tr = await withLangAsync('tr', () =>
      run(['publisher', 'alice', '--dry-run'], { env, fetch: m.fetch }),
    );
    expect(tr.err).toEqual([
      'Bu marketplace yayıncı adınızı GitHub girişinden alır, bu yüzden elle ayarlanamaz. ccinfobar catalog login komutunu çalıştırın.',
    ]);
    // showing the handle reads nothing
    const n = m.calls.length;
    expect((await run(['publisher'], { env, fetch: m.fetch })).code).toBeUndefined();
    expect(m.calls).toHaveLength(n);
    // a server that also takes tokens still lets you choose
    const both = githubMarket({ auth: ['token', 'github-device'] });
    expect((await run(['publisher', 'alice'], { env, fetch: both.fetch })).out).toEqual([
      `Publisher handle on ${GH_ENDPOINT} is now @alice. Nothing is sent until you publish.`,
    ]);
  });

  it('publisher --check reports a rejected entry and frees it (WR-04)', async () => {
    const m = githubMarket();
    await saveMine();
    writeCredential(GH_ENDPOINT, GH_TOKEN, cat);
    await run(['publish', '--yes'], { env, fetch: m.fetch });
    m.entries.delete('octo/mine');
    const out = await run(['publisher', '--check'], { env, fetch: m.fetch });
    expect(out.out).toEqual([
      `Signed in to ${GH_ENDPOINT} as @octo`,
      '1 entry was rejected by an admin; share it again to submit it as a new entry',
      'No entries are waiting for review',
    ]);
    expect(readEntry(entryOf('Mine').id, cat)!.entry.share).toMatchObject({ state: 'local', remote: null });
  });

  it('publisher --check asks the account and refreshes the review wait', async () => {
    const m = githubMarket();
    await saveMine();
    const out = await run(['publisher', '--check'], { env, fetch: m.fetch });
    expect(out.code).toBe(1);
    expect(out.err).toEqual(['Sign in first: ccinfobar catalog login']);
    expect(m.calls.map((c) => c.url)).toEqual([`${GH_ENDPOINT}/v1/meta.json`]);
    writeCredential(GH_ENDPOINT, GH_TOKEN, cat);
    await run(['publish', '--yes'], { env, fetch: m.fetch });
    const n = m.calls.length;
    const one = await run(['publisher', '--check'], { env, fetch: m.fetch });
    expect(one.code).toBeUndefined();
    expect(one.out).toEqual([`Signed in to ${GH_ENDPOINT} as @octo`, '1 entry is waiting for review']);
    expect(m.calls.slice(n).map((c) => c.url.slice(GH_ENDPOINT.length))).toEqual(['/v1/meta.json', '/v1/me']);
    m.approve('octo/mine');
    m.state.admin = true;
    const tr = await withLangAsync('tr', () => run(['publisher', '--check'], { env, fetch: m.fetch }));
    expect(tr.out).toEqual([
      `${GH_ENDPOINT} üzerinde @octo olarak giriş yaptınız`,
      "Bu marketplace'te yöneticisiniz.",
      '1 girdi onaylandı ve artık yayında',
      'İnceleme bekleyen girdi yok',
    ]);
    expect(readEntry(entryOf('Mine').id, cat)!.entry.share.remote?.review).toBeUndefined();
    expect((await run(['list', '--user'])).text).not.toContain('Waiting for review');
    const j = await withLangAsync('tr', () =>
      run(['publisher', '--check', '--json'], { env, fetch: m.fetch }),
    );
    expect(JSON.parse(j.out[0]!)).toEqual({
      schema: 1,
      endpoint: GH_ENDPOINT,
      publisher: 'octo',
      admin: true,
      checked: 0,
      cleared: 0,
      rejected: 0,
      waiting: 0,
    });
    for (const argv of [
      ['publisher', 'x', '--check'],
      ['publisher', '--check', '--forget'],
      ['publisher', '--check', '--dry-run'],
    ]) {
      const bad = await run(argv, { env, fetch: m.fetch });
      expect(bad.code).toBe(1);
      expect(bad.err[0]).toMatch(/^Usage: ccinfobar catalog list/);
    }
  });

  it('publisher --check names a marketplace without GitHub sign-in and a failed answer', async () => {
    const t = githubMarket({ auth: ['token'] });
    const r = await run(['publisher', '--check'], { env, fetch: t.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['This marketplace does not offer GitHub sign-in.']);
    expect((await run(['publisher', '--check'])).err).toEqual([
      'No marketplace endpoint set; entries stay waiting to publish',
    ]);
    const m = githubMarket();
    writeCredential(GH_ENDPOINT, 'c'.repeat(64), cat);
    const bad = await run(['publisher', '--check'], { env, fetch: m.fetch });
    expect(bad.code).toBe(1);
    expect(bad.err[0]).toMatch(/^Could not check your publisher account: The marketplace did not accept/);
    const tr = await withLangAsync('tr', () => run(['publisher', '--check'], { env, fetch: m.fetch }));
    expect(tr.err[0]).toMatch(/^Yayıncı hesabınız kontrol edilemedi: /);
  });
});

describe('catalog --remote', () => {
  it('needs an endpoint and sends nothing without one', async () => {
    const f = fakeFetch([]);
    const spy = vi.spyOn(globalThis, 'fetch');
    const list = await run(['list', '--remote'], { fetch: f.fetch });
    expect(list.code).toBe(1);
    expect(list.err).toEqual(['No marketplace endpoint set; entries stay waiting to publish']);
    const show = await run(['show', 'alp/x', '--remote'], { fetch: f.fetch });
    expect(show.code).toBe(1);
    expect(f.calls).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('lists published entries with author and publisher', async () => {
    await saveMine('Mine', 'preset');
    await saveMine('Look', 'theme');
    const s = await server();
    await run(['publish', '--yes'], { env: s.env });
    const r = await run(['list', '--remote'], { env: s.env });
    expect(r.out[0]).toBe(`Marketplace ${s.url}`);
    const rows = r.out.join('\n');
    expect(rows).toMatch(/ {4}Mine +alperen\/mine +Preset +v1 +Alperen \(alperen\)/);
    expect(rows).toMatch(/ {4}Look +alperen\/look +Theme +v1 +Alperen \(alperen\)/);
    expect(r.out).toContain('  Presets');
    const themes = await run(['list', '--remote', '--kind', 'theme'], { env: s.env });
    expect(themes.out.join('\n')).not.toContain('alperen/mine');
    const j = await withLangAsync('tr', () => run(['list', '--remote', '--json'], { env: s.env }));
    const parsed = JSON.parse(j.out[0]!);
    expect(parsed.schema).toBe(1);
    expect(parsed.endpoint).toBe(s.url);
    expect(parsed.entries.map((e: { id: string }) => e.id).sort()).toEqual(['alperen/look', 'alperen/mine']);
  });

  it('sanitizes remote names', async () => {
    const hash = 'a'.repeat(64);
    const index = {
      entries: [
        {
          id: 'evil/x',
          kind: 'preset',
          name: 'Ev\u001b[31mil\u202e',
          description: '',
          author: 'Real\u0007 Name',
          publisher: 'evil',
          version: 1,
          updatedAt: '2026-10-16T10:00:00.000Z',
          hash,
        },
      ],
      generatedAt: '2026-10-16T10:00:00.000Z',
    };
    const env = { CCINFOBAR_MARKETPLACE_URL: 'https://market.example.com' };
    const r = await run(['list', '--remote'], { env, fetch: fakeFetch([json(index)]).fetch });
    for (const line of [...r.out, ...r.err]) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
    expect(r.text).toContain('(evil)');
    const down = await run(['list', '--remote'], {
      env: { CCINFOBAR_MARKETPLACE_URL: 'https://down.example.com' },
      fetch: fakeFetch([new TypeError('fetch failed')]).fetch,
    });
    expect(down.code).toBe(1);
    expect(down.err).toEqual(['Could not read the marketplace: Could not reach the marketplace']);
  });

  it('shows versions, consent targets and the install hint', async () => {
    writeCfg([[{ id: 'l', type: 'link', options: { url: 'https://example.com/docs', text: 'Docs' } }]]);
    await saveMine();
    const s = await server();
    await run(['publish', '--yes'], { env: s.env });
    const r = await run(['show', 'alperen/mine', '--remote'], { env: s.env });
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toBe('Mine  alperen/mine');
    expect(r.out[1]).toBe('Preset · v1 · by Alperen (alperen)');
    expect(r.out).toContain('my layout');
    expect(r.out).toContain('Versions');
    expect(r.out.some((l) => /^ {2}v1 {2}\S/.test(l))).toBe(true);
    expect(r.out).toContain('Applying it runs commands or opens URLs:');
    expect(r.out).toContain('  link: https://example.com/docs');
    expect(r.out.at(-1)).toBe('Install it with: ccinfobar catalog install alperen/mine');
    const j = await withLangAsync('tr', () =>
      run(['show', 'alperen/mine', '--remote', '--json'], { env: s.env }),
    );
    const parsed = JSON.parse(j.out[0]!);
    expect(parsed).toMatchObject({ schema: 1, endpoint: s.url, entry: { id: 'alperen/mine', version: 1 } });
    expect(parsed.latest.targets).toEqual([
      { kind: 'link', line: 0, index: 0, target: 'https://example.com/docs' },
    ]);
    const tr = await withLangAsync('tr', () => run(['show', 'alperen/mine', '--remote'], { env: s.env }));
    expect(tr.out).toContain('Sürümler');
    expect(tr.out.at(-1)).toBe('Yüklemek için: ccinfobar catalog install alperen/mine');
    const bad = await run(['show', 'nope', '--remote'], { env: s.env });
    expect(bad.code).toBe(1);
    expect(bad.err).toEqual(['nope is not a marketplace id; use publisher/slug']);
    const missing = await run(['show', 'alperen/none', '--remote'], { env: s.env });
    expect(missing.err).toEqual([
      'Could not read the marketplace: The entry was not found on the marketplace',
    ]);
  });
});
