import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import { configPath } from '../../../src/core/paths.js';
import { scheduleJobs } from '../../../src/data/jobs/index.js';
import {
  createJobReader,
  envelopeFile,
  type Job,
  type JobNetwork,
  lockFile,
  okEnvelope,
  writeEnvelope,
} from '../../../src/data/jobs/runner.js';
import { updateJob } from '../../../src/data/jobs/update.js';
import { usageJob } from '../../../src/data/jobs/usage.js';
import { usageKey } from '../../../src/data/usage.js';

const NOW = 1_800_000_000_000;
const CWD = path.resolve(os.tmpdir(), 'proj');

const tmpEnv = (): NodeJS.ProcessEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-sched-'));
  return { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'), CCINFOBAR_CONFIG_DIR: path.join(dir, 'cfg') };
};

const fake = (key: string, network: JobNetwork, over: Partial<Job<unknown>> = {}): Job<unknown> => ({
  id: 'http',
  network,
  lockMs: 60_000,
  timeoutMs: 1000,
  retryMs: 0,
  keyRe: new RegExp(`^${key}$`),
  keys: () => [{ key }],
  accepts: () => true,
  due: () => true,
  run: async () => okEnvelope(key, 1, NOW),
  ...over,
});

const three = () => [fake('a-auto', 'auto'), fake('b-explicit', 'explicit'), fake('c-none', 'none')];

const run = (env: NodeJS.ProcessEnv, jobs: Job<unknown>[], cfgFile: string | null = configPath(env)) => {
  const calls: string[][] = [];
  const spawn = (args: string[]) => {
    calls.push(args);
    return true;
  };
  const keys = scheduleJobs(defaultConfig(), {}, env, CWD, cfgFile, { now: NOW, spawn, jobs });
  return { keys, calls };
};

describe('scheduleJobs', () => {
  it('spawns one worker for every due job', () => {
    const { keys, calls } = run(tmpEnv(), three());
    expect(keys).toEqual(['a-auto', 'b-explicit', 'c-none']);
    expect(calls).toEqual([['worker', 'a-auto', 'b-explicit', 'c-none', `--cwd=${CWD}`]]);
  });

  it('drops only auto jobs when NONESSENTIAL traffic is off', () => {
    const env = { ...tmpEnv(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const { keys, calls } = run(env, three());
    expect(keys).toEqual(['b-explicit', 'c-none']);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(lockFile('a-auto', env))).toBe(false);
  });

  it('does nothing with CCINFOBAR_NO_JOBS', () => {
    const env = { ...tmpEnv(), CCINFOBAR_NO_JOBS: '1' };
    const { keys, calls } = run(env, three());
    expect(keys).toEqual([]);
    expect(calls).toEqual([]);
    for (const k of ['a-auto', 'b-explicit', 'c-none']) expect(fs.existsSync(lockFile(k, env))).toBe(false);
  });

  it('skips jobs that are not due or whose keys() throws', () => {
    const jobs = [
      fake('a-auto', 'auto', { due: () => false }),
      fake('b-explicit', 'explicit', {
        keys: () => {
          throw new Error('boom');
        },
      }),
      fake('c-none', 'none'),
    ];
    const { keys, calls } = run(tmpEnv(), jobs);
    expect(keys).toEqual(['c-none']);
    expect(calls).toEqual([['worker', 'c-none', `--cwd=${CWD}`]]);
  });

  it('passes the param and the stored envelope to due()', () => {
    const env = tmpEnv();
    const prev = okEnvelope('p-key', 1, NOW - 1000);
    writeEnvelope(prev, env);
    const due = vi.fn(() => true);
    const { keys } = run(env, [fake('p-key', 'none', { keys: () => [{ key: 'p-key', param: 'x/y' }], due })]);
    expect(keys).toEqual(['p-key=x/y']);
    expect(due).toHaveBeenCalledWith(expect.objectContaining({ key: 'p-key', fetchedAt: NOW - 1000 }), NOW, {
      key: 'p-key',
      param: 'x/y',
    });
  });

  it('adds --config only for a non-default config file', () => {
    const env = tmpEnv();
    expect(run(env, [fake('c-none', 'none')]).calls[0]).not.toContainEqual(
      expect.stringMatching(/^--config=/),
    );
    const other = path.resolve(os.tmpdir(), 'other.json');
    expect(run(tmpEnv(), [fake('c-none', 'none')], other).calls[0]).toContain(`--config=${other}`);
    const rel = run(tmpEnv(), [fake('c-none', 'none')], 'rel/config.json').calls[0];
    expect(rel).toContain(`--config=${path.resolve('rel/config.json')}`);
  });

  it('passes no --cwd for a relative cwd', () => {
    const calls: string[][] = [];
    scheduleJobs(defaultConfig(), {}, tmpEnv(), 'rel', null, {
      now: NOW,
      jobs: [fake('c-none', 'none')],
      spawn: (args) => {
        calls.push(args);
        return true;
      },
    });
    expect(calls).toEqual([['worker', 'c-none']]);
  });

  it('never reads the envelope of an inactive job', () => {
    const readPrev = vi.fn(() => null);
    const due = vi.fn(() => true);
    const { calls } = run(tmpEnv(), [fake('a-auto', 'auto', { keys: () => [], readPrev, due })]);
    expect(readPrev).not.toHaveBeenCalled();
    expect(due).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('spawns nothing when no job is due', () => {
    const { keys, calls } = run(tmpEnv(), [fake('a-auto', 'auto', { due: () => false })]);
    expect(keys).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reads an envelope once when a widget reader already has it', () => {
    const env = tmpEnv();
    writeEnvelope(okEnvelope('a-auto', 1, NOW), env);
    const file = envelopeFile('a-auto', env);
    const reader = createJobReader(env);
    const read = vi.spyOn(fs, 'readFileSync');
    reader.job('a-auto');
    try {
      scheduleJobs(defaultConfig(), {}, env, CWD, null, {
        now: NOW,
        spawn: () => true,
        jobs: [fake('a-auto', 'auto')],
        reader,
      });
      expect(read.mock.calls.filter(([f]) => f === file)).toHaveLength(1);
    } finally {
      read.mockRestore();
    }
  });

  it('hands the reader to a job readPrev', () => {
    const readPrev = vi.fn(() => null);
    const reader = createJobReader(tmpEnv());
    scheduleJobs(defaultConfig(), {}, tmpEnv(), CWD, null, {
      now: NOW,
      spawn: () => true,
      jobs: [fake('a-auto', 'auto', { readPrev })],
      reader,
    });
    expect(readPrev).toHaveBeenCalledWith('a-auto', expect.anything(), reader);
  });

  it('reads the update and usage envelopes through the reader, legacy only without one', () => {
    const env = tmpEnv();
    const upd = okEnvelope('update', { latest: '9.9.9' }, NOW);
    const use = okEnvelope(usageKey(env), { fetchedAt: NOW }, NOW);
    const job = vi.fn((k: string) => (k === 'update' ? upd : k === usageKey(env) ? use : null));
    const reader = { job } as unknown as ReturnType<typeof createJobReader>;
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      expect(updateJob.readPrev?.('update', env, reader)).toBe(upd);
      expect(usageJob.readPrev?.(usageKey(env), env, reader)).toBe(use);
      expect(job).toHaveBeenCalledTimes(2);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
