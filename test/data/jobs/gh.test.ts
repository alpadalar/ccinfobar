import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import type { GhValue } from '../../../src/core/job-values.js';
import type { Config, StatusPayload, WidgetItem } from '../../../src/core/types.js';
import { ghJob, ghParam } from '../../../src/data/jobs/gh.js';
import { defaultExecFile } from '../../../src/data/jobs/gh-exec.js';
import { JOBS, jobFor } from '../../../src/data/jobs/index.js';
import { ghKey } from '../../../src/data/jobs/keys.js';
import {
  type ExecFileLike,
  executeJob,
  type JobCtx,
  type JobEnvelope,
  okEnvelope,
  readEnvelope,
  writeEnvelope,
} from '../../../src/data/jobs/runner.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const sandbox = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-gh-'));
  return {
    HOME: dir,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'cfg'),
    CCINFOBAR_NO_UPDATE: '1',
    ...extra,
  };
};

const pr = (options: WidgetItem['options'] = { ci: true }): WidgetItem => ({ id: 'p1', type: 'pr', options });
const withItems = (...items: WidgetItem[]): Config => ({ ...defaultConfig(), lines: [items] });

const payload = (
  repo: Record<string, unknown> = { host: 'github.com', owner: 'acme', name: 'api' },
  p: Record<string, unknown> = { number: 128, review_state: 'approved' },
): StatusPayload => ({ workspace: { repo }, pr: p }) as unknown as StatusPayload;

type Result = Awaited<ReturnType<ExecFileLike>>;
interface Call {
  file: string;
  args: string[];
  opts: Parameters<ExecFileLike>[2];
}

const ok = (stdout: string, code: number | null = 0): Result => ({ code, stdout, stderr: '' });
const err = (stderr: string, code: number | null = 1, errno?: string): Result => ({
  code,
  stdout: '',
  stderr,
  ...(errno ? { errno } : {}),
});

function fakeGh(checks: Result[], auth?: Result) {
  const calls: Call[] = [];
  const exec: ExecFileLike = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (args[0] === 'auth') return auth ?? err('not logged in', 1);
    return checks.shift() ?? err('unexpected', 1);
  };
  return { exec, calls, checks: () => calls.filter((c) => c.args[0] === 'pr') };
}

const rows = (...buckets: string[]) =>
  JSON.stringify(buckets.map((bucket, i) => ({ name: `check-${i}`, state: bucket.toUpperCase(), bucket })));

const MIX = rows('pass', 'pass', 'pass', 'fail', 'cancel', 'pending', 'skipping');

function ctx(env: NodeJS.ProcessEnv, exec: ExecFileLike, prev: JobEnvelope<GhValue> | null = null) {
  return {
    env,
    config: withItems(pr()),
    cwd: '/',
    prev,
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    execFile: exec,
    now: NOW,
  } satisfies JobCtx<GhValue>;
}

const req = (param = 'github.com/acme/api#128') => ({ key: ghKey(param), param });

async function run(
  exec: ExecFileLike,
  opts: { env?: NodeJS.ProcessEnv; param?: string; prev?: JobEnvelope<GhValue> | null } = {},
) {
  const env = opts.env ?? sandbox();
  const r = req(opts.param);
  const e = await executeJob(ghJob, r, ctx(env, exec, opts.prev ?? null), env);
  return { e, env, r };
}

describe('ghParam', () => {
  it('builds host/owner/name#number from the payload', () => {
    expect(ghParam(payload())).toBe('github.com/acme/api#128');
    expect(ghParam(payload({ owner: 'acme', name: 'api' }))).toBe('github.com/acme/api#128');
    expect(ghParam(payload({ host: 'GHE.Corp.Example', owner: 'acme', name: 'api' }))).toBe(
      'ghe.corp.example/acme/api#128',
    );
  });

  it('skips merge requests, bad numbers and unsafe repo parts', () => {
    expect(ghParam(payload(undefined, { number: 128, kind: 'mr' }))).toBeNull();
    expect(ghParam(payload(undefined, {}))).toBeNull();
    expect(ghParam(payload(undefined, { number: 0 }))).toBeNull();
    expect(ghParam(payload(undefined, { number: 1.5 }))).toBeNull();
    expect(ghParam(payload({ host: 'github.com', owner: 'group/sub', name: 'api' }))).toBeNull();
    expect(ghParam(payload({ host: 'github.com', owner: 'acme', name: '-x' }))).toBeNull();
    expect(ghParam(payload({ host: 'git hub.com', owner: 'acme', name: 'api' }))).toBeNull();
    expect(ghParam(payload({ host: 'github.com', name: 'api' }))).toBeNull();
    expect(ghParam({} as StatusPayload)).toBeNull();
  });
});

describe('ghJob registry and identity', () => {
  it('is registered, explicit and keyed by a param hash', () => {
    expect(JOBS).toContain(ghJob);
    expect(ghJob.network).toBe('explicit');
    const key = ghKey('github.com/acme/api#128');
    expect(key).toMatch(/^gh-[0-9a-f]{16}$/);
    expect(jobFor(key)).toBe(ghJob);
    expect(jobFor('gh-hosts')).toBeUndefined();
  });

  it('asks for a key only when a pr item has ci on', () => {
    const input = (config: Config, p = payload()) => ({ config, payload: p, env: {}, cwd: '/', now: NOW });
    expect(ghJob.keys(input(withItems(pr())))).toEqual([req()]);
    expect(ghJob.keys(input(withItems(pr({ ci: false }))))).toEqual([]);
    expect(ghJob.keys(input(withItems(pr({}))))).toEqual([]);
    expect(ghJob.keys(input(withItems(pr()), payload(undefined, { number: 3, kind: 'mr' })))).toEqual([]);
  });

  it('accepts only a matching key, a valid param and a ci item', () => {
    const a = { config: withItems(pr()), env: {}, cwd: '/' };
    expect(ghJob.accepts(req(), a)).toBe(true);
    expect(
      ghJob.accepts({ key: ghKey('github.com/acme/other#1'), param: 'github.com/acme/api#128' }, a),
    ).toBe(false);
    expect(ghJob.accepts(req('github.com/-x/api#1'), a)).toBe(false);
    expect(ghJob.accepts(req('github.com/a/b/c#1'), a)).toBe(false);
    expect(ghJob.accepts(req(), { ...a, config: withItems(pr({ ci: false })) })).toBe(false);
  });
});

describe('gh invocation', () => {
  it('runs gh pr checks with fixed argv, timeout and a quiet env', async () => {
    const gh = fakeGh([ok(MIX)]);
    const env = sandbox({ GH_TOKEN: 'keep-me', GH_ENTERPRISE_TOKEN: 'ent', GITHUB_ENTERPRISE_TOKEN: 'ent2' });
    await run(gh.exec, { env });
    expect(gh.calls).toHaveLength(1);
    const c = gh.calls[0]!;
    expect(c.file).toBe('gh');
    expect(c.args).toEqual([
      'pr',
      'checks',
      '128',
      '-R',
      'github.com/acme/api',
      '--json',
      'name,state,bucket',
    ]);
    expect(c.opts.timeout).toBe(10_000);
    for (const k of ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'GH_SPINNER_DISABLED', 'NO_COLOR'])
      expect(c.opts.env[k]).toBe('1');
    expect(c.opts.env.GH_TOKEN).toBe('keep-me');
    expect(c.opts.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(c.opts.env.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
  });
});

describe('gh classification', () => {
  const MIXED = { pass: 3, fail: 2, cancelled: 1, pending: 1, skipped: 1, total: 7 };

  it('counts buckets from stdout whatever the exit code', async () => {
    for (const code of [0, 8, 1]) {
      const { e } = await run(fakeGh([ok(MIX, code)]).exec);
      expect(e.ok).toBe(true);
      expect(e.value).toMatchObject(MIXED);
      expect(e.value?.names).toHaveLength(7);
    }
  });

  it('treats unknown buckets as pending', async () => {
    const { e } = await run(fakeGh([ok(rows('weird', 'pass'))]).exec);
    expect(e.value).toMatchObject({ pass: 1, pending: 1, total: 2 });
  });

  it('reads no checks reported as ok with total 0', async () => {
    const { e } = await run(fakeGh([err("no checks reported on the 'x' branch", 1)]).exec);
    expect(e.ok).toBe(true);
    expect(e.value).toEqual({ pass: 0, fail: 0, pending: 0, skipped: 0, cancelled: 0, total: 0, names: [] });
  });

  it('blocks 30 min on auth failures', async () => {
    const a = await run(fakeGh([err('To get started with GitHub CLI, please run:  gh auth login', 4)]).exec);
    expect(a.e).toMatchObject({ ok: false, error: 'gh-auth', blockedUntil: NOW + 30 * MIN });
    const b = await run(fakeGh([err('please run gh auth login', 1)]).exec);
    expect(b.e).toMatchObject({ ok: false, error: 'gh-auth', blockedUntil: NOW + 30 * MIN });
  });

  it('blocks 1 h when gh is missing (ENOENT)', async () => {
    const { e } = await run(fakeGh([err('', null, 'ENOENT')]).exec);
    expect(e).toMatchObject({ ok: false, error: 'gh-missing', blockedUntil: NOW + 60 * MIN });
  });

  it('blocks 15 min on a rate limit', async () => {
    const { e } = await run(fakeGh([err('API rate limit exceeded for user', 1)]).exec);
    expect(e).toMatchObject({ ok: false, error: 'gh-rate', blockedUntil: NOW + 15 * MIN });
  });

  it('backs off from 60 s on other failures', async () => {
    const stderr = 'GraphQL: Could not resolve to a PullRequest with the number of 128.';
    const env = sandbox();
    const first = await run(fakeGh([err(stderr, 1)]).exec, { env });
    expect(first.e).toMatchObject({ ok: false, error: 'gh-failed', blockedUntil: NOW + 60_000 });
    const second = await run(fakeGh([err(stderr, 1)]).exec, { env, prev: first.e });
    expect(second.e).toMatchObject({ ok: false, error: 'gh-failed', blockedUntil: NOW + 120_000 });
  });

  it('never stores stderr text', async () => {
    const MARK = 'ZZ-STDERR-MARK-91';
    for (const r of [
      err(`no checks reported on the '${MARK}' branch`, 1),
      err(`${MARK} gh auth login`, 4),
      err(`${MARK} rate limit`, 1),
      err(`${MARK} boom`, 1),
      { code: 0, stdout: rows('pass'), stderr: MARK },
    ]) {
      const { e, env, r: q } = await run(fakeGh([r]).exec);
      expect(JSON.stringify(e)).not.toContain(MARK);
      expect(JSON.stringify(readEnvelope(q.key, env))).not.toContain(MARK);
    }
  });

  it('caps and sanitizes check names', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: i === 0 ? `bad\u001b[31mred\u001b[0m${'x'.repeat(300)}` : `c${i}`,
      state: 'SUCCESS',
      bucket: 'pass',
    }));
    const { e } = await run(fakeGh([ok(JSON.stringify(many))]).exec);
    expect(e.value?.total).toBe(30);
    expect(e.value?.pass).toBe(30);
    expect(e.value?.names).toHaveLength(20);
    const first = e.value!.names[0]!;
    expect(first).not.toContain('\u001b');
    expect(first.startsWith('badred')).toBe(true);
    expect(first.length).toBeLessThanOrEqual(80);
  });

  it('fails on stdout that is not a check list', async () => {
    const { e } = await run(fakeGh([ok('{"not":"rows"}')]).exec);
    expect(e).toMatchObject({ ok: false, error: 'gh-failed' });
  });
});

describe('gh host gate', () => {
  const HOSTS = (...hosts: string[]) =>
    ok(JSON.stringify({ hosts: Object.fromEntries(hosts.map((h) => [h, [{ state: 'success', host: h }]])) }));

  it('refuses a host gh is not logged in to', async () => {
    const gh = fakeGh([ok(MIX)], HOSTS('github.com'));
    const env = sandbox({ GH_ENTERPRISE_TOKEN: 'ent' });
    const { e } = await run(gh.exec, { env, param: 'git.evil.example/acme/api#128' });
    expect(gh.checks()).toHaveLength(0);
    expect(e).toMatchObject({ ok: false, error: 'gh-host', blockedUntil: NOW + 60 * MIN });
    expect(gh.calls[0]?.args).toEqual(['auth', 'status', '--json', 'hosts']);
    expect(gh.calls[0]?.opts.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it('runs for a stored enterprise host and keeps its token', async () => {
    const gh = fakeGh([ok(MIX)], HOSTS('github.com', 'ghe.corp.example'));
    const env = sandbox({ GH_ENTERPRISE_TOKEN: 'ent' });
    const { e } = await run(gh.exec, { env, param: 'ghe.corp.example/acme/api#128' });
    expect(e.ok).toBe(true);
    const c = gh.checks()[0]!;
    expect(c.args).toContain('ghe.corp.example/acme/api');
    expect(c.opts.env.GH_ENTERPRISE_TOKEN).toBe('ent');
  });

  it('never asks auth status for github.com', async () => {
    const gh = fakeGh([ok(MIX)]);
    const { e } = await run(gh.exec, { env: sandbox({ GH_ENTERPRISE_TOKEN: 'ent' }) });
    expect(e.ok).toBe(true);
    expect(gh.calls.map((c) => c.args[0])).toEqual(['pr']);
    expect(gh.calls[0]?.opts.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it('checks *.ghe.com hosts against auth status too', async () => {
    const param = 'acme.ghe.com/acme/api#128';
    const off = fakeGh([ok(MIX)], HOSTS('github.com'));
    const refused = await run(off.exec, { env: sandbox(), param });
    expect(off.checks()).toHaveLength(0);
    expect(refused.e).toMatchObject({ ok: false, error: 'gh-host' });
    const on = fakeGh([ok(MIX)], HOSTS('acme.ghe.com'));
    const { e } = await run(on.exec, { env: sandbox(), param });
    expect(e.ok).toBe(true);
    expect(on.calls.map((c) => c.args[0])).toEqual(['auth', 'pr']);
  });

  it('says gh-old when gh has no auth status --json', async () => {
    const gh = fakeGh([ok(MIX)], err('unknown flag: --json\n\nUsage:  gh auth status [flags]'));
    const { e } = await run(gh.exec, { env: sandbox(), param: 'ghe.corp.example/acme/api#128' });
    expect(gh.checks()).toHaveLength(0);
    expect(e).toMatchObject({ ok: false, error: 'gh-old', blockedUntil: NOW + 60 * MIN });
  });

  it('caches the host list for about an hour', async () => {
    const env = sandbox();
    const param = 'ghe.corp.example/acme/api#128';
    const first = fakeGh([ok(MIX)], HOSTS('ghe.corp.example'));
    await run(first.exec, { env, param });
    const cached = readEnvelope<{ hosts: string[] }>('gh-hosts', env);
    expect(cached?.value?.hosts).toEqual(['ghe.corp.example']);
    const second = fakeGh([ok(MIX)], HOSTS());
    await run(second.exec, { env, param });
    expect(second.calls.map((c) => c.args[0])).toEqual(['pr']);
    writeEnvelope({ ...cached!, fetchedAt: NOW - 61 * MIN }, env);
    const third = fakeGh([ok(MIX)], HOSTS());
    const { e } = await run(third.exec, { env, param });
    expect(third.calls.map((c) => c.args[0])).toEqual(['auth']);
    expect(e.error).toBe('gh-host');
  });

  it('drops host names that are not host names', async () => {
    const env = sandbox();
    const bad = ok(
      JSON.stringify({ hosts: { 'ghe.corp.example': [], 'a b': [], '../x': [], 'ok.example:8443': [] } }),
    );
    await run(fakeGh([ok(MIX)], bad).exec, { env, param: 'ghe.corp.example/acme/api#128' });
    expect(readEnvelope<{ hosts: string[] }>('gh-hosts', env)?.value?.hosts).toEqual([
      'ghe.corp.example',
      'ok.example:8443',
    ]);
  });
});

describe('gh cadence', () => {
  const value = (pending: number): GhValue => ({
    pass: 1,
    fail: 0,
    pending,
    skipped: 0,
    cancelled: 0,
    total: 1 + pending,
    names: [],
  });
  const at = (v: GhValue, ago: number) => okEnvelope(req().key, v, NOW - ago);

  it('refreshes every 60 s while pending and 5 min when settled', () => {
    expect(ghJob.due(at(value(2), 70_000), NOW, req())).toBe(true);
    expect(ghJob.due(at(value(0), 70_000), NOW, req())).toBe(false);
    expect(ghJob.due(at(value(0), 6 * MIN), NOW, req())).toBe(true);
    expect(ghJob.due(null, NOW, req())).toBe(true);
  });
});

describe('defaultExecFile', () => {
  const opts = { timeout: 10_000, env: { PATH: process.env.PATH ?? '' }, maxBuffer: 1 << 20 };

  it('resolves stdout, stderr and the exit code without rejecting', async () => {
    const code = "process.stdout.write('[]');process.stderr.write('e');process.exit(8)";
    const r = await defaultExecFile(process.execPath, ['-e', code], opts);
    expect(r).toEqual({ code: 8, stdout: '[]', stderr: 'e' });
    expect(await defaultExecFile(process.execPath, ['-e', ''], opts)).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('reports a missing binary as ENOENT', async () => {
    const r = await defaultExecFile(path.join(os.tmpdir(), 'ccib-no-such-gh-bin'), [], opts);
    expect(r).toMatchObject({ code: null, errno: 'ENOENT' });
  });
});
