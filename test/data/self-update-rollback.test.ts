import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import { fakeFetch, json, streamed } from '../fake-fetch.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, execFile: (...a: unknown[]) => mocks.execFile(...a) };
});

const { checkForUpdate, fetchTarball, installVersionAsync, releaseDigest, verifyInstall } = await import(
  '../../src/data/self-update.js'
);
const realExecFile = (await vi.importActual<typeof import('node:child_process')>('node:child_process'))
  .execFile;

const cfg: Config = { ...defaultConfig(), update: 'auto' };
const latest = async () => '9.9.9';
const base = { kind: 'npm-global' as const, fetchLatest: latest };

beforeEach(() => {
  mocks.execFile.mockReset();
});

describe('checkForUpdate verify and rollback', () => {
  it('reinstalls the running version and records the rejection when verify fails', async () => {
    const install = vi.fn();
    const verify = vi.fn(async (v: string) => (v === '9.9.9' ? 'version-mismatch:1.0.0' : null));
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify });
    expect(install.mock.calls.map((c) => c[0])).toEqual(['9.9.9', '0.1.0']);
    expect(out).toEqual({
      latest: '9.9.9',
      rejected: '9.9.9',
      rollback: 'ok',
      reason: 'version-mismatch:1.0.0',
    });
    expect(out.installed).toBeUndefined();
  });

  it('skips the install of a rejected version', async () => {
    const install = vi.fn();
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, rejected: '9.9.9' });
    expect(install).not.toHaveBeenCalled();
    expect(out).toEqual({ latest: '9.9.9', rejected: '9.9.9' });
  });

  it('reports a failed rollback when verify of the old version fails or its install throws', async () => {
    const verify = async () => 'render-failed:1';
    const a = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install: vi.fn(), verify });
    expect(a.rollback).toBe('failed');
    let n = 0;
    const install = vi.fn(async () => {
      if (++n === 2) throw new Error('npm down');
    });
    const b = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify });
    expect(b).toMatchObject({ rejected: '9.9.9', rollback: 'failed', reason: 'render-failed:1' });
  });

  it('gives the rollback its own budget and records the rejection before it starts', async () => {
    const ac = new AbortController();
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const install = vi.fn(async (v: string, _p?: string, signal?: AbortSignal) => {
      calls.push(`install:${v}`);
      signals.push(signal!);
      if (v === '9.9.9') ac.abort();
    });
    const verify = async (v: string) => (v === '9.9.9' ? 'render-failed:1' : null);
    const recordRejected = vi.fn(() => {
      calls.push('record');
    });
    const out = await checkForUpdate(
      cfg,
      '0.1.0',
      {},
      { ...base, install, verify, recordRejected, signal: ac.signal },
    );
    expect(calls).toEqual(['install:9.9.9', 'record', 'install:0.1.0']);
    expect(signals[1]!.aborted).toBe(false);
    expect(out).toMatchObject({ rejected: '9.9.9', rollback: 'ok' });
    expect(recordRejected).toHaveBeenCalledWith({
      latest: '9.9.9',
      rejected: '9.9.9',
      rollback: 'failed',
      reason: 'render-failed:1',
    });
  });

  it('still rejects the version when the rollback runs out of its budget', async () => {
    const install = vi.fn(
      (v: string, _p?: string, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          if (v === '9.9.9') return resolve();
          signal?.addEventListener('abort', () => reject(new Error('install cancelled')));
        }),
    );
    const verify = async (v: string) => (v === '9.9.9' ? 'render-failed:1' : null);
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify, rollbackMs: 20 });
    expect(out).toMatchObject({ rejected: '9.9.9', rollback: 'failed', reason: 'render-failed:1' });
  });

  it('keeps the install and records an error when the machine, not the version, failed to verify', async () => {
    for (const why of ['entry-missing', 'verify-failed']) {
      const install = vi.fn();
      const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify: async () => why });
      expect(install).toHaveBeenCalledTimes(1);
      expect(out).toEqual({ latest: '9.9.9', installed: '9.9.9', error: `verify-inconclusive:${why}` });
      expect(out.rejected).toBeUndefined();
    }
  });

  it('rejects a version whose verify hangs after rolling back (D-02)', async () => {
    const install = vi.fn();
    const recordRejected = vi.fn();
    const verify = async (v: string) => (v === '9.9.9' ? 'verify-timeout' : null);
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify, recordRejected });
    expect(install.mock.calls.map((c) => c[0])).toEqual(['9.9.9', '0.1.0']);
    expect(recordRejected).toHaveBeenCalledTimes(1);
    expect(recordRejected).toHaveBeenCalledWith({
      latest: '9.9.9',
      rejected: '9.9.9',
      rollback: 'failed',
      reason: 'verify-timeout',
    });
    expect(recordRejected.mock.invocationCallOrder[0]!).toBeLessThan(install.mock.invocationCallOrder[1]!);
    expect(out).toEqual({ latest: '9.9.9', rejected: '9.9.9', rollback: 'ok', reason: 'verify-timeout' });
    const bad = await checkForUpdate(
      cfg,
      '0.1.0',
      {},
      { ...base, install, verify: async () => 'verify-timeout' },
    );
    expect(bad).toEqual({
      latest: '9.9.9',
      rejected: '9.9.9',
      rollback: 'unverified',
      reason: 'verify-timeout',
    });
  });

  it("reports an unverified rollback when the restored version's check times out (16.2-D-02)", async () => {
    const install = vi.fn();
    const recordRejected = vi.fn();
    const verify = async (v: string) => (v === '9.9.9' ? 'render-failed:1' : 'verify-timeout');
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify, recordRejected });
    expect(out).toEqual({
      latest: '9.9.9',
      rejected: '9.9.9',
      rollback: 'unverified',
      reason: 'render-failed:1',
    });
    expect(install.mock.calls.map((c) => c[0])).toEqual(['9.9.9', '0.1.0']);
    expect(recordRejected).toHaveBeenCalledTimes(1);
    expect(recordRejected.mock.calls[0]![0].rollback).toBe('failed');
    expect(recordRejected.mock.invocationCallOrder[0]!).toBeLessThan(install.mock.invocationCallOrder[1]!);
    for (const why of ['verify-timeout', 'verify-failed', 'entry-missing']) {
      const r = await checkForUpdate(
        cfg,
        '0.1.0',
        {},
        { ...base, install: vi.fn(), verify: async (v: string) => (v === '9.9.9' ? 'render-failed:1' : why) },
      );
      expect(r.rollback).toBe('unverified');
    }
  });

  it('keeps a failed rollback for a real failure of the restored version (16.2-D-02)', async () => {
    const mismatch = await checkForUpdate(
      cfg,
      '0.1.0',
      {},
      {
        ...base,
        install: vi.fn(),
        verify: async (v: string) => (v === '9.9.9' ? 'render-failed:1' : 'version-mismatch:0.0.9'),
      },
    );
    expect(mismatch.rollback).toBe('failed');
    const verify = vi.fn(async (v: string) => (v === '9.9.9' ? 'render-failed:1' : null));
    const install = vi.fn(async (v: string) => {
      if (v === '0.1.0') throw new Error('npm down');
    });
    const threw = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify });
    expect(threw.rollback).toBe('failed');
    expect(verify.mock.calls.map((c) => c[0])).toEqual(['9.9.9']);
  });

  it('installs a hanging version only once across two daily runs', async () => {
    const install = vi.fn();
    const verify = async (v: string) => (v === '9.9.9' ? 'verify-timeout' : null);
    const run1 = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify });
    install.mockClear();
    const run2 = await checkForUpdate(
      cfg,
      '0.1.0',
      {},
      { ...base, install, verify, rejected: run1.rejected },
    );
    expect(install).not.toHaveBeenCalled();
    expect(run2).toEqual({ latest: '9.9.9', rejected: '9.9.9' });
  });

  it('keeps the install when verify passes', async () => {
    const install = vi.fn();
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify: async () => null });
    expect(out).toEqual({ latest: '9.9.9', installed: '9.9.9' });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('never spawns the default verify when install is stubbed', async () => {
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install: vi.fn() });
    expect(out).toEqual({ latest: '9.9.9', installed: '9.9.9' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});

describe('verifyInstall with a real node child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-verify-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    return f;
  };
  const ver = "if (process.argv[2] === '--version') { console.log('9.9.9'); process.exit(0); }";
  const good = script('good.js', `${ver}\nconsole.log('model | cost');`);
  const envcheck = script(
    'envcheck.js',
    `${ver}\nrequire('node:fs').writeFileSync(process.env.CCIB_TEST_REPORT, JSON.stringify(process.env));\nconsole.log('model | cost');`,
  );
  const bad = script('bad.js', `${ver}\nprocess.exit(2);`);
  const safe = script('safe.js', `${ver}\nconsole.log('ccinfobar: invalid JSON on stdin');`);

  beforeEach(() => {
    mocks.execFile.mockImplementation((...a: Parameters<typeof realExecFile>) => realExecFile(...a));
  });

  it('accepts a working entry', async () => {
    expect(await verifyInstall('9.9.9', process.env, undefined, good)).toBeNull();
  });

  it('rejects a version mismatch, a failing render and a safe-line render', async () => {
    expect(await verifyInstall('1.0.0', process.env, undefined, good)).toMatch(/^version-mismatch:/);
    expect(await verifyInstall('9.9.9', process.env, undefined, bad)).toBe('render-failed:2');
    expect(await verifyInstall('9.9.9', process.env, undefined, safe)).toBe('render-failed:0');
  });

  it("isolates the render from the user's config env (D-01)", async () => {
    const cfg = path.join(dir, 'user-config.json');
    const content = '{"lines":[[{"type":"model"}]]}';
    fs.writeFileSync(cfg, content);
    const mtime = fs.statSync(cfg).mtimeMs;
    const report = path.join(dir, 'env-report.json');
    const env = {
      ...process.env,
      CCINFOBAR_CONFIG: cfg,
      CLAUDE_POWERLINE_CONFIG: cfg,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
      XDG_CONFIG_HOME: dir,
      XDG_CACHE_HOME: dir,
      APPDATA: dir,
      LOCALAPPDATA: dir,
      CCIB_TEST_REPORT: report,
    };
    expect(await verifyInstall('9.9.9', env, undefined, envcheck)).toBeNull();
    const seen = JSON.parse(fs.readFileSync(report, 'utf8')) as Record<string, string>;
    for (const k of [
      'CCINFOBAR_CONFIG',
      'CLAUDE_POWERLINE_CONFIG',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'APPDATA',
      'LOCALAPPDATA',
    ]) {
      expect(seen[k]).toBeUndefined();
    }
    for (const k of ['CCINFOBAR_CONFIG_DIR', 'CCINFOBAR_CACHE_DIR', 'CLAUDE_CONFIG_DIR']) {
      expect(seen[k]).toContain('ccinfobar-verify-');
    }
    expect(seen.CCIB_TEST_REPORT).toBe(report);
    expect(seen.PATH).toBeDefined();
    expect(fs.readFileSync(cfg, 'utf8')).toBe(content);
    expect(fs.statSync(cfg).mtimeMs).toBe(mtime);
  });

  it('reports a missing entry', async () => {
    expect(await verifyInstall('9.9.9', process.env, undefined, path.join(dir, 'nope.js'))).toBe(
      'entry-missing',
    );
  });
});

describe('tarball digest verification', () => {
  const bytes = Buffer.from('tarball-bytes');
  const hex = createHash('sha256').update(bytes).digest('hex');
  const release = (digest?: unknown) => json({ assets: [{ name: 'ccinfobar.tgz', digest }] });
  const tgz = () => new Response(bytes);
  const failFirst = () => {
    let n = 0;
    mocks.execFile.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as (e: Error | null, o: string, s: string) => void;
      cb(++n === 1 ? new Error('npm down') : null, '', '');
      return { stdin: { end() {} } };
    });
  };
  const specs = () =>
    mocks.execFile.mock.calls.map((c) => (c[1] as string[]).find((x) => /ccinfobar/.test(x)));

  it('releaseDigest returns the hex or null', async () => {
    expect(await releaseDigest('9.9.9', fakeFetch([release(`sha256:${hex}`)]).fetch)).toBe(hex);
    expect(await releaseDigest('9.9.9', fakeFetch([release('md5:abc')]).fetch)).toBeNull();
    expect(await releaseDigest('9.9.9', fakeFetch([json({ assets: [] })]).fetch)).toBeNull();
    expect(await releaseDigest('9.9.9', fakeFetch([json({}, 404)]).fetch)).toBeNull();
  });

  it('fetchTarball rejects a mismatch without writing', async () => {
    const file = path.join(os.tmpdir(), `ccinfobar-9.9.9-${process.pid}.tgz`);
    fs.rmSync(file, { force: true });
    await expect(fetchTarball('9.9.9', 'a'.repeat(64), fakeFetch([tgz()]).fetch)).rejects.toThrow(
      'checksum-mismatch',
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it('writes the tarball into a fresh private dir and never follows a planted symlink', async () => {
    const victim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-victim-')), 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    const planted = path.join(os.tmpdir(), `ccinfobar-9.9.9-${process.pid}.tgz`);
    fs.rmSync(planted, { force: true });
    fs.symlinkSync(victim, planted);
    let file = '';
    try {
      file = await fetchTarball('9.9.9', hex, fakeFetch([tgz()]).fetch);
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
      expect(path.dirname(file)).not.toBe(os.tmpdir());
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(planted, { force: true });
      if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.rmSync(path.dirname(victim), { recursive: true, force: true });
    }
  });

  it('stops reading the body once the size cap is passed', async () => {
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const probe = streamed([chunk, chunk, chunk, chunk, chunk]);
    await expect(fetchTarball('9.9.9', hex, fakeFetch([new Response(probe.body)]).fetch)).rejects.toThrow(
      'tarball-too-large',
    );
    expect(probe.cancelled()).toBe(true);
    expect(probe.pulls()).toBeLessThanOrEqual(5);
  });

  it('installs the verified local tarball after a registry failure and removes it', async () => {
    failFirst();
    const f = fakeFetch([release(`sha256:${hex}`), tgz()]);
    await installVersionAsync('9.9.9', undefined, undefined, f.fetch);
    const second = specs()[1] as string;
    expect(second.endsWith('.tgz')).toBe(true);
    expect(second.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.existsSync(path.dirname(second))).toBe(false);
  });

  it('skips the tarball when GitHub gives no digest (SEC2-11)', async () => {
    for (const responses of [[json({ assets: [] })], [json({}, 403)], [new Error('offline')]]) {
      mocks.execFile.mockReset();
      failFirst();
      const f = fakeFetch(responses as never);
      await expect(installVersionAsync('9.9.9', undefined, undefined, f.fetch)).rejects.toThrow(
        'digest-unavailable',
      );
      expect(specs()).toEqual(['ccinfobar@9.9.9']);
    }
  });

  it('records a rollback whose reinstall has no digest as failed, installing nothing', async () => {
    const f = fakeFetch([json({}, 403)]);
    mocks.execFile.mockImplementation((...a: unknown[]) => {
      const cb = a[a.length - 1] as (e: Error | null, o: string, s: string) => void;
      cb(new Error('npm down'), '', '');
      return { stdin: { end() {} } };
    });
    const seen: string[] = [];
    let calls = 0;
    const install = async (v: string) => {
      if (++calls === 2) {
        try {
          await installVersionAsync(v, undefined, undefined, f.fetch);
        } catch (err) {
          seen.push((err as Error).message);
          throw err;
        }
      }
    };
    const verify = async (v: string) => (v === '9.9.9' ? 'render-failed:1' : null);
    const out = await checkForUpdate(cfg, '0.1.0', {}, { ...base, install, verify });
    expect(out).toMatchObject({ rejected: '9.9.9', rollback: 'failed', reason: 'render-failed:1' });
    expect(seen).toEqual(['digest-unavailable']);
    expect(specs()).toEqual(['ccinfobar@0.1.0']);
  });

  it('aborts on a mismatch before npm runs the fallback', async () => {
    failFirst();
    const f = fakeFetch([release(`sha256:${'b'.repeat(64)}`), tgz()]);
    await expect(installVersionAsync('9.9.9', undefined, undefined, f.fetch)).rejects.toThrow(
      'checksum-mismatch',
    );
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });
});
