import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, execFile: (...a: unknown[]) => mocks.execFile(...a) };
});

const { checkForUpdate, verifyInstall } = await import('../../src/data/self-update.js');
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
