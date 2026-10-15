import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { parseWorkerArgs, runWorker, sweepJobs, type WorkerDeps } from '../../src/commands/worker.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import {
  type Job,
  type JobId,
  jobsDir,
  lockFile,
  okEnvelope,
  readEnvelope,
} from '../../src/data/jobs/runner.js';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup(configText = '{}') {
  const root = tmp('ccib-worker-');
  const env: NodeJS.ProcessEnv = {
    CCINFOBAR_CACHE_DIR: path.join(root, 'cache'),
    CCINFOBAR_CONFIG_DIR: path.join(root, 'config'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    HOME: root,
  };
  const cfgFile = path.join(root, 'config.json');
  fs.writeFileSync(cfgFile, configText);
  fs.mkdirSync(jobsDir(env), { recursive: true });
  const exits: number[] = [];
  const deps = (jobs: Job<unknown>[], more: Partial<WorkerDeps> = {}): WorkerDeps => ({
    jobs,
    env,
    silent: false,
    exit: (code) => exits.push(code),
    fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch,
    ...more,
  });
  return { root, env, cfgFile, exits, deps };
}

interface Seen {
  accepts: { config: Config; cwd: string }[];
  runs: { key: string; param?: string; cwd: string }[];
}

function fake(
  key: string,
  over: Partial<Job<unknown>> & { id?: JobId } = {},
  seen: Seen = { accepts: [], runs: [] },
): Job<unknown> {
  return {
    id: 'status',
    network: 'none',
    lockMs: 30_000,
    timeoutMs: 2000,
    retryMs: 60_000,
    keyRe: new RegExp(`^${key}$`),
    keys: () => [{ key }],
    accepts: (_req, input) => {
      seen.accepts.push({ config: input.config, cwd: input.cwd });
      return true;
    },
    due: () => true,
    run: async (req, ctx) => {
      seen.runs.push({ key: req.key, ...(req.param ? { param: req.param } : {}), cwd: ctx.cwd });
      return okEnvelope(req.key, { from: key }, ctx.now);
    },
    ...over,
  };
}

const worker = (argv: string[]) => parseArgs(['worker', ...argv]);
const touchLock = (env: NodeJS.ProcessEnv, key: string) => fs.writeFileSync(lockFile(key, env), '');

describe('parseWorkerArgs', () => {
  it('splits at the first =, drops unsafe keys and dedupes', () => {
    expect(parseWorkerArgs(['a', 'b=x=y', '../evil', 'a', 'Bad', ''])).toEqual([
      { key: 'a' },
      { key: 'b', param: 'x=y' },
    ]);
  });

  it('caps the count and the entry length', () => {
    const many = Array.from({ length: 40 }, (_, i) => `k${i}`);
    expect(parseWorkerArgs(many)).toHaveLength(32);
    expect(parseWorkerArgs([`gh=${'x'.repeat(5000)}`, 'ok'])).toEqual([{ key: 'ok' }]);
  });
});

describe('runWorker', () => {
  it('runs requested jobs concurrently and leaves no locks', async () => {
    const s = setup();
    let bDone!: () => void;
    const b = new Promise<void>((r) => {
      bDone = r;
    });
    const fakeA = fake('fake-a', {
      run: async (req, ctx) => {
        await b;
        return okEnvelope(req.key, 'a', ctx.now);
      },
    });
    const fakeB = fake('fake-b', {
      run: async (req, ctx) => {
        bDone();
        return okEnvelope(req.key, 'b', ctx.now);
      },
    });
    touchLock(s.env, 'fake-a');
    touchLock(s.env, 'fake-b');
    await runWorker(worker(['fake-a', 'fake-b']), s.cfgFile, s.deps([fakeA, fakeB]));
    expect(readEnvelope('fake-a', s.env)).toMatchObject({ ok: true, value: 'a' });
    expect(readEnvelope('fake-b', s.env)).toMatchObject({ ok: true, value: 'b' });
    expect(fs.existsSync(lockFile('fake-a', s.env))).toBe(false);
    expect(fs.existsSync(lockFile('fake-b', s.env))).toBe(false);
    expect(s.exits).toEqual([0]);
  });

  it('skips unknown keys and rejected requests, and unlinks their locks', async () => {
    const s = setup();
    const seen: Seen = { accepts: [], runs: [] };
    const jobs = [fake('fake-a', { accepts: () => false }, seen), fake('fake-b', {}, seen)];
    for (const k of ['fake-a', 'nope']) touchLock(s.env, k);
    await runWorker(worker(['fake-a', 'nope', '../evil']), s.cfgFile, s.deps(jobs));
    expect(seen.runs).toEqual([]);
    expect(fs.existsSync(lockFile('fake-a', s.env))).toBe(false);
    expect(fs.existsSync(lockFile('nope', s.env))).toBe(false);
    expect(readEnvelope('fake-a', s.env)).toBeNull();
    expect(fs.existsSync(path.join(jobsDir(s.env), 'fake-b.json'))).toBe(false);
  });

  it('checks the param against the job', async () => {
    const s = setup();
    const seen: Seen = { accepts: [], runs: [] };
    const jobs = [fake('gh', { paramRe: /^[a-z]+#\d+$/ }, seen), fake('fake-b', {}, seen)];
    await runWorker(worker(['gh=bad param', 'fake-b=x']), s.cfgFile, s.deps(jobs));
    expect(seen.runs).toEqual([]);
    await runWorker(worker(['gh=repo#12']), s.cfgFile, s.deps(jobs));
    expect(seen.runs).toEqual([{ key: 'gh', param: 'repo#12', cwd: process.cwd() }]);
  });

  it('runs only the update job with the default config when the config is broken', async () => {
    const s = setup('{ "theme": ');
    const seen: Seen = { accepts: [], runs: [] };
    const jobs = [fake('update', { id: 'update' }, seen), fake('fake-a', {}, seen)];
    await runWorker(worker(['update', 'fake-a']), s.cfgFile, s.deps(jobs));
    expect(seen.runs.map((r) => r.key)).toEqual(['update']);
    expect(seen.accepts[0]!.config).toEqual(defaultConfig());
  });

  it('keeps old http files when the config is broken (issue)', async () => {
    const s = setup('{ broken');
    const old = path.join(jobsDir(s.env), 'http-0123456789abcdef.json');
    fs.writeFileSync(old, '{}');
    const t = (Date.now() - 8 * 86_400_000) / 1000;
    fs.utimesSync(old, t, t);
    await runWorker(worker([]), s.cfgFile, s.deps([]));
    expect(fs.existsSync(old)).toBe(true);
    expect(s.exits).toEqual([0]);
  });

  it('loads --config and passes --cwd', async () => {
    const s = setup();
    const other = path.join(s.root, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ theme: 'nord' }));
    const dir = tmp('ccib-worker-cwd-');
    const seen: Seen = { accepts: [], runs: [] };
    await runWorker(
      worker(['fake-a', `--config=${other}`, `--cwd=${dir}`]),
      s.cfgFile,
      s.deps([fake('fake-a', {}, seen)]),
    );
    expect(seen.accepts[0]).toMatchObject({ cwd: dir });
    expect(seen.accepts[0]!.config.theme).toBe('nord');
    expect(seen.runs[0]!.cwd).toBe(dir);
    await runWorker(worker(['fake-a', '--cwd=relative/dir']), s.cfgFile, s.deps([fake('fake-a', {}, seen)]));
    expect(seen.accepts[1]!.cwd).toBe(process.cwd());
    expect(seen.accepts[1]!.config.theme).toBe(defaultConfig().theme);
  });

  it('exits 0 once when a job throws synchronously', async () => {
    const s = setup();
    const boom = fake('fake-a', {
      run: () => {
        throw new Error('boom');
      },
    });
    const thrower = fake('fake-b', {
      accepts: () => {
        throw new Error('bad accepts');
      },
    });
    await runWorker(worker(['fake-a', 'fake-b']), s.cfgFile, s.deps([boom, thrower]));
    expect(readEnvelope('fake-a', s.env)).toMatchObject({ ok: false, error: 'failed' });
    expect(s.exits).toEqual([0]);
  });

  it('passes the previous envelope to run', async () => {
    const s = setup();
    let prev: unknown = 'unset';
    const job = fake('fake-a', {
      run: async (req, ctx) => {
        prev = ctx.prev?.value;
        return okEnvelope(req.key, 2, ctx.now);
      },
    });
    await runWorker(worker(['fake-a']), s.cfgFile, s.deps([job]));
    expect(prev).toBeUndefined();
    await runWorker(worker(['fake-a']), s.cfgFile, s.deps([job]));
    expect(prev).toBe(2);
  });
});

describe('sweepJobs', () => {
  it('deletes only old http/gh envelopes the config no longer produces, and stale tmp files', () => {
    const s = setup();
    const dir = jobsDir(s.env);
    const now = Date.now();
    const age = (name: string, ms: number) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, '{}');
      const t = (now - ms) / 1000;
      fs.utimesSync(p, t, t);
      return p;
    };
    const day = 86_400_000;
    const gone = age('http-0123456789abcdef.json', 8 * day);
    const ghGone = age('gh-0123456789abcdef.json', 8 * day);
    const kept = age('http-fedcba9876543210.json', 8 * day);
    const fresh = age('http-00000000000000aa.json', day);
    const others = ['update.json', 'status.json', 'gh-hosts.json', 'http-0123.json'].map((n) =>
      age(n, 30 * day),
    );
    const tmpOld = age('x.json.123.tmp', 2 * 3_600_000);
    const tmpNew = age('y.json.123.tmp', 60_000);
    sweepJobs(s.env, new Set(['http-fedcba9876543210']), now);
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(ghGone)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
    for (const p of others) expect(fs.existsSync(p)).toBe(true);
    expect(fs.existsSync(tmpOld)).toBe(false);
    expect(fs.existsSync(tmpNew)).toBe(true);
  });

  it('never follows a directory or fails on a missing jobs dir', () => {
    const s = setup();
    const d = path.join(jobsDir(s.env), 'http-1111111111111111.json');
    fs.mkdirSync(d);
    const t = (Date.now() - 30 * 86_400_000) / 1000;
    fs.utimesSync(d, t, t);
    sweepJobs(s.env, new Set(), Date.now());
    expect(fs.existsSync(d)).toBe(true);
    expect(() =>
      sweepJobs({ CCINFOBAR_CACHE_DIR: path.join(s.root, 'none') }, new Set(), Date.now()),
    ).not.toThrow();
  });

  it('keeps keys the registered jobs still produce after a run', async () => {
    const s = setup();
    const name = 'http-abababababababab';
    const p = path.join(jobsDir(s.env), `${name}.json`);
    fs.writeFileSync(p, '{}');
    const t = (Date.now() - 8 * 86_400_000) / 1000;
    fs.utimesSync(p, t, t);
    const job = fake('other', { id: 'http', keys: () => [{ key: name }] });
    await runWorker(worker([]), s.cfgFile, s.deps([job]));
    expect(fs.existsSync(p)).toBe(true);
    await runWorker(worker([]), s.cfgFile, s.deps([fake('other', { id: 'http', keys: () => [] })]));
    expect(fs.existsSync(p)).toBe(false);
  });
});
