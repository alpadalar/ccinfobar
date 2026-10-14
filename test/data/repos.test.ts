import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config, WidgetItem } from '../../src/core/types.js';
import {
  ancestors,
  dirtyFile,
  gitdirOf,
  insideRepo,
  parseHead,
  readDirty,
  readHead,
  readRepos,
  repoDirtyWanted,
  reposCacheName,
  scanRepos,
  scheduleRepoDirty,
  type WorkspaceRepos,
} from '../../src/data/repos.js';

const posix = process.platform !== 'win32';
const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git'));
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-repos-')));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function repo(root: string, name: string, head = 'ref: refs/heads/main\n'): string {
  const gd = path.join(root, name, '.git');
  fs.mkdirSync(gd, { recursive: true });
  fs.writeFileSync(path.join(gd, 'HEAD'), head);
  return path.join(root, name);
}

const cacheFiles = () =>
  fs.existsSync(env.CCINFOBAR_CACHE_DIR!)
    ? fs.readdirSync(env.CCINFOBAR_CACHE_DIR!).filter((f) => f.startsWith('repos-'))
    : [];

const SHA1 = 'abc1234def5678901234567890abcdef12345678';

describe('parseHead', () => {
  it('reads a branch and trims CRLF', () => {
    expect(parseHead('ref: refs/heads/feat/x\r\n')).toEqual({ branch: 'feat/x', detached: false });
  });

  it('shows 7 chars for SHA-1 and SHA-256 detached heads', () => {
    expect(parseHead(`${SHA1}\n`)).toEqual({ branch: 'abc1234', detached: true });
    expect(parseHead(`${'f'.repeat(64)}\n`)).toEqual({ branch: 'fffffff', detached: true });
  });

  it('gives no branch for the reftable stub and garbage', () => {
    expect(parseHead('ref: refs/heads/.invalid\n').branch).toBeNull();
    expect(parseHead('hello world').branch).toBeNull();
    expect(parseHead(`${SHA1}0`).branch).toBeNull();
  });

  it('strips escapes from branch names', () => {
    expect(parseHead('ref: refs/heads/x\u001b[31my\n').branch).toBe('xy');
  });
});

describe('gitdir paths', () => {
  it('resolves win32 forward-slash and backslash gitdirs', () => {
    expect(gitdirOf('gitdir: C:/repos/main/.git/worktrees/wt\n', 'C:\\ws\\wt', path.win32)).toBe(
      'C:\\repos\\main\\.git\\worktrees\\wt',
    );
    expect(gitdirOf('gitdir: ..\\.git\\modules\\sub\r\n', 'C:\\ws\\sub', path.win32)).toBe(
      'C:\\ws\\.git\\modules\\sub',
    );
  });

  it('stops the ancestor walk at drive and UNC roots', () => {
    expect(ancestors('C:\\a\\b', path.win32)).toEqual(['C:\\a\\b', 'C:\\a', 'C:\\']);
    expect(ancestors('\\\\server\\share\\x', path.win32)).toEqual([
      '\\\\server\\share\\x',
      '\\\\server\\share\\',
    ]);
    expect(ancestors('/a/b', path.posix)).toEqual(['/a/b', '/a', '/']);
  });
});

describe.skipIf(tmpRepo)('readHead and insideRepo', () => {
  it('follows an absolute worktree gitdir', () => {
    const main = repo(dir, 'main');
    const wtGit = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/feature\n');
    const wt = path.join(dir, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    expect(readHead(wt)).toEqual({ branch: 'feature', detached: false, gitdir: wtGit });
  });

  it('follows a relative submodule gitdir', () => {
    const mod = path.join(dir, '.git', 'modules', 'sub');
    fs.mkdirSync(mod, { recursive: true });
    fs.writeFileSync(path.join(mod, 'HEAD'), `${SHA1}\n`);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(readHead(sub)).toEqual({ branch: 'abc1234', detached: true, gitdir: mod });
  });

  it('ignores a HEAD over 4096 bytes', () => {
    const r = repo(dir, 'big', `ref: refs/heads/main\n${'x'.repeat(5000)}`);
    expect(readHead(r)).toMatchObject({ branch: null, gitdir: path.join(r, '.git') });
  });

  it.skipIf(!posix)('does not hang on a FIFO HEAD', () => {
    const gd = path.join(dir, 'fifo', '.git');
    fs.mkdirSync(gd, { recursive: true });
    try {
      cp.execFileSync('mkfifo', [path.join(gd, 'HEAD')], { stdio: 'ignore' });
    } catch {
      return;
    }
    expect(readHead(path.join(dir, 'fifo'))).toMatchObject({ branch: null, gitdir: gd });
  });

  it('finds the nearest ancestor holding .git', () => {
    const inner = path.join(dir, 'w', 'a', 'b');
    fs.mkdirSync(inner, { recursive: true });
    expect(insideRepo(inner)).toBeNull();
    fs.writeFileSync(path.join(dir, 'w', '.git'), 'gitdir: /nowhere\n');
    expect(insideRepo(inner)).toBe(path.join(dir, 'w'));
  });

  it('ignores GIT_DIR and GIT_WORK_TREE', () => {
    const w = path.join(dir, 'w');
    repo(w, 'api');
    const prev = [process.env.GIT_DIR, process.env.GIT_WORK_TREE];
    process.env.GIT_DIR = path.join(w, 'api', '.git');
    process.env.GIT_WORK_TREE = path.join(w, 'api');
    try {
      expect(readRepos(w, env)?.repos.map((r) => r.name)).toEqual(['api']);
    } finally {
      if (prev[0] === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev[0];
      if (prev[1] === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = prev[1];
    }
  });
});

describe.skipIf(tmpRepo)('scanRepos', () => {
  it('skips node_modules and plain folders, marks hidden repos', () => {
    const w = path.join(dir, 'w');
    repo(w, 'web', 'ref: refs/heads/dev\n');
    repo(w, '.dot');
    repo(w, 'node_modules');
    fs.mkdirSync(path.join(w, 'notes'));
    fs.writeFileSync(path.join(w, 'file.txt'), 'x');
    const s = scanRepos(w);
    expect(s.repos.map((r) => [r.name, r.branch, r.hidden])).toEqual([
      ['.dot', 'main', true],
      ['web', 'dev', false],
    ]);
    expect(s.total).toBe(2);
    expect(s.repos[1]!.activity).toEqual(expect.any(Number));
  });

  it.skipIf(!posix)('follows a symlinked repo folder once', () => {
    const w = path.join(dir, 'w');
    const target = repo(dir, 'elsewhere');
    fs.mkdirSync(w);
    fs.symlinkSync(target, path.join(w, 'linked'));
    fs.symlinkSync(path.join(dir, 'missing'), path.join(w, 'dangling'));
    expect(scanRepos(w).repos.map((r) => r.name)).toEqual(['linked']);
  });

  it('reads at most 1,000 entries', () => {
    const w = path.join(dir, 'w');
    for (let i = 0; i < 1005; i++) repo(w, `r${String(i).padStart(4, '0')}`);
    const s = scanRepos(w);
    expect(s.total).toBe(1000);
  });

  it('returns nothing for an unreadable folder', () => {
    expect(scanRepos(path.join(dir, 'missing'))).toEqual({ repos: [], total: 0 });
  });
});

describe.skipIf(tmpRepo)('readRepos cache', () => {
  const T = 1_800_000_000_000;
  const setup = () => {
    const w = path.join(dir, 'w');
    repo(w, 'api');
    fs.utimesSync(w, 1_700_000_000, 1_700_000_000);
    return w;
  };
  const addRepo = (w: string, name: string, keepMtime: boolean) => {
    repo(w, name);
    if (keepMtime) fs.utimesSync(w, 1_700_000_000, 1_700_000_000);
  };
  const names = (w: string, now: number) => readRepos(w, env, { now })?.repos.map((r) => r.name);

  it('is null inside a repo and empty for a missing folder', () => {
    const w = path.join(dir, 'w');
    fs.mkdirSync(path.join(w, '.git'), { recursive: true });
    fs.mkdirSync(path.join(w, 'sub'));
    expect(readRepos(path.join(w, 'sub'), env)).toBeNull();
    expect(readRepos(path.join(dir, 'missing'), env)).toEqual({
      root: path.join(dir, 'missing'),
      repos: [],
      total: 0,
    });
  });

  it('serves the cache within 10 s while the folder mtime is unchanged', () => {
    const w = setup();
    expect(names(w, T)).toEqual(['api']);
    expect(cacheFiles()).toEqual([reposCacheName(w)]);
    addRepo(w, 'web', true);
    expect(names(w, T + 9_000)).toEqual(['api']);
  });

  it('rescans when the folder mtime changes', () => {
    const w = setup();
    names(w, T);
    addRepo(w, 'web', false);
    expect(names(w, T + 1_000)).toEqual(['api', 'web']);
  });

  it('rescans after 10 s', () => {
    const w = setup();
    names(w, T);
    addRepo(w, 'web', true);
    expect(names(w, T + 10_000)).toEqual(['api', 'web']);
  });

  it('never writes with persist false', () => {
    const w = setup();
    expect(readRepos(w, env, { persist: false, now: T })?.total).toBe(1);
    expect(cacheFiles()).toEqual([]);
  });

  it('ignores a tampered cache', () => {
    const w = setup();
    names(w, T);
    const file = path.join(env.CCINFOBAR_CACHE_DIR!, reposCacheName(w));
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, repos: 'nope' }));
    expect(names(w, T + 1_000)).toEqual(['api']);
    fs.writeFileSync(file, JSON.stringify({ ...raw, repos: [{ name: 'evil\u001b[2J', branch: null }] }));
    expect(names(w, T + 1_000)).toEqual(['api']);
  });

  it('sanitizes names read from the cache', () => {
    const w = setup();
    names(w, T);
    const file = path.join(env.CCINFOBAR_CACHE_DIR!, reposCacheName(w));
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.repos[0].name = 'ev\u001b[2Jil';
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(names(w, T + 1_000)).toEqual(['evil']);
  });
});

describe('dirty cache', () => {
  const T = Date.now();
  const ws = (total = 1): WorkspaceRepos => ({
    root: '/ws',
    repos: total ? [{ name: 'api', branch: 'main', detached: false, activity: null, hidden: false }] : [],
    total,
  });
  const write = (cwd: string, v: unknown) => {
    fs.mkdirSync(env.CCINFOBAR_CACHE_DIR!, { recursive: true });
    fs.writeFileSync(dirtyFile(cwd, env), JSON.stringify(v));
  };
  const lock = (cwd: string) => fs.existsSync(`${dirtyFile(cwd, env)}.lock`);

  it('keeps only boolean entries and skips prototype keys', () => {
    write('/ws', JSON.parse('{"v":1,"at":1,"dirty":{"__proto__":true,"api":true,"web":"yes"}}'));
    const d = readDirty('/ws', env);
    expect(d?.at).toBe(1);
    expect(Object.getPrototypeOf(d?.dirty)).toBeNull();
    expect({ ...d?.dirty }).toEqual({ api: true });
    expect(({} as Record<string, unknown>).api).toBeUndefined();
  });

  it('is null for a missing or malformed file', () => {
    expect(readDirty('/ws', env)).toBeNull();
    write('/ws', { v: 1, at: 'x', dirty: {} });
    expect(readDirty('/ws', env)).toBeNull();
    write('/ws', { v: 1, at: 1, dirty: [] });
    expect(readDirty('/ws', env)).toBeNull();
  });

  it('repoDirtyWanted needs a workspace-repos item with dirty on', () => {
    const cfg = (options: WidgetItem['options']) =>
      ({ ...defaultConfig(), lines: [[{ id: 'r', type: 'workspace-repos', options }]] }) as Config;
    expect(repoDirtyWanted(cfg({ dirty: true }))).toBe(true);
    expect(repoDirtyWanted(cfg({}))).toBe(false);
    expect(
      repoDirtyWanted({
        ...cfg({ dirty: true }),
        lines: [[{ id: 'd', type: 'git-branch', options: { dirty: true } }]],
      }),
    ).toBe(false);
  });

  it('skips scheduling while the cache is fresh', () => {
    write('/ws', { v: 1, at: T - 1_000, dirty: {} });
    scheduleRepoDirty('/ws', ws(), env, T);
    expect(lock('/ws')).toBe(false);
  });

  it('takes the lock once when the cache is missing or stale', () => {
    scheduleRepoDirty('/ws', ws(), env, T);
    expect(lock('/ws')).toBe(true);
    const at = fs.statSync(`${dirtyFile('/ws', env)}.lock`).mtimeMs;
    scheduleRepoDirty('/ws', ws(), env, T + 1_000);
    expect(fs.statSync(`${dirtyFile('/ws', env)}.lock`).mtimeMs).toBe(at);
    fs.rmSync(`${dirtyFile('/ws', env)}.lock`);
    write('/ws', { v: 1, at: T - 61_000, dirty: {} });
    scheduleRepoDirty('/ws', ws(), env, T);
    expect(lock('/ws')).toBe(true);
  });

  it('does nothing without repos', () => {
    scheduleRepoDirty('/ws', null, env, T);
    scheduleRepoDirty('/ws', ws(0), env, T);
    expect(lock('/ws')).toBe(false);
  });
});

describe.skipIf(tmpRepo)('readRepos dirty merge', () => {
  it('adds the dirty map from the cache', () => {
    const w = path.join(dir, 'w');
    repo(w, 'api');
    fs.mkdirSync(env.CCINFOBAR_CACHE_DIR!, { recursive: true });
    fs.writeFileSync(dirtyFile(w, env), JSON.stringify({ v: 1, at: 1, dirty: { api: true } }));
    expect(readRepos(w, env)?.dirty?.api).toBe(true);
    expect(readRepos(w, env)?.dirty?.api).toBe(true);
  });
});
