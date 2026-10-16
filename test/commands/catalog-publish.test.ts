import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shareState } from '../../src/catalog/share.js';
import { listEntries, readCredential, readEntry } from '../../src/catalog/store.js';
import { parseArgs } from '../../src/cli/args.js';
import { runCatalog } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
import { startMarketServer } from '../../src/market/server.js';
import { fakeFetch, json } from '../fake-fetch.js';
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
    expect(f.calls()).toBe(0);
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
    expect(f.calls()).toBe(0);
  });

  it('asks in a terminal and keeps everything on no', async () => {
    await saveMine();
    const s = await server();
    const f = counted();
    const r = await run(['publish'], { env: s.env, fetch: f.fetch, tty: true, answers: [false] });
    expect(r.asked).toEqual(['Send this entry?']);
    expect(r.out.at(-1)).toBe('Nothing was sent.');
    expect(f.calls()).toBe(0);
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

  it('says withdrawn ids stay reserved when a withdrawn entry is shared again', async () => {
    await saveMine();
    const s = await server();
    await run(['publish', '--yes'], { env: s.env });
    await run(['unshare', entryOf('Mine').id]);
    await run(['publish', '--yes'], { env: s.env });
    await run(['share', entryOf('Mine').id]);
    const f = counted();
    const r = await run(['publish', '--yes'], { env: s.env, fetch: f.fetch });
    expect(r.out).toEqual([
      'Mine was withdrawn from the marketplace, and withdrawn ids stay reserved. Save it under a new name to publish it again.',
      'Nothing is waiting to publish.',
    ]);
    expect(f.calls()).toBe(0);
    const tr = await withLangAsync('tr', () => run(['publish', '--yes'], { env: s.env }));
    expect(tr.out[0]).toBe(
      'Mine pazar yerinden geri çekildi ve geri çekilen kimlikler ayrılmış kalır. Yeniden yayımlamak için farklı bir adla kaydedin.',
    );
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
    await saveMine('Mine', 'preset');
    await saveMine('Mine', 'theme');
    const s = await server();
    const r = await run(['publish', '--yes'], { env: s.env });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Published Mine v1 as alperen/mine');
    expect(r.err).toEqual(['Mine: The marketplace already has an entry with this name']);
    const tr = await withLangAsync('tr', () => run(['publish', '--yes'], { env: s.env }));
    expect(tr.err).toEqual(['Mine: Pazar yerinde bu adla bir girdi zaten var']);
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
    expect(tr.err).toEqual(['Yayımlama başarısız oldu: Bu pazar yeri salt okunur ve yükleme kabul etmiyor']);
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
      env,
      fetch: fakeFetch([new TypeError('fetch failed')]).fetch,
    });
    expect(down.code).toBe(1);
    expect(down.err).toEqual(['Could not read the marketplace: Could not reach the marketplace']);
  });

  it('shows versions, consent targets and the read-only note', async () => {
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
    expect(r.out.at(-1)).toBe('Read only: installing from the marketplace is not available yet.');
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
    expect(tr.out.at(-1)).toBe('Salt okunur: pazar yerinden yükleme henüz kullanılamıyor.');
    const bad = await run(['show', 'nope', '--remote'], { env: s.env });
    expect(bad.code).toBe(1);
    expect(bad.err).toEqual(['nope is not a marketplace id; use publisher/slug']);
    const missing = await run(['show', 'alperen/none', '--remote'], { env: s.env });
    expect(missing.err).toEqual([
      'Could not read the marketplace: The entry was not found on the marketplace',
    ]);
  });
});
