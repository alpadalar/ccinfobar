import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARDEN, hardenedGit, localFilterOverrides, parseScopedConfig, readGit } from '../../src/data/git.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const available = hasGit();
const posix = process.platform !== 'win32';

const SAMPLE =
  'local\0remote.origin.url\ngit@h:o/r.git\0' +
  'local\0filter.evil.clean\ntouch /x\0' +
  'global\0filter.lfs.clean\ngit-lfs clean -- %f\0';

describe('scoped config parsing', () => {
  it('parses scope, key and value', () => {
    expect(parseScopedConfig(SAMPLE)).toEqual([
      { scope: 'local', key: 'remote.origin.url', value: 'git@h:o/r.git' },
      { scope: 'local', key: 'filter.evil.clean', value: 'touch /x' },
      { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
    ]);
    expect(parseScopedConfig('local\0filter.x.clean\0\0')).toEqual([
      { scope: 'local', key: 'filter.x.clean', value: '' },
    ]);
  });

  it('parses keys with spaces and valueless records', () => {
    const out = 'local\0filter.a b.clean\necho evil\0global\0user.name\nMe\0';
    expect(parseScopedConfig(out)).toEqual([
      { scope: 'local', key: 'filter.a b.clean', value: 'echo evil' },
      { scope: 'global', key: 'user.name', value: 'Me' },
    ]);
    expect(parseScopedConfig('local\0core.bare\0')).toEqual([
      { scope: 'local', key: 'core.bare', value: '' },
    ]);
    expect(parseScopedConfig('')).toEqual([]);
    expect(localFilterOverrides(parseScopedConfig(out))).toEqual([
      '-c',
      'filter.a b.clean=',
      '-c',
      'filter.a b.smudge=',
      '-c',
      'filter.a b.process=',
    ]);
  });

  it('overrides only local and worktree filter drivers', () => {
    expect(localFilterOverrides(parseScopedConfig(SAMPLE))).toEqual([
      '-c',
      'filter.evil.clean=',
      '-c',
      'filter.evil.smudge=',
      '-c',
      'filter.evil.process=',
    ]);
    const wt = parseScopedConfig('worktree\0filter.w.process\ncmd\0worktree\0filter.w.smudge\ncmd\0');
    expect(localFilterOverrides(wt)).toEqual([
      '-c',
      'filter.w.clean=',
      '-c',
      'filter.w.smudge=',
      '-c',
      'filter.w.process=',
    ]);
    expect(localFilterOverrides(parseScopedConfig('system\0filter.s.clean\nx\0'))).toEqual([]);
  });

  it('uses --config-env for names that contain =', () => {
    const out = localFilterOverrides(parseScopedConfig('local\0filter.a=b.clean\nx\0'));
    expect(out).toHaveLength(3);
    for (const a of out) expect(a).toMatch(/^--config-env=filter\.a=b\.(clean|smudge|process)=\w+$/);
  });

  it('exports the hardening prefix', () => {
    expect(HARDEN).toEqual(['-c', 'core.fsmonitor=false', '--no-optional-locks']);
  });
});

describe.skipIf(!available || !posix)('hostile repos', () => {
  let base: string;
  const setupEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

  function run(cwd: string, ...args: string[]) {
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd, stdio: 'ignore', windowsHide: true, env: setupEnv },
    );
  }

  function hook(name: string, marker: string, body = ''): string {
    const p = path.join(base, name);
    fs.writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\n${body}`);
    fs.chmodSync(p, 0o755);
    return p;
  }

  function repo(name: string): string {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    run(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    run(dir, 'add', '.');
    run(dir, 'commit', '-q', '-m', 'init');
    run(dir, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    return dir;
  }

  function filterRepo(name: string, filter: string, marker: string): string {
    const dir = repo(name);
    fs.writeFileSync(path.join(dir, '.gitattributes'), `* filter=${filter}\n`);
    run(dir, '-c', `filter.${filter}.clean=cat`, 'add', '.gitattributes');
    run(dir, 'commit', '-q', '-m', 'attrs');
    run(dir, 'config', `filter.${filter}.clean`, hook(`${name}.sh`, marker, 'cat\n'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    return dir;
  }

  beforeAll(() => {
    const parent = process.env.CCIB_TEST_ROOT ?? os.tmpdir();
    base = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'ccib-harden-')));
  });

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('runs the hardened status without blocking the event loop', async () => {
    const dir = repo('async');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const out = await hardenedGit(dir, ['status', '--porcelain'], { harden: true, timeout: 5000 });
      expect(out?.trim()).toBe('M a.txt');
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it('disables a repo-local filter whose name has a space', () => {
    const marker = path.join(base, 'space-marker');
    const dir = filterRepo('space', 'a b', marker);
    const g = readGit(dir);
    expect(g?.unstaged).toBe(1);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('blocks a core.fsmonitor hook, and the switch turns it back on', () => {
    const dir = repo('fsmon');
    const marker = path.join(base, 'fsmon-marker');
    run(dir, 'config', 'core.fsmonitor', hook('fsmon.sh', marker));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');

    const g = readGit(dir);
    expect(g?.branch).toBe('main');
    expect(g?.remoteUrl).toBe('git@github.com:acme/demo.git');
    expect(fs.existsSync(marker)).toBe(false);

    readGit(dir, { harden: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('blocks a repo-local clean filter', () => {
    const marker = path.join(base, 'filter-marker');
    const dir = filterRepo('filter', 'evil', marker);

    const g = readGit(dir);
    expect(g?.branch).toBe('main');
    expect(g?.unstaged).toBe(1);
    expect(g?.remoteUrl).toBe('git@github.com:acme/demo.git');
    expect(fs.existsSync(marker)).toBe(false);

    readGit(dir, { harden: false });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('blocks a repo-local clean filter through the cache', () => {
    const marker = path.join(base, 'cached-filter-marker');
    const dir = filterRepo('cached-filter', 'evil', marker);
    const cacheDir = path.join(base, 'cached-filter-cache');
    fs.mkdirSync(cacheDir);
    const env = { ...process.env, CCINFOBAR_CACHE_DIR: cacheDir };
    const T = 1_700_000_000_000;
    for (const now of [T, T + 100, T + 5000]) {
      const g = readGit(dir, { cache: { now, persist: true }, env });
      expect(g?.unstaged).toBe(1);
      expect(g?.remoteUrl).toBe('git@github.com:acme/demo.git');
      expect(fs.existsSync(marker)).toBe(false);
    }
  });

  it('blocks a filter whose name contains =', () => {
    const marker = path.join(base, 'eq-marker');
    const dir = filterRepo('eq', 'a=b', marker);
    expect(readGit(dir)?.branch).toBe('main');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
