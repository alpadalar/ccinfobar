import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findJjRoot, parseBookmarks, parseJjChange, readJj } from '../../src/data/jj.js';

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
