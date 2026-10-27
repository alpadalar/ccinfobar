import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: ((file: string, args: string[], o: never) => {
      calls.push(args);
      if (args.includes('--show-stash')) throw new Error('unknown option');
      return real.execFileSync(file, args, o);
    }) as typeof real.execFileSync,
  };
});

const { readGit } = await import('../../src/data/git.js');

let dir: string;
let cacheDir: string;
const run = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir,
    stdio: 'ignore',
    windowsHide: true,
  });

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gitstashnull-')));
  cacheDir = path.join(dir, '..', `${path.basename(dir)}-cache`);
  fs.mkdirSync(cacheDir);
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('stash null through the cache', () => {
  it('keeps stash null on the miss and on the zero-spawn hit', () => {
    const env = { ...process.env, CCINFOBAR_CACHE_DIR: cacheDir };
    const miss = readGit(dir, { cache: { now: 1_700_000_000_000, persist: true }, env });
    expect(miss?.stash).toBeNull();
    calls.length = 0;
    const hit = readGit(dir, { cache: { now: 1_700_000_000_100, persist: true }, env });
    expect(hit?.stash).toBeNull();
    expect(calls).toEqual([]);
  });
});
