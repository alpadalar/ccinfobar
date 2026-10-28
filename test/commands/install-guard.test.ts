import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { resetLanguageCache } from '../../src/cli/lang.js';
import { buildCommand } from '../../src/commands/command.js';
import {
  applyInstall,
  InstallNeedsConfirmError,
  planInstall,
  projectSettingsPath,
  takeOverProjects,
} from '../../src/commands/install.js';
import {
  type InstallIo,
  isRunnerCommand,
  runInstall,
  runUninstall,
  uninstallMessage,
} from '../../src/commands/install-cli.js';
import { findStatusLineEntry, manifestFile, readManifest } from '../../src/commands/manifest.js';
import { runUpdate, selfCommand } from '../../src/commands/update.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';
import { starterConfig } from '../../src/core/presets.js';
import { VERSION } from '../../src/core/version.js';
import { restoreEnv } from '../helpers.js';

const tmpEnv = () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-guard-')));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
  };
  const file = path.join(dir, 'claude', 'settings.json');
  return { dir, env, file };
};

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) {
        out[`${p}/`] = '';
        walk(p);
      } else out[p] = fs.readFileSync(p, 'base64');
    }
  };
  walk(dir);
  return out;
}

const foreign = { type: 'command' as const, command: '/usr/local/bin/other-line', refreshInterval: 3 };
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('planInstall', () => {
  it('plans a fresh install into a missing file', () => {
    const { env, file } = tmpEnv();
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan).toMatchObject({
      owner: 'none',
      needsConfirm: false,
      changes: true,
      current: null,
      diff: [],
    });
    expect(plan.proposed).toEqual({ type: 'command', command: '/bin/ccinfobar', padding: 0 });
  });

  it('needs confirmation over a foreign statusLine and lists the diffs', () => {
    const { env, file } = tmpEnv();
    writeJson(file, { statusLine: foreign });
    const plan = planInstall({ file, command: '/bin/ccinfobar', refresh: 7.9, env });
    expect(plan.owner).toBe('foreign');
    expect(plan.needsConfirm).toBe(true);
    expect(plan.current).toEqual(foreign);
    expect(plan.proposed).toEqual({
      type: 'command',
      command: '/bin/ccinfobar',
      padding: 0,
      refreshInterval: 7,
    });
    expect(plan.diff).toEqual([
      { key: 'refreshInterval', current: 3, proposed: 7 },
      { key: 'padding', current: null, proposed: 0 },
    ]);
    const noRefresh = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(noRefresh.proposed.refreshInterval).toBeUndefined();
  });

  it('sees its own identical statusLine as unchanged', () => {
    const { env, file } = tmpEnv();
    applyInstall(planInstall({ file, command: '/bin/ccinfobar', refresh: 5, env }), {
      confirmed: false,
      env,
    });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan).toMatchObject({ owner: 'ours', changes: false, needsConfirm: false, diff: [] });
    expect(plan.proposed.refreshInterval).toBe(5);
  });

  it('asks for legacy-ask and inherits refresh for legacy-ours', () => {
    const { env, file } = tmpEnv();
    writeJson(file, { statusLine: { type: 'command', command: 'ccinfobar --x | tee /tmp/y' } });
    expect(planInstall({ file, command: '/bin/ccinfobar', env })).toMatchObject({
      owner: 'legacy-ask',
      needsConfirm: true,
    });
    writeJson(file, { statusLine: { type: 'command', command: 'ccinfobar', refreshInterval: 4 } });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan).toMatchObject({ owner: 'legacy-ours', needsConfirm: false });
    expect(plan.proposed.refreshInterval).toBe(4);
  });

  it('writes nothing', () => {
    const { dir, env, file } = tmpEnv();
    writeJson(file, { statusLine: foreign });
    const before = snapshot(dir);
    planInstall({ file, command: '/bin/ccinfobar', env });
    expect(snapshot(dir)).toEqual(before);
  });
});

describe('install re-pins a vanished node', () => {
  it('rewrites an owned command that pins a missing node to the current one', () => {
    const { env, file } = tmpEnv();
    const gone = "'/gone/node' '/x/dist/ccinfobar.js'";
    applyInstall(planInstall({ file, command: gone, env }), { confirmed: true, env });
    expect(read(file).statusLine.command).toBe(gone);
    const built = buildCommand({ kind: 'script', script: '/x/dist/ccinfobar.js' }, 'linux');
    const current = built.ok ? built.command : '';
    expect(current).toContain(process.execPath.replace(/'/g, ''));
    const plan = planInstall({ file, command: current, env });
    expect(plan.needsConfirm).toBe(false);
    applyInstall(plan, { confirmed: false, env });
    expect(read(file).statusLine.command).toBe(current);
  });
});

describe('applyInstall', () => {
  it('refuses an unconfirmed foreign replacement without touching anything', () => {
    const { dir, env, file } = tmpEnv();
    writeJson(file, { statusLine: foreign });
    const before = snapshot(dir);
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(() => applyInstall(plan, { confirmed: false, env })).toThrow(InstallNeedsConfirmError);
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(manifestFile(env))).toBe(false);
  });

  it('replaces when confirmed and records the manifest', () => {
    const { env, file } = tmpEnv();
    writeJson(file, { model: 'opus', statusLine: foreign });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    const res = applyInstall(plan, { confirmed: true, env });
    expect(res.written).toEqual(plan.proposed);
    expect(res.replaced).toEqual(foreign);
    expect(res.changed).toBe(true);
    expect(res.backup && fs.existsSync(res.backup)).toBe(true);
    expect(read(file)).toEqual({ model: 'opus', statusLine: plan.proposed });
    const entry = findStatusLineEntry(readManifest(env), file);
    expect(entry?.value).toEqual(plan.proposed);
    expect(entry?.previous).toEqual(foreign);
  });

  it('refuses a stale plan when the statusLine changed after planning', () => {
    const { env, file } = tmpEnv();
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    writeJson(file, { statusLine: foreign });
    expect(() => applyInstall(plan, { confirmed: true, env })).toThrow(InstallNeedsConfirmError);
    expect(read(file).statusLine).toEqual(foreign);
  });

  it('adopts a legacy-ask statusLine with the legacy restore chain', () => {
    const { env, file } = tmpEnv();
    const prior = { type: 'command', command: 'npx ccstatusline' };
    writeJson(`${file}.ccinfobar-backup`, { statusLine: prior });
    writeJson(file, { statusLine: { type: 'command', command: '"/opt/x/ccinfobar" --flag' } });
    const plan = planInstall({ file, command: '/bin/ccinfobar', env });
    expect(plan.owner).toBe('legacy-ask');
    applyInstall(plan, { confirmed: true, adoptLegacy: true, env });
    const entry = findStatusLineEntry(readManifest(env), file);
    expect(entry?.previous).toEqual(prior);
    expect(entry?.restore).toBeNull();
    expect(entry?.fileExisted).toBe(true);

    const other = tmpEnv();
    const legacy = { type: 'command' as const, command: '"/opt/x/ccinfobar" --flag' };
    writeJson(other.file, { statusLine: legacy });
    applyInstall(planInstall({ file: other.file, command: '/bin/ccinfobar', env: other.env }), {
      confirmed: true,
      env: other.env,
    });
    expect(findStatusLineEntry(readManifest(other.env), other.file)?.previous).toEqual(legacy);
  });

  it('has no unguarded install() export', async () => {
    const mod: Record<string, unknown> = await import('../../src/commands/install.js');
    expect(mod.install).toBeUndefined();
  });
});

describe('takeOverProjects', () => {
  it('applies confirmed installs and records each project', () => {
    const { dir, env } = tmpEnv();
    const roots = ['a', 'b'].map((n) => {
      const root = path.join(dir, n);
      writeJson(projectSettingsPath(root, false), {
        statusLine: { type: 'command', command: 'node .claude/hooks/gsd-statusline.js' },
      });
      return root;
    });
    writeJson(path.join(dir, 'claude', '.claude.json'), {
      projects: Object.fromEntries(roots.map((r) => [r, {}])),
    });
    expect(takeOverProjects('/bin/ccinfobar', 6, env)).toEqual(roots);
    const m = readManifest(env);
    for (const root of roots) {
      const entry = findStatusLineEntry(m, projectSettingsPath(root));
      expect(entry?.value).toEqual({
        type: 'command',
        command: '/bin/ccinfobar',
        padding: 0,
        refreshInterval: 6,
      });
      expect(entry?.restore).toEqual({ absent: true });
    }
  });
});

describe('runInstall and runUninstall', () => {
  let saved: NodeJS.ProcessEnv;
  let argv1: string | undefined;
  let dir: string;
  let settings: string;
  let cfg: string;

  beforeEach(() => {
    saved = { ...process.env };
    argv1 = process.argv[1];
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cli-')));
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
    process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
    settings = path.join(dir, 'claude', 'settings.json');
    cfg = path.join(dir, 'config', 'config.json');
  });

  afterEach(() => {
    restoreEnv(saved);
    process.argv[1] = argv1 as string;
    process.exitCode = undefined;
    vi.unstubAllGlobals();
  });

  const fake = (tty: boolean, answer = false) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const asked: string[] = [];
    const setup = vi.fn(() => {
      throw new Error('setup must not run');
    });
    const io: InstallIo = {
      tty,
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      setup: setup as unknown as InstallIo['setup'],
    };
    return { io, lines, errors, asked, setup };
  };
  const args = (...a: string[]) => parseArgs(['install', '--command', '/bin/ccinfobar', ...a]);
  const proposed = t('install.proposed', { command: '/bin/ccinfobar' });

  it.each([
    ['a comment', '{\n  // comment\n  "a": 1\n}', 'line 2, column 3'],
    ['a trailing comma', '{"a":1,}', 'line 1, column 8'],
    ['CRLF line endings', '{\r\n  "a": 1,\r\n  // c\r\n}', 'line 3, column 3'],
  ])('install and uninstall name the line of %s and write nothing', async (_n, text, where) => {
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, text);
    const before = snapshot(dir);
    const bytes = fs.readFileSync(settings);
    const strict = new RegExp(`strict JSON.*${where}`);
    await expect(runInstall(args(), cfg, fake(false).io)).rejects.toThrow(strict);
    await expect(runUninstall(parseArgs(['uninstall']), cfg, fake(false).io)).rejects.toThrow(strict);
    expect(fs.readFileSync(settings).equals(bytes)).toBe(true);
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, 'config', 'backups'))).toBe(false);
  });

  it('keeps a foreign statusLine when the TTY user says no', async () => {
    writeJson(settings, { statusLine: foreign });
    const before = snapshot(dir);
    const f = fake(true, false);
    await runInstall(args(), cfg, f.io);
    expect(f.lines[0]).toBe(t('install.installing', { version: VERSION }));
    expect(f.lines).toContain(t('install.foreignHeader', { file: tildify(settings) }));
    expect(f.lines).toContain(t('install.current', { command: foreign.command }));
    expect(f.lines).toContain(proposed);
    expect(f.lines).toContain(t('install.refreshDiff', { current: 3, proposed: t('install.unset') }));
    expect(f.lines).toContain(t('install.paddingDiff', { current: t('install.unset'), proposed: 0 }));
    expect(f.lines.at(-1)).toBe(t('install.kept'));
    expect(f.asked).toEqual([t('install.replacePrompt')]);
    expect(snapshot(dir)).toEqual(before);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('a declined foreign replacement installs no hooks either (D-17)', async () => {
    writeJson(settings, { statusLine: foreign });
    const before = snapshot(dir);
    const f = fake(true, false);
    f.io.claudeVersion = () => '2.1.299';
    await runInstall(args('--hooks'), cfg, f.io);
    expect(f.lines.at(-1)).toBe(t('install.kept'));
    expect(f.lines).toContain(t('hooks.detected', { version: '2.1.299' }));
    expect(snapshot(dir)).toEqual(before);
  });

  it('--hooks with a bad value exits 1 before detecting or writing', async () => {
    const f = fake(false);
    const detect = vi.fn(() => '2.1.299');
    f.io.claudeVersion = detect;
    await runInstall(args('--hooks=all'), cfg, f.io);
    expect(f.errors).toEqual([t('hooks.badFlag')]);
    expect(detect).not.toHaveBeenCalled();
    expect(fs.existsSync(settings)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('a value after a space (--hooks permission) exits 1 before writing', async () => {
    const f = fake(false);
    const detect = vi.fn(() => '2.1.299');
    f.io.claudeVersion = detect;
    await runInstall(args('--hooks', 'permission'), cfg, f.io);
    expect(f.errors).toEqual([t('hooks.badArg', { arg: 'permission' })]);
    expect(detect).not.toHaveBeenCalled();
    expect(fs.existsSync(settings)).toBe(false);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const u = fake(false);
    await runUninstall(parseArgs(['uninstall', '--hooks', 'Stop']), cfg, u.io);
    expect(u.errors).toEqual([t('hooks.badArg', { arg: 'Stop' })]);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    const p = fake(false);
    await runInstall(parseArgs(['install', '--project', 'here']), cfg, p.io);
    expect(p.errors).toEqual([t('hooks.badArg', { arg: 'here' })]);
    expect(process.exitCode).toBe(1);
  });

  it('warns when the hooks would run through a package runner', async () => {
    for (const c of ['npx -y ccinfobar', 'bunx ccinfobar', 'pnpm dlx ccinfobar', '"C:/n/npx.cmd" ccinfobar'])
      expect(isRunnerCommand(c), c).toBe(true);
    for (const c of ['ccinfobar', 'node "/x/npx/ccinfobar.js"', 'pnpm exec ccinfobar', '/usr/bin/ccinfobar'])
      expect(isRunnerCommand(c), c).toBe(false);
    const f = fake(false);
    f.io.claudeVersion = () => '2.1.299';
    await runInstall(
      parseArgs(['install', '--command', 'npx -y ccinfobar', '--hooks', '--dry-run']),
      cfg,
      f.io,
    );
    expect(f.lines).toContain(`⚠ ${t('hooks.runnerCommand')}`);
    const g = fake(false);
    g.io.claudeVersion = () => '2.1.299';
    await runInstall(args('--hooks', '--dry-run'), cfg, g.io);
    expect(g.lines).not.toContain(`⚠ ${t('hooks.runnerCommand')}`);
  });

  it('replaces after a TTY yes and prints what it wrote', async () => {
    writeJson(settings, { statusLine: foreign });
    const f = fake(true, true);
    await runInstall(args(), cfg, f.io);
    expect(read(settings).statusLine.command).toBe('/bin/ccinfobar');
    const wrote = f.lines.indexOf(t('install.wrote', { command: '/bin/ccinfobar', file: tildify(settings) }));
    expect(wrote).toBeGreaterThan(0);
    expect(f.lines.slice(wrote).some((l) => l.startsWith(t('install.backup', { file: '' })))).toBe(true);
    expect(fs.existsSync(cfg)).toBe(true);
  });

  it('replaces without a TTY and says what it replaced', async () => {
    writeJson(settings, { statusLine: foreign });
    const f = fake(false);
    await runInstall(args(), cfg, f.io);
    expect(f.asked).toEqual([]);
    expect(f.lines).toContain(t('install.replaced', { command: foreign.command }));
    expect(f.lines).not.toContain(t('install.foreignHeader', { file: tildify(settings) }));
    expect(read(settings).statusLine.command).toBe('/bin/ccinfobar');
  });

  it('replaces with --yes without asking', async () => {
    writeJson(settings, { statusLine: foreign });
    const f = fake(true, false);
    await runInstall(args('--yes'), cfg, f.io);
    expect(f.asked).toEqual([]);
    expect(read(settings).statusLine.command).toBe('/bin/ccinfobar');
    const g = fake(true, false);
    writeJson(settings, { statusLine: foreign });
    await runInstall(args('-y'), cfg, g.io);
    expect(g.asked).toEqual([]);
  });

  it('prints only the diffs that differ', async () => {
    writeJson(settings, { statusLine: { ...foreign, padding: 0 } });
    const f = fake(true, false);
    await runInstall(args('--refresh', '3'), cfg, f.io);
    expect(f.lines.some((l) => l.includes('refreshInterval:'))).toBe(false);
    expect(f.lines.some((l) => l.includes('padding:'))).toBe(false);
  });

  it('sanitizes the foreign command it prints', async () => {
    writeJson(settings, { statusLine: { type: 'command', command: 'evil\u001b]0;x\u0007\u202eline' } });
    const f = fake(false);
    await runInstall(args(), cfg, f.io);
    expect(f.lines).toContain(t('install.replaced', { command: 'evilline' }));
  });

  it('writes nothing on --dry-run and never runs setup', async () => {
    writeJson(settings, { statusLine: foreign });
    const before = snapshot(dir);
    const f = fake(true, true);
    await runInstall(args('--dry-run'), cfg, f.io);
    expect(f.lines).toContain(t('install.current', { command: foreign.command }));
    expect(f.lines).toContain(proposed);
    expect(f.lines.at(-1)).toBe(t('install.dryRun'));
    expect(f.asked).toEqual([]);
    expect(snapshot(dir)).toEqual(before);

    const g = fake(false);
    await runInstall(parseArgs(['install', '--dry-run']), cfg, g.io);
    expect(g.setup).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
  });

  it('prints the closing lines of an install', async () => {
    const f = fake(false);
    await runInstall(args(), cfg, f.io);
    const hint = selfCommand();
    expect(f.lines).toContain(`  Config: ${tildify(cfg)}`);
    expect(f.lines).toContain(`  Customize with \`${hint} edit\` (browser) or \`${hint} tui\` (terminal).`);
  });

  it('prints a Turkish dry run with the path and command unchanged', async () => {
    writeJson(settings, {});
    process.env.CCINFOBAR_LANG = 'tr';
    resetLanguageCache();
    const before = snapshot(dir);
    const f = fake(false);
    await runInstall(args('--dry-run'), cfg, f.io);
    expect(f.lines[0]).toBe(`ccinfobar ${VERSION} kuruluyor`);
    expect(f.lines).toContain(`${tildify(settings)} dosyasında statusLine ayarlanacak`);
    expect(f.lines).toContain('  önerilen: /bin/ccinfobar');
    expect(f.lines.at(-1)).toBe('Deneme çalıştırması: hiçbir şey yazılmadı.');
    expect(snapshot(dir)).toEqual(before);
  });

  it('prints the Turkish closing lines of an install', async () => {
    process.env.CCINFOBAR_LANG = 'tr';
    resetLanguageCache();
    const f = fake(false);
    await runInstall(args(), cfg, f.io);
    const hint = selfCommand();
    expect(f.lines).toContain(
      `✓ ${tildify(settings)} dosyasında statusLine "/bin/ccinfobar" olarak ayarlandı`,
    );
    expect(f.lines).toContain(`  Yapılandırma: ${tildify(cfg)}`);
    expect(f.lines).toContain(
      `  \`${hint} edit\` (tarayıcı) veya \`${hint} tui\` (terminal) ile özelleştirin.`,
    );
  });

  it('says it would install with npm on a dry run from npx', async () => {
    process.argv[1] = path.join(dir, '_npx', 'abc', 'node_modules', 'ccinfobar', 'dist', 'ccinfobar.js');
    process.env.PATH = '';
    const f = fake(false);
    await runInstall(parseArgs(['install', '--dry-run']), cfg, f.io);
    expect(f.setup).not.toHaveBeenCalled();
    expect(f.lines).toContain(t('install.dryRunGlobal', { version: VERSION }));
    expect(f.lines.at(-1)).toBe(t('install.dryRun'));
    expect(fs.existsSync(path.join(dir, 'config'))).toBe(false);
  });

  it('persists the GSD line migration on install', async () => {
    fs.mkdirSync(path.join(dir, 'claude', 'get-shit-done'), { recursive: true });
    saveConfig(starterConfig(false), cfg);
    expect(read(cfg).gsdAutoLine).toBe(true);
    await runInstall(args(), cfg, fake(false).io);
    expect(read(cfg).gsdAutoLine).toBeUndefined();
    expect(loadConfig(cfg).exists).toBe(true);
  });

  const legacy = { type: 'command' as const, command: 'ccinfobar --x | tee /tmp/y' };

  it('asks once on uninstall for a legacy-looking statusLine', async () => {
    writeJson(settings, { model: 'opus', statusLine: legacy });
    const no = fake(true, false);
    await runUninstall(parseArgs(['uninstall']), cfg, no.io);
    expect(no.asked).toEqual([t('install.legacyPrompt', { command: legacy.command })]);
    expect(read(settings).statusLine).toEqual(legacy);
    expect(no.lines).toContain(t('uninstall.foreign', { file: tildify(settings), command: legacy.command }));

    const quiet = fake(false, true);
    await runUninstall(parseArgs(['uninstall']), cfg, quiet.io);
    expect(quiet.asked).toEqual([]);
    expect(read(settings).statusLine).toEqual(legacy);

    const yes = fake(true, true);
    await runUninstall(parseArgs(['uninstall']), cfg, yes.io);
    expect(yes.asked).toHaveLength(1);
    expect(read(settings)).toEqual({ model: 'opus' });
    expect(yes.lines).toContain(t('uninstall.removed', { file: tildify(settings) }));
  });

  it('asks once on install for a legacy-looking statusLine and adopts it', async () => {
    writeJson(settings, { statusLine: legacy });
    const f = fake(true, true);
    await runInstall(args(), cfg, f.io);
    expect(f.asked).toEqual([t('install.legacyPrompt', { command: legacy.command })]);
    expect(f.lines).not.toContain(t('install.replaced', { command: legacy.command }));
    expect(findStatusLineEntry(readManifest(), settings)?.previous).toBeNull();
  });

  it('round-trips install and uninstall through the CLI', async () => {
    writeJson(settings, { model: 'opus', statusLine: foreign });
    const before = fs.readFileSync(settings);
    await runInstall(args(), cfg, fake(false).io);
    const f = fake(false);
    await runUninstall(parseArgs(['uninstall']), cfg, f.io);
    expect(f.lines).toContain(t('uninstall.restoredExact', { file: tildify(settings) }));
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('has a message for every uninstall status', () => {
    const file = settings;
    const s = (command: string) => ({ type: 'command' as const, command });
    const NO_HOOKS = { removed: [], kept: [] };
    const cases = [
      ['restored-exact', t('uninstall.restoredExact', { file: tildify(file) }), null],
      ['restored-previous', t('uninstall.restoredPrevious', { command: 'prev' }), s('prev')],
      ['removed', t('uninstall.removed', { file: tildify(file) }), null],
      ['deleted-file', t('uninstall.deletedFile', { file: tildify(file) }), null],
      ['gone-restored', t('uninstall.goneRestored', { file: tildify(file), command: 'prev' }), s('prev')],
      ['gone-nothing', t('uninstall.goneNothing', { file: tildify(file) }), null],
      ['not-installed', t('uninstall.notInstalled', { file: tildify(file) }), null],
    ] as const;
    for (const [status, text, restored] of cases) {
      expect(
        uninstallMessage({ status, file, removed: false, restored, hooks: NO_HOOKS, subagent: null }),
      ).toBe(text);
    }
    expect(
      uninstallMessage({
        status: 'foreign',
        file,
        removed: false,
        restored: null,
        current: s('other'),
        hooks: NO_HOOKS,
        subagent: null,
      }),
    ).toBe(t('uninstall.foreign', { file: tildify(file), command: 'other' }));
  });

  const gsdProject = () => {
    const root = path.join(dir, 'proj');
    writeJson(projectSettingsPath(root, false), {
      statusLine: { type: 'command', command: 'node .claude/hooks/gsd-statusline.js' },
    });
    writeJson(path.join(dir, 'claude', '.claude.json'), { projects: { [root]: {} } });
    return root;
  };

  it('takes over GSD projects in the background only when the user statusLine is ours', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const root = gsdProject();
    writeJson(settings, { statusLine: { type: 'command', command: 'wrap-ccinfobar --fancy' } });
    await runUpdate(parseArgs(['update', '--background']), cfg);
    expect(fs.existsSync(projectSettingsPath(root))).toBe(false);

    applyInstall(planInstall({ file: settings, command: '/bin/ccinfobar', refresh: 9 }), { confirmed: true });
    await runUpdate(parseArgs(['update', '--background']), cfg);
    expect(read(projectSettingsPath(root)).statusLine).toEqual({
      type: 'command',
      command: '/bin/ccinfobar',
      padding: 0,
      refreshInterval: 9,
    });
    expect(findStatusLineEntry(readManifest(), projectSettingsPath(root))).not.toBeNull();
  });
});
