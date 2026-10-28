import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import { lastPayloadPath } from '../../../src/core/paths.js';
import type { Config, WidgetItem } from '../../../src/core/types.js';
import { cacheKey } from '../../../src/data/cache.js';
import { type CommandValue, commandGroups, commandJob } from '../../../src/data/jobs/command.js';
import { JOBS, jobFor } from '../../../src/data/jobs/index.js';
import {
  type ExecFileLike,
  executeJob,
  type JobCtx,
  okEnvelope,
  readEnvelope,
} from '../../../src/data/jobs/runner.js';

const NOW = 1_800_000_000_000;
const sandbox = (): NodeJS.ProcessEnv => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cmd-'));
  return { HOME: dir, CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'), CCINFOBAR_NO_UPDATE: '1' };
};
let n = 0;
const item = (options: WidgetItem['options']): WidgetItem => ({ id: `c${n++}`, type: 'command', options });
const cfg = (...items: WidgetItem[]): Config => ({ ...defaultConfig(), lines: [items] });
const config = cfg(
  item({ command: 'echo a', cacheSeconds: 30, background: true, timeout: 2500 }),
  item({ command: 'echo b', cacheSeconds: 0, background: true }),
  item({ command: 'echo c', cacheSeconds: 30 }),
);
const KEY = `cmd-${cacheKey('echo a', '/w')}`;

describe('commandJob', () => {
  it('is registered and keyed by command and cwd', () => {
    expect(JOBS).toContain(commandJob);
    expect(jobFor(KEY)).toBe(commandJob);
    expect(commandJob.keyRe.test(KEY)).toBe(true);
    expect(commandJob.keyRe.test('cmd-x')).toBe(false);
    const env = sandbox();
    const reqs = commandJob.keys({ config, payload: {}, env, cwd: '/w', now: NOW });
    expect(reqs).toEqual([{ key: KEY, ttlMs: 30_000 }]);
    expect(commandJob.accepts({ key: KEY }, { config, env, cwd: '/w' })).toBe(true);
    expect(commandJob.accepts({ key: KEY }, { config, env, cwd: '/other' })).toBe(false);
    expect(commandJob.accepts({ key: `cmd-${'0'.repeat(20)}` }, { config, env, cwd: '/w' })).toBe(false);
  });

  it('holds its lock longer than the job may run', () => {
    expect(commandJob.lockMs).toBeGreaterThan(commandJob.timeoutMs);
  });

  it('is due every cacheSeconds', () => {
    const req = { key: KEY, ttlMs: 30_000 };
    expect(commandJob.due(null, NOW, req)).toBe(true);
    const e = okEnvelope<CommandValue>(KEY, { out: 'x' }, NOW - 10_000);
    expect(commandJob.due(e, NOW, req)).toBe(false);
    expect(commandJob.due(e, NOW + 21_000, req)).toBe(true);
  });

  const runWith = async (env: NodeJS.ProcessEnv, exec: ExecFileLike, c: Config = config) => {
    const ctx: JobCtx<CommandValue> = {
      env,
      config: c,
      cwd: '/w',
      prev: readEnvelope<CommandValue>(KEY, env),
      fetch: globalThis.fetch,
      now: NOW,
      execFile: exec,
    };
    return executeJob(commandJob, { key: KEY }, ctx);
  };

  it('runs through the injected spawner with shell, cwd, timeout and the saved payload', async () => {
    const env = sandbox();
    fs.mkdirSync(path.dirname(lastPayloadPath(env)), { recursive: true });
    fs.writeFileSync(lastPayloadPath(env), '{"a":1}');
    const seen: Parameters<ExecFileLike>[] = [];
    const exec: ExecFileLike = async (...a) => {
      seen.push(a);
      return { code: 0, stdout: '\n\u001b[31mhello\u001b[0m world\nsecond\n', stderr: '' };
    };
    const env1 = await runWith(env, exec);
    expect(seen).toHaveLength(1);
    const [file, args, opts] = seen[0]!;
    expect(file).toBe('echo a');
    expect(args).toEqual([]);
    expect(opts).toMatchObject({
      shell: true,
      windowsHide: true,
      cwd: '/w',
      timeout: 2500,
      input: '{"a":1}',
    });
    expect(env1.ok).toBe(true);
    expect(env1.value?.out).toBe('hello world');
  });

  it('feeds {} when no payload was saved and caps the output', async () => {
    const env = sandbox();
    let input: string | undefined;
    const exec: ExecFileLike = async (_f, _a, o) => {
      input = o.input;
      return { code: 0, stdout: 'y'.repeat(5000), stderr: '' };
    };
    const e = await runWith(env, exec);
    expect(input).toBe('{}');
    expect(e.value?.out).toHaveLength(1024);
  });

  it('turns a failure or timeout into a failed envelope with a 60 s retry', async () => {
    const env = sandbox();
    const bad = await runWith(env, async () => ({ code: 3, stdout: '', stderr: '' }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('exit-3');
    const slow = await runWith(env, async () => ({ code: null, stdout: '', stderr: '' }));
    expect(slow.error).toBe('timeout');
    expect(slow.blockedUntil).toBeGreaterThanOrEqual(NOW + 60_000);
  });

  it('fails not-configured when the item vanished', async () => {
    const e = await runWith(sandbox(), async () => ({ code: 0, stdout: 'x', stderr: '' }), cfg());
    expect(e.ok).toBe(false);
    expect(e.error).toBe('not-configured');
  });

  it('groups only background items with a cache', () => {
    expect([...commandGroups(config, '/w').keys()]).toEqual([KEY]);
  });

  it('reads background the way the widget does: true and "true" count, "false" does not', () => {
    const groups = (background: unknown) => [
      ...commandGroups(
        cfg(item({ command: 'echo a', cacheSeconds: '30', background } as WidgetItem['options'])),
        '/w',
      ).keys(),
    ];
    expect(groups(true)).toEqual([KEY]);
    expect(groups('true')).toEqual([KEY]);
    expect(groups('false')).toEqual([]);
    expect(groups('yes')).toEqual([]);
  });
});
