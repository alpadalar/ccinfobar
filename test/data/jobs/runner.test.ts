import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/types.js';
import { retryAfterMs } from '../../../src/data/jobs/fetch.js';
import {
  backoffMs,
  blockedByTraffic,
  defaultDue,
  envelopeFile,
  executeJob,
  failEnvelope,
  formatArg,
  type Job,
  type JobCtx,
  type JobEnvelope,
  jobsDir,
  jobsDisabled,
  jobValue,
  lockFile,
  okEnvelope,
  parseArg,
  readEnvelope,
  scheduleRequests,
  writeEnvelope,
} from '../../../src/data/jobs/runner.js';
import * as state from '../../../src/data/update-state.js';

const tmpEnv = (): NodeJS.ProcessEnv => ({
  CCINFOBAR_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-jobs-')),
});

const NOW = 1_800_000_000_000;

describe('backoff', () => {
  it('doubles per attempt and caps at 30 min', () => {
    expect(backoffMs(60_000, 1)).toBe(60_000);
    expect(backoffMs(60_000, 3)).toBe(240_000);
    expect(backoffMs(60_000, 20)).toBe(1_800_000);
    expect(backoffMs(60_000, 5, 120_000)).toBe(120_000);
  });

  it('reads Retry-After as seconds or an HTTP date', () => {
    expect(retryAfterMs('120', NOW)).toBe(120_000);
    expect(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    for (const bad of ['0', '', 'garbage', new Date(NOW - 5_000).toUTCString(), null]) {
      expect(retryAfterMs(bad, NOW)).toBeNull();
    }
    expect(retryAfterMs('999999', NOW)).toBe(86_400_000);
  });
});

describe('envelopes', () => {
  it('keeps the last good value across failures and backs off', () => {
    const ok = okEnvelope('status', { a: 1 }, NOW);
    expect(ok).toMatchObject({ v: 1, ok: true, value: { a: 1 }, lastGood: { a: 1 }, attempts: 0 });
    const f1 = failEnvelope('status', ok, 'network', NOW + 1000, { retryMs: 60_000 });
    expect(f1).toMatchObject({ ok: false, value: null, lastGood: { a: 1 }, lastGoodAt: NOW, attempts: 1 });
    expect(f1.blockedUntil).toBe(NOW + 1000 + 60_000);
    const f2 = failEnvelope('status', f1, 'network', NOW + 2000, { retryMs: 60_000 });
    expect(f2).toMatchObject({ attempts: 2, lastGood: { a: 1 }, lastGoodAt: NOW });
    expect(f2.blockedUntil).toBe(NOW + 2000 + 120_000);
  });

  it('prefers Retry-After and an explicit block, and has no block without opts', () => {
    const after = failEnvelope('status', null, 'http-429', NOW, { retryMs: 60_000, retryAfterMs: 300_000 });
    expect(after.blockedUntil).toBe(NOW + 300_000);
    const short = failEnvelope('status', null, 'http-503', NOW, { retryMs: 60_000, retryAfterMs: 1000 });
    expect(short.blockedUntil).toBe(NOW + 60_000);
    const third = failEnvelope('status', { ...short, attempts: 2 }, 'http-503', NOW, {
      retryMs: 60_000,
      retryAfterMs: 1000,
    });
    expect(third.blockedUntil).toBe(NOW + 240_000);
    expect(defaultDue(short, NOW + 2000, 180_000)).toBe(false);
    const garbage = failEnvelope('status', null, 'http-429', NOW, { retryMs: 60_000, retryAfterMs: null });
    expect(garbage.blockedUntil).toBe(NOW + 60_000);
    const block = failEnvelope('usage-0123456789abcdef', null, 'no token', NOW, { blockMs: 600_000 });
    expect(block.blockedUntil).toBe(NOW + 600_000);
    const plain = failEnvelope('update', null, 'offline', NOW);
    expect(plain.blockedUntil).toBeUndefined();
    expect(plain.lastGood).toBeNull();
  });

  it('sanitizes and truncates the error', () => {
    const e = failEnvelope('status', null, `bad\u001b[31m${'x'.repeat(400)}`, NOW);
    expect(e.error).not.toContain('\u001b');
    expect(e.error!.length).toBeLessThanOrEqual(200);
  });

  it('jobValue reports fresh or stale values', () => {
    expect(jobValue(null)).toBeNull();
    const ok = okEnvelope('status', 'up', NOW);
    expect(jobValue(ok)).toEqual({ value: 'up', at: NOW, stale: false, error: null });
    const failed = failEnvelope('status', ok, 'timeout', NOW + 5, { retryMs: 1000 });
    expect(jobValue(failed)).toEqual({ value: 'up', at: NOW, stale: true, error: 'timeout' });
    expect(jobValue(failEnvelope('status', null, 'timeout', NOW))).toEqual({
      value: null,
      at: null,
      stale: true,
      error: 'timeout',
    });
  });

  it('round-trips through the jobs dir', () => {
    const env = tmpEnv();
    const e = okEnvelope('gh-0123456789abcdef', { checks: 3 }, NOW, 'github.com/o/r#1');
    writeEnvelope(e, env);
    expect(fs.existsSync(envelopeFile('gh-0123456789abcdef', env))).toBe(true);
    expect(readEnvelope('gh-0123456789abcdef', env)).toEqual(e);
  });

  it('sanitizes what it reads and drops __proto__', () => {
    const env = tmpEnv();
    fs.mkdirSync(jobsDir(env), { recursive: true });
    fs.writeFileSync(
      envelopeFile('status', env),
      '{"v":1,"key":"status","fetchedAt":1,"ok":true,"value":{"name":"red\\u001b[31mx","__proto__":{"polluted":1}}}',
    );
    const e = readEnvelope<Record<string, unknown>>('status', env)!;
    expect(e.value!.name).toBe('redx');
    expect(Object.hasOwn(e.value!, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reads bad files and bad keys as null', () => {
    const env = tmpEnv();
    fs.mkdirSync(jobsDir(env), { recursive: true });
    const bad = [
      'not json',
      '[1]',
      '{"v":2,"key":"status","fetchedAt":1,"ok":true,"value":1}',
      '{"v":1,"key":"other","fetchedAt":1,"ok":true,"value":1}',
      '{"v":1,"key":"status","fetchedAt":"1","ok":true,"value":1}',
      '{"v":1,"key":"status","fetchedAt":1,"ok":"yes","value":1}',
    ];
    for (const text of bad) {
      fs.writeFileSync(envelopeFile('status', env), text);
      expect(readEnvelope('status', env), text).toBeNull();
    }
    expect(readEnvelope('../x', env)).toBeNull();
    expect(readEnvelope('Status', env)).toBeNull();
    writeEnvelope({ ...okEnvelope('status', 1, NOW), key: '../x' }, env);
    expect(fs.existsSync(path.join(env.CCINFOBAR_CACHE_DIR!, 'x.json'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes 0600 files in a 0700 dir', () => {
    const env = tmpEnv();
    fs.mkdirSync(jobsDir(env), { mode: 0o755 });
    fs.chmodSync(jobsDir(env), 0o755);
    writeEnvelope(okEnvelope('status', 1, NOW), env);
    expect(fs.statSync(envelopeFile('status', env)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(jobsDir(env)).mode & 0o777).toBe(0o700);
  });
});

describe('defaultDue', () => {
  it('follows the ttl and the block', () => {
    expect(defaultDue(null, NOW, 60_000)).toBe(true);
    const ok = okEnvelope('status', 1, NOW);
    expect(defaultDue(ok, NOW + 59_000, 60_000)).toBe(false);
    expect(defaultDue(ok, NOW + 60_000, 60_000)).toBe(true);
    const failed = failEnvelope('status', ok, 'x', NOW, { retryMs: 120_000 });
    expect(defaultDue(failed, NOW + 60_000, 60_000)).toBe(false);
    expect(defaultDue(failed, NOW + 120_000, 60_000)).toBe(true);
    expect(defaultDue(ok, NOW - 10_000, 60_000)).toBe(true);
  });
});

describe('keyNetwork', () => {
  it('matches the network of every registered job', async () => {
    const { JOBS } = await import('../../../src/data/jobs/index.js');
    const { keyNetwork } = await import('../../../src/data/jobs/keys.js');
    const samples: Record<string, string> = {
      usage: 'usage-0123456789abcdef',
      update: 'update',
      status: 'status',
      http: 'http-0123456789abcdef',
      gh: 'gh-0123456789abcdef',
      repos: 'repos-dirty-0123456789abcdef0123',
    };
    for (const job of JOBS) {
      const key = samples[job.id]!;
      expect(job.keyRe.test(key), job.id).toBe(true);
      expect(keyNetwork(key), job.id).toBe(job.network);
    }
    expect(keyNetwork('gh-hosts')).toBeNull();
    expect(keyNetwork('http-xyz')).toBeNull();
  });
});

describe('switches', () => {
  it('reads NO_JOBS and NONESSENTIAL', () => {
    expect(jobsDisabled({ CCINFOBAR_NO_JOBS: '1' })).toBe(true);
    expect(jobsDisabled({})).toBe(false);
    const off = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    expect(blockedByTraffic('auto', off)).toBe(true);
    expect(blockedByTraffic('explicit', off)).toBe(false);
    expect(blockedByTraffic('none', off)).toBe(false);
    expect(blockedByTraffic('auto', {})).toBe(false);
  });

  it('keeps the update-state re-exports', () => {
    expect(typeof state.spawnSelf).toBe('function');
    expect(typeof state.spawnSelfDetached).toBe('function');
    expect(state.nonessentialTrafficOff({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })).toBe(true);
  });

  it('formats and parses worker args', () => {
    expect(formatArg({ key: 'a' })).toBe('a');
    expect(formatArg({ key: 'b', param: 'p=q' })).toBe('b=p=q');
    expect(parseArg('b=p=q')).toEqual({ key: 'b', param: 'p=q' });
    expect(parseArg('a')).toEqual({ key: 'a' });
  });
});

describe('scheduleRequests', () => {
  const items = (lockMs = 60_000) => [
    { req: { key: 'a' }, lockMs },
    { req: { key: 'b', param: 'p' }, lockMs },
    { req: { key: 'c' }, lockMs },
  ];
  const locks = (env: NodeJS.ProcessEnv) => ['a', 'b', 'c'].map((k) => fs.existsSync(lockFile(k, env)));

  it('takes one lock per key and spawns once', () => {
    const env = tmpEnv();
    const calls: string[][] = [];
    const spawn = (args: string[]) => {
      calls.push(args);
      return true;
    };
    const out = scheduleRequests(items(), env, ['--cwd=/x'], { now: Date.now(), spawn });
    expect(calls).toEqual([['worker', 'a', 'b=p', 'c', '--cwd=/x']]);
    expect(out).toEqual(['a', 'b=p', 'c']);
    expect(locks(env)).toEqual([true, true, true]);
    expect(scheduleRequests(items(), env, [], { now: Date.now() + 1000, spawn })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('releases the locks when the spawn throws or reports an error', () => {
    const env = tmpEnv();
    const out = scheduleRequests(items(), env, [], {
      now: Date.now(),
      spawn: () => {
        throw new Error('EAGAIN');
      },
    });
    expect(out).toEqual([]);
    expect(locks(env)).toEqual([false, false, false]);
    let onError: (() => void) | undefined;
    scheduleRequests(items(), env, [], {
      now: Date.now(),
      spawn: (_a, _e, cb) => {
        onError = cb;
        return true;
      },
    });
    expect(locks(env)).toEqual([true, true, true]);
    onError!();
    expect(locks(env)).toEqual([false, false, false]);
  });

  it('releases the locks and reports nothing when spawn starts no worker', () => {
    const env = tmpEnv();
    expect(scheduleRequests(items(), env, [], { now: Date.now(), spawn: () => false })).toEqual([]);
    expect(locks(env)).toEqual([false, false, false]);
  });

  it('spawns only for the keys it locked', () => {
    const env = tmpEnv();
    const calls: string[][] = [];
    const spawn = (args: string[]) => {
      calls.push(args);
      return true;
    };
    scheduleRequests([{ req: { key: 'b' }, lockMs: 60_000 }], env, [], { now: Date.now(), spawn });
    scheduleRequests(items(), env, [], { now: Date.now(), spawn });
    expect(calls[1]).toEqual(['worker', 'a', 'c']);
    expect(
      scheduleRequests([{ req: { key: '../x' }, lockMs: 1 }], env, [], { now: Date.now(), spawn }),
    ).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('does nothing when jobs are disabled', () => {
    const env = { ...tmpEnv(), CCINFOBAR_NO_JOBS: '1' };
    let spawned = false;
    const out = scheduleRequests(items(), env, [], {
      now: Date.now(),
      spawn: () => {
        spawned = true;
        return true;
      },
    });
    expect(out).toEqual([]);
    expect(spawned).toBe(false);
    expect(locks(env)).toEqual([false, false, false]);
  });
});

describe('executeJob', () => {
  const ctx = (env: NodeJS.ProcessEnv, prev: JobEnvelope<string> | null = null): JobCtx<string> => ({
    env,
    config: {} as Config,
    cwd: '/',
    prev,
    fetch: (() => {
      throw new Error('no network in tests');
    }) as unknown as typeof fetch,
    now: NOW,
  });
  const job = (run: Job<string>['run']): Job<string> => ({
    id: 'status',
    network: 'auto',
    lockMs: 60_000,
    timeoutMs: 50,
    retryMs: 60_000,
    keyRe: /^status$/,
    keys: () => [{ key: 'status' }],
    accepts: () => true,
    due: () => true,
    run,
  });

  it('writes the envelope with the param and drops the lock', async () => {
    const env = tmpEnv();
    scheduleRequests([{ req: { key: 'status' }, lockMs: 60_000 }], env, [], { now: NOW, spawn: () => true });
    expect(fs.existsSync(lockFile('status', env))).toBe(true);
    const out = await executeJob(
      job(async (req, c) => okEnvelope(req.key, 'up', c.now)),
      { key: 'status', param: 'p' },
      ctx(env),
    );
    expect(out).toMatchObject({ ok: true, value: 'up', param: 'p' });
    expect(readEnvelope('status', env)).toMatchObject({ ok: true, value: 'up', param: 'p' });
    expect(fs.existsSync(lockFile('status', env))).toBe(false);
  });

  it('records a rejected run as failed and keeps the last good value', async () => {
    const env = tmpEnv();
    const prev = okEnvelope('status', 'up', NOW - 1000);
    const out = await executeJob(
      job(async () => {
        throw new Error('secret https://x?token=1');
      }),
      { key: 'status' },
      ctx(env, prev),
    );
    expect(out).toMatchObject({ ok: false, error: 'failed', lastGood: 'up', attempts: 1 });
    expect(readEnvelope('status', env)).toMatchObject({ error: 'failed', lastGood: 'up' });
  });

  it('times out a slow run', async () => {
    const env = tmpEnv();
    const out = await executeJob(
      job(() => new Promise((r) => setTimeout(() => r(okEnvelope('status', 'late', NOW)), 400).unref())),
      { key: 'status' },
      ctx(env),
    );
    expect(out).toMatchObject({ ok: false, error: 'timeout' });
    expect(readEnvelope('status', env)?.error).toBe('timeout');
  });

  it('treats a bad run result as failed', async () => {
    const env = tmpEnv();
    const out = await executeJob(
      job(async () => null as unknown as JobEnvelope<string>),
      { key: 'status' },
      ctx(env),
    );
    expect(out).toMatchObject({ ok: false, error: 'failed' });
  });
});
