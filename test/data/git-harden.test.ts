import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARDEN, localFilterOverrides, parseScopedConfig, readGit } from '../../src/data/git.js';

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
  'local\tremote.origin.url git@h:o/r.git\n' +
  'local\tfilter.evil.clean touch /x\n' +
  'global\tfilter.lfs.clean git-lfs clean -- %f\n';

describe('scoped config parsing', () => {
  it('parses scope, key and value', () => {
    expect(parseScopedConfig(SAMPLE)).toEqual([
      { scope: 'local', key: 'remote.origin.url', value: 'git@h:o/r.git' },
      { scope: 'local', key: 'filter.evil.clean', value: 'touch /x' },
      { scope: 'global', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
    ]);
    expect(parseScopedConfig('local\tfilter.x.clean\n\n')).toEqual([
      { scope: 'local', key: 'filter.x.clean', value: '' },
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
    const wt = parseScopedConfig('worktree\tfilter.w.process cmd\nworktree\tfilter.w.smudge cmd\n');
    expect(localFilterOverrides(wt)).toEqual([
      '-c',
      'filter.w.clean=',
      '-c',
      'filter.w.smudge=',
      '-c',
      'filter.w.process=',
    ]);
    expect(localFilterOverrides(parseScopedConfig('system\tfilter.s.clean x\n'))).toEqual([]);
  });

  it('uses --config-env for names that contain =', () => {
    const out = localFilterOverrides(parseScopedConfig('local\tfilter.a=b.clean x\n'));
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

  it('blocks a filter whose name contains =', () => {
    const marker = path.join(base, 'eq-marker');
    const dir = filterRepo('eq', 'a=b', marker);
    expect(readGit(dir)?.branch).toBe('main');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
