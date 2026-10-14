import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommand } from '../../src/commands/command.js';
import {
  acceptCommand,
  defaultCommand,
  ignoreLocally,
  install,
  isTransientBin,
  projectLocalFile,
  projectOverride,
  projectSettingsPath,
  releaseProjects,
  takeOverProjects,
  uninstall,
} from '../../src/commands/install.js';
import { backupsDir } from '../../src/commands/settings-file.js';
import { t } from '../../src/core/i18n/index.js';
import { claudeSettingsPath } from '../../src/core/paths.js';

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
      const backup = install('/bin/ccinfobar', 10, file);
      expect(path.dirname(backup ?? '')).toBe(backupsDir());
      expect(backup).toMatch(/settings-\d{8}T\d{6}Z(-\d+)?\.json$/);
      expect(read(backup ?? '').statusLine).toEqual(previous);
      expect(read(path.join(backupsDir(), 'settings-original.json')).statusLine).toEqual(previous);
      expect(install('/bin/ccinfobar', 10, file)).toBeNull();
      expect(fs.existsSync(`${file}.ccinfobar-backup`)).toBe(false);
      expect(read(file)).toEqual({
        model: 'opus',
        statusLine: { type: 'command', command: '/bin/ccinfobar', padding: 0, refreshInterval: 10 },
      });
      install('/bin/ccinfobar', undefined, file);
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
    expect(uninstall(file)).toEqual({ removed: true, restored: previous });
    expect(read(file)).toEqual({ model: 'opus', statusLine: previous });
    expect(fs.existsSync(legacy)).toBe(true);
    expect(uninstall(file)).toEqual({ removed: false });
  });

  it('names project backups by a path hash', () => {
    const file = settingsFile({ model: 'opus' });
    expect(install('ccinfobar', undefined, file)).toMatch(/project-[0-9a-f]{8}-\d{8}T\d{6}Z(-\d+)?\.json$/);
    expect(fs.existsSync(`${file}.ccinfobar-backup`)).toBe(false);
    expect(uninstall(file)).toEqual({ removed: true, restored: null });
    expect(read(file)).toEqual({ model: 'opus' });
  });

  it('refuses to touch a settings file that does not parse', () => {
    const file = settingsFile(null);
    fs.writeFileSync(file, '{"model": ');
    expect(() => install('ccinfobar', undefined, file)).toThrow(/Cannot parse/);
    expect(() => uninstall(file)).toThrow(/Cannot parse/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"model": ');
  });

  it('removes the file it created when nothing else is left', () => {
    const file = settingsFile(null);
    expect(install('ccinfobar', undefined, file)).toBeNull();
    expect(uninstall(file)).toEqual({ removed: true, restored: null });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('finds a project status line that beats the user one and wins over it locally', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-project-')));
    const shared = projectSettingsPath(root, false);
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, JSON.stringify({ statusLine: { type: 'command', command: 'node gsd.js' } }));
    expect(projectOverride(root)).toEqual({ file: shared, command: 'node gsd.js' });
    const local = projectSettingsPath(root);
    install('ccinfobar', undefined, local);
    expect(projectOverride(root)).toBeNull();
    expect(projectLocalFile(root)).toBe(local);
    expect(uninstall(local)).toEqual({ removed: true, restored: null });
    expect(projectOverride(root)?.command).toBe('node gsd.js');
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
      install('ccinfobar', undefined, local);
      expect(ignoreLocally(local)).toBe(true);
      expect(ignoreLocally(local)).toBe(false);
      const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
      expect(exclude.match(/\/\.claude\/settings\.local\.json/g)).toHaveLength(1);
    } finally {
      process.env = saved;
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
