import cp, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import type { StatusPayload } from '../../src/core/types.js';
import { writeCache } from '../../src/data/cache.js';
import {
  discoverGit,
  type GitCacheEntry,
  type GitLayout,
  gitCacheName,
  gitSig,
  readGit,
  readGitCache,
  sameSig,
} from '../../src/data/git.js';
import { binary, whichDeps } from '../../src/data/which.js';
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
        v: 2,
        at: 5,
        sig: [
          ['/a', 1, 2],
          ['/b', null],
        ],
        info,
      };
      writeCache('t.json', good, env);
      expect(readGitCache('t.json', env)).toEqual(good);
      for (const bad of [
        { v: 99 },
        { v: 2, at: 'x' },
        { ...good, v: 1 },
        'str',
        null,
        { ...good, sig: [['/a', 'x']] },
        { ...good, info: { ...info, detached: 'yes' } },
        { ...good, info: { ...info, sha: 5 } },
        { ...good, info: { ...info, remoteUrl: {} } },
      ]) {
        writeCache('t.json', bad, env);
        expect(readGitCache('t.json', env)).toBeNull();
      }
      const ok = { ...good, info: { ...info, upstreamUrl: undefined, forkUrl: null } };
      writeCache('t.json', ok, env);
      expect(readGitCache('t.json', env)).not.toBeNull();
      writeCache('t.json', { ...good, info: { ...info, branch: '\u001b[31mred' } }, env);
      expect(readGitCache('t.json', env)!.info.branch).not.toContain('\u001b');
      expect(readGitCache('missing.json', env)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!available)('cached readGit', () => {
  const T = 1_700_000_000_000;
  let root: string;
  let dir: string;
  let gitdir: string;
  let cacheDir: string;
  let env: NodeJS.ProcessEnv;
  let spy: ReturnType<typeof vi.spyOn>;
  let future = Math.floor(Date.now() / 1000) + 1000;

  const render = (t: number, e: NodeJS.ProcessEnv = env) =>
    createContext({
      payload: { cwd: dir, workspace: { current_dir: dir } } as StatusPayload,
      config: defaultConfig(),
      env: e,
      now: new Date(t),
      preview: false,
    }).data.git();
  const gitSpawns = () =>
    spy.mock.calls.filter((c: unknown[]) => /(^|[\\/])git(\.exe|\.com)?$/i.test(String(c[0]))).length;
  const bump = (f: string) => {
    future += 10;
    fs.utimesSync(f, future, future);
  };
  const cacheFiles = () => fs.readdirSync(cacheDir).filter((f) => /^git-.*\.json$/.test(f));
  const step = (t: number, e?: NodeJS.ProcessEnv) => {
    spy.mockClear();
    const r = render(t, e);
    return { r, n: gitSpawns() };
  };

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gcr-')));
    dir = path.join(root, 'repo');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'i');
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    gitdir = path.join(dir, '.git');
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir);
    env = { ...process.env, CCINFOBAR_CACHE_DIR: cacheDir };
    spy = vi.spyOn(cp, 'execFileSync');
    module.syncBuiltinESMExports();
  });
  afterEach(() => spy.mockClear());
  afterAll(() => {
    vi.restoreAllMocks();
    module.syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('follows the spawn table', () => {
    const first = step(T);
    expect(first.n).toBe(3);
    expect(cacheFiles()).toHaveLength(1);
    spy.mockClear();
    expect(first.r).toEqual(readGit(dir));
    const hit = step(T + 100);
    expect(hit.n).toBe(0);
    expect(hit.r).toEqual(first.r);
    expect(step(T + 2500).n).toBe(2);
    expect(hit.r?.stash).toBe(readGit(dir)?.stash);
  });

  it('invalidates on each key file', () => {
    let t = T + 2600;
    const next = () => {
      t += 50;
      return t;
    };
    for (const f of ['index', 'HEAD', path.join('logs', 'HEAD'), path.join('refs', 'heads', 'main')]) {
      bump(path.join(gitdir, f));
      expect(step(next()).n).toBe(2);
    }
    git(dir, 'pack-refs', '--all');
    expect(step(next()).n).toBe(2);
    bump(path.join(gitdir, 'packed-refs'));
    expect(step(next()).n).toBe(2);
    bump(path.join(gitdir, 'config'));
    expect(step(next()).n).toBe(3);
    expect(step(next()).n).toBe(0);
  });

  it('shows a real change after the ttl', () => {
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x');
    const r = step(T + 5000);
    expect(r.n).toBe(2);
    expect(r.r?.untracked).toBe(1);
  });

  it('falls back to the spawning path with GIT_DIR', () => {
    const saved = { ...process.env };
    process.env.GIT_DIR = gitdir;
    try {
      const before = cacheFiles().join();
      const r = step(T + 6000, { ...env, GIT_DIR: gitdir });
      expect(r.n).toBe(4);
      expect(cacheFiles().join()).toBe(before);
      spy.mockClear();
      expect(r.r).toEqual(readGit(dir));
    } finally {
      restoreEnv(saved);
    }
  });

  it('never caches config with an include', () => {
    const cfg = path.join(gitdir, 'config');
    const orig = fs.readFileSync(cfg, 'utf8');
    fs.writeFileSync(cfg, `${orig}[include]\n\tpath = extra\n`);
    expect(step(T + 7000).n).toBe(3);
    expect(step(T + 10000).n).toBe(3);
    fs.writeFileSync(cfg, orig);
    bump(cfg);
    expect(step(T + 13000).n).toBe(3);
    expect(step(T + 16000).n).toBe(2);
  });

  it('never caches config that is larger than the include scan reads', () => {
    const cfg = path.join(gitdir, 'config');
    const orig = fs.readFileSync(cfg, 'utf8');
    fs.writeFileSync(cfg, `${orig}# ${'x'.repeat(5000)}\n[include]\n\tpath = extra\n`);
    expect(step(T + 30000).n).toBe(3);
    expect(step(T + 33000).n).toBe(3);
    fs.writeFileSync(cfg, orig);
    bump(cfg);
    expect(step(T + 36000).n).toBe(3);
    expect(step(T + 39000).n).toBe(2);
  });

  it('never caches config that cannot be read', () => {
    const cfg = path.join(gitdir, 'config');
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...a: unknown[]) => {
      if (String(p) === cfg) throw new Error('EACCES');
      return (open as (...x: unknown[]) => number)(p, ...a);
    }) as typeof fs.openSync);
    bump(cfg);
    expect(step(T + 42000).n).toBe(3);
    expect(step(T + 45000).n).toBe(3);
    vi.mocked(fs.openSync).mockRestore();
    expect(step(T + 48000).n).toBe(3);
    expect(step(T + 51000).n).toBe(2);
  });

  it('honours persist false and replaces a tampered entry', () => {
    for (const f of cacheFiles()) fs.rmSync(path.join(cacheDir, f));
    readGit(dir, { cache: { now: T + 20000, persist: false }, env });
    expect(cacheFiles()).toHaveLength(0);
    const l = discoverGit(dir, env)!;
    const bin = binary('git', whichDeps(env))!;
    const name = gitCacheName(l.root, l.gitdir, true, bin);
    writeCache(name, { v: 1, at: T + 20000, sig: [], info: {} }, env);
    const r = step(T + 20100);
    expect(r.n).toBe(3);
    expect(readGitCache(name, env)).not.toBeNull();
  });

  it('matches uncached reads for worktrees and submodules', () => {
    const w = path.join(root, 'wtree');
    git(dir, 'worktree', 'add', '-q', w, '-b', 'wt2');
    const cached = readGit(w, { cache: { now: T + 30000, persist: true }, env });
    expect(cached?.isWorktree).toBe(true);
    expect(cached).toEqual(readGit(w));
    const par = path.join(root, 'par');
    fs.mkdirSync(par);
    git(par, 'init', '-q', '-b', 'main');
    git(par, 'commit', '-q', '--allow-empty', '-m', 'i');
    try {
      git(par, 'submodule', 'add', '-q', dir, 'sub');
    } catch {
      return;
    }
    const sub = path.join(par, 'sub');
    expect(readGit(sub, { cache: { now: T + 30000, persist: true }, env })).toEqual(readGit(sub));
  });
});
