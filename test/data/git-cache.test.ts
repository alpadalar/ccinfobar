import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCache } from '../../src/data/cache.js';
import {
  discoverGit,
  type GitCacheEntry,
  type GitLayout,
  gitCacheName,
  gitSig,
  readGitCache,
  sameSig,
} from '../../src/data/git.js';
import { restoreEnv } from '../helpers.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const available = hasGit();
let tmp: string;
let main: string;
let wt: string;
let parent: string;
let submodOk = false;

function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, stdio: 'ignore', windowsHide: true },
  );
}

const real = (p: string) => fs.realpathSync.native(p);

describe.skipIf(!available)('discoverGit', () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gc-'));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    parent = path.join(tmp, 'parent');
    fs.mkdirSync(path.join(main, 'a', 'b'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'i');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
    fs.mkdirSync(parent);
    git(parent, 'init', '-q', '-b', 'main');
    git(parent, 'commit', '-q', '--allow-empty', '-m', 'i');
    try {
      git(parent, 'submodule', 'add', '-q', main, 'sub');
      submodOk = true;
    } catch {}
  });
  it('finds a plain repo and a nested dir', () => {
    const l = discoverGit(main, {})!;
    expect(l.root).toBe(real(main));
    expect(l.gitdir).toBe(path.join(main, '.git'));
    expect(l.common).toBe(l.gitdir);
    expect(discoverGit(path.join(main, 'a', 'b'), {})).toEqual(l);
  });

  it('finds a linked worktree', () => {
    const l = discoverGit(wt, {})!;
    expect(real(l.gitdir).startsWith(real(path.join(main, '.git', 'worktrees')))).toBe(true);
    expect(real(l.common)).toBe(real(path.join(main, '.git')));
    expect(l.gitdir).not.toBe(l.common);
  });

  it('finds a submodule gitdir', () => {
    if (!submodOk) return;
    const l = discoverGit(path.join(parent, 'sub'), {})!;
    expect(real(l.gitdir)).toBe(real(path.join(parent, '.git', 'modules', 'sub')));
    expect(l.common).toBe(l.gitdir);
  });

  it('returns null when GIT_DIR is set', () => {
    expect(discoverGit(main, { GIT_DIR: '/x' })).toBeNull();
    const saved = { ...process.env };
    process.env.GIT_WORK_TREE = '/x';
    try {
      expect(discoverGit(main)).toBeNull();
    } finally {
      restoreEnv(saved);
    }
  });

  it('returns null without .git', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-nogit-'));
    try {
      expect(discoverGit(d, {})).toBeNull();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('returns null for an unparsable .git file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-badgit-'));
    try {
      fs.writeFileSync(path.join(d, '.git'), 'nonsense');
      expect(discoverGit(d, {})).toBeNull();
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('returns null for reftable HEAD', () => {
    const d = path.join(tmp, 'reft');
    fs.mkdirSync(d);
    git(d, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    expect(discoverGit(d, {})).toBeNull();
  });

  it('returns null inside a bare repo', () => {
    git(tmp, 'init', '-q', '--bare', 'bare.git');
    expect(discoverGit(path.join(tmp, 'bare.git'), {})).toBeNull();
  });
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!available)('gitSig', () => {
  let layout: GitLayout;
  beforeAll(() => {
    layout = discoverGit(main, {})!;
  });

  it('lists seven entries in order', () => {
    const s = gitSig(layout);
    expect(s.map((e) => path.relative(layout.gitdir, e[0]).split(path.sep).join('/'))).toEqual([
      'HEAD',
      'index',
      'packed-refs',
      'config',
      'refs/heads/main',
      'logs/HEAD',
      'refs/stash',
    ]);
    expect(s[0]![1]).toEqual(expect.any(Number));
    expect(s[2]![1]).toBeNull();
    expect(s[6]).toEqual([path.join(layout.common, 'refs', 'stash'), null]);
  });

  it('changes when a file changes', () => {
    const before = gitSig(layout);
    expect(sameSig(before, gitSig(layout))).toBe(true);
    const f = path.join(layout.gitdir, 'HEAD');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(f, t, t);
    const after = gitSig(layout);
    expect(sameSig(before, after)).toBe(false);
    expect(after[0]![1]).not.toBe(before[0]![1]);
  });

  it('drops the branch ref when detached', () => {
    const d = path.join(tmp, 'det');
    fs.mkdirSync(d);
    git(d, 'init', '-q', '-b', 'main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'i');
    git(d, 'checkout', '-q', '--detach');
    expect(gitSig(discoverGit(d, {})!)).toHaveLength(6);
  });
});

describe('gitCacheName and readGitCache', () => {
  it('names are stable and distinct', () => {
    const a = gitCacheName('/r', '/r/.git', false, 'git');
    expect(a).toMatch(/^git-[0-9a-f]{20}\.json$/);
    expect(gitCacheName('/r', '/r/.git', false, 'git')).toBe(a);
    expect(gitCacheName('/r', '/r/.git', true, 'git')).not.toBe(a);
    expect(gitCacheName('/r', '/r/.git', false, '/usr/bin/git')).not.toBe(a);
  });

  const info = {
    root: '/r',
    branch: 'main',
    detached: false,
    sha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    insertions: null,
    deletions: null,
    stash: null,
    operation: null,
    remoteUrl: null,
    isWorktree: false,
  };

  it('round-trips a valid entry and rejects broken ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gcc-'));
    const env = { CCINFOBAR_CACHE_DIR: dir };
    try {
      const good: GitCacheEntry = {
        v: 1,
        at: 5,
        sig: [
          ['/a', 1, 2],
          ['/b', null],
        ],
        info,
      };
      writeCache('t.json', good, env);
      expect(readGitCache('t.json', env)).toEqual(good);
      for (const bad of [{ v: 99 }, { v: 1, at: 'x' }, 'str', null, { ...good, sig: [['/a', 'x']] }]) {
        writeCache('t.json', bad, env);
        expect(readGitCache('t.json', env)).toBeNull();
      }
      writeCache('t.json', { ...good, info: { ...info, branch: '\u001b[31mred' } }, env);
      expect(readGitCache('t.json', env)!.info.branch).not.toContain('\u001b');
      expect(readGitCache('missing.json', env)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
