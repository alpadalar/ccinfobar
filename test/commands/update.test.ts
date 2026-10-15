import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  availableUpdate,
  compareVersions,
  installKind,
  scheduleCheck,
  updateFile,
  updateNotice,
  updatesDisabled,
} from '../../src/commands/update.js';
import { defaultConfig } from '../../src/core/config.js';

const envWith = () =>
  ({ CCINFOBAR_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-upd-')) }) as NodeJS.ProcessEnv;
const writeState = (env: NodeJS.ProcessEnv, state: object) => {
  fs.mkdirSync(path.dirname(updateFile(env)), { recursive: true });
  fs.writeFileSync(updateFile(env), JSON.stringify(state));
};
const lock = (env: NodeJS.ProcessEnv) =>
  fs.existsSync(path.join(env.CCINFOBAR_CACHE_DIR!, 'jobs', 'update.lock'));
const jobState = (env: NodeJS.ProcessEnv) => path.join(env.CCINFOBAR_CACHE_DIR!, 'jobs', 'update.json');

describe('update', () => {
  it('rejects anything that is not a plain version', async () => {
    const { assertVersion, tarballUrl } = await import('../../src/commands/update.js');
    expect(assertVersion('0.3.0')).toBe('0.3.0');
    expect(assertVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    for (const bad of ['0.3.0 & calc', '0.3.0"', '../x', '0.3', 'v0.3.0', '0.3.0;rm']) {
      expect(() => assertVersion(bad)).toThrow();
      expect(() => tarballUrl(bad)).toThrow();
    }
  });

  it('installs from npm first and falls back to the GitHub release', async () => {
    const { installSources, selfCommand } = await import('../../src/commands/update.js');
    expect(installSources('0.5.1')).toEqual([
      'ccinfobar@0.5.1',
      'https://github.com/alpadalar/ccinfobar/releases/download/v0.5.1/ccinfobar.tgz',
    ]);
    expect(() => installSources('0.5.1 && x')).toThrow();
    expect(selfCommand('npx')).toBe('npx ccinfobar@latest');
    expect(selfCommand('npm-global')).toBe('ccinfobar');
  });

  it('runs npm without install scripts and quotes args for the Windows shell', async () => {
    const { npmCommand, npmInstallRuns, shellArg } = await import('../../src/commands/update.js');
    const node = { file: '/n/node', args: ['/n/npm-cli.js'], shell: false };
    const plain = npmInstallRuns('0.5.1', '/home/a b/app', node);
    expect(plain.opts.shell).toBe(false);
    expect(plain.runs[0]).toEqual([
      '/n/npm-cli.js',
      'install',
      '--prefix',
      '/home/a b/app',
      '--save-exact',
      'ccinfobar@0.5.1',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ]);
    expect(plain.runs[1]).toContain('--ignore-scripts');
    const win = npmInstallRuns('0.5.1', 'C:\\Users\\A B\\ccinfobar\\app', {
      file: 'npm.cmd',
      args: [],
      shell: true,
    });
    expect(win.runs[0]?.[2]).toBe('"C:\\Users\\A B\\ccinfobar\\app"');
    expect(win.runs[1]?.[4]).toBe(
      'https://github.com/alpadalar/ccinfobar/releases/download/v0.5.1/ccinfobar.tgz',
    );
    expect(shellArg('-g')).toBe('-g');
    const none = () => false;
    expect(npmCommand({ platform: 'win32', env: {}, exists: none })).toEqual({
      file: 'npm.cmd',
      args: [],
      shell: true,
    });
    const viaNpx = npmCommand({
      execPath: '/n/node',
      platform: 'win32',
      env: { npm_execpath: '/x/npm/bin/npm-cli.js' },
      exists: (f) => f === '/x/npm/bin/npm-cli.js',
    });
    expect(viaNpx).toEqual({ file: '/n/node', args: ['/x/npm/bin/npm-cli.js'], shell: false });
  });

  it('compares versions', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
    expect(compareVersions('1.0.1-beta', '1.0.0')).toBeGreaterThan(0);
  });

  it('shows a notice only in notify mode when a newer release is cached', () => {
    const env = envWith();
    const cfg = { ...defaultConfig(), update: 'notify' as const };
    expect(updateNotice(cfg, '0.2.0', env)).toBeNull();
    writeState(env, { checkedAt: Date.now(), latest: '0.3.0' });
    expect(availableUpdate('0.2.0', env)).toBe('0.3.0');
    expect(updateNotice(cfg, '0.2.0', env)).toBe('⬆ ccinfobar 0.3.0 · ccinfobar update');
    expect(updateNotice(cfg, '0.3.0', env)).toBeNull();
    expect(updateNotice({ ...cfg, update: 'auto' }, '0.2.0', env)).toBeNull();
    expect(updateNotice(cfg, '0.2.0', { ...env, CCINFOBAR_NO_UPDATE: '1' })).toBeNull();
  });

  it('treats a corrupt update.json as having no update', () => {
    const env = envWith();
    const cfg = { ...defaultConfig(), update: 'notify' as const };
    for (const state of [
      { checkedAt: 1, latest: 42 },
      { latest: { x: 1 } },
      [1, 2],
      { latest: '1.0.0\u001b]0;x' },
    ]) {
      writeState(env, state);
      expect(() => updateNotice(cfg, '0.2.0', env)).not.toThrow();
      expect(updateNotice(cfg, '0.2.0', env)).toBeNull();
      expect(availableUpdate('0.2.0', env)).toBeNull();
    }
    expect(compareVersions(42 as unknown as string, '1.0.0')).toBe(0);
  });

  it('honours off, CI and the opt-out variable', () => {
    const cfg = defaultConfig();
    expect(updatesDisabled({ ...cfg, update: 'off' }, {})).toBe(true);
    expect(updatesDisabled(cfg, { CI: 'true' })).toBe(true);
    expect(updatesDisabled(cfg, {})).toBe(false);
  });

  it('does not spawn when a fresh check exists or outside the ccinfobar binary', () => {
    const env = envWith();
    writeState(env, { checkedAt: Date.now(), latest: '0.2.0' });
    scheduleCheck(defaultConfig(), undefined, env);
    expect(lock(env)).toBe(false);
    const stale = envWith();
    writeState(stale, { checkedAt: 0, latest: '0.2.0' });
    scheduleCheck(defaultConfig(), undefined, stale);
    expect(lock(stale)).toBe(true);
    expect(fs.readFileSync(updateFile(stale), 'utf8')).toContain('"checkedAt":0');
    expect(fs.existsSync(`${updateFile(stale)}.lock`)).toBe(false);
    expect(fs.existsSync(jobState(stale))).toBe(false);
  });

  it('schedules no background check when nonessential traffic is off', () => {
    const off = { ...envWith(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    writeState(off, { checkedAt: 0, latest: '0.2.0' });
    scheduleCheck(defaultConfig(), 'a', off);
    expect(lock(off)).toBe(false);
    const empty = { ...envWith(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' };
    writeState(empty, { checkedAt: 0, latest: '0.2.0' });
    scheduleCheck(defaultConfig(), 'a', empty);
    expect(lock(empty)).toBe(true);
  });

  it('checks again when a new Claude Code session starts', () => {
    const env = envWith();
    writeState(env, { checkedAt: Date.now() - 120_000, latest: '0.2.0', session: 'a' });
    scheduleCheck(defaultConfig(), 'a', env);
    expect(lock(env)).toBe(false);
    scheduleCheck(defaultConfig(), 'b', env);
    expect(lock(env)).toBe(true);
    // the worker stores the session, not the renderer
    expect(JSON.parse(fs.readFileSync(updateFile(env), 'utf8')).session).toBe('a');
    expect(fs.existsSync(jobState(env))).toBe(false);
    const recent = envWith();
    writeState(recent, { checkedAt: Date.now(), latest: '0.2.0', session: 'a' });
    scheduleCheck(defaultConfig(), 'b', recent);
    expect(lock(recent)).toBe(false);
  });

  it('detects how it was installed', () => {
    expect(installKind('/home/u/.npm-global/lib/node_modules/ccinfobar/dist/ccinfobar.js')).toBe(
      'npm-global',
    );
    expect(
      installKind('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ccinfobar\\dist\\ccinfobar.js'),
    ).toBe('npm-global');
    expect(installKind('/home/u/.npm/_npx/abc/node_modules/ccinfobar/dist/ccinfobar.js')).toBe('npx');
    expect(installKind(path.resolve(__dirname, '../../dist/ccinfobar.js'))).toBe('source');
  });
});
