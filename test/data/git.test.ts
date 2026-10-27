import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseShortstat, parseStatus, readGit } from '../../src/data/git.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const available = hasGit();
let dir: string;

function git(...args: string[]) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });
}

describe('git parsing', () => {
  it('parses porcelain v2 status', () => {
    const s = parseStatus(
      [
        '# branch.oid abcdef1234567',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -1',
        '# stash 3',
        '1 M. N... 100644 100644 100644 a b f1',
        '1 .M N... 100644 100644 100644 a b f2',
        '1 MM N... 100644 100644 100644 a b f3',
        'u UU N... 1 2 3 4 a b c f4',
        '? new.txt',
      ].join('\n'),
    );
    expect(s).toMatchObject({
      branch: 'main',
      sha: 'abcdef1',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      staged: 2,
      unstaged: 2,
      conflicts: 1,
      untracked: 1,
      stash: 3,
    });
  });

  it('parses shortstat', () => {
    expect(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)')).toEqual({
      insertions: 10,
      deletions: 2,
    });
    expect(parseShortstat('')).toEqual({ insertions: 0, deletions: 0 });
  });
});

describe.skipIf(!available)('readGit', () => {
  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-git-')));
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('remote', 'add', 'origin', 'git@github.com:acme/demo.git');
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns null outside a repo', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-nogit-'));
    try {
      expect(readGit(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('reads a clean repo', () => {
    const g = readGit(dir)!;
    expect(fs.realpathSync.native(g.root)).toBe(fs.realpathSync.native(dir));
    expect(g.branch).toBe('main');
    expect(g.detached).toBe(false);
    expect(g.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(g.staged + g.unstaged + g.untracked + g.conflicts).toBe(0);
    expect(g.insertions).toBe(0);
    expect(g.deletions).toBe(0);
    expect(g.remoteUrl).toBe('git@github.com:acme/demo.git');
    expect(g.operation).toBeNull();
    expect(g.isWorktree).toBe(false);
  });

  it('counts changes and diff stats', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'new\n');
    git('add', 'b.txt');
    const g = readGit(dir)!;
    expect(g.unstaged).toBe(1);
    expect(g.staged).toBe(1);
    expect(g.untracked).toBe(1);
    expect(g.insertions).toBe(2);
    expect(g.deletions).toBe(0);
  });

  it('reads the upstream and fork remotes in both modes', () => {
    expect(readGit(dir)!.upstreamUrl).toBeNull();
    git('remote', 'add', 'upstream', 'git@github.com:parent/demo.git');
    try {
      for (const harden of [true, false]) {
        const g = readGit(dir, { harden })!;
        expect(g.remoteUrl).toBe('git@github.com:acme/demo.git');
        expect(g.upstreamUrl).toBe('git@github.com:parent/demo.git');
        expect(g.forkUrl).toBeNull();
      }
    } finally {
      git('remote', 'remove', 'upstream');
    }
  });

  it('detects a merge in progress', () => {
    fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'x\n');
    expect(readGit(dir)!.operation).toBe('MERGING');
    fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));
  });

  it('detects detached head and worktrees', () => {
    git('stash', '-u', '-q');
    git('checkout', '-q', '--detach');
    const g = readGit(dir)!;
    expect(g.detached).toBe(true);
    expect(g.branch).toBeNull();
    expect(g.stash).toBe(1);
    git('checkout', '-q', 'main');
    const wt = `${dir}-wt`;
    git('worktree', 'add', '-q', '-b', 'wt', wt);
    try {
      expect(readGit(wt)!.isWorktree).toBe(true);
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});
