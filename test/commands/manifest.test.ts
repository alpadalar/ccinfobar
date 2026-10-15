import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstall, planInstall, uninstall } from '../../src/commands/install.js';
import {
  classifyOwner,
  dropEntry,
  dropHookEntry,
  findHookEntries,
  findStatusLineEntry,
  isLegacyCcinfobarCommand,
  type Manifest,
  manifestFile,
  owns,
  readManifest,
  recordGitExclude,
  recordHook,
  recordStatusLine,
  refreshWrittenHash,
  writeManifest,
} from '../../src/commands/manifest.js';
import { t } from '../../src/core/i18n/index.js';
import { withLang } from '../helpers.js';
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
      const tr = withLang('tr', () => t('install.manifestReadOnly', { file: manifestFile(env) }));
      expect(() => withLang('tr', () => writeManifest(m, env))).toThrow(tr);
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

  it('removes the npx command 0.5.x wrote instead of restoring it', () => {
    const old = { type: 'command', command: 'npx -y ccinfobar@latest', padding: 0 };
    expect(isLegacyCcinfobarCommand(old.command)).toBe(true);
    expect(isLegacyCcinfobarCommand('npx -y ccinfobar@latest --x')).toBe(false);
    const fx = settingsFixture({ data: { model: 'opus', statusLine: old } });
    expect(uninstall(fx.file)).toMatchObject({ status: 'removed', removed: true });
    expect(json(fx.file)).toEqual({ model: 'opus' });
    fs.writeFileSync(fx.file, JSON.stringify({ model: 'opus', statusLine: old }));
    const plan = planInstall({ file: fx.file, command: '/bin/ccinfobar' });
    expect(plan).toMatchObject({ owner: 'legacy-ours', needsConfirm: false });
    applyInstall(plan, { confirmed: true });
    expect(uninstall(fx.file)).toMatchObject({ removed: true, restored: null });
    expect(json(fx.file)).toEqual({ model: 'opus' });
  });

  it('restores the pre-install bytes exactly when the file is untouched', () => {
    const fx = settingsFixture({ data: { model: 'opus', statusLine: foreign }, indent: '    ', eol: '\r\n' });
    const before = bytes(fx.file);
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar', refresh: 5 }), { confirmed: true });
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-exact', removed: true, restored: foreign });
    expect(bytes(fx.file).equals(before)).toBe(true);
    expect(findStatusLineEntry(readManifest(), fx.file)).toBeNull();
  });

  it('goes key-level after a reformat and keeps the other edits', () => {
    const fx = settingsFixture({ data: { model: 'opus', statusLine: foreign }, indent: '\t' });
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
    const now = json(fx.file);
    fs.writeFileSync(fx.file, `${JSON.stringify({ ...now, theme: 'dark' }, null, 2)}\n`);
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-previous', restored: foreign });
    expect(json(fx.file)).toEqual({ model: 'opus', statusLine: foreign, theme: 'dark' });
  });

  it('restores the first foreign value after several reinstalls', () => {
    const fx = settingsFixture({ data: { statusLine: foreign } });
    const before = bytes(fx.file);
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
    applyInstall(planInstall({ file: fx.file, command: '/opt/ccinfobar', refresh: 3 }), { confirmed: true });
    expect(findStatusLineEntry(readManifest(), fx.file)?.previous).toEqual(foreign);
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-exact', restored: foreign });
    expect(bytes(fx.file).equals(before)).toBe(true);
  });

  it('keeps the chain but drops byte restore when someone edited between installs', () => {
    const fx = settingsFixture({ data: { statusLine: foreign } });
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
    fs.writeFileSync(fx.file, JSON.stringify({ ...json(fx.file), model: 'opus' }));
    applyInstall(planInstall({ file: fx.file, command: '/opt/ccinfobar' }), { confirmed: true });
    expect(findStatusLineEntry(readManifest(), fx.file)?.restore).toBeNull();
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-previous', restored: foreign });
    expect(json(fx.file)).toEqual({ statusLine: foreign, model: 'opus' });
  });

  it('deletes a file that ccinfobar created', () => {
    const fx = settingsFixture();
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
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
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
    const other = { type: 'command', command: 'bash -c "ccinfobar | tee /tmp/x"' };
    fs.writeFileSync(fx.file, JSON.stringify({ statusLine: other }));
    expect(uninstall(fx.file)).toMatchObject({ status: 'foreign', removed: false, current: other });
    expect(json(fx.file)).toEqual({ statusLine: other });
    expect(findStatusLineEntry(readManifest(), fx.file)).toBeNull();
  });

  it('handles a status line Claude Code already removed', () => {
    const a = settingsFixture({ data: { model: 'opus', statusLine: foreign } });
    applyInstall(planInstall({ file: a.file, command: '/bin/ccinfobar' }), { confirmed: true });
    fs.writeFileSync(a.file, JSON.stringify({ model: 'opus' }));
    expect(uninstall(a.file)).toMatchObject({ status: 'gone-restored', removed: true, restored: foreign });
    expect(json(a.file)).toEqual({ model: 'opus', statusLine: foreign });

    const b = settingsFixture({ data: { model: 'opus' } });
    applyInstall(planInstall({ file: b.file, command: '/bin/ccinfobar' }), { confirmed: true });
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
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
    expect(json(fx.file).statusLine.refreshInterval).toBe(7);
    expect(findStatusLineEntry(readManifest(), fx.file)).toMatchObject({ previous: foreign, restore: null });
    expect(uninstall(fx.file)).toMatchObject({ status: 'restored-previous', restored: foreign });
  });

  it('does not inherit the refresh of a foreign status line', () => {
    const fx = settingsFixture({ data: { statusLine: { ...foreign, refreshInterval: 9 } } });
    applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true });
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
      expect(
        () =>
          applyInstall(planInstall({ file: fx.file, command: '/bin/ccinfobar' }), { confirmed: true }).backup,
      ).toThrow(/newer ccinfobar/);
      expect(() => uninstall(fx.file)).toThrow(/newer ccinfobar/);
      expect(bytes(fx.file).equals(before)).toBe(true);
    } finally {
      if (saved) fs.writeFileSync(file, saved);
      else fs.rmSync(file, { force: true });
    }
  });
});

describe('hook entries', () => {
  const group = (cmd: string) => ({ hooks: [{ type: 'command', command: cmd, async: true, timeout: 5 }] });
  const hook = (file: string, event: string, cmd = 'ccinfobar hook X') => ({
    file,
    event,
    value: group(cmd),
    claudeCode: '2.1.299',
    writtenHash: 'sha256:a',
  });

  it('replaces the entry for the same event and drops one event only', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    let m: Manifest = { version: 1, entries: [] };
    m = recordHook(m, hook(file, 'Stop', 'a'));
    m = recordHook(m, { ...hook(file, 'Notification'), matcher: 'permission_prompt' });
    m = recordHook(m, hook(file, 'Stop', 'b'));
    const found = findHookEntries(m, file);
    expect(found.map((e) => e.event)).toEqual(['Notification', 'Stop']);
    expect(found[1]?.value).toEqual(group('b'));
    expect(found[0]).toMatchObject({ kind: 'hook', matcher: 'permission_prompt', claudeCode: '2.1.299' });
    expect(Object.hasOwn(found[1] as object, 'matcher')).toBe(false);
    expect(findHookEntries(dropHookEntry(m, file, 'Stop'), file).map((e) => e.event)).toEqual([
      'Notification',
    ]);
    expect(findHookEntries({ ...m, readOnly: true }, file)).toEqual([]);
  });

  it('keeps a progress entry apart from the Phase 4 entry on the same event', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    let m: Manifest = { version: 1, entries: [] };
    m = recordHook(m, hook(file, 'UserPromptSubmit', 'a'));
    m = recordHook(m, { ...hook(file, 'UserPromptSubmit', 'p'), role: 'progress' });
    m = recordHook(m, { ...hook(file, 'UserPromptSubmit', 'p2'), role: 'progress' });
    const found = findHookEntries(m, file);
    expect(found).toHaveLength(2);
    expect(found.find((e) => !e.role)?.value).toEqual(group('a'));
    expect(found.find((e) => e.role === 'progress')?.value).toEqual(group('p2'));
    const noProgress = findHookEntries(dropHookEntry(m, file, 'UserPromptSubmit', 'progress'), file);
    expect(noProgress.map((e) => [e.event, e.role])).toEqual([['UserPromptSubmit', undefined]]);
    const noAsync = findHookEntries(dropHookEntry(m, file, 'UserPromptSubmit'), file);
    expect(noAsync.map((e) => e.role)).toEqual(['progress']);
  });

  it('reads an old entry without a role as the Phase 4 entry', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const old = { kind: 'hook', ...hook(file, 'Stop'), version: '0.7.0', at: 'x' };
    const m: Manifest = { version: 1, entries: [old] };
    expect(Object.hasOwn(findHookEntries(m, file)[0] as object, 'role')).toBe(false);
    expect(findHookEntries(dropHookEntry(m, file, 'Stop', 'progress'), file)).toHaveLength(1);
    expect(findHookEntries(dropHookEntry(m, file, 'Stop'), file)).toEqual([]);
    const next = recordHook(m, { ...hook(file, 'Stop', 'new'), role: 'progress' });
    expect(findHookEntries(next, file)).toHaveLength(2);
  });

  it('refreshes writtenHash on every entry of that file only', () => {
    const { dir } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const other = path.join(dir, 'other.json');
    let m: Manifest = { version: 1, entries: [] };
    m = recordStatusLine(m, entryFor(file));
    m = recordHook(m, hook(file, 'Stop'));
    m = recordHook(m, hook(other, 'Stop'));
    m = recordGitExclude(m, file, '/x');
    const next = refreshWrittenHash(m, file, 'sha256:new');
    expect(findStatusLineEntry(next, file)?.writtenHash).toBe('sha256:new');
    expect(findHookEntries(next, file)[0]?.writtenHash).toBe('sha256:new');
    expect(findHookEntries(next, other)[0]?.writtenHash).toBe('sha256:a');
    const git = next.entries.find((e) => e.kind === 'gitExclude');
    expect(git && Object.hasOwn(git, 'writtenHash')).toBe(false);
  });

  it('round-trips hook entries with manifest version 1', () => {
    const { dir, env } = tmpEnv();
    const file = path.join(dir, 'settings.json');
    const m = recordHook(recordStatusLine({ version: 1, entries: [] }, entryFor(file)), hook(file, 'Stop'));
    writeManifest(m, env);
    expect(JSON.parse(fs.readFileSync(manifestFile(env), 'utf8')).version).toBe(1);
    const back = readManifest(env);
    expect(back.readOnly).toBeUndefined();
    expect(findHookEntries(back, file)).toEqual(findHookEntries(m, file));
  });
});
