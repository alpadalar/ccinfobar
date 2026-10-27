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

  it('uses the URL without a digest', async () => {
    failFirst();
    await installVersionAsync('9.9.9', undefined, undefined, fakeFetch([release()]).fetch);
    expect(specs()[1]).toMatch(/^https:\/\/github\.com\//);
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
