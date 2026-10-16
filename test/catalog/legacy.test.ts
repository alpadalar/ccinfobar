import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCatalogContent, type EntryContent } from '../../src/catalog/model.js';
import { contentFromConfig } from '../../src/catalog/snapshot.js';
import {
  adoptLegacy,
  CatalogStoreError,
  deleteEntry,
  deleteLegacy,
  findByName,
  installEntryTheme,
  listEntries,
  listLegacy,
  saveEntry,
  themeChain,
} from '../../src/catalog/store.js';
import { defaultConfig, normalizeConfig } from '../../src/core/config.js';
import { resolveAppearance } from '../../src/core/renderer.js';
import { BUILTIN_THEMES, resolveTheme, themeToInput } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';

let root = '';
let cat = '';
let presets = '';
let themes = '';
let prev: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-legacy-'));
  cat = path.join(root, 'catalog');
  presets = path.join(root, 'presets');
  themes = path.join(root, 'themes');
  fs.mkdirSync(presets);
  fs.mkdirSync(themes);
  prev = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = root;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prev;
  fs.rmSync(root, { recursive: true, force: true });
});

const NOW = new Date('2026-10-16T10:00:00.000Z');
const lines = [[{ id: 'm', type: 'model' }]];

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function seed(): void {
  writeJson(path.join(presets, 'mine.json'), {
    name: 'Mine',
    description: 'My layout',
    config: {
      theme: 'nord',
      separator: ' / ',
      lines,
      budget: { daily: 5 },
      profiles: { models: [{ match: 'opus', theme: 'dracula' }] },
      language: 'tr',
    },
  });
  writeJson(path.join(presets, 'plain.json'), { name: 'Plain', config: { lines } });
  writeJson(path.join(themes, 't1.json'), { name: 'T1', extends: 'nord', colors: { fg: '#112233' } });
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, f);
    const st = fs.statSync(file);
    out[f] = `${fs.readFileSync(file, 'base64')}:${st.mtimeMs}:${st.size}`;
  }
  return out;
}

const byRef = (ref: string) => listLegacy({ dir: cat }).find((i) => i.ref === ref);

describe('listLegacy', () => {
  it('lists presets with a theme as bundles, others as presets, theme files as themes', () => {
    seed();
    const items = listLegacy({ dir: cat });
    expect(items.map((i) => [i.ref, i.kind, i.legacyId, i.name])).toEqual([
      ['legacy:preset/mine', 'bundle', 'mine', 'Mine'],
      ['legacy:preset/plain', 'preset', 'plain', 'Plain'],
      ['legacy:theme/t1', 'theme', 't1', 'T1'],
    ]);
    for (const i of items) expect(i.source).toBe('legacy');
    expect(byRef('legacy:preset/mine')?.file).toBe(path.join(presets, 'mine.json'));
    expect(byRef('legacy:theme/t1')?.file).toBe(path.join(themes, 't1.json'));
    expect(byRef('legacy:preset/mine')?.description).toBe('My layout');
  });

  it('builds content from the files without personal keys', () => {
    seed();
    const mine = byRef('legacy:preset/mine')!;
    expect(mine.content.layout?.lines).toEqual(lines);
    expect(mine.content.appearance?.theme).toBe('nord');
    expect(mine.content.appearance?.separator).toBe(' / ');
    const text = JSON.stringify(mine.content);
    for (const k of ['budget', 'profiles', 'language']) expect(text).not.toContain(`"${k}"`);
    const plain = byRef('legacy:preset/plain')!;
    expect(plain.content.appearance).toBeUndefined();
    expect(plain.content.layout?.lines).toEqual(lines);
    const t1 = byRef('legacy:theme/t1')!;
    expect(t1.content.appearance).toEqual({ theme: 't1' });
    expect(t1.content.theme?.id).toBe('t1');
    expect(t1.content.theme?.colors?.fg).toBe('#112233');
    expect(t1.content.theme?.extends).toBeUndefined();
  });

  it('never changes file bytes or mtimes', () => {
    seed();
    const old = new Date('2020-01-02T03:04:05.000Z');
    for (const d of [presets, themes])
      for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), old, old);
    const before = [snapshot(presets), snapshot(themes)];
    listLegacy({ dir: cat });
    listLegacy({ dir: cat });
    expect([snapshot(presets), snapshot(themes)]).toEqual(before);
    expect(fs.existsSync(cat)).toBe(false);
  });

  it('skips unreadable files and bad ids, and is empty without folders', () => {
    expect(listLegacy({ dir: path.join(root, 'nope', 'catalog') })).toEqual([]);
    fs.writeFileSync(path.join(presets, 'broken.json'), '{');
    fs.writeFileSync(path.join(presets, '-bad.json'), '{"config":{}}');
    expect(listLegacy({ dir: cat })).toEqual([]);
  });

  it('accepts explicit preset and theme folders', () => {
    seed();
    const other = path.join(root, 'other');
    fs.mkdirSync(other);
    expect(listLegacy({ dir: cat, presets: other, themes: other })).toEqual([]);
  });
});

describe('adoptLegacy', () => {
  it('creates a linked local entry once and keeps the file', () => {
    seed();
    const file = path.join(presets, 'mine.json');
    const bytes = fs.readFileSync(file);
    const e = adoptLegacy('legacy:preset/mine', NOW, cat);
    expect(e.legacy).toEqual({ preset: 'mine' });
    expect(e.kind).toBe('bundle');
    expect(e.name).toBe('Mine');
    expect(e.version).toBe(1);
    expect(e.versions).toHaveLength(1);
    expect(e.share.state).toBe('local');
    expect(e.share.wanted).toBe(false);
    expect(JSON.stringify(e.versions[0]!.content)).not.toContain('budget');
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(listLegacy({ dir: cat }).map((i) => i.ref)).toEqual(['legacy:preset/plain', 'legacy:theme/t1']);
    const again = adoptLegacy('legacy:preset/mine', NOW, cat);
    expect(again.id).toBe(e.id);
    expect(listEntries(cat)).toHaveLength(1);
  });

  it('adopts themes with the resolved theme embedded', () => {
    seed();
    const e = adoptLegacy('legacy:theme/t1', NOW, cat);
    expect(e.kind).toBe('theme');
    expect(e.legacy).toEqual({ theme: 't1' });
    expect(e.versions[0]!.content.theme?.colors?.fg).toBe('#112233');
    expect(fs.existsSync(path.join(themes, 't1.json'))).toBe(true);
  });

  it('adopted entries take updates like any other entry', () => {
    seed();
    const e = adoptLegacy('legacy:preset/plain', NOW, cat);
    const next = saveEntry(
      {
        kind: 'preset',
        name: e.name,
        description: '',
        author: '',
        content: { layout: { lines: [[{ id: 'c', type: 'cwd' }]] } },
        share: false,
        mode: 'update',
        id: e.id,
      },
      cat,
    );
    expect(next.version).toBe(2);
    expect(next.legacy).toEqual({ preset: 'plain' });
  });

  it('rejects bad and unknown refs before touching paths', () => {
    seed();
    for (const ref of [
      'legacy:preset/../mine',
      'legacy:preset/',
      'legacy:widget/mine',
      'mine',
      'legacy:theme/a/b',
    ]) {
      expect(() => adoptLegacy(ref, NOW, cat)).toThrow(CatalogStoreError);
    }
    try {
      adoptLegacy('legacy:preset/none', NOW, cat);
      expect.unreachable();
    } catch (e) {
      expect((e as CatalogStoreError).code).toBe('not-found');
    }
    expect(fs.existsSync(path.join(cat, 'entries'))).toBe(false);
  });
});

describe('deleteLegacy', () => {
  it('copies the file to trash, then removes it', () => {
    seed();
    const file = path.join(themes, 't1.json');
    const bytes = fs.readFileSync(file);
    expect(deleteLegacy('legacy:theme/t1', cat, NOW)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    const trash = fs.readdirSync(path.join(cat, 'trash'));
    expect(trash).toEqual(['legacy-theme-t1-20261016T100000000Z.json']);
    expect(fs.readFileSync(path.join(cat, 'trash', trash[0]!))).toEqual(bytes);
    expect(deleteLegacy('legacy:preset/mine', cat, NOW)).toBe(true);
    expect(fs.existsSync(path.join(presets, 'mine.json'))).toBe(false);
    expect(fs.readdirSync(path.join(cat, 'trash'))).toContain('legacy-preset-mine-20261016T100000000Z.json');
  });

  it('keeps earlier copies with the same stamp', () => {
    seed();
    deleteLegacy('legacy:theme/t1', cat, NOW);
    writeJson(path.join(themes, 't1.json'), { name: 'T1 again' });
    deleteLegacy('legacy:theme/t1', cat, NOW);
    expect(fs.readdirSync(path.join(cat, 'trash')).sort()).toEqual([
      'legacy-theme-t1-20261016T100000000Z-2.json',
      'legacy-theme-t1-20261016T100000000Z.json',
    ]);
  });

  it('keeps the newest 20 trash files', () => {
    for (let i = 0; i < 22; i++) {
      writeJson(path.join(themes, 't1.json'), { name: `T${i}` });
      deleteLegacy('legacy:theme/t1', cat, new Date(NOW.getTime() + i * 1000));
    }
    const left = fs.readdirSync(path.join(cat, 'trash')).sort();
    expect(left).toHaveLength(20);
    expect(left[0]).toBe('legacy-theme-t1-20261016T100002000Z.json');
  });

  it('goes with its adopted entry, so it does not come back', () => {
    seed();
    const e = adoptLegacy('legacy:preset/mine', NOW, cat);
    const bytes = fs.readFileSync(path.join(presets, 'mine.json'));
    deleteEntry(e.id, cat, NOW);
    expect(listLegacy({ dir: cat }).map((i) => i.ref)).not.toContain('legacy:preset/mine');
    expect(fs.existsSync(path.join(presets, 'mine.json'))).toBe(false);
    const copy = path.join(cat, 'trash', 'legacy-preset-mine-20261016T100000000Z.json');
    expect(fs.readFileSync(copy)).toEqual(bytes);
  });

  it('keeps an adopted theme file the config uses, also as a parent (WR-09)', () => {
    writeJson(path.join(themes, 't1.json'), { name: 'T1', extends: 'nord', colors: { fg: '#111111' } });
    writeJson(path.join(themes, 'child.json'), { name: 'Child', extends: 't1' });
    expect(themeChain('child', themes)).toEqual(['child', 't1', 'nord']);
    expect(themeChain(undefined, themes)).toEqual([]);
    const e = adoptLegacy('legacy:theme/t1', NOW, cat);
    const kept = deleteEntry(e.id, cat, NOW, { themesInUse: themeChain('child', themes) });
    expect(kept.kept).toBe('t1');
    expect(fs.existsSync(path.join(themes, 't1.json'))).toBe(true);
    expect(fs.existsSync(kept.file)).toBe(true);
    // not in use: the old file goes to the trash with the entry
    const again = adoptLegacy('legacy:theme/t1', NOW, cat);
    expect(deleteEntry(again.id, cat, NOW, { themesInUse: themeChain('dracula', themes) }).kept).toBeNull();
    expect(fs.existsSync(path.join(themes, 't1.json'))).toBe(false);
  });

  it('adopting a file whose name an entry already has picks a free slug (IN-05)', () => {
    seed();
    const own = saveEntry(
      {
        kind: 'bundle',
        name: 'Mine',
        description: '',
        author: '',
        content: { layout: { lines }, appearance: { theme: 'nord' } },
        share: false,
        mode: 'new',
      },
      cat,
    );
    const adopted = adoptLegacy('legacy:preset/mine', NOW, cat);
    expect(adopted.kind).toBe('bundle');
    expect(adopted.name).toBe('Mine');
    expect(adopted.slug).toBe('mine-2');
    expect(findByName('bundle', 'Mine', cat)?.id).toBe(own.id);
  });

  it('returns false for missing files and bad refs', () => {
    expect(deleteLegacy('legacy:theme/none', cat, NOW)).toBe(false);
    expect(deleteLegacy('legacy:theme/../x', cat, NOW)).toBe(false);
    expect(fs.existsSync(path.join(cat, 'trash'))).toBe(false);
  });
});

describe('installEntryTheme', () => {
  const custom = (fg: string): EntryContent => ({
    appearance: { theme: 'x' },
    theme: {
      ...themeToInput(resolveTheme('nord', themes), 'x'),
      colors: { ...resolveTheme('nord').colors, fg },
    },
  });

  it('returns null without an embedded theme', () => {
    expect(installEntryTheme({ appearance: { theme: 'nord' } }, themes)).toBeNull();
    expect(installEntryTheme({ layout: { lines } }, themes)).toBeNull();
    expect(fs.readdirSync(themes)).toEqual([]);
  });

  it('writes a missing theme, reuses an identical one, renames a different one', () => {
    expect(installEntryTheme(custom('#111111'), themes)).toEqual({ id: 'x', written: true, renamed: false });
    const bytes = fs.readFileSync(path.join(themes, 'x.json'));
    expect(installEntryTheme(custom('#111111'), themes)).toEqual({ id: 'x', written: false, renamed: false });
    expect(fs.readFileSync(path.join(themes, 'x.json'))).toEqual(bytes);
    expect(installEntryTheme(custom('#222222'), themes)).toEqual({ id: 'x-2', written: true, renamed: true });
    expect(installEntryTheme(custom('#333333'), themes)).toEqual({ id: 'x-3', written: true, renamed: true });
    expect(installEntryTheme(custom('#222222'), themes)).toEqual({
      id: 'x-2',
      written: false,
      renamed: true,
    });
    expect(fs.readFileSync(path.join(themes, 'x.json'))).toEqual(bytes);
    expect(resolveTheme('x-3', themes).colors.fg).toBe('#333333');
  });

  it('never shadows a built-in theme with different content', () => {
    const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!;
    const same: EntryContent = { appearance: { theme: 'nord' }, theme: themeToInput(nord, 'nord') };
    expect(installEntryTheme(same, themes)).toEqual({ id: 'nord', written: false, renamed: false });
    expect(fs.readdirSync(themes)).toEqual([]);
    const changed: EntryContent = { ...same, theme: { ...same.theme, separator: ' :: ' } };
    expect(installEntryTheme(changed, themes)).toEqual({ id: 'nord-2', written: true, renamed: true });
    expect(resolveTheme('nord', themes).source).toBe('builtin');
  });

  it('keeps suffixed ids within the id length limit', () => {
    const id = 'a'.repeat(64);
    writeJson(path.join(themes, `${id}.json`), { name: 'other', colors: { fg: '#010101' } });
    const r = installEntryTheme({ theme: { id, colors: { fg: '#020202' } } }, themes)!;
    expect(r.renamed).toBe(true);
    expect(r.id.length).toBeLessThanOrEqual(64);
    expect(r.id.endsWith('-2')).toBe(true);
  });

  it('an applied bundle renders with its installed theme, not classic', () => {
    const source: Config = normalizeConfig({ ...defaultConfig(), theme: 'nord', separator: ' ~ ' });
    const content = contentFromConfig(source, 'bundle');
    expect(content.theme).toBeDefined();
    fs.writeFileSync(path.join(themes, 'nord.json'), '{"colors":{"fg":"#abcdef"}}\n');
    const r = installEntryTheme(content, themes)!;
    expect(r).toEqual({ id: 'nord-2', written: true, renamed: true });
    const applied = applyCatalogContent(defaultConfig(), content, 'bundle', r.id);
    expect(applied.theme).toBe('nord-2');
    const theme = resolveTheme(applied.theme, themes);
    expect(theme.source).toBe('user');
    expect(theme.id).toBe('nord-2');
    const got = resolveAppearance(applied, undefined, {});
    expect(got.theme.id).toBe('nord-2');
    const nord = BUILTIN_THEMES.find((t) => t.id === 'nord')!;
    const classic = BUILTIN_THEMES.find((t) => t.id === 'classic')!;
    expect(got.theme.colors.cycle).toEqual(nord.colors.cycle);
    expect(got.theme.colors.cycle).not.toEqual(classic.colors.cycle);
    expect(got.style).toBe('powerline');
    expect(got.separator).toBe(' ~ ');
  });
});
