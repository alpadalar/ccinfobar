import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: ((file: string, args: string[], o: never) => {
      if (args.includes('diff')) throw new Error('timeout');
      return real.execFileSync(file, args, o);
    }) as typeof real.execFileSync,
  };
});

const { readGit } = await import('../../src/data/git.js');

let dir: string;
const run = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gitnull-')));
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('git diff failure', () => {
  it('yields null counts and still reads the branch', () => {
    const g = readGit(dir)!;
    expect(g.insertions).toBeNull();
    expect(g.deletions).toBeNull();
    expect(g.branch).toBe('main');
  });
});
