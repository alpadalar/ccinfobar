import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, pruneTmp, readJsonSafe, renameWithRetry, writeAtomic } from '../../src/data/store.js';

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const errno = (code: string) => Object.assign(new Error(code), { code });
const tmpFiles = (d: string) => fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));

describe('writeAtomic', () => {
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
    const start = Date.now();
    expect(() =>
      renameWithRetry('a', 'b', 50, {
        platform: 'win32',
        rename: () => {
          throw errno('EPERM');
        },
      }),
    ).toThrow('EPERM');
    expect(Date.now() - start).toBeLessThan(200);
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

  it('returns false when the lock cannot be created', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, '');
    expect(acquireLock(path.join(blocker, 'x.lock'), 1000)).toBe(false);
  });
});
