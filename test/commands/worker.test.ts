import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import {
  parseWorkerArgs,
  runWorker,
  sweepCache,
  sweepJobs,
  type WorkerDeps,
} from '../../src/commands/worker.js';
import { defaultConfig } from '../../src/core/config.js';
import { cacheDir, lastPayloadPath } from '../../src/core/paths.js';
import type { Config } from '../../src/core/types.js';
import { ghJob } from '../../src/data/jobs/gh.js';
import { ghKey } from '../../src/data/jobs/keys.js';
import {
  type ExecFileLike,
  type Job,
  type JobId,
  jobsDir,
  lockFile,
  okEnvelope,
  readEnvelope,
} from '../../src/data/jobs/runner.js';

// never an npm-global or local install kind, so the update job cannot install
vi.mock('../../src/data/update-state.js', async (orig) => ({
  ...(await orig<typeof import('../../src/data/update-state.js')>()),
  installKind: () => 'source',
}));

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
    const oldCache = path.join(cacheDir(s.env), `transcript-${'a'.repeat(20)}.json`);
    fs.writeFileSync(oldCache, '{}');
    const t = (Date.now() - 31 * 86_400_000) / 1000;
    fs.utimesSync(oldCache, t, t);
    await runWorker(worker(['fake-a', 'fake-b']), s.cfgFile, s.deps([fakeA, fakeB]));
    expect(fs.existsSync(oldCache)).toBe(false);
    expect(readEnvelope('fake-a', s.env)).toMatchObject({ ok: true, value: 'a' });
    expect(readEnvelope('fake-b', s.env)).toMatchObject({ ok: true, value: 'b' });
    expect(fs.existsSync(lockFile('fake-a', s.env))).toBe(false);
    expect(fs.existsSync(lockFile('fake-b', s.env))).toBe(false);
    expect(s.exits).toEqual([0]);
  });

  it('takes over project status lines only after the update job ran', async () => {
    const s = setup();
    const took: unknown[] = [];
    await runWorker(
      worker(['fake-a']),
      s.cfgFile,
      s.deps([fake('fake-a')], { takeOver: (e) => took.push(e) }),
    );
    expect(took).toEqual([]);
  });

  it('skips jobs that CCINFOBAR_NO_JOBS or the nonessential flag turn off', async () => {
    for (const [extra, ran] of [
      [{ CCINFOBAR_NO_JOBS: '1' }, []],
      [{ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }, ['fake-b']],
    ] as const) {
      const s = setup();
      Object.assign(s.env, extra);
      const seen: Seen = { accepts: [], runs: [] };
      const jobs = [fake('fake-a', { network: 'auto' }, seen), fake('fake-b', { network: 'explicit' }, seen)];
      for (const k of ['fake-a', 'fake-b']) touchLock(s.env, k);
      await runWorker(worker(['fake-a', 'fake-b']), s.cfgFile, s.deps(jobs));
      expect(seen.runs.map((r) => r.key)).toEqual(ran);
      expect(readEnvelope('fake-a', s.env)).toBeNull();
      for (const k of ['fake-a', 'fake-b']) expect(fs.existsSync(lockFile(k, s.env))).toBe(false);
    }
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

  it('runs the real update job with and without a session param', async () => {
    const { installKind } = await import('../../src/data/update-state.js');
    expect(installKind()).toBe('source');
    const { updateJob } = await import('../../src/data/jobs/update.js');
    for (const argv of [['update'], ['update=abc-123']]) {
      const { env, cfgFile, deps } = setup();
      let calls = 0;
      const f = (async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: '/releases/tag/v0.0.1' } });
      }) as typeof fetch;
      touchLock(env, 'update');
      const took: NodeJS.ProcessEnv[] = [];
      const takeOver = (e: NodeJS.ProcessEnv) => took.push(e);
      await runWorker(worker(argv), cfgFile, deps([updateJob as Job<unknown>], { fetch: f, takeOver }));
      expect(calls, argv[0]).toBe(1);
      expect(took).toEqual([env]);
      expect(readEnvelope('update', env)).toMatchObject({ ok: true, value: { latest: '0.0.1' } });
      expect(fs.existsSync(lockFile('update', env))).toBe(false);
    }
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

  it('keeps the gh envelope of a pr ci item it just ran', async () => {
    const s = setup(JSON.stringify({ lines: [[{ id: 'p', type: 'pr', options: { ci: true } }]] }));
    const param = 'github.com/o/r#7';
    const key = ghKey(param);
    const later = Date.now() + 8 * 86_400_000;
    const execFile: ExecFileLike = async () => ({
      code: 0,
      stdout: JSON.stringify([{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }]),
      stderr: '',
    });
    await runWorker(
      worker([`${key}=${param}`]),
      s.cfgFile,
      s.deps([ghJob as Job<unknown>], {
        execFile,
        now: () => later,
      }),
    );
    expect(readEnvelope(key, s.env)?.ok).toBe(true);
  });
});

describe('sweepCache', () => {
  const day = 86_400_000;
  const hex = '0123456789abcdef0123';
  const make = () => {
    const s = setup();
    const dir = cacheDir(s.env);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const file = (name: string, ageMs: number) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, '{}');
      const t = (now - ageMs) / 1000;
      fs.utimesSync(p, t, t);
      return p;
    };
    return { s, dir, now, file };
  };
  const names = [
    `transcript-${hex}.json`,
    `git-${hex}.json`,
    `jj-miss-${hex}.json`,
    `agents-dir-${hex}.json`,
    `bin-${hex}.json`,
    'width-abc_123.json',
  ];

  it('removes known per-session files after 30 days and keeps younger ones', () => {
    const { s, now, file } = make();
    const old = names.map((n) => file(n, 31 * day));
    sweepCache(s.env, now);
    for (const p of old) expect(fs.existsSync(p)).toBe(false);
    const young = names.map((n) => file(n, 29 * day));
    sweepCache(s.env, now);
    for (const p of young) expect(fs.existsSync(p)).toBe(true);
  });

  it('removes legacy agent2 files at any age', () => {
    const { s, now, file } = make();
    const p = file(`agent2-${hex}.json`, 0);
    sweepCache(s.env, now);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('keeps account, update and unknown files', () => {
    const { s, now, file } = make();
    const kept = [
      `usage-${hex}.json`,
      'usage.json',
      'update.json',
      'editor.json',
      path.basename(lastPayloadPath(s.env)),
      'notes.txt',
      'git-short.json',
    ].map((n) => file(n, 31 * day));
    sweepCache(s.env, now);
    for (const p of kept) expect(fs.existsSync(p)).toBe(true);
  });

  it('never follows directories or symlinks', () => {
    const { s, dir, now, file } = make();
    const target = file('usage.json', 31 * day);
    const d = path.join(dir, `transcript-${hex}.json`);
    fs.mkdirSync(d);
    expect(fs.existsSync(d)).toBe(true);
    const link = path.join(dir, `git-${hex}.json`);
    const canLink = process.platform !== 'win32';
    if (canLink) fs.symlinkSync(target, link);
    sweepCache(s.env, now);
    expect(fs.statSync(d).isDirectory()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    if (canLink) {
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    }
  });

  it('prunes stale tmp files', () => {
    const { s, now, file } = make();
    const old = file('x.json.123.deadbeef.tmp', 2 * 3_600_000);
    const fresh = file('y.json.123.deadbeef.tmp', 60_000);
    sweepCache(s.env, now);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('does not throw when the cache dir is missing', () => {
    const env = { CCINFOBAR_CACHE_DIR: path.join(tmp('ccib-sweep-'), 'nope') };
    expect(() => sweepCache(env, Date.now())).not.toThrow();
  });
});
