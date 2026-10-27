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
      if (args.includes('config')) throw new Error('timeout');
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
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gitcfgnull-')));
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

describe('git config failure', () => {
  it('fails closed with hardening and reads without it', () => {
    expect(readGit(dir)).toBeNull();
    expect(readGit(dir, { harden: false })?.branch).toBe('main');
  });

  it('does the same through the cache and writes nothing when hardened', () => {
    const env = { ...process.env, CCINFOBAR_CACHE_DIR: cacheDir };
    const cache = { now: 1_700_000_000_000, persist: true };
    expect(readGit(dir, { cache, env })).toBeNull();
    expect(fs.readdirSync(cacheDir).filter((f) => f.startsWith('git-'))).toEqual([]);
    expect(readGit(dir, { harden: false, cache, env })?.branch).toBe('main');
  });
});
