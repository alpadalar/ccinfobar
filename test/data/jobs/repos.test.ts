import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import type { Config, WidgetItem } from '../../../src/core/types.js';
import { JOBS, scheduleJobs } from '../../../src/data/jobs/index.js';
import { reposJob } from '../../../src/data/jobs/repos.js';
import {
  envelopeFile,
  executeJob,
  lockFile,
  okEnvelope,
  readEnvelope,
  writeEnvelope,
} from '../../../src/data/jobs/runner.js';
import { legacyDirtyFile, readDirty, reposKey, type WorkspaceRepos } from '../../../src/data/repos.js';

const KEY_RE = /^repos-dirty-[0-9a-f]{20}$/;
const NOW = 1_800_000_000_000;
const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git'));
const posix = process.platform !== 'win32';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const cfg = (options: WidgetItem['options'] = { dirty: true }, more: WidgetItem[] = []): Config => ({
  ...defaultConfig(),
  lines: [[{ id: 'r', type: 'workspace-repos', options }, ...more]],
});

function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), prefix)));
}

function fakeRepo(root: string, name: string): void {
  fs.mkdirSync(path.join(root, name, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, name, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

const input = (config: Config, cwd: string, env: NodeJS.ProcessEnv, more = {}) => ({
  config,
  payload: {},
  env,
  cwd,
  now: NOW,
  ...more,
});

describe.skipIf(tmpRepo)('reposJob keys and accepts', () => {
  let base: string;
  let ws: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    base = tmpDir('ccib-reposjob-');
    ws = path.join(base, 'ws');
    fakeRepo(ws, 'api');
    fakeRepo(ws, 'web');
    env = { CCINFOBAR_CACHE_DIR: path.join(base, 'cache') };
  });

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('is registered with no network and a 2 min lock', () => {
    expect(JOBS).toContain(reposJob);
    expect(reposJob.network).toBe('none');
    expect(reposJob.lockMs).toBe(120_000);
  });

  it('asks for one key per workspace, with the absolute cwd as param', () => {
    const reqs = reposJob.keys(input(cfg(), ws, env));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.param).toBe(ws);
    expect(reqs[0]!.key).toMatch(KEY_RE);
    expect(reqs[0]!.key).toBe(reposKey(ws));
  });

  it('asks for nothing with dirty off, without repos or with a fresh dirty time', () => {
    expect(reposJob.keys(input(cfg({}), ws, env))).toEqual([]);
    expect(reposJob.keys(input(cfg(), path.join(base, 'empty'), env))).toEqual([]);
    expect(reposJob.keys(input(cfg(), 'rel/ws', env))).toEqual([]);
    const fresh: WorkspaceRepos = { root: ws, repos: [], total: 2, dirty: {}, dirtyAt: NOW - 1_000 };
    expect(reposJob.keys(input(cfg(), ws, env, { repos: () => fresh }))).toEqual([]);
    expect(
      reposJob.keys(input(cfg(), ws, env, { repos: () => ({ ...fresh, dirtyAt: NOW - 61_000 }) })),
    ).toHaveLength(1);
  });

  it('uses the scan render already made', () => {
    let calls = 0;
    const scan = (): WorkspaceRepos => {
      calls++;
      return { root: ws, repos: [], total: 1, dirtyAt: null };
    };
    expect(reposJob.keys(input(cfg(), ws, env, { repos: scan }))).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('accepts only an absolute existing folder whose key matches', () => {
    const ok = (param: string, key = reposKey(param), config = cfg()) =>
      reposJob.accepts({ key, param }, { config, env, cwd: ws });
    expect(ok(ws)).toBe(true);
    expect(ok('ws', reposKey(path.resolve('ws')))).toBe(false);
    expect(ok(path.join(base, 'missing'))).toBe(false);
    expect(ok(ws, reposKey(path.join(base, 'other')))).toBe(false);
    expect(ok(`${ws}${path.sep}`, reposKey(ws))).toBe(false);
    expect(ok(ws, reposKey(ws), cfg({}))).toBe(false);
    expect(reposJob.accepts({ key: reposKey(ws) }, { config: cfg(), env, cwd: ws })).toBe(false);
  });

  it('param pattern takes absolute paths without control characters', () => {
    const re = reposJob.paramRe!;
    expect(re.test('/home/u/ws')).toBe(true);
    expect(re.test('C:\\Users\\u\\ws')).toBe(true);
    expect(re.test('\\\\server\\share\\ws')).toBe(true);
    expect(re.test('ws')).toBe(false);
    expect(re.test('/ws\u0000x')).toBe(false);
    expect(re.test('/ws\nx')).toBe(false);
    expect(re.test(`/${'a'.repeat(4095)}`)).toBe(true);
    expect(re.test(`/${'a'.repeat(4096)}`)).toBe(false);
  });
});

describe('reposJob previous value', () => {
  let env: NodeJS.ProcessEnv;
  let base: string;
  beforeAll(() => {
    base = tmpDir('ccib-reposprev-');
    env = { CCINFOBAR_CACHE_DIR: path.join(base, 'cache') };
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  const legacy = (cwd: string, v: unknown) => {
    fs.mkdirSync(env.CCINFOBAR_CACHE_DIR!, { recursive: true });
    fs.writeFileSync(legacyDirtyFile(cwd, env), JSON.stringify(v));
  };

  it('reads the envelope first and the legacy file second', () => {
    const cwd = path.resolve('/ws-prev');
    const key = reposKey(cwd);
    legacy(cwd, { v: 1, at: NOW - 5_000, dirty: { api: true } });
    const prev = reposJob.readPrev!(key, env);
    expect(prev?.ok).toBe(true);
    expect(prev?.fetchedAt).toBe(NOW - 5_000);
    expect({ ...prev?.value?.dirty }).toEqual({ api: true });
    expect({ ...readDirty(cwd, env)?.dirty }).toEqual({ api: true });
    writeEnvelope(okEnvelope(key, { dirty: { web: true } }, NOW), env);
    expect({ ...reposJob.readPrev!(key, env)?.value?.dirty }).toEqual({ web: true });
    expect(readDirty(cwd, env)).toEqual({ at: NOW, dirty: { web: true } });
  });

  it('keeps the last good map of a failed envelope and drops bad entries', () => {
    const cwd = path.resolve('/ws-fail');
    const key = reposKey(cwd);
    const bad = JSON.parse('{"__proto__":true,"api":true,"web":"yes"}');
    writeEnvelope(
      {
        v: 1,
        key,
        fetchedAt: NOW,
        ok: false,
        value: null,
        error: 'timeout',
        lastGood: { dirty: bad },
        lastGoodAt: NOW - 90_000,
      },
      env,
    );
    const d = readDirty(cwd, env);
    expect(d?.at).toBe(NOW - 90_000);
    expect(Object.getPrototypeOf(d?.dirty)).toBeNull();
    expect({ ...d?.dirty }).toEqual({ api: true });
  });

  it('is due after 60 s', () => {
    const e = okEnvelope('repos-dirty-00000000000000000000', { dirty: {} }, NOW);
    expect(reposJob.due(e, NOW + 59_000, { key: e.key })).toBe(false);
    expect(reposJob.due(e, NOW + 60_000, { key: e.key })).toBe(true);
    expect(reposJob.due(null, NOW, { key: e.key })).toBe(true);
  });
});

describe('one spawn for every job', () => {
  it('schedules repos, status and http in a single worker', () => {
    const base = tmpDir('ccib-reposched-');
    const ws = path.join(base, 'ws');
    fakeRepo(ws, 'api');
    const env = { CCINFOBAR_CACHE_DIR: path.join(base, 'cache'), CCINFOBAR_CONFIG_DIR: path.join(base, 'c') };
    const config = cfg({ dirty: true }, [
      { id: 's', type: 'service-status' },
      { id: 'h', type: 'http', options: { url: 'https://example.com/x.json' } },
    ]);
    const calls: string[][] = [];
    const spawn = (args: string[]) => {
      calls.push(args);
      return true;
    };
    const keys = scheduleJobs(config, {}, env, ws, null, { now: NOW, spawn });
    expect(calls).toHaveLength(1);
    expect(keys).toContain('status');
    expect(keys.some((k) => /^http-[0-9a-f]{16}$/.test(k))).toBe(true);
    expect(keys).toContain(`${reposKey(ws)}=${ws}`);
    expect(fs.existsSync(lockFile(reposKey(ws), env))).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe.skipIf(!hasGit() || tmpRepo)('reposJob run', () => {
  let base: string;
  let ws: string;
  let gitEnv: NodeJS.ProcessEnv;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd,
        stdio: 'ignore',
        windowsHide: true,
        env: gitEnv,
      },
    );

  function repo(root: string, name: string): string {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    git(d, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
    git(d, 'add', '.');
    git(d, 'commit', '-q', '-m', 'init');
    return d;
  }

  beforeAll(() => {
    base = tmpDir('ccib-reposrun-');
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    gitEnv = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      CCINFOBAR_CACHE_DIR: path.join(base, 'cache'),
    };
    ws = path.join(base, 'ws');
    fs.writeFileSync(path.join(repo(ws, 'dirty'), 'u.txt'), 'new\n');
    repo(ws, 'clean');
  }, 60_000);

  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  const ctx = (config: Config) => ({
    env: gitEnv,
    config,
    cwd: ws,
    prev: null,
    fetch: (() => Promise.reject(new Error('no network'))) as typeof fetch,
    now: NOW,
  });

  it('writes the dirty map to the envelope and never to the legacy file', async () => {
    const key = reposKey(ws);
    fs.mkdirSync(gitEnv.CCINFOBAR_CACHE_DIR!, { recursive: true });
    fs.writeFileSync(legacyDirtyFile(ws, gitEnv), JSON.stringify({ v: 1, at: 1, dirty: { clean: true } }));
    const out = await executeJob(reposJob, { key, param: ws }, ctx(cfg()), gitEnv);
    expect(out.ok).toBe(true);
    expect({ ...readEnvelope<{ dirty: Record<string, boolean> }>(key, gitEnv)?.value?.dirty }).toEqual({
      dirty: true,
      clean: false,
    });
    expect(fs.existsSync(envelopeFile(key, gitEnv))).toBe(true);
    expect(fs.existsSync(legacyDirtyFile(ws, gitEnv))).toBe(false);
    expect(fs.existsSync(lockFile(key, gitEnv))).toBe(false);
  });

  it.skipIf(!posix)('never runs a core.fsmonitor hook from a child repo', async () => {
    const w = path.join(base, 'fsws');
    const d = repo(w, 'mon');
    const marker = path.join(base, 'fsmonitor-marker');
    const hook = path.join(base, 'fsmon.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(hook, 0o755);
    git(d, 'config', 'core.fsmonitor', hook);
    fs.writeFileSync(path.join(d, 'a.txt'), 'two\n');
    const key = reposKey(w);
    const out = await executeJob(reposJob, { key, param: w }, { ...ctx(cfg()), cwd: w }, gitEnv);
    expect({ ...out.value?.dirty }).toEqual({ mon: true });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
