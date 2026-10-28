import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  availableUpdate,
  compareVersions,
  installKind,
  manualUpdate,
  scheduleCheck,
  updateFile,
  updateNotice,
  updatesDisabled,
} from '../../src/commands/update.js';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { safeCwd } from '../../src/data/update-state.js';
import { useIdleEntry } from '../helpers.js';

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
  useIdleEntry();
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
    expect(win.opts.cwd).toBe(safeCwd());
    expect(plain.opts).not.toHaveProperty('cwd');
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
    const entry = process.argv[1]!;
    process.argv[1] = path.join(os.tmpdir(), 'not-the-cli.js');
    scheduleCheck(defaultConfig(), undefined, stale);
    expect(lock(stale)).toBe(false);
    process.argv[1] = entry;
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
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-src-'));
    try {
      fs.mkdirSync(path.join(checkout, '.git'));
      fs.mkdirSync(path.join(checkout, 'dist'));
      fs.writeFileSync(path.join(checkout, 'dist', 'ccinfobar.js'), '');
      expect(installKind(path.join(checkout, 'dist', 'ccinfobar.js'))).toBe('source');
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe('manual update output', () => {
  type Kind = ReturnType<typeof installKind>;
  async function run(opts: {
    latest?: string;
    kind?: Kind;
    check?: boolean;
    fail?: string;
    offline?: string;
  }) {
    const out: string[] = [];
    const installs: Array<[string, string | undefined]> = [];
    const code = await manualUpdate('1.0.0', opts.check === true, {
      fetchLatest: async () => {
        if (opts.offline) throw new Error(opts.offline);
        return opts.latest ?? '1.0.0';
      },
      install: (v, prefix) => {
        installs.push([v, prefix]);
        if (opts.fail) throw new Error(opts.fail);
      },
      verify: async () => null,
      installKind: () => opts.kind ?? 'npm-global',
      writeState: () => {},
      log: (l) => out.push(l),
      error: (l) => out.push(`E ${l}`),
    });
    return { code, out, installs };
  }

  const CASES: Array<[string, Parameters<typeof run>[0], string[], string[], number]> = [
    ['latest', {}, ['✓ ccinfobar 1.0.0 is the latest version'], ['✓ ccinfobar 1.0.0 en son sürüm'], 0],
    [
      'check only',
      { latest: '1.1.0', check: true },
      ['New version available: 1.0.0 → 1.1.0'],
      ['Yeni sürüm var: 1.0.0 → 1.1.0'],
      0,
    ],
    [
      'source checkout',
      { latest: '1.1.0', kind: 'source' },
      [
        'New version available: 1.0.0 → 1.1.0',
        '  This is a source checkout; update it with git pull && npm run build.',
      ],
      [
        'Yeni sürüm var: 1.0.0 → 1.1.0',
        '  Bu bir kaynak kod kopyası; git pull && npm run build ile güncelleyin.',
      ],
      0,
    ],
    [
      'npx',
      { latest: '1.1.0', kind: 'npx' },
      [
        'New version available: 1.0.0 → 1.1.0',
        '  Running through npx: run `npx ccinfobar@latest install` to set up the newest release.',
      ],
      [
        'Yeni sürüm var: 1.0.0 → 1.1.0',
        '  npx üzerinden çalışıyor: en yeni sürümü kurmak için `npx ccinfobar@latest install` çalıştırın.',
      ],
      0,
    ],
    [
      'installed',
      { latest: '1.1.0' },
      ['New version available: 1.0.0 → 1.1.0', '  Installing ccinfobar@1.1.0 ...', '✓ Updated to 1.1.0'],
      ['Yeni sürüm var: 1.0.0 → 1.1.0', '  ccinfobar@1.1.0 kuruluyor ...', '✓ 1.1.0 sürümüne güncellendi'],
      0,
    ],
    [
      'registry only, no checksum path',
      { latest: '1.1.0', fail: 'digest-unavailable' },
      [
        'New version available: 1.0.0 → 1.1.0',
        '  Installing ccinfobar@1.1.0 ...',
        'E ✗ npm install failed: digest-unavailable',
        'E   Run it yourself: npm install -g ccinfobar@1.1.0',
      ],
      [
        'Yeni sürüm var: 1.0.0 → 1.1.0',
        '  ccinfobar@1.1.0 kuruluyor ...',
        'E ✗ npm install başarısız oldu: digest-unavailable',
        'E   Kendiniz çalıştırın: npm install -g ccinfobar@1.1.0',
      ],
      1,
    ],
    [
      'npm failed',
      { latest: '1.1.0', fail: 'EACCES' },
      [
        'New version available: 1.0.0 → 1.1.0',
        '  Installing ccinfobar@1.1.0 ...',
        'E ✗ npm install failed: EACCES',
        'E   Run it yourself: npm install -g ccinfobar@1.1.0',
      ],
      [
        'Yeni sürüm var: 1.0.0 → 1.1.0',
        '  ccinfobar@1.1.0 kuruluyor ...',
        'E ✗ npm install başarısız oldu: EACCES',
        'E   Kendiniz çalıştırın: npm install -g ccinfobar@1.1.0',
      ],
      1,
    ],
    [
      'offline',
      { offline: 'fetch failed' },
      ['E ✗ Could not reach GitHub: fetch failed'],
      ["E ✗ GitHub'a ulaşılamadı: fetch failed"],
      1,
    ],
  ];

  it.each(CASES)('%s in English and Turkish', async (_name, opts, en, tr, code) => {
    const a = await run(opts);
    expect(a.out).toEqual(en);
    expect(a.code).toBe(code);
    // run is async, so no withLang
    const prev = setLanguage('tr');
    try {
      expect((await run(opts)).out).toEqual(tr);
    } finally {
      setLanguage(prev);
    }
  });

  it('installs the latest version into the local prefix for a local install', async () => {
    expect((await run({ latest: '1.1.0' })).installs).toEqual([['1.1.0', undefined]]);
    const local = await run({ latest: '1.1.0', kind: 'local' });
    expect(local.installs[0]?.[1]).toBeTruthy();
    expect(local.code).toBe(0);
  });
});

describe('manual update verification', () => {
  const state: Array<Record<string, unknown>> = [];
  async function verified(
    verifyFn: (v: string) => Promise<string | null>,
    opts: { reinstallFails?: boolean } = {},
  ) {
    const out: string[] = [];
    state.length = 0;
    const installs: string[] = [];
    const code = await manualUpdate('0.8.2', false, {
      fetchLatest: async () => '0.9.0',
      installKind: () => 'npm-global',
      install: async (v) => {
        installs.push(v);
        if (opts.reinstallFails && v === '0.8.2') throw new Error('EACCES');
      },
      verify: verifyFn,
      writeState: ((s: Record<string, unknown>) => {
        state.push(s);
      }) as never,
      log: (l) => out.push(l),
      error: (l) => out.push(`E ${l}`),
    });
    return { code, out, installs };
  }
  const bad = async (v: string) => (v === '0.9.0' ? 'render-failed:1' : null);

  it('a verified install is reported and exits 0', async () => {
    const r = await verified(async () => null);
    expect(r.code).toBe(0);
    expect(r.out.at(-1)).toBe('✓ Updated to 0.9.0');
    expect(state.at(-1)).toMatchObject({ latest: '0.9.0', installed: '0.9.0' });
  });

  it('rolls back a failed check, prints it in en and tr, exits 1 and records the rejection', async () => {
    const r = await verified(bad);
    expect(r.code).toBe(1);
    expect(r.installs).toEqual(['0.9.0', '0.8.2']);
    expect(r.out.at(-1)).toBe('E ✗ 0.9.0 failed its check (render-failed:1); back on 0.8.2');
    expect(state.at(-1)).toMatchObject({
      latest: '0.9.0',
      rejected: '0.9.0',
      rollback: 'ok',
      reason: 'render-failed:1',
    });
    const prev = setLanguage('tr');
    try {
      const tr = await verified(bad);
      expect(tr.out.at(-1)).toBe('E ✗ 0.9.0 denetimi geçemedi (render-failed:1); 0.8.2 sürümüne dönüldü');
    } finally {
      setLanguage(prev);
    }
  });

  it('keeps the install when the check could not run, with a warning and exit 0', async () => {
    const r = await verified(async () => 'verify-failed');
    expect(r.code).toBe(0);
    expect(r.installs).toEqual(['0.9.0']);
    expect(r.out.at(-1)).toBe(
      '  0.9.0 is installed; the check could not run on this machine (verify-failed)',
    );
    expect(state.at(-1)).toMatchObject({ installed: '0.9.0' });
    expect(state.at(-1)?.rejected).toBeUndefined();
  });

  it('says so when the rollback failed, and gives the manual command', async () => {
    const r = await verified(bad, { reinstallFails: true });
    expect(r.code).toBe(1);
    expect(r.out.slice(-2)).toEqual([
      'E ✗ 0.9.0 failed its check (render-failed:1) and the rollback to 0.8.2 failed',
      'E   Run it yourself: npm install -g ccinfobar@0.8.2',
    ]);
    expect(state.at(-1)).toMatchObject({ rejected: '0.9.0', rollback: 'failed' });
  });

  it('says so when the restored version could not be verified', async () => {
    const r = await verified(async (v) => (v === '0.9.0' ? 'render-failed:1' : 'verify-timeout'));
    expect(r.code).toBe(1);
    expect(r.out.at(-1)).toBe(
      'E ✗ 0.9.0 failed its check (render-failed:1); 0.8.2 was restored but could not be verified',
    );
    expect(state.at(-1)).toMatchObject({ rollback: 'unverified' });
    const prev = setLanguage('tr');
    try {
      expect(
        (await verified(async (v) => (v === '0.9.0' ? 'render-failed:1' : 'verify-timeout'))).out.at(-1),
      ).toBe('E ✗ 0.9.0 denetimi geçemedi (render-failed:1); 0.8.2 geri yüklendi ama doğrulanamadı');
    } finally {
      setLanguage(prev);
    }
  });

  it('ignores a previously rejected version on an explicit update', async () => {
    const r = await verified(async () => null);
    expect(r.installs).toEqual(['0.9.0']);
  });
});
