import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BREW_UPGRADE,
  brewPrefix,
  checkForUpdate,
  effectiveUpdate,
  type InstallKind,
  installKind,
  localPrefix,
  manualUpdate,
  readUpdateState,
  updateHint,
  updateNotice,
} from '../../src/commands/update.js';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage, t } from '../../src/core/i18n/index.js';
import type { Config } from '../../src/core/types.js';
import { executeJob } from '../../src/data/jobs/runner.js';
import { updateJob } from '../../src/data/jobs/update.js';

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), execFileSync: vi.fn() }));

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}));

const root = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), 'ccib-brew-upd-'));
let n = 0;
function sandbox(): NodeJS.ProcessEnv {
  const dir = path.join(root, `s${n++}`);
  return {
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    HOME: path.join(dir, 'home'),
    USERPROFILE: path.join(dir, 'home'),
  };
}
const cfg = (update: Config['update']): Config => ({ ...defaultConfig(), update });
const latest = async () => '9.9.9';

beforeEach(() => {
  mocks.execFile.mockReset();
  mocks.execFileSync.mockReset();
});

describe('background update gate', () => {
  it('only records the latest version for a brew copy, whatever the mode', async () => {
    for (const mode of ['auto', 'notify'] as const) {
      const install = vi.fn();
      const env = sandbox();
      const out = await checkForUpdate(cfg(mode), '0.1.0', env, {
        kind: 'brew',
        fetchLatest: latest,
        install,
      });
      expect(out).toEqual({ latest: '9.9.9' });
      expect(out.installed).toBeUndefined();
      expect(install).not.toHaveBeenCalled();
    }
  });

  it('still installs npm-global and local copies in auto mode', async () => {
    const env = sandbox();
    const install = vi.fn();
    const g = await checkForUpdate(cfg('auto'), '0.1.0', env, {
      kind: 'npm-global',
      fetchLatest: latest,
      install,
    });
    expect(g).toEqual({ latest: '9.9.9', installed: '9.9.9' });
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.slice(0, 2)).toEqual(['9.9.9', undefined]);

    const local = vi.fn();
    await checkForUpdate(cfg('auto'), '0.1.0', env, { kind: 'local', fetchLatest: latest, install: local });
    expect(local).toHaveBeenCalledTimes(1);
    expect(local.mock.calls[0]?.slice(0, 2)).toEqual(['9.9.9', localPrefix(env)]);
  });

  it('never installs in notify mode or when already current', async () => {
    const install = vi.fn();
    const env = sandbox();
    const kind: InstallKind = 'npm-global';
    expect(await checkForUpdate(cfg('notify'), '0.1.0', env, { kind, fetchLatest: latest, install })).toEqual(
      {
        latest: '9.9.9',
      },
    );
    expect(await checkForUpdate(cfg('auto'), '9.9.9', env, { kind, fetchLatest: latest, install })).toEqual({
      latest: '9.9.9',
    });
    expect(install).not.toHaveBeenCalled();
  });
});

describe('background update job on a Homebrew Cellar copy', () => {
  let prev: string | undefined;
  let entry = '';
  beforeAll(() => {
    const prefix = path.join(root, 'brew');
    const dist = path.join(prefix, 'Cellar', 'ccinfobar', '0.1.0', 'libexec', 'lib', 'node_modules');
    entry = path.join(dist, 'ccinfobar', 'dist', 'ccinfobar.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    prev = process.argv[1];
    process.argv[1] = entry;
  });
  afterAll(() => {
    if (prev !== undefined) process.argv[1] = prev;
  });

  it('checks GitHub and records the version but never runs npm, even with update auto', async () => {
    expect(installKind()).toBe('brew');
    expect(brewPrefix()).toBe(path.join(fs.realpathSync(root), 'brew'));
    const env = sandbox();
    const config = cfg('auto');
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/alpadalar/ccinfobar/releases/tag/v9.9.9' },
        }),
    ) as unknown as typeof globalThis.fetch;
    const e = await executeJob(
      updateJob,
      { key: 'update' },
      {
        env,
        config,
        cwd: root,
        prev: null,
        fetch,
        now: Date.now(),
      },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(e.ok).toBe(true);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    const state = readUpdateState(env);
    expect(state?.latest).toBe('9.9.9');
    expect(state?.installed).toBeUndefined();
    expect(updateNotice(config, '0.1.0', env)).toBe(`⬆ ccinfobar 9.9.9 · ${BREW_UPGRADE}`);
  });
});

describe('manual update on a brew copy', () => {
  async function run(current: string, check: boolean) {
    const out: string[] = [];
    const install = vi.fn();
    const writeState = vi.fn();
    const code = await manualUpdate(current, check, {
      installKind: () => 'brew',
      fetchLatest: latest,
      install,
      writeState,
      log: (l) => out.push(l),
      error: (l) => out.push(`E ${l}`),
    });
    return { code, out, install, writeState };
  }

  it('prints the new version and the brew hint, and never runs npm', async () => {
    const r = await run('0.1.0', false);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      'New version available: 0.1.0 → 9.9.9',
      '  Installed with Homebrew: run `brew upgrade ccinfobar`',
    ]);
    expect(r.out[1]).toBe(t('update.brewManual', { command: BREW_UPGRADE }));
    expect(r.install).not.toHaveBeenCalled();
    expect(r.writeState).toHaveBeenCalledTimes(1);
    expect(r.writeState.mock.calls[0]?.[0]).not.toHaveProperty('installed');
    expect(mocks.execFileSync).not.toHaveBeenCalled();

    const prevLang = setLanguage('tr');
    try {
      expect((await run('0.1.0', false)).out).toEqual([
        'Yeni sürüm var: 0.1.0 → 9.9.9',
        '  Homebrew ile kurulmuş: `brew upgrade ccinfobar` çalıştırın',
      ]);
    } finally {
      setLanguage(prevLang);
    }
  });

  it('keeps --check as today', async () => {
    const r = await run('0.1.0', true);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['New version available: 0.1.0 → 9.9.9']);
    expect(r.install).not.toHaveBeenCalled();
  });

  it('says the copy is current when it is', async () => {
    const r = await run('9.9.9', false);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['✓ ccinfobar 9.9.9 is the latest version']);
  });
});

describe('update strings and helpers', () => {
  it('has the brew messages', () => {
    expect(t('update.brewRefused', { command: BREW_UPGRADE })).toBe(
      'Installed with Homebrew: run `brew upgrade ccinfobar`',
    );
    expect(t('update.kindBrew')).toBe('Homebrew install');
    expect(t('update.brewSettingsHint', { command: BREW_UPGRADE })).toContain('brew upgrade ccinfobar');
  });

  it('re-exports the shared helpers', () => {
    expect(effectiveUpdate({ update: 'auto' }, 'brew')).toBe('notify');
    expect(effectiveUpdate({ update: 'auto' }, 'npm-global')).toBe('auto');
    expect(updateHint('brew')).toBe(BREW_UPGRADE);
  });
});
