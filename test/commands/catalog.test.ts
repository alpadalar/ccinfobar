import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEntry, restoreEntry, saveEntry } from '../../src/catalog/store.js';
import { systemEntries } from '../../src/catalog/system.js';
import { parseArgs } from '../../src/cli/args.js';
import { type AnyEntry, resolveRef, runCatalog } from '../../src/commands/catalog.js';
import type { PromptIo } from '../../src/commands/io.js';
import { withLangAsync } from '../helpers.js';

let root = '';
let cat = '';
let cfg = '';
let prev: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-catalog-cmd-'));
  cat = path.join(root, 'catalog');
  cfg = path.join(root, 'config.json');
  fs.mkdirSync(path.join(root, 'presets'));
  fs.mkdirSync(path.join(root, 'themes'));
  prev = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = root;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prev;
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-16T10:00:00.000Z');
const lines = [[{ id: 'm', type: 'model' }]];

function saveBundle(name = 'My look') {
  return saveEntry(
    {
      kind: 'bundle',
      name,
      description: 'Mine',
      author: 'Ann',
      content: { layout: { lines }, appearance: { theme: 'nord' } },
      share: false,
      mode: 'new',
      now: NOW,
    },
    cat,
  );
}

function legacyPreset(): void {
  fs.writeFileSync(
    path.join(root, 'presets', 'old.json'),
    JSON.stringify({ name: 'Old one', description: 'Older', config: { lines } }),
  );
}

async function run(argv: string[], opts: { gsd?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: PromptIo = {
    tty: false,
    columns: 100,
    ask: async () => false,
    log: (l) => void out.push(l),
    error: (l) => void err.push(l),
  };
  process.exitCode = undefined;
  await runCatalog(parseArgs(['catalog', ...argv]), cfg, { io, dir: cat, gsd: opts.gsd ?? true });
  const code = process.exitCode;
  process.exitCode = undefined;
  return { out, err, code };
}

const all = (gsd = true): AnyEntry[] => systemEntries({ gsd }).map((entry) => ({ source: 'system', entry }));

const section = (out: string[], heading: string) => {
  const i = out.indexOf(heading);
  if (i < 0) return [];
  const end = out.indexOf('', i);
  return out.slice(i + 1, end < 0 ? undefined : end);
};
const rows = (part: string[]) => part.filter((l) => l.startsWith('    '));

describe('catalog command', () => {
  it('prints the usage and fails without a known subcommand', async () => {
    for (const argv of [[], ['nope'], ['show'], ['history']]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.join('\n')).toContain('Usage: ccinfobar catalog list');
    }
  });

  it('resolves refs in order', () => {
    const user = saveBundle('Nord minimal');
    const mine: AnyEntry = { source: 'user', entry: user };
    const sys = all();
    const hit = (ref: string, list = sys) => resolveRef(ref, list);
    const nord = hit('bundle/nord-minimal');
    expect(nord && 'source' in nord && nord.source === 'system' && nord.entry.ref).toBe(
      'bundle/nord-minimal',
    );
    expect(hit(user.id, [mine, ...sys])).toBe(mine);
    expect(hit('bundle/nord-minimal', [...sys, mine])).toBe(mine);
    expect(resolveRef('minimal', sys)).toEqual({ ambiguous: ['preset/minimal', 'theme/minimal'] });
    const cockpit = hit('catppuccin-cockpit');
    expect(cockpit && 'source' in cockpit && cockpit.source === 'system' && cockpit.entry.ref).toBe(
      'bundle/catppuccin-cockpit',
    );
    expect(resolveRef('nope', sys)).toBeNull();
    expect(resolveRef('preset/nope', sys)).toBeNull();
    expect(resolveRef('', sys)).toBeNull();
  });

  it('labels presets/ and themes/ files by what they are (IN-04)', async () => {
    fs.mkdirSync(path.join(root, 'themes'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'themes', 'oldt.json'),
      JSON.stringify({ name: 'Old theme', extends: 'nord' }),
    );
    legacyPreset();
    const text = (await run(['list', '--user'])).out.join('\n');
    expect(text).toMatch(/Old theme +legacy:theme\/oldt +Theme +v1 +Theme file/);
    expect(text).toMatch(/Old one +legacy:preset\/old +Preset +v1 +Preset file/);
    const tr = (await withLangAsync('tr', () => run(['list', '--user']))).out.join('\n');
    expect(tr).toContain('Tema dosyası');
    expect(tr).toContain('Hazır ayar dosyası');
  });

  it('list prints user entries then system entries grouped by kind', async () => {
    saveBundle();
    legacyPreset();
    const r = await run(['list']);
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toBe('Your entries');
    const mine = section(r.out, 'Your entries');
    expect(mine.join('\n')).toMatch(/Bundles\n {4}My look +u-[0-9a-f]{12} +Bundle +v1 +Ann +Not shared/);
    expect(mine.join('\n')).toMatch(/Presets\n {4}Old one +legacy:preset\/old +Preset +v1 +Preset file/);
    const sys = section(r.out, 'Built in');
    const headings = sys.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
    expect(headings).toEqual(['Bundles', 'Presets', 'Themes']);
    expect(rows(sys)).toHaveLength(61);
    expect(rows(sys)[0]).toMatch(/^ {4}Mocha cockpit +bundle\/catppuccin-cockpit +Bundle +v1 +ccinfobar$/);
    expect(r.out.indexOf('Your entries')).toBeLessThan(r.out.indexOf('Built in'));
    const nogsd = await run(['list', '--system'], { gsd: false });
    expect(rows(section(nogsd.out, 'Built in')).length).toBeLessThan(61);
  });

  it('list filters by kind and section', async () => {
    saveBundle();
    const themes = await run(['list', '--kind', 'theme']);
    expect(themes.out).not.toContain('Your entries');
    expect(themes.out.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim())).toEqual(['Themes']);
    expect(rows(themes.out).every((l) => / Theme +v1/.test(l))).toBe(true);
    const user = await run(['list', '--user']);
    expect(user.out).not.toContain('Built in');
    expect(rows(user.out)).toHaveLength(1);
    const sys = await run(['list', '--system']);
    expect(sys.out).not.toContain('Your entries');
    expect(rows(sys.out)).toHaveLength(61);
    const bad = await run(['list', '--kind', 'layout']);
    expect(bad.code).toBe(1);
    expect(bad.err).toEqual(['--kind must be preset, theme or bundle']);
    expect((await run(['list', '--kind'])).code).toBe(1);
  });

  it('list says when there are no saved entries', async () => {
    const r = await run(['list', '--user']);
    expect(r.out).toEqual([
      'Your entries',
      '  No saved entries yet. Save one with ccinfobar catalog save <name>.',
    ]);
  });

  it('list --json is English and has schema 1', async () => {
    const e = saveBundle();
    legacyPreset();
    const en = await run(['list', '--json']);
    expect(en.out).toHaveLength(1);
    const data = JSON.parse(en.out[0]!);
    expect(data.schema).toBe(1);
    expect(data.user.map((s: { ref: string }) => s.ref)).toEqual([e.id, 'legacy:preset/old']);
    expect(data.user[0]).toEqual({
      ref: e.id,
      source: 'user',
      kind: 'bundle',
      name: 'My look',
      description: 'Mine',
      author: 'Ann',
      version: 1,
      share: 'local',
      updatedAt: NOW.toISOString(),
      cols: null,
    });
    expect(data.user[1]).toMatchObject({ source: 'legacy', kind: 'preset', share: null, updatedAt: null });
    expect(data.system).toHaveLength(61);
    expect(data.system[0]).toMatchObject({ ref: 'bundle/catppuccin-cockpit', name: 'Mocha cockpit' });
    const tr = await withLangAsync('tr', () => run(['list', '--json']));
    expect(tr.out[0]).toBe(en.out[0]);
    expect(tr.out[0]).not.toMatch(/[çğıİöşüÇĞÖŞÜ]/);
    const kind = JSON.parse((await run(['list', '--json', '--kind', 'preset', '--system'])).out[0]!);
    expect(kind.user).toEqual([]);
    expect(kind.system.every((s: { kind: string }) => s.kind === 'preset')).toBe(true);
  });

  it('show <ref> prints details and a preview', async () => {
    const r = await run(['show', 'bundle/nord-minimal']);
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toBe('Nord minimal  bundle/nord-minimal');
    expect(r.out[1]).toBe('Bundle · v1 · by ccinfobar · Built in');
    expect(r.out[2]).toBe('One compact line in cool Nord powerline colors');
    const at = r.out.indexOf('Preview');
    expect(at).toBeGreaterThan(0);
    const preview = r.out.slice(at + 1);
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.join('\n')).toContain('Opus');
    expect(preview.join('')).not.toContain('\u001b');
    const json = await run(['show', 'bundle/nord-minimal', '--json', '--width', '80']);
    const data = JSON.parse(json.out[0]!);
    expect(data.schema).toBe(1);
    expect(data.entry).toMatchObject({ ref: 'bundle/nord-minimal', kind: 'bundle', author: 'ccinfobar' });
    expect(data.entry.versions).toBeUndefined();
    expect(Array.isArray(data.preview) && data.preview.length > 0).toBe(true);
    expect(data.preview.every((l: unknown) => typeof l === 'string' && !l.includes('\u001b'))).toBe(true);
  });

  it('list and show print cols and show previews at it', async () => {
    const wide = saveEntry(
      {
        kind: 'bundle',
        name: 'Wide',
        description: '',
        author: 'Ann',
        content: {
          layout: {
            lines: [
              [
                { id: 'm', type: 'model' },
                { id: 'f', type: 'flex' },
                { id: 'c', type: 'text', options: { text: 'end' } },
              ],
            ],
          },
          appearance: { theme: 'nord' },
        },
        cols: 150,
        share: false,
        mode: 'new',
        now: NOW,
      },
      cat,
    );
    saveBundle();
    const list = await run(['list', '--user']);
    expect(list.out.find((l) => l.includes('Wide'))).toContain('v1  150 cols');
    expect(list.out.find((l) => l.includes('My look'))).not.toContain('cols');
    const json = JSON.parse((await run(['list', '--json', '--user'])).out[0]!);
    expect(json.user.map((u: { cols: number | null }) => u.cols).sort()).toEqual([150, null]);
    const show = await run(['show', wide.id]);
    expect(show.out[1]).toBe('Bundle · v1 · 150 cols · by Ann · Not shared');
    const preview = show.out.slice(show.out.indexOf('Preview') + 1);
    const w = Math.max(...preview.map((l) => [...l].length));
    expect(w).toBeGreaterThan(120);
    expect(w).toBeLessThanOrEqual(152);
    const narrow = await run(['show', wide.id, '--width', '80']);
    const p2 = narrow.out.slice(narrow.out.indexOf('Preview') + 1);
    expect(Math.max(...p2.map((l) => [...l].length))).toBeLessThanOrEqual(82);
  });

  it('show uses --scenario and an embedded theme without installing it', async () => {
    const e = saveEntry(
      {
        kind: 'bundle',
        name: 'Drafty',
        description: '',
        author: '',
        content: {
          layout: { lines },
          appearance: { theme: 'drafty' },
          theme: { id: 'drafty', name: 'Drafty', extends: 'nord' },
        },
        share: false,
        mode: 'new',
        now: NOW,
      },
      cat,
    );
    const before = fs.readdirSync(path.join(root, 'themes'));
    const r = await run(['show', 'drafty', '--scenario', 'context-full']);
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toBe(`Drafty  ${e.id}`);
    expect(r.out[1]).toBe('Bundle · v1 · Not shared');
    expect(r.out.slice(r.out.indexOf('Preview') + 1).length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(root, 'themes'))).toEqual(before);
    expect(fs.existsSync(cfg)).toBe(false);
    const bad = await run(['show', 'drafty', '--scenario', 'nope']);
    expect(bad.code).toBe(1);
  });

  it('show fails on an unknown or ambiguous ref', async () => {
    const nope = await run(['show', 'nope']);
    expect(nope.code).toBe(1);
    expect(nope.err).toEqual(['No catalog entry nope']);
    const amb = await run(['show', 'minimal']);
    expect(amb.code).toBe(1);
    expect(amb.err).toEqual(['minimal matches more than one entry: preset/minimal, theme/minimal']);
  });

  it('history lists versions with restores', async () => {
    const v1 = saveBundle();
    const v2 = saveEntry(
      {
        kind: 'bundle',
        name: 'My look',
        description: 'Mine',
        author: 'Ann',
        content: { layout: { lines }, appearance: { theme: 'dracula' } },
        share: false,
        mode: 'update',
        note: 'darker',
        now: new Date('2026-10-16T11:00:00.000Z'),
      },
      cat,
    );
    restoreEntry(v1.id, 1, v2.rev, 'back', cat, new Date('2026-10-16T12:00:00.000Z'));
    const r = await run(['history', v1.id]);
    expect(r.code).toBeUndefined();
    expect(r.out[0]).toBe('Versions of My look');
    expect(r.out.slice(1)).toHaveLength(3);
    expect(r.out[1]).toMatch(/^ {2}v1 {2}\S/);
    expect(r.out[2]).toMatch(/^ {2}v2 {2}.+ {2}darker$/);
    expect(r.out[3]).toMatch(/^ {2}v3 {2}.+ {2}back {2}restored from v1$/);
    const json = JSON.parse((await run(['history', 'bundle/my-look', '--json'])).out[0]!);
    expect(json).toEqual({
      schema: 1,
      ref: v1.id,
      versions: [
        { version: 1, at: NOW.toISOString(), note: '', restoredFrom: null, overwrittenAt: null },
        {
          version: 2,
          at: '2026-10-16T11:00:00.000Z',
          note: 'darker',
          restoredFrom: null,
          overwrittenAt: null,
        },
        { version: 3, at: '2026-10-16T12:00:00.000Z', note: 'back', restoredFrom: 1, overwrittenAt: null },
      ],
    });
  });

  it('history of a built-in entry shows one version', async () => {
    const r = await run(['history', 'theme/nord']);
    expect(r.out).toEqual(['Versions of Nord', '  v1  Built in']);
    const json = JSON.parse((await run(['history', 'theme/nord', '--json'])).out[0]!);
    expect(json.versions).toEqual([
      { version: 1, at: null, note: '', restoredFrom: null, overwrittenAt: null },
    ]);
  });

  it('prints names without terminal escapes', async () => {
    const e = saveBundle();
    const stored = readEntry(e.id, cat)!;
    const raw = JSON.parse(fs.readFileSync(stored.file, 'utf8'));
    raw.name = 'Evil\u001b[31m red\u0007';
    raw.description = 'desc\u001b]0;title\u0007';
    fs.writeFileSync(stored.file, JSON.stringify(raw));
    for (const argv of [['list'], ['show', e.id], ['history', e.id], ['list', '--json']]) {
      const r = await run(argv);
      expect(r.out.join('\n'), argv.join(' ')).toContain('Evil');
      expect(r.out.join('\n'), argv.join(' ')).not.toMatch(/\u001b|\u0007/);
    }
  });

  it('prints Turkish headings and empty state', async () => {
    const empty = await withLangAsync('tr', () => run(['list']));
    expect(empty.out[0]).toBe('Sizin girdileriniz');
    expect(empty.out[1]).toBe(
      '  Henüz kayıtlı girdi yok. ccinfobar catalog save <name> ile bir tane kaydedin.',
    );
    expect(empty.out).toContain('Yerleşik');
    expect(empty.out).toContain('  Paketler');
    expect(empty.out).toContain('  Hazır ayarlar');
    expect(empty.out).toContain('  Temalar');
    expect(empty.out.join('\n')).toContain('Mocha kokpit');
    const show = await withLangAsync('tr', () => run(['show', 'bundle/nord-minimal']));
    expect(show.out[1]).toBe('Paket · v1 · ccinfobar tarafından · Yerleşik');
    expect(show.out).toContain('Önizleme');
    const bad = await withLangAsync('tr', () => run(['list', '--kind', 'x']));
    expect(bad.err).toEqual(['--kind preset, theme veya bundle olmalı']);
    const usage = await withLangAsync('tr', () => run([]));
    expect(usage.err[0]).toMatch(/^Kullanım: ccinfobar catalog list/);
  });
});
