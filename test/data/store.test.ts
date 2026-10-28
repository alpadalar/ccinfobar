import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savePayload } from '../../src/cli/render.js';
import { lastPayloadPath } from '../../src/core/paths.js';
import { cacheFile, writeCache } from '../../src/data/cache.js';
import {
  acquireLock,
  appendLine,
  pruneTmp,
  readJsonSafe,
  renameWithRetry,
  writeAtomic,
} from '../../src/data/store.js';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-store-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const errno = (code: string) => Object.assign(new Error(code), { code });
const tmpFiles = (d: string) => fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));

describe('writeAtomic', () => {
  it.skipIf(process.platform === 'win32')('writes through a symlink and keeps it', () => {
    const real = path.join(dir, 'dotfiles', 'config.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, 'old');
    const link = path.join(dir, 'config.json');
    fs.symlinkSync(real, link);
    expect(writeAtomic(link, 'new', { class: 'settings' })).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('new');
    const dangling = path.join(dir, 'dangling.json');
    fs.symlinkSync(path.join(dir, 'dotfiles', 'later.json'), dangling);
    expect(writeAtomic(dangling, 'x')).toBe(true);
    expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'dotfiles', 'later.json'), 'utf8')).toBe('x');
  });

  it.skipIf(process.platform === 'win32')('keeps session data private (0600)', () => {
    const env = { CCINFOBAR_CACHE_DIR: dir };
    writeCache('x.json', { a: 1 }, env);
    expect(fs.statSync(cacheFile('x.json', env)).mode & 0o777).toBe(0o600);
    savePayload({ session_id: 's' });
    expect(fs.statSync(lastPayloadPath()).mode & 0o777).toBe(0o600);
  });

  it('replaces the file and leaves no tmp files', () => {
    const file = path.join(dir, 'a.json');
    expect(writeAtomic(file, 'a')).toBe(true);
    expect(writeAtomic(file, 'b')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('b');
    expect(tmpFiles(dir)).toEqual([]);
  });

  it('creates missing parent dirs', () => {
    const file = path.join(dir, 'x', 'y', 'z.json');
    expect(writeAtomic(file, '{}')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{}');
  });

  it('writes binary data', () => {
    const file = path.join(dir, 'b.bin');
    writeAtomic(file, new Uint8Array([1, 2, 3]));
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3]);
  });

  it.skipIf(process.platform === 'win32')('applies opts.mode and keeps an existing mode', () => {
    const file = path.join(dir, 'm.json');
    writeAtomic(file, 'x', { mode: 0o600 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    writeAtomic(file, 'y');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o640);
    writeAtomic(file, 'z', { class: 'settings' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it('cache class returns false on an unwritable target; settings class throws', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    const file = path.join(blocker, 'c.json');
    expect(writeAtomic(file, 'x')).toBe(false);
    expect(() => writeAtomic(file, 'x', { class: 'settings' })).toThrow();
  });

  it('removes the tmp file when the rename fails', () => {
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), '');
    expect(writeAtomic(target, 'x')).toBe(false);
    expect(() => writeAtomic(target, 'x', { class: 'settings' })).toThrow();
    expect(tmpFiles(dir)).toEqual([]);
  });
});

describe('renameWithRetry', () => {
  it('retries EPERM on win32 until the rename succeeds', () => {
    let calls = 0;
    const waits: number[] = [];
    renameWithRetry('a', 'b', 2000, {
      platform: 'win32',
      sleep: (ms) => waits.push(ms),
      rename: () => {
        calls++;
        if (calls <= 2) throw errno('EPERM');
      },
    });
    expect(calls).toBe(3);
    expect(waits).toEqual([10, 20]);
  });

  it('throws once the budget is spent', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const waits: number[] = [];
    expect(() =>
      renameWithRetry('a', 'b', 50, {
        platform: 'win32',
        sleep: (ms) => {
          waits.push(ms);
          vi.advanceTimersByTime(ms);
        },
        rename: () => {
          throw errno('EPERM');
        },
      }),
    ).toThrow('EPERM');
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(50);
    expect(Math.max(...waits)).toBeLessThanOrEqual(100);
  });

  it('caps each wait at 100 ms', () => {
    const waits: number[] = [];
    let calls = 0;
    renameWithRetry('a', 'b', 10_000, {
      platform: 'win32',
      sleep: (ms) => waits.push(ms),
      rename: () => {
        if (++calls < 15) throw errno('EBUSY');
      },
    });
    expect(Math.max(...waits)).toBe(100);
  });

  it('does not retry EPERM off win32 but retries EBUSY', () => {
    let calls = 0;
    expect(() =>
      renameWithRetry('a', 'b', 2000, {
        platform: 'linux',
        sleep: () => {},
        rename: () => {
          calls++;
          throw errno('EPERM');
        },
      }),
    ).toThrow('EPERM');
    expect(calls).toBe(1);

    calls = 0;
    renameWithRetry('a', 'b', 2000, {
      platform: 'linux',
      sleep: () => {},
      rename: () => {
        if (++calls < 3) throw errno('EBUSY');
      },
    });
    expect(calls).toBe(3);
  });

  it('does not retry other codes', () => {
    let calls = 0;
    expect(() =>
      renameWithRetry('a', 'b', 2000, {
        platform: 'win32',
        sleep: () => {},
        rename: () => {
          calls++;
          throw errno('ENOENT');
        },
      }),
    ).toThrow('ENOENT');
    expect(calls).toBe(1);
  });
});

describe('readJsonSafe', () => {
  it('returns null for missing, malformed or rejected data', () => {
    const file = path.join(dir, 'r.json');
    expect(readJsonSafe(file)).toBeNull();
    fs.writeFileSync(file, '{oops');
    expect(readJsonSafe(file)).toBeNull();
    fs.writeFileSync(file, '[1]');
    const isObj = (v: unknown): v is { a: number } =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    expect(readJsonSafe(file, isObj)).toBeNull();
    fs.writeFileSync(file, '{"a":1}');
    expect(readJsonSafe(file, isObj)).toEqual({ a: 1 });
    expect(readJsonSafe(file)).toEqual({ a: 1 });
  });
});

describe('pruneTmp', () => {
  it('removes old tmp files only', () => {
    const old = path.join(dir, 'x.json.123.abcd1234.tmp');
    const legacy = path.join(dir, 'y.json.456.tmp');
    const fresh = path.join(dir, 'x.json.124.deadbeef.tmp');
    const normal = path.join(dir, 'x.json');
    for (const f of [old, legacy, fresh, normal]) fs.writeFileSync(f, '');
    const past = new Date(Date.now() - 2 * 3_600_000);
    for (const f of [old, legacy, normal]) fs.utimesSync(f, past, past);
    expect(pruneTmp(dir, 3_600_000)).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(normal)).toBe(true);
  });

  it('removes old stale lock graves only', () => {
    const old = path.join(dir, 'job.lock.4242.0badf00d.stale');
    const fresh = path.join(dir, 'job.lock.4243.deadbeef.stale');
    const lock = path.join(dir, 'job.lock');
    for (const f of [old, fresh, lock]) fs.writeFileSync(f, '');
    const past = new Date(Date.now() - 2 * 3_600_000);
    for (const f of [old, lock]) fs.utimesSync(f, past, past);
    expect(pruneTmp(dir, 3_600_000)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('returns 0 for a missing dir', () => {
    expect(pruneTmp(path.join(dir, 'nope'), 1000)).toBe(0);
  });
});

describe('acquireLock', () => {
  it('locks once, refuses while fresh and takes over a stale lock', () => {
    const lock = path.join(dir, 'locks', 'x.lock');
    expect(acquireLock(lock, 60_000)).toBe(true);
    expect(acquireLock(lock, 60_000)).toBe(false);
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, past, past);
    expect(acquireLock(lock, 60_000)).toBe(true);
    expect(acquireLock(lock, 60_000)).toBe(false);
  });

  const stale = (lock: string) => {
    expect(acquireLock(lock, 60_000)).toBe(true);
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, past, past);
  };
  const leftovers = (d: string) =>
    fs.readdirSync(d).filter((n) => n.endsWith('.stale') || n.endsWith('.takeover'));

  it('never grants a stale lock to two contenders', () => {
    const lock = path.join(dir, 'locks', 'race.lock');
    stale(lock);
    const rename = fs.renameSync;
    let rival: boolean | null = null;
    let entered = false;
    // the rival contender runs while the first is mid-takeover
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === lock && !entered) {
        entered = true;
        rival = acquireLock(lock, 60_000);
      }
      return rename(from, to);
    }) as typeof fs.renameSync);
    const first = acquireLock(lock, 60_000);
    spy.mockRestore();
    expect([first, rival].filter(Boolean)).toHaveLength(1);
    expect(leftovers(path.dirname(lock))).toEqual([]);
    expect(acquireLock(lock, 60_000)).toBe(false);
  });

  it('wins exactly once when both contenders pass the staleness check', () => {
    const lock = path.join(dir, 'locks', 'both.lock');
    stale(lock);
    const rename = fs.renameSync;
    let rival: boolean | null = null;
    let entered = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === lock && !entered) {
        entered = true;
        fs.unlinkSync(`${lock}.takeover`);
        rival = acquireLock(lock, 60_000);
      }
      return rename(from, to);
    }) as typeof fs.renameSync);
    const first = acquireLock(lock, 60_000);
    spy.mockRestore();
    expect([first, rival].filter(Boolean)).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(lock)).filter((n) => n.endsWith('.stale'))).toEqual([]);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('restores a fresh lock that appears between the check and the rename', () => {
    const lock = path.join(dir, 'locks', 'fresh.lock');
    stale(lock);
    const rename = fs.renameSync;
    let entered = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === lock && !entered) {
        entered = true;
        fs.unlinkSync(lock);
        fs.closeSync(fs.openSync(lock, 'wx'));
      }
      return rename(from, to);
    }) as typeof fs.renameSync);
    const got = acquireLock(lock, 60_000);
    spy.mockRestore();
    expect(got).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(Date.now() - fs.statSync(lock).mtimeMs).toBeLessThan(60_000);
    expect(leftovers(path.dirname(lock))).toEqual([]);
  });

  it('restores by rename when hard links are unavailable', () => {
    const lock = path.join(dir, 'locks', 'nolink.lock');
    stale(lock);
    const rename = fs.renameSync;
    let entered = false;
    const rn = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === lock && !entered) {
        entered = true;
        fs.unlinkSync(lock);
        fs.closeSync(fs.openSync(lock, 'wx'));
      }
      return rename(from, to);
    }) as typeof fs.renameSync);
    const ln = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw errno('EPERM');
    });
    const got = acquireLock(lock, 60_000);
    ln.mockRestore();
    rn.mockRestore();
    expect(got).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(leftovers(path.dirname(lock))).toEqual([]);
  });

  it('replaces a plain stale lock with a fresh one and leaves no grave', () => {
    const lock = path.join(dir, 'locks', 'plain.lock');
    stale(lock);
    expect(acquireLock(lock, 60_000)).toBe(true);
    expect(Date.now() - fs.statSync(lock).mtimeMs).toBeLessThan(60_000);
    expect(fs.readdirSync(path.dirname(lock))).toEqual(['plain.lock']);
  });

  it('backs off from a fresh takeover guard and clears a crashed one', () => {
    const lock = path.join(dir, 'locks', 'guard.lock');
    expect(acquireLock(lock, 60_000)).toBe(true);
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, past, past);
    fs.writeFileSync(`${lock}.takeover`, '');
    expect(acquireLock(lock, 60_000)).toBe(false);
    fs.utimesSync(`${lock}.takeover`, past, past);
    const moved: string[] = [];
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      moved.push(String(from));
      return rename(from, to);
    }) as typeof fs.renameSync);
    expect(acquireLock(lock, 60_000)).toBe(false);
    spy.mockRestore();
    expect(moved).toEqual([`${lock}.takeover`]);
    expect(fs.existsSync(`${lock}.takeover`)).toBe(false);
    expect(leftovers(path.dirname(lock))).toEqual([]);
    expect(acquireLock(lock, 60_000)).toBe(true);
  });

  it('returns false when the lock cannot be created', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    expect(acquireLock(path.join(blocker, 'x.lock'), 1000)).toBe(false);
  });
});

describe('appendLine', () => {
  it('creates the dir and appends newline-terminated lines', () => {
    const file = path.join(dir, 'ledger', '2026-10.jsonl');
    expect(appendLine(file, '{"a":1}')).toBe(true);
    expect(appendLine(file, '{"a":2}\n')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
  });

  it('returns false on error', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    expect(appendLine(path.join(blocker, 'x.jsonl'), 'x')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates the file private (0600)', () => {
    const file = path.join(dir, 'a.jsonl');
    appendLine(file, 'x');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('creates missing dirs private (0700)', () => {
    const file = path.join(dir, 'cache', 'hooks', 's.jsonl');
    expect(appendLine(file, 'x')).toBe(true);
    for (const d of [path.join(dir, 'cache'), path.join(dir, 'cache', 'hooks')])
      expect(fs.statSync(d).mode & 0o777).toBe(0o700);
  });
});
