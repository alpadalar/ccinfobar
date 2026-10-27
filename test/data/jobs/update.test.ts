import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../../src/core/config.js';
import type { Config } from '../../../src/core/types.js';
import { type JobCtx, type JobEnvelope, okEnvelope, writeEnvelope } from '../../../src/data/jobs/runner.js';
import {
  fromUpdateState,
  readLegacyUpdate,
  SESSION_GAP,
  toUpdateState,
  type UpdateValue,
  updateDue,
  updateJob,
} from '../../../src/data/jobs/update.js';
import {
  readUpdateState,
  rejectedUpdate,
  scheduleCheck,
  updateFile,
  updateNotice,
} from '../../../src/data/update-state.js';
import { useIdleEntry } from '../../helpers.js';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  kind: vi.fn(() => 'unknown'),
}));

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}));

vi.mock('../../../src/data/update-state.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/data/update-state.js')>()),
  installKind: mocks.kind,
}));

const HOUR = 3_600_000;

function sandbox(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-updjob-'));
  return {
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    HOME: path.join(dir, 'home'),
  };
}

const legacy = (env: NodeJS.ProcessEnv, state: object) => {
  fs.mkdirSync(path.dirname(updateFile(env)), { recursive: true });
  fs.writeFileSync(updateFile(env), JSON.stringify(state));
};
const jobsFile = (env: NodeJS.ProcessEnv, name: string) => path.join(env.CCINFOBAR_CACHE_DIR!, 'jobs', name);
const cfg = (update: Config['update']): Config => ({ ...defaultConfig(), update });

const redirect = (to: string) =>
  vi.fn(
    async () => new Response(null, { status: 302, headers: { location: to } }),
  ) as unknown as typeof fetch;

function ctx(env: NodeJS.ProcessEnv, config: Config, f: typeof fetch, now = Date.now()): JobCtx<UpdateValue> {
  return { env, config, cwd: '/', prev: updateJob.readPrev!('update', env), fetch: f, now };
}

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.execFileSync.mockReset();
  mocks.kind.mockReset();
  mocks.kind.mockReturnValue('unknown');
});

describe('updateDue', () => {
  const now = 1_000_000_000_000;
  it('keeps the daily and new-session rules', () => {
    expect(updateDue(null, now)).toBe(true);
    expect(updateDue({ checkedAt: now - HOUR, latest: '1.0.0', session: 's1' }, now, 's1')).toBe(false);
    expect(updateDue({ checkedAt: now - 25 * HOUR, latest: '1.0.0', session: 's1' }, now, 's1')).toBe(true);
    expect(updateDue({ checkedAt: now - 2 * 60_000, latest: '1.0.0', session: 's1' }, now, 's2')).toBe(true);
    expect(updateDue({ checkedAt: now - 30_000, latest: '1.0.0', session: 's1' }, now, 's2')).toBe(false);
    expect(updateDue({ checkedAt: now - SESSION_GAP, latest: null }, now, 's2')).toBe(true);
    expect(updateDue({ checkedAt: now - HOUR, latest: null }, now)).toBe(false);
  });
});

describe('update job keys', () => {
  it('gives no request when updates are off', () => {
    const input = (config: Config, env: NodeJS.ProcessEnv) => ({
      config,
      payload: { session_id: 's1' },
      env,
      cwd: '',
      now: 0,
    });
    expect(updateJob.keys(input(cfg('off'), {}))).toEqual([]);
    expect(updateJob.keys(input(cfg('auto'), { CI: '1' }))).toEqual([]);
    expect(updateJob.keys(input(cfg('auto'), { CCINFOBAR_NO_UPDATE: '1' }))).toEqual([]);
    expect(updateJob.keys(input(cfg('notify'), {}))).toEqual([{ key: 'update', param: 's1' }]);
    expect(updateJob.keys({ ...input(cfg('auto'), {}), payload: { session_id: 'a b' } })).toEqual([
      { key: 'update' },
    ]);
    expect(updateJob.keys({ ...input({ update: 'auto' } as Config, {}), payload: {} })).toEqual([
      { key: 'update' },
    ]);
    expect(updateJob.accepts({ key: 'update' }, { config: cfg('off'), env: {}, cwd: '' })).toBe(false);
    expect(updateJob.accepts({ key: 'update' }, { config: cfg('auto'), env: {}, cwd: '' })).toBe(true);
    expect(updateJob.accepts({ key: 'usage' }, { config: cfg('auto'), env: {}, cwd: '' })).toBe(false);
  });
});

describe('legacy update.json fallback', () => {
  useIdleEntry();
  it('reads the legacy file and schedules through jobs/update.lock', () => {
    const env = sandbox();
    legacy(env, { checkedAt: Date.now() - HOUR, latest: '9.9.9', session: 's1' });
    const before = fs.readFileSync(updateFile(env), 'utf8');
    expect(readUpdateState(env)).toMatchObject({ latest: '9.9.9', session: 's1' });
    expect(readLegacyUpdate(env)?.latest).toBe('9.9.9');
    scheduleCheck(cfg('notify'), 's1', env);
    expect(fs.existsSync(jobsFile(env, 'update.lock'))).toBe(false);
    scheduleCheck(cfg('notify'), 's2', env);
    expect(fs.existsSync(jobsFile(env, 'update.lock'))).toBe(true);
    expect(fs.existsSync(`${updateFile(env)}.lock`)).toBe(false);
    expect(fs.readFileSync(updateFile(env), 'utf8')).toBe(before);
  });

  it('prefers the envelope and keeps the notice text', () => {
    const env = sandbox();
    legacy(env, { checkedAt: Date.now(), latest: '0.0.1' });
    writeEnvelope(okEnvelope<UpdateValue>('update', { latest: '9.9.9' }, Date.now(), 's1'), env);
    expect(readUpdateState(env)).toMatchObject({ latest: '9.9.9', session: 's1' });
    expect(updateNotice(cfg('notify'), '0.0.1', env)).toBe('⬆ ccinfobar 9.9.9 · ccinfobar update');
  });

  it('rejectedUpdate reports only a still-current rejection newer than the running version', () => {
    const env = sandbox();
    const put = (v: UpdateValue) => writeEnvelope(okEnvelope<UpdateValue>('update', v, Date.now(), 's1'), env);
    expect(rejectedUpdate('0.1.0', env)).toBeNull();
    put({ latest: '9.9.9', rejected: '9.9.9' });
    expect(rejectedUpdate('0.1.0', env)).toEqual({ rejected: '9.9.9' });
    expect(rejectedUpdate('9.9.9', env)).toBeNull();
    put({ latest: '9.9.10', rejected: '9.9.9' });
    expect(rejectedUpdate('0.1.0', env)).toBeNull();
  });

  it('maps a failed envelope to the previous latest', () => {
    const e: JobEnvelope<UpdateValue> = {
      v: 1,
      key: 'update',
      fetchedAt: 5,
      ok: false,
      value: null,
      error: 'boom',
      lastGood: { latest: '1.2.3', installed: '1.2.3' },
      param: 's9',
    };
    expect(toUpdateState(e)).toEqual({ checkedAt: 5, latest: '1.2.3', error: 'boom', session: 's9' });
  });
});

describe('update job run', () => {
  it('fetches the latest release with the injected fetch', async () => {
    const env = sandbox();
    const f = redirect('https://github.com/alpadalar/ccinfobar/releases/tag/v9.9.9');
    const e = await updateJob.run({ key: 'update', param: 's1' }, ctx(env, cfg('notify'), f, 42));
    expect(f).toHaveBeenCalledOnce();
    expect(e).toMatchObject({ ok: true, fetchedAt: 42, value: { latest: '9.9.9' }, param: 's1' });
    expect(e.value?.installed).toBeUndefined();
  });

  it('keeps the last latest and sets no backoff on failure', async () => {
    const env = sandbox();
    legacy(env, { checkedAt: 1, latest: '1.0.0' });
    const f = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const e = await updateJob.run({ key: 'update' }, ctx(env, cfg('notify'), f, 100));
    expect(e.ok).toBe(false);
    expect(e.error).toBe('offline');
    expect(e.lastGood?.latest).toBe('1.0.0');
    expect(e.blockedUntil).toBeUndefined();
    expect(toUpdateState(e).latest).toBe('1.0.0');
    expect(updateJob.due(e, 100 + 23 * HOUR, { key: 'update' })).toBe(false);
    expect(updateJob.due(e, 100 + 24 * HOUR, { key: 'update' })).toBe(true);
  });

  it('auto-installs with installVersionAsync, never the sync install', async () => {
    mocks.kind.mockReturnValue('npm-global');
    mocks.execFile.mockImplementation(
      (_f: string, _a: string[], _o: object, cb: (e: null, out: string) => void) => {
        cb(null, '9.9.9');
        return { stdin: { end() {} } };
      },
    );
    const env = sandbox();
    const f = redirect('https://github.com/alpadalar/ccinfobar/releases/tag/v9.9.9');
    const e = await updateJob.run({ key: 'update' }, ctx(env, cfg('auto'), f));
    expect(mocks.execFile).toHaveBeenCalled();
    expect(mocks.execFile.mock.calls[0]?.[1]).toContain('ccinfobar@9.9.9');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(e).toMatchObject({ ok: true, value: { latest: '9.9.9', installed: '9.9.9' } });
  });

  it('kills npm and tries no other source once the signal aborts', async () => {
    const { installVersionAsync } = await import('../../../src/data/self-update.js');
    const ac = new AbortController();
    mocks.execFile.mockImplementation(
      (_f: string, _a: string[], o: { signal?: AbortSignal }, cb: (e: Error) => void) => {
        expect(o.signal).toBe(ac.signal);
        ac.abort();
        cb(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        return { stdin: { end() {} } };
      },
    );
    await expect(installVersionAsync('9.9.9', undefined, ac.signal)).rejects.toThrow('install cancelled');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    await expect(installVersionAsync('9.9.9', undefined, ac.signal)).rejects.toThrow('install cancelled');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('update --background runs the job and keeps the legacy session', async () => {
    const env = process.env;
    legacy(env, { checkedAt: 1, latest: '1.0.0', session: 's7' });
    vi.stubGlobal('fetch', redirect('https://github.com/alpadalar/ccinfobar/releases/tag/v9.9.9'));
    try {
      const { runUpdate } = await import('../../../src/commands/update.js');
      const cfgFile = path.join(env.CCINFOBAR_CONFIG_DIR!, 'bg-config.json');
      await runUpdate({ command: 'update', positional: [], flags: { background: true } }, cfgFile);
    } finally {
      vi.unstubAllGlobals();
    }
    const e = JSON.parse(fs.readFileSync(jobsFile(env, 'update.json'), 'utf8'));
    expect(e).toMatchObject({ v: 1, key: 'update', ok: true, value: { latest: '9.9.9' }, param: 's7' });
    expect(JSON.parse(fs.readFileSync(updateFile(env), 'utf8')).latest).toBe('1.0.0');
    expect(fs.existsSync(jobsFile(env, 'update.lock'))).toBe(false);
  });
});

describe('rejected updates', () => {
  it('round-trips rejected, rollback and reason and drops a bad rollback', () => {
    const e = okEnvelope<UpdateValue>(
      'update',
      { latest: '9.9.9', rejected: '9.9.9', rollback: 'ok', reason: 'version-mismatch:1.0.0' },
      7,
    );
    const s = toUpdateState(e);
    expect(s).toMatchObject({ rejected: '9.9.9', rollback: 'ok', reason: 'version-mismatch:1.0.0' });
    expect(fromUpdateState(s).value).toEqual({
      latest: '9.9.9',
      rejected: '9.9.9',
      rollback: 'ok',
      reason: 'version-mismatch:1.0.0',
    });
    const bad = okEnvelope('update', { latest: '9.9.9', rejected: '9.9.9', rollback: 'maybe' }, 7);
    const t = toUpdateState(bad as unknown as JobEnvelope<UpdateValue>);
    expect(t.rollback).toBeUndefined();
    expect(t.rejected).toBe('9.9.9');
  });

  it('run() skips the install of a version the previous envelope rejected', async () => {
    mocks.kind.mockReturnValue('npm-global');
    const env = sandbox();
    writeEnvelope(okEnvelope('update', { latest: '9.9.9', rejected: '9.9.9', rollback: 'ok' }, 1), env);
    const f = redirect('https://github.com/alpadalar/ccinfobar/releases/tag/v9.9.9');
    const e = await updateJob.run({ key: 'update' }, ctx(env, cfg('auto'), f));
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(e).toMatchObject({ ok: true, value: { latest: '9.9.9', rejected: '9.9.9' } });
  });
});
