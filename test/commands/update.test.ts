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

  it('compares versions', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
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

  it('honours off, CI and the opt-out variable', () => {
    const cfg = defaultConfig();
    expect(updatesDisabled({ ...cfg, update: 'off' }, {})).toBe(true);
    expect(updatesDisabled(cfg, { CI: 'true' })).toBe(true);
    expect(updatesDisabled(cfg, {})).toBe(false);
  });

  it('does not spawn when a fresh check exists or outside the ccinfobar binary', () => {
    const env = envWith();
    writeState(env, { checkedAt: Date.now(), latest: '0.2.0' });
    scheduleCheck(defaultConfig(), env);
    expect(fs.existsSync(`${updateFile(env)}.lock`)).toBe(false);
    const stale = envWith();
    writeState(stale, { checkedAt: 0, latest: '0.2.0' });
    scheduleCheck(defaultConfig(), stale);
    expect(fs.readFileSync(updateFile(stale), 'utf8')).toContain('"checkedAt":0');
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
