import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { binary, findBinary, pathDirs, pathValue, resetWhich, type WhichDeps } from '../../src/data/which.js';

const GIT = 'C:\\Git\\cmd\\git.exe';

function mk(files: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = 'win32', now = 1_000_000) {
  const set = new Set(files);
  const log: string[] = [];
  const state = { now };
  const deps: WhichDeps = {
    platform,
    env,
    isFile: (p) => {
      log.push(p);
      return set.has(p);
    },
    now: () => state.now,
  };
  return { deps, log, state, set };
}

const binFiles = () =>
  fs.readdirSync(process.env.CCINFOBAR_CACHE_DIR!).filter((f) => /^bin-.*\.json$/.test(f));

beforeEach(() => {
  resetWhich();
  for (const f of binFiles()) fs.rmSync(`${process.env.CCINFOBAR_CACHE_DIR}/${f}`);
});

describe('which', () => {
  it('splits a messy win32 PATH fixture', () => {
    const env = {
      PATH: 'C:\\a;.;;rel\\x;"C:\\Program Files\\Git\\cmd";%SystemRoot%\\x;\\\\srv\\share\\bin',
    };
    expect(pathDirs(env, 'win32')).toEqual(['C:\\a', 'C:\\Program Files\\Git\\cmd', '\\\\srv\\share\\bin']);
  });

  it('uses the sorted-first PATH key on win32', () => {
    expect(pathValue({ Path: 'B', PATH: 'A' }, 'win32')).toBe('A');
    expect(pathValue({ PATH: 'x' }, 'linux')).toBe('x');
  });

  it('keeps only absolute POSIX entries', () => {
    expect(pathDirs({ PATH: ':/usr/bin::.' }, 'linux')).toEqual(['/usr/bin']);
  });

  it('tries .com before .exe in PATH order', () => {
    const { deps, log } = mk(['C:\\a\\git.exe', 'C:\\a\\git.com', 'C:\\b\\git.exe'], { PATH: 'C:\\a;C:\\b' });
    expect(findBinary('git', deps)).toBe('C:\\a\\git.com');
    expect(log).toEqual(['C:\\a\\git.com']);
  });

  it('finds the exe after a missing com and never probes outside PATH', () => {
    const { deps, log } = mk(['C:\\b\\git.exe'], { PATH: 'C:\\a;C:\\b' });
    expect(findBinary('git', deps)).toBe('C:\\b\\git.exe');
    expect(log.every((p) => p.startsWith('C:\\a\\') || p.startsWith('C:\\b\\'))).toBe(true);
  });

  it('ignores cmd and bat only dirs', () => {
    const { deps } = mk(['C:\\a\\git.cmd', 'C:\\a\\git.bat'], { PATH: 'C:\\a' });
    expect(findBinary('git', deps)).toBeNull();
  });

  it('does no IO and writes no cache on non-win32', () => {
    const { deps, log } = mk([], { PATH: '/usr/bin' }, 'linux');
    expect(binary('git', deps)).toBe('git');
    expect(binary('jj', deps)).toBe('jj');
    expect(log).toEqual([]);
    expect(binFiles()).toEqual([]);
  });

  it('memoizes per process and resetWhich clears it', () => {
    const { deps, log } = mk([GIT], { PATH: 'C:\\Git\\cmd' });
    expect(binary('git', deps)).toBe(GIT);
    const n = log.length;
    expect(binary('git', deps)).toBe(GIT);
    expect(log.length).toBe(n);
    resetWhich();
    expect(binary('git', deps)).toBe(GIT);
    expect(log.length).toBeGreaterThan(n);
  });

  it('honours a valid cache hit without scanning', () => {
    const a = mk([GIT], { PATH: 'C:\\Git\\cmd' });
    binary('git', a.deps);
    resetWhich();
    a.log.length = 0;
    a.state.now += 1000;
    expect(binary('git', a.deps)).toBe(GIT);
    expect(a.log).toEqual([GIT]);
  });

  it('rescans a stale cache hit', () => {
    const a = mk([GIT], { PATH: 'C:\\Git\\cmd' });
    binary('git', a.deps);
    resetWhich();
    a.log.length = 0;
    a.state.now += 86_400_001;
    expect(binary('git', a.deps)).toBe(GIT);
    expect(a.log.length).toBe(2);
    expect(a.log[0]).toBe('C:\\Git\\cmd\\git.com');
  });

  it('rescans when the cached path is gone', () => {
    const a = mk([GIT], { PATH: 'C:\\Git\\cmd' });
    binary('git', a.deps);
    resetWhich();
    a.set.delete(GIT);
    expect(binary('git', a.deps)).toBeNull();
  });

  it('rejects a cached path with an invalid basename or relative path', () => {
    const env = { PATH: 'C:\\Git\\cmd' };
    const a = mk([GIT, 'C:\\x\\notgit.exe', 'rel\\git.exe'], env);
    binary('git', a.deps);
    const [file] = binFiles();
    for (const bad of ['C:\\x\\notgit.exe', 'rel\\git.exe']) {
      resetWhich();
      fs.writeFileSync(
        `${process.env.CCINFOBAR_CACHE_DIR}/${file}`,
        JSON.stringify({ path: bad, at: a.state.now }),
      );
      expect(binary('git', a.deps)).toBe(GIT);
    }
  });

  it('honours a negative hit for 5 minutes then rescans', () => {
    const a = mk([], { PATH: 'C:\\Git\\cmd' });
    expect(binary('git', a.deps)).toBeNull();
    a.set.add(GIT);
    resetWhich();
    a.state.now += 299_000;
    expect(binary('git', a.deps)).toBeNull();
    resetWhich();
    a.state.now += 2000;
    expect(binary('git', a.deps)).toBe(GIT);
  });
});
