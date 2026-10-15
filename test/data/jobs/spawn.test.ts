import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as { file: string; args: string[]; opts: Record<string, unknown> }[]);

vi.mock('node:child_process', async (orig) => {
  const child = () => Object.assign(new EventEmitter(), { unref() {}, stdin: { end() {} }, pid: 1 });
  return {
    ...(await orig<typeof import('node:child_process')>()),
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      return child();
    },
    execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: (e: null) => void) => {
      calls.push({ file, args, opts });
      setImmediate(() => cb(null));
      return child();
    },
  };
});

const { absoluteEnv, safeCwd, spawnSelf } = await import('../../../src/data/jobs/runner.js');
const { defaultExecFile } = await import('../../../src/data/jobs/gh-exec.js');
const { ghJob } = await import('../../../src/data/jobs/gh.js');
const { executeJob } = await import('../../../src/data/jobs/runner.js');

const argv1 = process.argv[1]!;

afterEach(() => {
  process.argv[1] = argv1;
  calls.length = 0;
});

describe('worker spawn', () => {
  it('starts the worker in a safe cwd, never the project dir', () => {
    process.argv[1] = path.join(os.tmpdir(), 'bin', 'ccinfobar.js');
    expect(spawnSelf(['worker', 'update'], { CCINFOBAR_CACHE_DIR: '/abs/cache' })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.cwd).toBe(safeCwd());
    expect(calls[0]!.opts.cwd).not.toBe(process.cwd());
    expect((calls[0]!.opts.env as NodeJS.ProcessEnv).CCINFOBAR_CACHE_DIR).toBe('/abs/cache');
  });

  it('makes relative config and cache dirs absolute for the worker', () => {
    const env = { CCINFOBAR_CACHE_DIR: 'rel/cache', CLAUDE_CONFIG_DIR: 'rel/claude', OTHER: 'x/y' };
    const out = absoluteEnv(env);
    expect(out.CCINFOBAR_CACHE_DIR).toBe(path.resolve('rel/cache'));
    expect(out.CLAUDE_CONFIG_DIR).toBe(path.resolve('rel/claude'));
    expect(out.OTHER).toBe('x/y');
    expect(env.CCINFOBAR_CACHE_DIR).toBe('rel/cache');
    const abs = { CCINFOBAR_CACHE_DIR: path.resolve('a') };
    expect(absoluteEnv(abs)).toBe(abs);
  });

  it('runs gh from a safe cwd', async () => {
    await defaultExecFile('gh', ['--version'], { timeout: 1000, env: {}, maxBuffer: 1024, cwd: '/safe' });
    expect(calls[0]).toMatchObject({ file: 'gh', opts: { cwd: '/safe' } });
    const seen: (string | undefined)[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-spawn-'));
    const env = { CCINFOBAR_CACHE_DIR: dir, CCINFOBAR_CONFIG_DIR: dir };
    const param = 'ghe.corp.example/o/r#1';
    await executeJob(
      ghJob,
      { key: 'gh-0000000000000000', param },
      {
        env,
        config: { lines: [[{ id: 'p', type: 'pr', options: { ci: true } }]] } as never,
        cwd: '/',
        prev: null,
        fetch: globalThis.fetch,
        execFile: async (_f, _a, opts) => {
          seen.push(opts.cwd);
          return { code: 0, stdout: JSON.stringify({ hosts: { 'ghe.corp.example': [] } }), stderr: '' };
        },
        now: Date.now(),
      },
    );
    expect(seen).toHaveLength(2);
    expect(seen.every((c) => c === safeCwd())).toBe(true);
  });
});
