import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultCommand,
  ignoreLocally,
  install,
  NPX_COMMAND,
  projectLocalFile,
  projectOverride,
  projectSettingsPath,
  releaseProjects,
  takeOverProjects,
  uninstall,
} from '../../src/commands/install.js';

const settingsFile = (data: object | null) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-'));
  const file = path.join(dir, 'settings.json');
  if (data) fs.writeFileSync(file, JSON.stringify(data));
  return file;
};
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('install and uninstall', () => {
  it('backs up once, keeps other settings and restores the previous status line', () => {
    const previous = { type: 'command', command: '/usr/bin/ccstatusline', padding: 0 };
    const file = settingsFile({ model: 'opus', statusLine: previous });
    expect(install('/bin/ccinfobar', 10, file)).toBe(`${file}.ccinfobar-backup`);
    install('/bin/ccinfobar', 10, file);
    expect(read(`${file}.ccinfobar-backup`).statusLine).toEqual(previous);
    expect(read(file)).toEqual({
      model: 'opus',
      statusLine: { type: 'command', command: '/bin/ccinfobar', padding: 0, refreshInterval: 10 },
    });
    install('/bin/ccinfobar', undefined, file);
    expect(read(file).statusLine.refreshInterval).toBe(10);
    expect(uninstall(file)).toEqual({ removed: true, restored: previous });
    expect(read(file)).toEqual({ model: 'opus', statusLine: previous });
    expect(uninstall(file)).toEqual({ removed: false });
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

  it('writes the npx command when run through npx without a global install', () => {
    const path0 = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(defaultCommand('npx')).toBe(NPX_COMMAND);
      expect(defaultCommand('source')).not.toBe(NPX_COMMAND);
    } finally {
      process.env.PATH = path0;
    }
  });
});
