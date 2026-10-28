import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { cacheKey } from '../../src/data/cache.js';
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

  it('normalises forward slashes in drive entries and still drops relative ones', () => {
    const env = { PATH: 'C:/Program Files/Git/cmd;rel/x;/rooted;C:\\a' };
    expect(pathDirs(env, 'win32')).toEqual(['C:\\Program Files\\Git\\cmd', 'C:\\a']);
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

describe('which cache by name', () => {
  const cdir = () => process.env.CCINFOBAR_CACHE_DIR!;
  const read = (f: string) => JSON.parse(fs.readFileSync(`${cdir()}/${f}`, 'utf8'));

  it('keeps one file per binary across PATH variants', () => {
    for (const p of ['C:\\Git\\cmd', 'C:\\Git\\cmd;C:\\x', 'C:\\y;C:\\Git\\cmd']) {
      resetWhich();
      binary('git', mk([GIT], { Path: p }).deps);
    }
    binary('jj', mk([], { Path: 'C:\\Git\\cmd' }).deps);
    expect(binFiles().sort()).toEqual(['bin-git.json', 'bin-jj.json']);
    const c = read('bin-git.json');
    expect(c.pv).toMatch(/^[0-9a-f]{20}$/);
    expect(c.pv).toBe(cacheKey('C:\\y;C:\\Git\\cmd'));
    expect(c.path).toBe(GIT);
    expect(typeof c.at).toBe('number');
  });

  it('treats a foreign, missing or non-string pv as a miss and overwrites', () => {
    const env = { PATH: 'C:\\Git\\cmd' };
    for (const pv of ['f'.repeat(20), undefined, 7]) {
      const a = mk([GIT], env);
      resetWhich();
      fs.writeFileSync(`${cdir()}/bin-git.json`, JSON.stringify({ pv, path: GIT, at: a.state.now }));
      expect(binary('git', a.deps)).toBe(GIT);
      expect(a.log.length).toBeGreaterThan(1);
      expect(read('bin-git.json').pv).toBe(cacheKey(env.PATH));
    }
  });

  it('re-probes when PATH changes and leaves legacy files alone', () => {
    const legacy = `${cdir()}/bin-${'a'.repeat(20)}.json`;
    fs.writeFileSync(legacy, '{}');
    const a = mk([GIT], { PATH: 'C:\\Git\\cmd' });
    binary('git', a.deps);
    resetWhich();
    a.log.length = 0;
    binary('git', a.deps);
    expect(a.log).toEqual([GIT]);
    const b = mk([GIT], { PATH: 'C:\\Git\\cmd;C:\\z' });
    resetWhich();
    binary('git', b.deps);
    expect(b.log.length).toBeGreaterThan(1);
    expect(read('bin-git.json').pv).toBe(cacheKey('C:\\Git\\cmd;C:\\z'));
    expect(fs.existsSync(legacy)).toBe(true);
    fs.rmSync(legacy);
  });
});
