import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findJjRoot, type JjExec, parseBookmarks, parseJjChange, readJj } from '../../src/data/jj.js';
import { resetWhich } from '../../src/data/which.js';

process.env.JJ_USER ??= 'ci';
process.env.JJ_EMAIL ??= 'ci@example.com';

const hasJj = spawnSync('jj', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
const requireJj = process.env.CCIB_REQUIRE_JJ === '1';

it.skipIf(!requireJj)('jj is installed when CCIB_REQUIRE_JJ is set', () => {
  expect(hasJj, 'jj not found on PATH but CCIB_REQUIRE_JJ=1').toBe(true);
});

let tmp: string;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-jj-')));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function repo(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(path.join(d, '.jj'), { recursive: true });
  return d;
}

function spy(outputs: Record<string, string | null>) {
  const calls: string[][] = [];
  const run = (args: string[], cwd: string) => {
    calls.push([cwd, ...args]);
    const cmd = args.find((a) => !a.startsWith('--')) ?? '';
    return cmd in outputs ? outputs[cmd]! : null;
  };
  return { calls, run };
}

describe('findJjRoot', () => {
  it('finds the nearest .jj folder walking up', () => {
    const root = repo('walk');
    const deep = path.join(root, 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    expect(findJjRoot(deep)).toBe(root);
    expect(findJjRoot(root)).toBe(root);
  });

  it('ignores a .jj file and returns null outside a repo', () => {
    const d = path.join(tmp, 'file');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '.jj'), 'x');
    expect(findJjRoot(d)).toBeNull();
  });
});

describe('parsers', () => {
  it('parses bookmarks', () => {
    expect(parseBookmarks('main feat/x\nrelease*\nmain\n')).toEqual(['main', 'feat/x', 'release*']);
    expect(parseBookmarks('\n')).toEqual([]);
  });

  it('parses the change line', () => {
    expect(parseJjChange('kkmpptxz\tFix the thing\n')).toEqual({
      id: 'kkmpptxz',
      description: 'Fix the thing',
    });
    expect(parseJjChange('kk\t\n')).toEqual({ id: 'kk', description: '' });
    expect(parseJjChange('')).toBeNull();
  });
});

describe('readJj', () => {
  it('never runs jj outside a .jj tree', () => {
    const d = path.join(tmp, 'plain');
    fs.mkdirSync(d, { recursive: true });
    const s = spy({});
    expect(readJj(d, { run: s.run })).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it('reads bookmarks, workspace and change read-only', () => {
    const root = repo('read');
    const s = spy({
      log: 'main feat/x\nrelease*\n',
      workspace: '\ndefault\n',
    });
    const r = readJj(root, { run: s.run })!;
    expect(r.root).toBe(root);
    expect(r.bookmarks()).toEqual(['main', 'feat/x', 'release*']);
    expect(r.workspace()).toBe('default');
    for (const c of s.calls) {
      expect(c[0]).toBe(root);
      expect(c).toContain('--ignore-working-copy');
      expect(c).toContain('--no-pager');
      expect(c).toContain('--color=never');
    }
  });

  it('parses the change and handles failures', () => {
    const root = repo('change');
    const ok = readJj(root, { run: spy({ log: 'kkmpptxz\tFix the thing\n' }).run })!;
    expect(ok.change()).toEqual({ id: 'kkmpptxz', description: 'Fix the thing' });
    const bad = readJj(root, { run: spy({}).run })!;
    expect(bad.change()).toBeNull();
    expect(bad.bookmarks()).toBeNull();
    expect(bad.workspace()).toBeNull();
    expect(bad.diff(true)).toBeNull();
  });

  it('returns no bookmarks for empty output', () => {
    const r = readJj(repo('empty'), { run: spy({ log: '' }).run })!;
    expect(r.bookmarks()).toEqual([]);
  });

  it('snapshots only for diff(true)', () => {
    const root = repo('diff');
    const s = spy({ diff: 'a.txt | 3 ++-\n3 files changed, 42 insertions(+), 10 deletions(-)\n' });
    const r = readJj(root, { run: s.run })!;
    expect(r.diff(true)).toEqual({ insertions: 42, deletions: 10 });
    expect(r.diff(false)).toEqual({ insertions: 42, deletions: 10 });
    expect(s.calls[0]).not.toContain('--ignore-working-copy');
    expect(s.calls[1]).toContain('--ignore-working-copy');
    expect(readJj(root, { run: spy({ diff: '' }).run })!.diff(true)).toEqual({ insertions: 0, deletions: 0 });
  });

  it('memoizes every method', () => {
    const s = spy({ log: 'main\n', workspace: 'default\n', diff: '0 files changed\n' });
    const r = readJj(repo('memo'), { run: s.run })!;
    for (let i = 0; i < 3; i++) {
      r.bookmarks();
      r.workspace();
      r.diff(true);
      r.diff(false);
    }
    expect(s.calls).toHaveLength(4);
  });

  it('strips escape sequences from output', () => {
    const r = readJj(repo('esc'), {
      run: spy({ log: '\x1b]0;pwn\x07main\x1b[31m\tdesc\x1b[2J\n', workspace: 'de\x1b[1mfault\n' }).run,
    })!;
    const all = JSON.stringify([r.bookmarks(), r.workspace(), r.change()]);
    expect(all).not.toContain('\\u001b');
    expect(r.workspace()).toBe('default');
  });
});

describe.skipIf(!hasJj && !requireJj)('readJj with jj', () => {
  const jj = (cwd: string, ...args: string[]) =>
    expect(spawnSync('jj', args, { cwd, stdio: 'ignore', windowsHide: true }).status).toBe(0);

  it('reads a fresh repo', () => {
    const d = path.join(tmp, 'real');
    fs.mkdirSync(d);
    jj(d, 'git', 'init');
    const r = readJj(d)!;
    expect(r.workspace()).toBe('default');
    expect(r.change()).not.toBeNull();
  });

  it('reads description, bookmarks, workspace and diff through every template', () => {
    const d = path.join(tmp, 'real-full');
    fs.mkdirSync(d);
    jj(d, 'git', 'init');
    jj(d, 'describe', '-m', 'msg');
    jj(d, 'bookmark', 'create', 'main', '-r', '@');
    fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\n');
    const r = readJj(d)!;
    expect(r.change()?.description).toContain('msg');
    expect(r.bookmarks()).toContain('main');
    expect(r.workspace()).toBe('default');
    expect(r.diff(false)).toEqual(expect.objectContaining({ insertions: expect.any(Number) }));
    expect(r.diff(true)!.insertions).toBeGreaterThan(0);
  });
});

describe('jj caches (injected exec)', () => {
  const T = 1_700_000_000_000;

  function fakeExec(codes: Record<string, string> = {}) {
    const calls: string[][] = [];
    const exec: JjExec = (_bin, args) => {
      calls.push(args);
      const key = args.includes('workspace')
        ? 'workspace'
        : args.includes('diff')
          ? 'diff'
          : args.includes('@')
            ? 'change'
            : 'bookmarks';
      if (key in codes) return { out: null, code: codes[key]! };
      const outs: Record<string, string> = {
        bookmarks: 'main\n',
        workspace: 'default\n',
        change: 'abcd1234\tdesc\n',
        diff: '1 file changed, 2 insertions(+), 1 deletion(-)\n',
      };
      return { out: outs[key]! };
    };
    return { calls, exec };
  }

  function setup(name: string, heads = true) {
    const root = repo(name);
    if (heads) fs.mkdirSync(path.join(root, '.jj', 'repo', 'op_heads', 'heads'), { recursive: true });
    if (heads) fs.writeFileSync(path.join(root, '.jj', 'repo', 'op_heads', 'heads', 'a'), '');
    const cache = fs.mkdtempSync(path.join(tmp, 'cache-'));
    const env: NodeJS.ProcessEnv = { ...process.env, CCINFOBAR_CACHE_DIR: cache };
    if (process.platform === 'win32') {
      // binary() resolves jj.exe on PATH there; the exec is injected, so any file works
      const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
      fs.writeFileSync(path.join(bin, 'jj.exe'), '');
      for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
      env.PATH = bin;
      resetWhich();
    }
    return { root, cache, env };
  }

  it('remembers a missing binary for five minutes', () => {
    const { root, env } = setup('enoent', false);
    const dir = fs.mkdtempSync(path.join(tmp, 'stub-'));
    const stub = path.join(dir, process.platform === 'win32' ? 'jj.exe' : 'jj');
    fs.writeFileSync(stub, '');
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
    env.PATH = dir;
    resetWhich();
    const f = fakeExec({ bookmarks: 'ENOENT' });
    // the binary vanishes between lookup and spawn
    const exec: JjExec = (b, a, d) => {
      fs.rmSync(stub, { force: true });
      return f.exec(b, a, d);
    };
    expect(readJj(root, { exec, env, now: T })?.bookmarks()).toBeNull();
    expect(f.calls.length).toBe(1);
    expect(readJj(root, { exec, env, now: T + 1000 })).toBeNull();
    expect(f.calls.length).toBe(1);
    fs.writeFileSync(stub, '');
    resetWhich();
    readJj(root, { exec, env, now: T + 300_001 })?.bookmarks();
    expect(f.calls.length).toBe(2);
  });

  it('backs off for a minute after a timeout', () => {
    const { root, env } = setup('timeout', false);
    const f = fakeExec({ bookmarks: 'ETIMEDOUT' });
    readJj(root, { exec: f.exec, env, now: T })?.bookmarks();
    expect(f.calls.length).toBe(1);
    const r = readJj(root, { exec: f.exec, env, now: T + 1000 })!;
    expect(r.bookmarks()).toBeNull();
    expect(r.workspace()).toBeNull();
    expect(r.change()).toBeNull();
    expect(r.diff(false)).toBeNull();
    expect(f.calls.length).toBe(1);
    const ok = fakeExec();
    expect(readJj(root, { exec: ok.exec, env, now: T + 60_001 })?.bookmarks()).toEqual(['main']);
    expect(ok.calls.length).toBe(1);
  });

  describe('ENOENT classification', () => {
    const win = process.platform === 'win32';
    function stubbed(name: string) {
      const s = setup(name, false);
      const dir = fs.mkdtempSync(path.join(tmp, 'stub-'));
      const stub = path.join(dir, win ? 'jj.exe' : 'jj');
      fs.writeFileSync(stub, '');
      fs.chmodSync(stub, 0o755);
      for (const k of Object.keys(s.env)) if (k.toUpperCase() === 'PATH') delete s.env[k];
      s.env.PATH = dir;
      resetWhich();
      const files = (prefix: string) => fs.readdirSync(s.cache).filter((n) => n.startsWith(prefix));
      return { ...s, stub, files };
    }

    it('a repo dir deleted before the spawn gets the per-root back-off, not jj-miss', () => {
      const a = stubbed('vanish');
      const r = readJj(a.root, { exec: () => ({ out: null, code: 'ENOENT' }), env: a.env, now: T })!;
      fs.rmSync(a.root, { recursive: true, force: true });
      expect(r.bookmarks()).toBeNull();
      expect(a.files('jj-miss-')).toEqual([]);
      expect(a.files('jj-backoff-').length).toBe(1);
      const b = setup('vanish-next', false);
      const ok = fakeExec();
      b.env.PATH = a.env.PATH;
      expect(readJj(b.root, { exec: ok.exec, env: b.env, now: T })?.bookmarks()).toEqual(['main']);
    });

    it('a missing binary with the repo dir present writes jj-miss only', () => {
      const a = stubbed('nobin');
      const r = readJj(a.root, { exec: () => ({ out: null, code: 'ENOENT' }), env: a.env, now: T })!;
      fs.rmSync(a.stub);
      expect(r.bookmarks()).toBeNull();
      expect(a.files('jj-miss-').length).toBe(1);
      expect(a.files('jj-backoff-')).toEqual([]);
    });

    it('ENOENT with dir and binary present backs off', () => {
      const a = stubbed('both');
      readJj(a.root, { exec: () => ({ out: null, code: 'ENOENT' }), env: a.env, now: T })!.bookmarks();
      expect(a.files('jj-miss-')).toEqual([]);
      expect(a.files('jj-backoff-').length).toBe(1);
    });

    it('persist false writes nothing in every case', () => {
      const a = stubbed('nopersist-enoent');
      const r = readJj(a.root, {
        exec: () => ({ out: null, code: 'ENOENT' }),
        env: a.env,
        now: T,
        persist: false,
      })!;
      fs.rmSync(a.stub);
      fs.rmSync(a.root, { recursive: true, force: true });
      r.bookmarks();
      expect(fs.readdirSync(a.cache).filter((n) => n.startsWith('jj-'))).toEqual([]);
    });
  });

  it('caches read-only results on op_heads', () => {
    const { root, env } = setup('heads');
    const f = fakeExec();
    const a = readJj(root, { exec: f.exec, env, now: T })!;
    expect(a.bookmarks()).toEqual(['main']);
    expect(a.change()?.id).toBe('abcd1234');
    expect(a.diff(false)).toEqual({ insertions: 2, deletions: 1 });
    expect(f.calls.length).toBe(3);
    const b = readJj(root, { exec: f.exec, env, now: T + 10 })!;
    expect(b.bookmarks()).toEqual(['main']);
    expect(b.change()?.id).toBe('abcd1234');
    expect(b.diff(false)).toEqual({ insertions: 2, deletions: 1 });
    expect(f.calls.length).toBe(3);
    b.diff(true);
    readJj(root, { exec: f.exec, env, now: T + 20 })!.diff(true);
    expect(f.calls.length).toBe(5);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, '.jj', 'repo', 'op_heads', 'heads'), future, future);
    readJj(root, { exec: f.exec, env, now: T + 30 })!.bookmarks();
    expect(f.calls.length).toBe(6);
  });

  it('persist false writes nothing, missing op_heads caches nothing', () => {
    const a = setup('nopersist');
    const f = fakeExec();
    readJj(a.root, { exec: f.exec, env: a.env, now: T, persist: false })!.bookmarks();
    expect(fs.readdirSync(a.cache).filter((n) => n.startsWith('jj-'))).toEqual([]);
    const b = setup('noheads', false);
    readJj(b.root, { exec: f.exec, env: b.env, now: T })!.bookmarks();
    readJj(b.root, { exec: f.exec, env: b.env, now: T })!.bookmarks();
    expect(f.calls.length).toBe(3);
    expect(fs.readdirSync(b.cache).filter((n) => n.startsWith('jj-'))).toEqual([]);
  });

  it('reads the timeout from CCINFOBAR_JJ_TIMEOUT', async () => {
    vi.resetModules();
    vi.stubEnv('CCINFOBAR_JJ_TIMEOUT', '1234');
    const m = await import('../../src/data/jj.js');
    expect(m.JJ_TIMEOUT).toBe(1234);
    vi.unstubAllEnvs();
  });
});
