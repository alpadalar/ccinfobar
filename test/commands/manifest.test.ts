import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { install, uninstall } from '../../src/commands/install.js';
import {
  classifyOwner,
  dropEntry,
  findStatusLineEntry,
  isLegacyCcinfobarCommand,
  type Manifest,
  manifestFile,
  owns,
  readManifest,
  recordGitExclude,
  recordStatusLine,
  writeManifest,
} from '../../src/commands/manifest.js';
import { settingsFixture } from './fixtures.js';

const tmpEnv = () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-manifest-')));
  return { dir, env: { ...process.env, CCINFOBAR_CONFIG_DIR: path.join(dir, 'config') } };
};
const sl = (command: string, extra: object = {}) => ({ type: 'command' as const, command, ...extra });
const entryFor = (file: string, value = sl('ccinfobar', { padding: 0 })) => ({
  file,
  value,
  previous: null,
  fileExisted: true,
  restore: null,
  writtenHash: 'sha256:x',
});

describe('manifest file', () => {
  it('starts empty when missing', () => {
    const { env } = tmpEnv();
    expect(readManifest(env)).toEqual({ version: 1, entries: [] });
  });

  it('fails closed on a newer or malformed manifest', () => {
    for (const text of ['{"version":2,"entries":[]}', '{"version":1', '[]', '{"version":1,"entries":[1]}']) {
      const { dir, env } = tmpEnv();
      const file = path.join(dir, 'settings.json');
      fs.mkdirSync(path.dirname(manifestFile(env)), { recursive: true });
      fs.writeFileSync(manifestFile(env), text);
      const m = readManifest(env);
      expect(m.readOnly).toBe(true);
      expect(m.entries).toEqual([]);
      expect(owns(m, file, sl('ccinfobar'))).toBe(false);
      expect(() => writeManifest(recordStatusLine(m, entryFor(file)), env)).toThrow(/newer ccinfobar/);
      expect(fs.readFileSync(manifestFile(env), 'utf8')).toBe(text);
    }
  });

  it('round-trips with mode 0600 and keeps unknown kinds', () => {
    const { dir, env } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const hook = { kind: 'hook', file: '/x/settings.json', event: 'Stop', command: 'ccinfobar hook' };
    let m: Manifest = { version: 1, entries: [hook] };
    m = recordStatusLine(m, entryFor(file));
    writeManifest(m, env);
    const back = readManifest(env);
    expect(back).toEqual(m);
    expect(back.entries[0]).toEqual(hook);
    if (process.platform !== 'win32') expect(fs.statSync(manifestFile(env)).mode & 0o777).toBe(0o600);
    expect(findStatusLineEntry(back, file)?.version).toEqual(expect.any(String));
  });

  it('replaces the entry for the same file and dedupes git excludes', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    let m: Manifest = { version: 1, entries: [] };
    m = recordStatusLine(m, entryFor(file));
    m = recordStatusLine(m, entryFor(file, sl('/bin/ccinfobar')));
    expect(m.entries).toHaveLength(1);
    expect(findStatusLineEntry(m, file)?.value).toEqual(sl('/bin/ccinfobar'));
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    m = recordGitExclude(m, exclude, '/.claude/settings.local.json');
    m = recordGitExclude(m, exclude, '/.claude/settings.local.json');
    expect(m.entries.filter((e) => e.kind === 'gitExclude')).toHaveLength(1);
    m = dropEntry(m, file, 'statusLine');
    expect(findStatusLineEntry(m, file)).toBeNull();
    expect(m.entries).toHaveLength(1);
  });
});

describe('ownership', () => {
  it('compares values structurally, ignoring key order', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const m = recordStatusLine({ version: 1, entries: [] }, entryFor(file));
    expect(owns(m, file, { command: 'ccinfobar', padding: 0, type: 'command' })).toBe(true);
    expect(owns(m, file, sl('ccinfobar', { padding: 1 }))).toBe(false);
    expect(owns(m, file, sl('bash -c "ccinfobar | tee x"'))).toBe(false);
    expect(owns(m, path.join(dir, 'other.json'), sl('ccinfobar', { padding: 0 }))).toBe(false);
    expect(owns(m, file, null)).toBe(false);
  });

  it('matches a symlinked settings path through its target', () => {
    const { dir } = tmpEnv();
    const target = path.join(dir, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}');
    const link = path.join(dir, 'settings.json');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return;
    }
    const m = recordStatusLine({ version: 1, entries: [] }, entryFor(target));
    expect(owns(m, link, sl('ccinfobar', { padding: 0 }))).toBe(true);
    expect(findStatusLineEntry(recordStatusLine(m, entryFor(link)), target)?.file).toBe(target);
  });

  it('classifies existing status lines', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const empty: Manifest = { version: 1, entries: [] };
    const m = recordStatusLine(empty, entryFor(file));
    const c = (mm: Manifest, cmd: string | null, expected: string | null = '/opt/x/ccinfobar') =>
      classifyOwner(mm, file, cmd === null ? null : sl(cmd), expected);
    expect(c(empty, null)).toBe('none');
    expect(classifyOwner(m, file, sl('ccinfobar', { padding: 0 }), null)).toBe('ours');
    expect(c(m, 'npx ccstatusline')).toBe('foreign');
    expect(c(m, '/usr/bin/ccinfobar')).toBe('foreign');
    expect(c(empty, '/opt/x/ccinfobar')).toBe('legacy-ours');
    expect(c(empty, "'/opt/my dir/ccinfobar'")).toBe('legacy-ours');
    expect(c(empty, '"C:\\Users\\u\\AppData\\Roaming\\npm\\ccinfobar.cmd"')).toBe('legacy-ours');
    expect(c(empty, 'C:\\Users\\u\\npm\\ccinfobar.ps1')).toBe('legacy-ours');
    expect(c(empty, 'node "C:\\x\\ccinfobar\\dist\\ccinfobar.js"')).toBe('legacy-ours');
    expect(c(empty, '/usr/bin/node /home/u/src/ccinfobar/dist/ccinfobar.js')).toBe('legacy-ours');
    expect(c(empty, 'npx ccinfobar@latest | other')).toBe('legacy-ask');
    expect(c(empty, 'bash -c "ccinfobar && other"')).toBe('legacy-ask');
    expect(c(empty, 'ccinfobar | tee x')).toBe('legacy-ask');
    expect(c(empty, 'npx ccstatusline')).toBe('foreign');
    expect(c({ ...empty, readOnly: true }, 'ccinfobar')).toBe('foreign');
  });

  it('recognises only the plain legacy command forms', () => {
    expect(isLegacyCcinfobarCommand('ccinfobar')).toBe(true);
    expect(isLegacyCcinfobarCommand('ccinfobar.exe')).toBe(true);
    expect(isLegacyCcinfobarCommand('/x/notccinfobar')).toBe(false);
    expect(isLegacyCcinfobarCommand('ccinfobar --x')).toBe(false);
    expect(isLegacyCcinfobarCommand('python /x/dist/ccinfobar.js')).toBe(false);
    expect(isLegacyCcinfobarCommand('node /x/dist/ccinfobar.js; rm -rf ~')).toBe(false);
    expect(isLegacyCcinfobarCommand('"ccinfobar')).toBe(false);
    expect(isLegacyCcinfobarCommand('')).toBe(false);
  });
});

describe('uninstall through the manifest', () => {
  const foreign = { type: 'command', command: 'npx ccstatusline', padding: 0 };
  const bytes = (f: string) => fs.readFileSync(f);
  const json = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

  it('restores the pre-install bytes exactly when the file is untouched', () => {
    const fx = settingsFixture({ data: { model: 'opus', statusLine: foreign }, indent: '    ', eol: '\r\n' });
    const before = bytes(fx.file);
    install('/bin/ccinfobar', 5, fx.file);
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-exact', removed: true, restored: foreign });
    expect(bytes(fx.file).equals(before)).toBe(true);
    expect(findStatusLineEntry(readManifest(), fx.file)).toBeNull();
  });

  it('goes key-level after a reformat and keeps the other edits', () => {
    const fx = settingsFixture({ data: { model: 'opus', statusLine: foreign }, indent: '\t' });
    install('/bin/ccinfobar', undefined, fx.file);
    const now = json(fx.file);
    fs.writeFileSync(fx.file, `${JSON.stringify({ ...now, theme: 'dark' }, null, 2)}\n`);
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-previous', restored: foreign });
    expect(json(fx.file)).toEqual({ model: 'opus', statusLine: foreign, theme: 'dark' });
  });

  it('restores the first foreign value after several reinstalls', () => {
    const fx = settingsFixture({ data: { statusLine: foreign } });
    const before = bytes(fx.file);
    install('/bin/ccinfobar', undefined, fx.file);
    install('/bin/ccinfobar', undefined, fx.file);
    install('/opt/ccinfobar', 3, fx.file);
    expect(findStatusLineEntry(readManifest(), fx.file)?.previous).toEqual(foreign);
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-exact', restored: foreign });
    expect(bytes(fx.file).equals(before)).toBe(true);
  });

  it('keeps the chain but drops byte restore when someone edited between installs', () => {
    const fx = settingsFixture({ data: { statusLine: foreign } });
    install('/bin/ccinfobar', undefined, fx.file);
    fs.writeFileSync(fx.file, JSON.stringify({ ...json(fx.file), model: 'opus' }));
    install('/opt/ccinfobar', undefined, fx.file);
    expect(findStatusLineEntry(readManifest(), fx.file)?.restore).toBeNull();
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-previous', restored: foreign });
    expect(json(fx.file)).toEqual({ statusLine: foreign, model: 'opus' });
  });

  it('deletes a file that ccinfobar created', () => {
    const fx = settingsFixture();
    install('/bin/ccinfobar', undefined, fx.file);
    expect(findStatusLineEntry(readManifest(), fx.file)).toMatchObject({
      fileExisted: false,
      previous: null,
      restore: { absent: true },
    });
    expect(uninstall(fx.file)).toMatchObject({ status: 'deleted-file', removed: true });
    expect(fs.existsSync(fx.file)).toBe(false);
  });

  it('leaves a status line another tool wrote after install', () => {
    const fx = settingsFixture({ data: { statusLine: foreign } });
    install('/bin/ccinfobar', undefined, fx.file);
    const other = { type: 'command', command: 'bash -c "ccinfobar | tee /tmp/x"' };
    fs.writeFileSync(fx.file, JSON.stringify({ statusLine: other }));
    expect(uninstall(fx.file)).toMatchObject({ status: 'foreign', removed: false, current: other });
    expect(json(fx.file)).toEqual({ statusLine: other });
    expect(findStatusLineEntry(readManifest(), fx.file)).toBeNull();
  });

  it('handles a status line Claude Code already removed', () => {
    const a = settingsFixture({ data: { model: 'opus', statusLine: foreign } });
    install('/bin/ccinfobar', undefined, a.file);
    fs.writeFileSync(a.file, JSON.stringify({ model: 'opus' }));
    expect(uninstall(a.file)).toMatchObject({ status: 'gone-restored', removed: true, restored: foreign });
    expect(json(a.file)).toEqual({ model: 'opus', statusLine: foreign });

    const b = settingsFixture({ data: { model: 'opus' } });
    install('/bin/ccinfobar', undefined, b.file);
    fs.writeFileSync(b.file, JSON.stringify({ model: 'sonnet' }));
    const before = bytes(b.file);
    expect(uninstall(b.file)).toMatchObject({ status: 'gone-nothing', removed: false, restored: null });
    expect(bytes(b.file).equals(before)).toBe(true);
    expect(findStatusLineEntry(readManifest(), b.file)).toBeNull();
  });

  it('only removes an unrecorded wrapper when asked to adopt it', () => {
    const wrapper = { type: 'command', command: 'bash -c "ccinfobar && other"' };
    const fx = settingsFixture({ data: { model: 'opus', statusLine: wrapper } });
    expect(uninstall(fx.file)).toMatchObject({ status: 'foreign', removed: false });
    expect(json(fx.file).statusLine).toEqual(wrapper);
    expect(uninstall(fx.file, { adoptLegacy: true })).toMatchObject({ status: 'removed', removed: true });
    expect(json(fx.file)).toEqual({ model: 'opus' });
  });

  it('adopts a 0.6.x install and restores from its legacy backup', () => {
    const legacyLine = { type: 'command', command: '/usr/local/bin/ccinfobar', padding: 0 };
    const fx = settingsFixture({ data: { model: 'opus', statusLine: legacyLine } });
    fs.writeFileSync(`${fx.file}.ccinfobar-backup`, JSON.stringify({ model: 'opus', statusLine: foreign }));
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-previous', restored: foreign });
    expect(json(fx.file)).toEqual({ model: 'opus', statusLine: foreign });
  });

  it('carries the legacy previous value through a reinstall over 0.6.x', () => {
    const legacyLine = {
      type: 'command',
      command: 'node /x/ccinfobar/dist/ccinfobar.js',
      refreshInterval: 7,
    };
    const fx = settingsFixture({ data: { statusLine: legacyLine } });
    fs.writeFileSync(`${fx.file}.ccinfobar-backup`, JSON.stringify({ statusLine: foreign }));
    install('/bin/ccinfobar', undefined, fx.file);
    expect(json(fx.file).statusLine.refreshInterval).toBe(7);
    expect(findStatusLineEntry(readManifest(), fx.file)).toMatchObject({ previous: foreign, restore: null });
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-previous', restored: foreign });
  });

  it('does not inherit the refresh of a foreign status line', () => {
    const fx = settingsFixture({ data: { statusLine: { ...foreign, refreshInterval: 9 } } });
    install('/bin/ccinfobar', undefined, fx.file);
    expect(json(fx.file).statusLine.refreshInterval).toBeUndefined();
  });

  it('refuses to install or uninstall while the manifest is from a newer version', () => {
    const fx = settingsFixture({ data: { statusLine: foreign } });
    const file = manifestFile();
    const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":2,"entries":[]}');
    try {
      const before = bytes(fx.file);
      expect(() => install('/bin/ccinfobar', undefined, fx.file)).toThrow(/newer ccinfobar/);
      expect(() => uninstall(fx.file)).toThrow(/newer ccinfobar/);
      expect(bytes(fx.file).equals(before)).toBe(true);
    } finally {
      if (saved) fs.writeFileSync(file, saved);
      else fs.rmSync(file, { force: true });
    }
  });
});
