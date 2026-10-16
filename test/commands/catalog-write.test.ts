import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markPublished } from '../../src/catalog/model.js';
import { contentFromConfig } from '../../src/catalog/snapshot.js';
import {
  commitEntry,
  listEntries,
  readEntry,
  readProfile,
  saveEntry,
  writeProfile,
} from '../../src/catalog/store.js';
import { findSystem } from '../../src/catalog/system.js';
import { parseArgs } from '../../src/cli/args.js';
import { runCatalog } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
import { normalizeConfig } from '../../src/core/config.js';
import { tildify } from '../../src/core/paths.js';
import { resolveTheme, saveUserTheme, themeToInput } from '../../src/core/themes.js';
import { withLangAsync } from '../helpers.js';

let root = '';
let cat = '';
let cfg = '';
let themes = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['CCINFOBAR_CONFIG_DIR', 'HOME', 'USERPROFILE', 'CCINFOBAR_MARKETPLACE_URL'];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-write-'));
  cat = path.join(root, 'catalog');
  cfg = path.join(root, 'config.json');
  themes = path.join(root, 'themes');
  fs.mkdirSync(path.join(root, 'presets'));
  fs.mkdirSync(themes);
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CCINFOBAR_CONFIG_DIR = root;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  delete process.env.CCINFOBAR_MARKETPLACE_URL;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.exitCode = undefined;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const NOW = new Date('2026-10-16T10:00:00.000Z');
const model = [{ id: 'm', type: 'model' }];

interface RunOpts {
  tty?: boolean;
  answers?: boolean[];
  fetch?: typeof fetch;
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
    env: {},
    gsd: true,
    now: () => NOW,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, asked, code };
}

const writeCfg = (c: object) => fs.writeFileSync(cfg, `${JSON.stringify(c, null, 2)}\n`);
const readCfg = () => JSON.parse(fs.readFileSync(cfg, 'utf8'));
const backups = () => fs.readdirSync(root).filter((f) => f.startsWith('config.json.') && f.endsWith('.bak'));
const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const text = (r: { out: string[]; err: string[] }) => [...r.out, ...r.err].join('\n');

const PERSONAL = {
  budget: { daily: 5, session: 2 },
  profiles: { builtIn: false },
  language: 'tr',
  charset: 'unicode',
};

function userEntry(layout: object[][], extra: Record<string, unknown> = {}) {
  return saveEntry(
    {
      kind: 'bundle',
      name: 'Tools',
      description: '',
      author: 'Ann',
      content: { layout: { lines: layout as never }, appearance: { theme: 'nord' } },
      share: false,
      mode: 'new',
      now: NOW,
      ...extra,
    },
    cat,
  );
}

describe('catalog apply', () => {
  it('applies a bundle and keeps personal keys, with a backup', async () => {
    writeCfg({ lines: [model], theme: 'dracula', ...PERSONAL });
    const before = normalizeConfig(readCfg());
    const r = await run(['apply', 'bundle/nord-minimal']);
    expect(r.code).toBeUndefined();
    const after = readCfg();
    const sys = findSystem('bundle/nord-minimal', { gsd: true })!;
    expect(after.lines).toEqual(normalizeConfig({ ...sys.content.layout }).lines);
    expect(after.theme).toBe('nord');
    for (const k of ['budget', 'profiles', 'language', 'charset'] as const)
      expect(after[k]).toEqual(before[k]);
    expect(backups()).toHaveLength(1);
    expect(r.out[0]).toBe(`Applied Nord minimal to ${tildify(cfg)}`);
    expect(r.out[1]).toBe(`Previous config saved to ${tildify(path.join(root, backups()[0]!))}`);
  });

  it('applies a preset and keeps the theme and style (D-23)', async () => {
    writeCfg({ lines: [model], theme: 'gruvbox', style: 'capsule', separator: ' | ' });
    await run(['apply', 'preset/compact']);
    const after = readCfg();
    expect(after.theme).toBe('gruvbox');
    expect(after.style).toBe('capsule');
    expect(after.separator).toBe(' | ');
    expect(after.lines).toEqual(
      normalizeConfig({ ...findSystem('preset/compact', { gsd: true })!.content.layout }).lines,
    );
  });

  it('installs an embedded theme as <id>-2 when a different one exists (D-26)', async () => {
    saveUserTheme({ ...themeToInput(resolveTheme('nord'), 'mine'), name: 'Mine' }, themes);
    const content = contentFromConfig(normalizeConfig({ lines: [model], theme: 'mine' }), 'bundle');
    const e = saveEntry(
      { kind: 'bundle', name: 'Mine', description: '', author: '', content, share: false, mode: 'new' },
      cat,
    );
    saveUserTheme({ ...themeToInput(resolveTheme('dracula'), 'mine'), name: 'Mine' }, themes);
    writeCfg({ lines: [model] });
    const r = await run(['apply', e.id]);
    expect(r.code).toBeUndefined();
    expect(readCfg().theme).toBe('mine-2');
    expect(files(themes).sort()).toEqual(['mine-2.json', 'mine.json']);
    expect(r.out).toContain('A different theme mine exists; installed this one as mine-2');
    const again = await run(['apply', e.id, '--json']);
    expect(JSON.parse(again.out[0]!).theme).toEqual({ id: 'mine-2', written: false, renamed: true });
  });

  it('--dry-run writes nothing and prints a preview', async () => {
    writeCfg({ lines: [model], theme: 'dracula' });
    const bytes = fs.readFileSync(cfg);
    const r = await run(['apply', 'bundle/nord-minimal', '--dry-run']);
    expect(r.code).toBeUndefined();
    expect(fs.readFileSync(cfg)).toEqual(bytes);
    expect(backups()).toEqual([]);
    expect(files(themes)).toEqual([]);
    expect(r.out[0]).toBe('Dry run: nothing was written. Nord minimal with sample data:');
    expect(r.out.length).toBeGreaterThan(1);
    const j = await run(['apply', 'bundle/nord-minimal', '--dry-run', '--json']);
    const parsed = JSON.parse(j.out[0]!);
    expect(parsed).toMatchObject({ schema: 1, applied: 'bundle/nord-minimal', dryRun: true, backup: null });
    expect(parsed.preview.length).toBeGreaterThan(0);
    expect(fs.readFileSync(cfg)).toEqual(bytes);
  });

  it('drops command widgets without consent and keeps them with --allow-commands', async () => {
    const e = userEntry([[...model, { id: 'c', type: 'command', options: { command: 'echo hi' } }]]);
    writeCfg({ lines: [model] });
    const r = await run(['apply', e.id]);
    expect(r.code).toBeUndefined();
    expect(readCfg().lines[0].map((i: { type: string }) => i.type)).toEqual(['model']);
    expect(r.out).toContain('This layout runs commands or opens URLs:');
    expect(text(r)).toMatch(new RegExp(`catalog apply "?${e.id}"? --allow-commands`));
    const prompt = await run(['apply', e.id], { tty: true, answers: [true] });
    expect(prompt.asked).toEqual(['Keep this item?']);
    expect(readCfg().lines[0].map((i: { type: string }) => i.type)).toEqual(['model', 'command']);
    const yes = await run(['apply', e.id, '--yes', '--json'], { tty: true });
    expect(yes.asked).toEqual([]);
    expect(JSON.parse(yes.out[0]!).dropped).toEqual([{ kind: 'command', target: 'echo hi' }]);
    expect(readCfg().lines[0]).toHaveLength(1);
    await run(['apply', e.id, '--allow-commands']);
    expect(readCfg().lines[0][1]).toMatchObject({ type: 'command', options: { command: 'echo hi' } });
  });

  it('refuses a broken config', async () => {
    fs.writeFileSync(cfg, '{ "lines": [');
    const r = await run(['apply', 'bundle/nord-minimal']);
    expect(r.code).toBe(1);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{ "lines": [');
    expect(backups()).toEqual([]);
  });

  it('--json is English with the documented shape', async () => {
    writeCfg({ lines: [model] });
    const r = await withLangAsync('tr', () => run(['apply', 'bundle/nord-minimal', '--json']));
    expect(r.out).toHaveLength(1);
    const j = JSON.parse(r.out[0]!);
    expect(j).toEqual({
      schema: 1,
      applied: 'bundle/nord-minimal',
      kind: 'bundle',
      file: cfg,
      backup: path.join(root, backups()[0]!),
      theme: null,
      dropped: [],
    });
  });

  it('applies a theme without touching the layout', async () => {
    const cmd = [...model, { id: 'c', type: 'command', options: { command: 'echo mine' } }];
    writeCfg({ lines: [cmd], theme: 'classic', style: 'capsule' });
    const r = await run(['apply', 'theme/nord']);
    expect(r.out.join('\n')).not.toContain('runs commands');
    const after = readCfg();
    expect(after.theme).toBe('nord');
    expect(after.style).toBeUndefined();
    expect(after.lines[0]).toHaveLength(2);
  });
});

describe('catalog save', () => {
  it('saves a bundle waiting to publish with the remembered author', async () => {
    writeProfile({ author: 'Pat' }, cat);
    writeCfg({ lines: [model], theme: 'nord' });
    const r = await run(['save', 'My look']);
    expect(r.code).toBeUndefined();
    expect(r.out).toEqual([
      'Saved bundle My look v1',
      'Waiting to publish. No marketplace endpoint is set, so nothing was sent.',
    ]);
    const [e] = listEntries(cat);
    expect(e).toMatchObject({ kind: 'bundle', name: 'My look', author: 'Pat', version: 1 });
    expect(e!.share.state).toBe('pending');
    expect(readProfile(cat).author).toBe('Pat');
  });

  it('remembers --author for the next save (D-07)', async () => {
    writeCfg({ lines: [model] });
    await run(['save', 'One', '--author', 'Alp', '--description', 'First']);
    expect(readProfile(cat).author).toBe('Alp');
    await run(['save', 'Two']);
    const byName = Object.fromEntries(listEntries(cat).map((e) => [e.name, e]));
    expect(byName.One).toMatchObject({ author: 'Alp', description: 'First' });
    expect(byName.Two!.author).toBe('Alp');
  });

  it('saves a theme only, not shared', async () => {
    writeCfg({ lines: [model], theme: 'nord' });
    const r = await run(['save', 'My look', '--kind', 'theme', '--no-share']);
    const [e] = listEntries(cat);
    expect(e).toMatchObject({ kind: 'theme' });
    expect(e!.share.state).toBe('local');
    expect(r.out[1]).toBe(`Not shared. Share it later with ccinfobar catalog share ${e!.id}.`);
    expect(Object.keys(e!.versions[0]!.content)).toEqual(['appearance']);
    expect((await run(['save', 'x', '--kind', 'nope'])).code).toBe(1);
  });

  it('needs --update or --overwrite on a name clash (D-06)', async () => {
    writeCfg({ lines: [model], theme: 'nord' });
    await run(['save', 'My look']);
    const id = listEntries(cat)[0]!.id;
    const before = fs.readFileSync(path.join(cat, 'entries', `${id}.json`));
    const clash = await run(['save', 'My look']);
    expect(clash.code).toBe(1);
    expect(clash.err).toEqual([
      'My look already exists as v1. Run again with --update to add a new version or --overwrite to replace v1.',
    ]);
    expect(fs.readFileSync(path.join(cat, 'entries', `${id}.json`))).toEqual(before);
    expect((await run(['save', 'My look', '--update', '--note', 'two'])).out[0]).toBe(
      'Saved bundle My look v2',
    );
    writeCfg({ lines: [model], theme: 'dracula' });
    await run(['save', 'My look', '--overwrite']);
    let e = readEntry(id, cat)!.entry;
    expect(e.version).toBe(2);
    expect(e.versions[1]!.content.appearance).toEqual({ theme: 'dracula' });
    expect(e.versions[1]!.overwrittenAt).toBeDefined();
    writeCfg({ lines: [model], theme: 'gruvbox' });
    const tty = await run(['save', 'My look'], { tty: true, answers: [false, true] });
    expect(tty.out[0]).toBe('My look already exists (v2). Update adds v3, overwrite replaces v2.');
    expect(tty.asked).toEqual(['Add v3?', 'Replace v2?']);
    e = readEntry(id, cat)!.entry;
    expect(e.version).toBe(2);
    expect(e.versions[1]!.content.appearance).toEqual({ theme: 'gruvbox' });
    const no = await run(['save', 'My look'], { tty: true });
    expect(no.out).toContain('Nothing was saved.');
    expect(readEntry(id, cat)!.entry.rev).toBe(e.rev);
    expect((await run(['save', 'My look', '--update', '--overwrite'])).code).toBe(1);
  });

  it('--dry-run --json prints the content and writes nothing', async () => {
    writeCfg({ lines: [model], theme: 'nord' });
    const r = await run(['save', 'My look', '--dry-run', '--json', '--author', 'Zed']);
    const j = JSON.parse(r.out[0]!);
    expect(j).toMatchObject({
      schema: 1,
      id: null,
      kind: 'bundle',
      version: 1,
      share: 'pending',
      mode: 'new',
    });
    expect(j.content.appearance).toEqual({ theme: 'nord' });
    expect(files(cat)).toEqual([]);
    const plain = await run(['save', 'My look', '--dry-run']);
    expect(plain.out[0]).toBe('Dry run: nothing was written. bundle My look v1 would contain:');
    expect(files(cat)).toEqual([]);
  });

  it('saves the JSON shape in English', async () => {
    writeCfg({ lines: [model] });
    const r = await withLangAsync('tr', () => run(['save', 'My look', '--json', '--no-share']));
    const id = listEntries(cat)[0]!.id;
    expect(JSON.parse(r.out[0]!)).toEqual({
      schema: 1,
      id,
      kind: 'bundle',
      name: 'My look',
      version: 1,
      share: 'local',
      mode: 'new',
    });
  });
});

describe('catalog restore, share, unshare and delete', () => {
  it('restore appends a version', async () => {
    writeCfg({ lines: [model], theme: 'nord' });
    await run(['save', 'My look']);
    writeCfg({ lines: [model], theme: 'dracula' });
    await run(['save', 'My look', '--update']);
    const id = listEntries(cat)[0]!.id;
    const dry = await run(['restore', id, '1', '--dry-run']);
    expect(dry.out).toEqual(['Restored v1 of My look as v3', 'Dry run: nothing was written.']);
    expect(readEntry(id, cat)!.entry.version).toBe(2);
    const r = await run(['restore', id, '1']);
    expect(r.out).toEqual(['Restored v1 of My look as v3']);
    const e = readEntry(id, cat)!.entry;
    expect(e.version).toBe(3);
    expect(e.versions[2]).toMatchObject({ note: '', restoredFrom: 1 });
    expect(e.versions[2]!.content.appearance).toEqual({ theme: 'nord' });
    const missing = await run(['restore', id, '9']);
    expect(missing.code).toBe(1);
    expect(missing.err).toEqual([`Entry ${id} has no version 9`]);
    expect((await run(['restore', id, 'x'])).code).toBe(1);
    expect(JSON.parse((await run(['restore', id, '2', '--json'])).out[0]!)).toEqual({
      schema: 1,
      id,
      version: 4,
      restoredFrom: 2,
    });
  });

  it('share and unshare change the publish state', async () => {
    const e = userEntry([model]);
    const on = await run(['share', e.id]);
    expect(on.out).toEqual(['Sharing Tools: Waiting to publish']);
    expect(readEntry(e.id, cat)!.entry.share.state).toBe('pending');
    const off = await run(['unshare', e.id, '--json']);
    expect(JSON.parse(off.out[0]!)).toEqual({ schema: 1, id: e.id, share: 'local' });
    const cur = readEntry(e.id, cat)!.entry;
    const remote = {
      endpoint: 'https://market.example.com',
      id: 'ann/tools',
      version: 1,
      hash: 'x',
      publishedAt: '',
    };
    commitEntry(markPublished(cur, remote), cur.rev, cat);
    const withdraw = await run(['unshare', e.id]);
    expect(withdraw.out).toEqual([
      'Not sharing Tools: Waiting to withdraw',
      'It stays on the marketplace until the next publish withdraws it.',
    ]);
    expect(readEntry(e.id, cat)!.entry.share.state).toBe('withdraw-pending');
    const dry = await run(['share', e.id, '--dry-run']);
    expect(dry.out[1]).toBe('Dry run: nothing was written.');
    expect(readEntry(e.id, cat)!.entry.share.state).toBe('withdraw-pending');
    expect((await run(['share', 'bundle/nord-minimal'])).err).toEqual(['Built-in entries cannot be changed']);
  });

  it('adopts a legacy preset before sharing it', async () => {
    fs.writeFileSync(
      path.join(root, 'presets', 'old.json'),
      JSON.stringify({ name: 'Old one', config: { lines: [model] } }),
    );
    const r = await run(['share', 'legacy:preset/old']);
    expect(r.code).toBeUndefined();
    const [e] = listEntries(cat);
    expect(e).toMatchObject({ name: 'Old one', legacy: { preset: 'old' } });
    expect(e!.share.state).toBe('pending');
    expect(fs.existsSync(path.join(root, 'presets', 'old.json'))).toBe(true);
  });

  it('delete needs confirmation and moves to the trash', async () => {
    const e = userEntry([model]);
    const entry = path.join(cat, 'entries', `${e.id}.json`);
    const no = await run(['delete', e.id]);
    expect(no.code).toBe(1);
    expect(no.err).toEqual(['Run again with --yes to delete Tools.']);
    expect(fs.existsSync(entry)).toBe(true);
    const kept = await run(['delete', e.id], { tty: true, answers: [false] });
    expect(kept.asked).toEqual([`Delete Tools? It goes to ${tildify(path.join(cat, 'trash'))}.`]);
    expect(kept.out).toEqual(['Tools was kept.']);
    expect(fs.existsSync(entry)).toBe(true);
    const dry = await run(['delete', e.id, '--dry-run']);
    expect(dry.out[1]).toBe('Dry run: nothing was written.');
    expect(fs.existsSync(entry)).toBe(true);
    const yes = await run(['delete', e.id, '--yes', '--json']);
    const j = JSON.parse(yes.out[0]!);
    expect(j.deleted).toBe(e.id);
    expect(fs.existsSync(j.trash)).toBe(true);
    expect(fs.existsSync(entry)).toBe(false);
    const sys = await run(['delete', 'bundle/nord-minimal', '--yes']);
    expect(sys.code).toBe(1);
    expect(sys.err).toEqual(['Built-in entries cannot be changed']);
  });

  it('deletes a legacy preset with a trash copy', async () => {
    const file = path.join(root, 'presets', 'old.json');
    fs.writeFileSync(file, JSON.stringify({ name: 'Old one', config: { lines: [model] } }));
    const r = await run(['delete', 'legacy:preset/old', '--yes']);
    expect(r.out).toEqual([`Moved Old one to ${tildify(path.join(cat, 'trash'))}`]);
    expect(fs.existsSync(file)).toBe(false);
    expect(files(path.join(cat, 'trash'))).toHaveLength(1);
  });
});

describe('catalog author and endpoint', () => {
  it('shows and sets the remembered author', async () => {
    expect((await run(['author'])).out).toEqual([
      'No author set. Set one with ccinfobar catalog author <name>.',
    ]);
    expect((await run(['author', 'Alp', 'Adalar', '--dry-run'])).out).toEqual([
      'Author is now Alp Adalar',
      'Dry run: nothing was written.',
    ]);
    expect(readProfile(cat).author).toBe('');
    expect((await run(['author', 'Alp'])).out).toEqual(['Author is now Alp']);
    expect((await run(['author'])).out).toEqual(['Author: Alp']);
    expect(JSON.parse((await run(['author', '--json'])).out[0]!)).toEqual({ schema: 1, author: 'Alp' });
  });

  it('shows, validates, sets and clears the endpoint without any fetch (D-09)', async () => {
    const fake = vi.fn(async () => new Response('{}'));
    const global = vi.spyOn(globalThis, 'fetch').mockImplementation(fake);
    const opts = { fetch: fake as unknown as typeof fetch };
    expect((await run(['endpoint'], opts)).out).toEqual([
      'No marketplace endpoint set. Nothing is sent anywhere.',
    ]);
    const bad = await run(['endpoint', 'http://example.com'], opts);
    expect(bad.code).toBe(1);
    expect(bad.err).toEqual(['Marketplace endpoint must be an https URL (http only for localhost)']);
    expect(readProfile(cat).endpoint).toBeNull();
    const set = await run(['endpoint', 'http://127.0.0.1:9/'], opts);
    expect(set.out).toEqual([
      'Marketplace endpoint is now http://127.0.0.1:9. Nothing is sent until you publish.',
    ]);
    expect(readProfile(cat).endpoint).toBe('http://127.0.0.1:9');
    expect((await run(['endpoint'], opts)).out).toEqual(['Marketplace endpoint: http://127.0.0.1:9']);
    expect(JSON.parse((await run(['endpoint', '--json'], opts)).out[0]!)).toEqual({
      schema: 1,
      endpoint: 'http://127.0.0.1:9',
    });
    writeCfg({ lines: [model] });
    expect((await run(['save', 'My look'], opts)).out[1]).toBe(
      'Waiting to publish. Nothing is sent until you publish it.',
    );
    expect((await run(['endpoint', '--clear'], opts)).out).toEqual([
      'Marketplace endpoint removed. Nothing is sent anywhere.',
    ]);
    expect(readProfile(cat).endpoint).toBeNull();
    expect(fake).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });
});

describe('catalog write text in Turkish', () => {
  it('uses the Turkish text', async () => {
    writeCfg({ lines: [model] });
    const tr = (argv: string[], opts?: RunOpts) => withLangAsync('tr', () => run(argv, opts));
    expect((await tr(['save', 'Görünüm'])).out).toEqual([
      'Görünüm (paket) v1 olarak kaydedildi',
      'Yayımlanmayı bekliyor. Pazar yeri adresi ayarlanmadığı için hiçbir şey gönderilmedi.',
    ]);
    const id = listEntries(cat)[0]!.id;
    expect((await tr(['save', 'Görünüm'])).err[0]).toMatch(/^Görünüm zaten v1 olarak var\. /);
    expect((await tr(['restore', id, '1'])).out).toEqual(['Görünüm için v1 sürümü v2 olarak geri yüklendi']);
    expect(readEntry(id, cat)!.entry.versions[1]).toMatchObject({ note: '', restoredFrom: 1 });
    expect((await tr(['unshare', id])).out).toEqual(['Görünüm paylaşılmıyor: Paylaşılmadı']);
    expect((await tr(['delete', id])).err).toEqual([
      'Görünüm girdisini silmek için --yes ile tekrar çalıştırın.',
    ]);
    expect((await tr(['author'])).out).toEqual([
      'Yazar ayarlanmadı. ccinfobar catalog author <name> ile ayarlayın.',
    ]);
    expect((await tr(['endpoint'])).out).toEqual([
      'Pazar yeri adresi ayarlanmadı. Hiçbir yere bir şey gönderilmez.',
    ]);
    const apply = await tr(['apply', 'bundle/nord-minimal']);
    expect(apply.out[0]).toBe(`Nord minimal, ${tildify(cfg)} dosyasına uygulandı`);
    expect(apply.out[1]).toMatch(/^Önceki yapılandırma .* dosyasına kaydedildi$/);
    expect((await tr(['delete', 'bundle/nord-minimal', '--yes'])).err).toEqual([
      'Yerleşik girdiler değiştirilemez',
    ]);
  });
});
