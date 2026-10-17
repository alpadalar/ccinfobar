import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommand } from '../../src/commands/command.js';
import {
  acceptCommand,
  applyInstall,
  defaultCommand,
  ignoreLocally,
  isTransientBin,
  planInstall,
  projectLocalFile,
  projectOverride,
  projectSettingsPath,
  releaseProjects,
  takeOverProjects,
  uninstall,
} from '../../src/commands/install.js';
import { ask, isYes, promptMarker } from '../../src/commands/install-cli.js';
import { findStatusLineEntry, readManifest } from '../../src/commands/manifest.js';
import { backupsDir, hashBytes, readSettings } from '../../src/commands/settings-file.js';
import { t } from '../../src/core/i18n/index.js';
import { claudeSettingsPath } from '../../src/core/paths.js';
import { restoreEnv, withLang } from '../helpers.js';

const settingsFile = (data: object | null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-'));
  const file = path.join(dir, 'settings.json');
  if (data) fs.writeFileSync(file, JSON.stringify(data));
  return file;
};
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('install and uninstall', () => {
  it('backs up into the config dir, keeps other settings and restores the previous status line', () => {
    const previous = { type: 'command', command: '/usr/bin/ccstatusline', padding: 0 };
    const file = claudeSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ model: 'opus', statusLine: previous }));
    try {
      const backup = applyInstall(planInstall({ file, command: '/bin/ccinfobar', refresh: 10 }), {
        confirmed: true,
      }).backup;
      expect(path.dirname(backup ?? '')).toBe(backupsDir());
      expect(backup).toMatch(/settings-\d{8}T\d{6}Z(-\d+)?\.json$/);
      expect(read(backup ?? '').statusLine).toEqual(previous);
      expect(read(path.join(backupsDir(), 'settings-original.json')).statusLine).toEqual(previous);
      expect(
        applyInstall(planInstall({ file, command: '/bin/ccinfobar', refresh: 10 }), { confirmed: true })
          .backup,
      ).toBeNull();
      expect(fs.existsSync(`${file}.ccinfobar-backup`)).toBe(false);
      expect(read(file)).toEqual({
        model: 'opus',
        statusLine: { type: 'command', command: '/bin/ccinfobar', padding: 0, refreshInterval: 10 },
      });
      applyInstall(planInstall({ file, command: '/bin/ccinfobar' }), { confirmed: true });
      expect(read(file).statusLine.refreshInterval).toBe(10);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('honours a legacy backup on uninstall and leaves it in place', () => {
    const previous = { type: 'command', command: '/usr/bin/ccstatusline', padding: 0 };
    const file = settingsFile({ model: 'opus', statusLine: { type: 'command', command: 'ccinfobar' } });
    const legacy = `${file}.ccinfobar-backup`;
    fs.writeFileSync(legacy, JSON.stringify({ model: 'opus', statusLine: previous }));
    expect(uninstall(file)).toMatchObject({ status: 'restored-previous', removed: true, restored: previous });
    expect(read(file)).toEqual({ model: 'opus', statusLine: previous });
    expect(fs.existsSync(legacy)).toBe(true);
    expect(uninstall(file)).toMatchObject({ status: 'foreign', removed: false, current: previous });
  });

  it('names project backups by a path hash', () => {
    const file = settingsFile({ model: 'opus' });
    expect(applyInstall(planInstall({ file, command: 'ccinfobar' }), { confirmed: true }).backup).toMatch(
      /project-[0-9a-f]{8}-\d{8}T\d{6}Z(-\d+)?\.json$/,
    );
    expect(fs.existsSync(`${file}.ccinfobar-backup`)).toBe(false);
    expect(uninstall(file)).toMatchObject({ status: 'restored-exact', removed: true, restored: null });
    expect(read(file)).toEqual({ model: 'opus' });
  });

  it('refuses to touch a settings file that does not parse', () => {
    const file = settingsFile(null);
    fs.writeFileSync(file, '{"model": ');
    expect(
      () => applyInstall(planInstall({ file, command: 'ccinfobar' }), { confirmed: true }).backup,
    ).toThrow(/Cannot parse/);
    expect(() => uninstall(file)).toThrow(/Cannot parse/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"model": ');
  });

  it('removes the file it created when nothing else is left', () => {
    const file = settingsFile(null);
    expect(applyInstall(planInstall({ file, command: 'ccinfobar' }), { confirmed: true }).backup).toBeNull();
    expect(uninstall(file)).toMatchObject({ status: 'deleted-file', removed: true, restored: null });
    expect(fs.existsSync(file)).toBe(false);
    expect(uninstall(file)).toMatchObject({ status: 'not-installed', removed: false });
  });

  it('finds a project status line that beats the user one and wins over it locally', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-project-')));
    const shared = projectSettingsPath(root, false);
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'node gsd.js' } }));
    expect(projectOverride(root)).toEqual({ file: shared, command: 'node gsd.js' });
    const local = projectSettingsPath(root);
    applyInstall(planInstall({ file: local, command: 'ccinfobar' }), { confirmed: true });
    expect(projectOverride(root)).toBeNull();
    expect(projectLocalFile(root)).toBe(local);
    expect(uninstall(local)).toMatchObject({ status: 'deleted-file', removed: true });
    expect(projectOverride(root)?.command).toBe('node gsd.js');
  });

  it.skipIf(process.platform === 'win32')('escapes gitignore metacharacters and resolves links', () => {
    const real = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-git-')));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, XDG_CONFIG_HOME: real };
    try {
      execFileSync('git', ['init', '-q'], { cwd: real, env });
    } catch {
      return;
    }
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    const sub = path.join(link, 'a [b]*?');
    fs.mkdirSync(sub);
    fs.mkdirSync(path.join(real, 'a bxy'));
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const local = projectSettingsPath(sub);
      applyInstall(planInstall({ file: local, command: 'ccinfobar' }), { confirmed: true });
      expect(ignoreLocally(local)).toBe(true);
      expect(ignoreLocally(local)).toBe(false);
      const exclude = fs.readFileSync(path.join(real, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude).toContain('/a \\[b\\]\\*\\?/.claude/settings.local.json\n');
      const other = path.join(real, 'a bxy', '.claude', 'settings.local.json');
      expect(() =>
        execFileSync('git', ['check-ignore', '-q', other], { cwd: real, env, stdio: 'ignore' }),
      ).toThrow();
    } finally {
      restoreEnv(saved);
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('adds settings.local.json to the repo exclude file once', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-git-')));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, XDG_CONFIG_HOME: root };
    try {
      execFileSync('git', ['init', '-q'], { cwd: root, env });
    } catch {
      return;
    }
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const local = projectSettingsPath(root);
      applyInstall(planInstall({ file: local, command: 'ccinfobar' }), { confirmed: true });
      expect(ignoreLocally(local)).toBe(true);
      expect(ignoreLocally(local)).toBe(false);
      const excludeFile = path.join(root, '.git', 'info', 'exclude');
      const exclude = fs.readFileSync(excludeFile, 'utf8');
      expect(exclude.match(/\/\.claude\/settings\.local\.json/g)).toHaveLength(1);
      const recorded = readManifest().entries.filter(
        (e) => e.kind === 'gitExclude' && e.file === excludeFile,
      );
      expect(recorded).toMatchObject([{ line: '/.claude/settings.local.json' }]);
    } finally {
      restoreEnv(saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes over GSD project status lines and gives them back', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-take-')));
    const claude = path.join(base, 'claude');
    const project = (name: string, command: string | null) => {
      const root = path.join(base, name);
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      if (command) {
        fs.writeFileSync(
          projectSettingsPath(root, false),
          JSON.stringify({ hooks: {}, statusLine: { type: 'command', command } }),
        );
      }
      return root;
    };
    const gsd = project('gsd', 'node .claude/hooks/gsd-statusline.js');
    const other = project('other', 'my-line');
    const plain = project('plain', null);
    fs.mkdirSync(claude);
    const projects = Object.fromEntries([gsd, other, plain, path.join(base, 'gone')].map((p) => [p, {}]));
    fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ projects }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude };
    expect(takeOverProjects('ccinfobar', 10, env)).toEqual([gsd]);
    expect(read(projectSettingsPath(gsd)).statusLine).toEqual({
      type: 'command',
      command: 'ccinfobar',
      padding: 0,
      refreshInterval: 10,
    });
    expect(takeOverProjects('ccinfobar', 10, env)).toEqual([]);
    expect(fs.existsSync(projectSettingsPath(other))).toBe(false);
    expect(releaseProjects(env)).toEqual([gsd]);
    expect(fs.existsSync(projectSettingsPath(gsd))).toBe(false);
    expect(read(projectSettingsPath(gsd, false)).statusLine.command).toMatch(/gsd-statusline/);
  });

  it('records every install in the manifest', () => {
    const previous = { type: 'command', command: 'npx ccstatusline' };
    const file = settingsFile({ statusLine: previous });
    applyInstall(planInstall({ file, command: '/bin/ccinfobar', refresh: 4 }), { confirmed: true });
    const entry = findStatusLineEntry(readManifest(), file);
    expect(entry).toMatchObject({
      kind: 'statusLine',
      file: fs.realpathSync(file),
      key: ['statusLine'],
      value: { type: 'command', command: '/bin/ccinfobar', padding: 0, refreshInterval: 4 },
      previous,
      fileExisted: true,
      writtenHash: hashBytes(fs.readFileSync(file)),
      version: expect.any(String),
      at: expect.any(String),
    });
  });

  it('writes the original copy only before the first recorded install', () => {
    const file = settingsFile({ model: 'opus' });
    applyInstall(planInstall({ file, command: '/bin/ccinfobar' }), { confirmed: true });
    const original = fs
      .readdirSync(backupsDir())
      .map((n) => path.join(backupsDir(), n))
      .find((f) => f.endsWith('-original.json') && read(f).model === 'opus' && !read(f).statusLine);
    expect(original).toBeDefined();
    fs.rmSync(original ?? '');
    applyInstall(planInstall({ file, command: '/opt/ccinfobar' }), { confirmed: true });
    expect(fs.existsSync(original ?? '')).toBe(false);
  });

  it('releases --project installs the manifest knows but .claude.json does not', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-rel-')));
    const claude = path.join(base, 'claude');
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude };
    fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ projects: {} }));
    const root = path.join(base, 'proj');
    const gone = path.join(base, 'gone');
    const own = path.join(claude, 'settings.local.json');
    for (const file of [projectSettingsPath(root), projectSettingsPath(gone), own]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } }));
      applyInstall(planInstall({ file, command: '/bin/ccinfobar', env }), { confirmed: true, env });
    }
    fs.rmSync(gone, { recursive: true });
    expect(releaseProjects(env)).toEqual([root]);
    expect(read(projectSettingsPath(root)).statusLine.command).toBe('my-line');
    expect(fs.existsSync(gone)).toBe(false);
    expect(read(own).statusLine.command).toBe('/bin/ccinfobar');
  });

  it('releases a --project install made in the home folder and leaves user settings', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-home-')));
    const home = path.join(base, 'home');
    const claude = path.join(home, '.claude');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: claude,
      CCINFOBAR_CONFIG_DIR: path.join(base, 'cfg'),
    };
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ projects: {} }));
    const user = claudeSettingsPath(env);
    const local = projectSettingsPath(home);
    for (const file of [user, local]) {
      fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } }));
      applyInstall(planInstall({ file, command: '/bin/ccinfobar', env }), { confirmed: true, env });
    }
    expect(releaseProjects(env)).toEqual([home]);
    expect(read(local).statusLine.command).toBe('my-line');
    expect(read(user).statusLine.command).toBe('/bin/ccinfobar');
  });

  it('never releases or shadows by substring', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-own-')));
    const claude = path.join(base, 'claude');
    const root = path.join(base, 'proj');
    const wrapper = { type: 'command', command: 'bash -c "ccinfobar | tee /tmp/x"' };
    const local = projectSettingsPath(root);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, JSON.stringify({ statusLine: wrapper }));
    fs.mkdirSync(claude);
    fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ projects: { [root]: {} } }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude };
    expect(releaseProjects(env)).toEqual([]);
    expect(read(local).statusLine).toEqual(wrapper);
    expect(projectOverride(root)).toEqual({ file: local, command: wrapper.command });
    expect(projectLocalFile(root)).toBe(local);
    applyInstall(planInstall({ file: local, command: '/bin/ccinfobar' }), { confirmed: true });
    expect(projectOverride(root)).toBeNull();
    expect(releaseProjects(env)).toEqual([root]);
    expect(read(local).statusLine).toEqual(wrapper);
  });

  it('never writes npx@latest as the status line command', () => {
    const path0 = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(defaultCommand('npx') ?? '').not.toMatch(/npx/);
      expect(defaultCommand('source') ?? '').not.toMatch(/npx/);
    } finally {
      process.env.PATH = path0;
    }
  });

  it('builds the fallback command with the shared builder', () => {
    const path0 = process.env.PATH;
    process.env.PATH = '';
    try {
      const entry = path.resolve(process.argv[1] ?? '');
      const want = buildCommand({ kind: 'script', script: entry });
      expect(defaultCommand('source')).toBe(want.ok ? want.command : null);
    } finally {
      process.env.PATH = path0;
    }
  });

  it('logs and returns null for an unsafe path', () => {
    const lines: string[] = [];
    const bad = buildCommand({ kind: 'script', script: 'C:\\a$b\\ccinfobar.js' }, 'win32');
    expect(acceptCommand(bad, (l) => lines.push(l))).toBeNull();
    expect(lines).toEqual([t('install.unsafePath', { path: 'C:\\a$b\\ccinfobar.js', chars: '$' })]);
    expect(acceptCommand(buildCommand({ kind: 'bin', bin: '/x/ccinfobar', onPath: true }, 'linux'))).toBe(
      '/x/ccinfobar',
    );
  });

  it('does not mistake the npx cache for a global install', () => {
    expect(isTransientBin('/home/u/.npm/_npx/0d89f6/node_modules/.bin/ccinfobar')).toBe(true);
    expect(
      isTransientBin('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\.bin\\ccinfobar.cmd'),
    ).toBe(true);
    expect(isTransientBin('/home/u/.npm-global/bin/ccinfobar')).toBe(false);
    expect(isTransientBin('/opt/homebrew/bin/ccinfobar')).toBe(false);
  });
});

describe('install prompt and messages', () => {
  it('shows the yes/no marker in the display language', () => {
    expect([promptMarker(true), promptMarker(false)]).toEqual(['[Y/n]', '[y/N]']);
    expect(withLang('tr', () => [promptMarker(true), promptMarker(false)])).toEqual(['[E/h]', '[e/H]']);
  });

  it('reads y, yes, e and evet as yes in any language', () => {
    for (const lang of ['en', 'tr'] as const)
      withLang(lang, () => {
        for (const a of ['y', 'yes', 'Y', ' YES ', 'e', 'evet', 'E', 'Evet', 'EVET'])
          expect(isYes(a, false), a).toBe(true);
        for (const a of ['n', 'no', 'N', 'h', 'hayır', 'Hayır', 'HAYIR', 'x'])
          expect(isYes(a, true), a).toBe(false);
        expect(isYes('', true)).toBe(true);
        expect(isYes('  ', false)).toBe(false);
      });
  });

  it('gives the fallback without a terminal', async () => {
    if (process.stdin.isTTY && process.stdout.isTTY) return;
    expect(await ask('Replace?', true)).toBe(true);
    expect(await ask('Replace?', false)).toBe(false);
  });

  it('counts released projects', () => {
    expect(t('uninstall.releasedProjects', { count: 1 })).toBe('✓ Gave 1 project its own status line back');
    expect(t('uninstall.releasedProjects', { count: 2 })).toBe(
      '✓ Gave 2 projects their own status line back',
    );
    expect(withLang('tr', () => t('uninstall.releasedProjects', { count: 2 }))).toBe(
      '✓ 2 projenin kendi durum satırı geri verildi',
    );
  });

  it('wraps the parse error of a settings file in the display language', () => {
    const file = settingsFile(null);
    fs.writeFileSync(file, '[1]');
    expect(() => readSettings(file)).toThrow(`Cannot parse ${file}: not a JSON object`);
    expect(() => withLang('tr', () => readSettings(file))).toThrow(
      `${file} ayrıştırılamıyor: bir JSON nesnesi değil`,
    );
    fs.writeFileSync(file, '{"model": ');
    expect(() => withLang('tr', () => readSettings(file))).toThrow(/ayrıştırılamıyor: .*JSON/);
  });
});
