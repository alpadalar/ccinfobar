import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { type InstallIo, runInstall, runUninstall } from '../../src/commands/install-cli.js';
import { findHookEntries, manifestFile, readManifest } from '../../src/commands/manifest.js';
import { loadConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { isHookEvent } from '../../src/data/hooks.js';
import { markSent, progressFiles, readWant } from '../../src/data/progress.js';
import { writeSmall } from '../../src/data/store.js';
import { restoreEnv } from '../helpers.js';

const CLEAR = '\u001b]9;4;0;\u0007';
const PROGRESS = ['UserPromptSubmit', 'Stop', 'StopFailure'];

describe('install --progress and uninstall --progress (D-42)', () => {
  let saved: NodeJS.ProcessEnv;
  let argv1: string | undefined;
  let dir: string;
  let settings: string;
  let cfg: string;

  beforeEach(() => {
    saved = { ...process.env };
    argv1 = process.argv[1];
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-progress-')));
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
    process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
    settings = path.join(dir, 'claude', 'settings.json');
    cfg = path.join(dir, 'config', 'config.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2));
  });

  afterEach(() => {
    restoreEnv(saved);
    process.argv[1] = argv1 as string;
    process.exitCode = undefined;
  });

  const fake = (tty: boolean, version: string | null = '2.1.300') => {
    const lines: string[] = [];
    const errors: string[] = [];
    const raw: string[] = [];
    const io: InstallIo = {
      tty,
      ask: async () => false,
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      setup: vi.fn(() => {
        throw new Error('setup must not run');
      }) as unknown as InstallIo['setup'],
      claudeVersion: () => version,
      write: (s) => raw.push(s),
    };
    return { io, lines, errors, raw };
  };
  const install = (io: InstallIo, ...a: string[]) =>
    runInstall(parseArgs(['install', '--command', '/bin/ccinfobar', '--no-import', ...a]), cfg, io);
  const remove = (io: InstallIo, ...a: string[]) => runUninstall(parseArgs(['uninstall', ...a]), cfg, io);
  const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
  const enabled = () => loadConfig(cfg).config.progress?.enabled;
  const progressGroups = (hooks: Record<string, unknown[]>) =>
    Object.values(hooks)
      .flat()
      .filter((g) => JSON.stringify(g).includes('--progress'));

  it('--dry-run prints the three progress lines and writes nothing', async () => {
    const before = fs.readFileSync(settings);
    const f = fake(false);
    await install(f.io, '--progress', '--dry-run');
    for (const e of PROGRESS)
      expect(f.lines).toContain(
        t('progress.dry.add', { event: e, command: `/bin/ccinfobar --progress hook ${e}` }),
      );
    expect(f.lines.filter((l) => l.includes('+ hook '))).toEqual([]);
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
    expect(fs.existsSync(cfg)).toBe(false);
  });

  it('installs the sync handlers, records the role and enables progress', async () => {
    const f = fake(false);
    await install(f.io, '--progress', '--yes');
    expect(f.errors).toEqual([]);
    const data = read();
    expect(data.model).toBe('opus');
    expect(data.theme).toBe('dark');
    expect(data.statusLine.command).toBe('/bin/ccinfobar');
    expect(Object.keys(data.hooks).sort()).toEqual([...PROGRESS].sort());
    for (const e of PROGRESS)
      expect(data.hooks[e]).toEqual([
        { hooks: [{ type: 'command', command: `/bin/ccinfobar --progress hook ${e}`, timeout: 5 }] },
      ]);
    const entries = findHookEntries(readManifest(), settings);
    expect(entries.map((e) => [e.event, e.role])).toEqual(PROGRESS.map((e) => [e, 'progress']));
    expect(enabled()).toBe(true);
    expect(f.lines).toContain(t('progress.added', { events: PROGRESS.join(', ') }));
    expect(f.lines).toContain(`  ${t('progress.tip')}`);
    expect(fs.readFileSync(settings, 'utf8')).not.toContain('terminalProgressBarEnabled');
    expect(f.raw).toEqual([]);
  });

  it('refuses on an old or unknown Claude Code and leaves settings and config alone', async () => {
    await install(fake(false).io);
    const s = fs.readFileSync(settings);
    const c = fs.readFileSync(cfg);
    const old = fake(false, '2.1.100');
    await install(old.io, '--progress', '--yes');
    expect(old.lines).toContain(
      `⚠ ${t('progress.refused.oldVersion', { floor: '2.1.141', version: '2.1.100' })}`,
    );
    expect(old.lines.some((l) => l.includes('Hooks need'))).toBe(false);
    const unknown = fake(false, null);
    await install(unknown.io, '--progress', '--yes');
    expect(unknown.lines).toContain(`⚠ ${t('progress.refused.unknownVersion', { floor: '2.1.141' })}`);
    expect(fs.readFileSync(settings).equals(s)).toBe(true);
    expect(fs.readFileSync(cfg).equals(c)).toBe(true);
    expect(enabled()).toBeUndefined();
  });

  it('refuses on a broken config before writing anything', async () => {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '{ "lines": [');
    const before = fs.readFileSync(settings);
    const f = fake(false);
    await install(f.io, '--progress', '--yes');
    expect(f.errors.join('\n')).toContain('Refusing to overwrite');
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{ "lines": [');
  });

  // WR-02
  it('adds no handlers on the tty channel and removes installed ones', async () => {
    if (process.platform === 'win32') return;
    await install(fake(false).io, '--progress', '--yes');
    expect(progressGroups(read().hooks)).toHaveLength(3);
    const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    fs.writeFileSync(cfg, JSON.stringify({ ...c, progress: { enabled: true, channel: 'tty' } }));
    const f = fake(false, null);
    await install(f.io, '--progress', '--yes');
    expect(f.lines).toContain(t('progress.tty'));
    expect(f.lines).toContain(t('progress.removed'));
    expect(f.lines.some((l) => l.includes('2.1.141'))).toBe(false);
    expect(read().hooks).toBeUndefined();
    expect(findHookEntries(readManifest(), settings)).toEqual([]);
    expect(loadConfig(cfg).config.progress).toEqual({ enabled: true, channel: 'tty' });
    const again = fake(false);
    await install(again.io, '--progress', '--yes');
    expect(again.lines).not.toContain(t('progress.removed'));
    expect(read().hooks).toBeUndefined();
  });

  // WR-06: older readers must not see progress entries as Phase 4 hooks
  const rawHooks = () =>
    (JSON.parse(fs.readFileSync(manifestFile(), 'utf8')).entries as Record<string, unknown>[]).filter(
      (e) => e.kind === 'hook',
    );
  const toOldShape = () => {
    const m = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
    for (const e of m.entries)
      if (e.role === 'progress') {
        e.event = e.hookEvent;
        delete e.hookEvent;
      }
    fs.writeFileSync(manifestFile(), JSON.stringify(m));
  };

  it('records progress entries under progress:<Event>', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    const progress = rawHooks().filter((e) => e.role === 'progress');
    expect(progress.map((e) => [e.event, e.hookEvent])).toEqual(PROGRESS.map((e) => [`progress:${e}`, e]));
    for (const e of progress) expect(isHookEvent(e.event)).toBe(false);
    expect(
      rawHooks()
        .filter((e) => !e.role)
        .every((e) => isHookEvent(e.event)),
    ).toBe(true);
  });

  it('migrates an old-shape manifest on the next install', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    const before = fs.readFileSync(settings, 'utf8');
    toOldShape();
    expect(rawHooks().some((e) => e.event === 'Stop' && e.role === 'progress')).toBe(true);
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
    const progress = rawHooks().filter((e) => e.role === 'progress');
    expect(progress.map((e) => e.event)).toEqual(PROGRESS.map((e) => `progress:${e}`));
    expect(rawHooks()).toHaveLength(7 + 3);
  });

  it('a full uninstall cleans an old-shape manifest completely', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    toOldShape();
    await remove(fake(false).io);
    expect(read()).toEqual({ model: 'opus', theme: 'dark' });
    expect(rawHooks()).toEqual([]);
  });

  it('uninstall --progress cleans an old-shape manifest and keeps the regular hooks', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    toOldShape();
    const f = fake(false);
    await remove(f.io, '--progress');
    expect(f.lines).toContain(t('progress.removed'));
    expect(progressGroups(read().hooks)).toEqual([]);
    expect(rawHooks().some((e) => e.role)).toBe(false);
    expect(rawHooks()).toHaveLength(7);
  });

  it('--progress=x is a usage error', async () => {
    const f = fake(false);
    await install(f.io, '--progress=x');
    expect(f.errors).toEqual([t('progress.badFlag')]);
    expect(process.exitCode).toBe(1);
  });

  it('uninstall --progress removes only progress groups and clears on a TTY only', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    const asyncGroups = Object.values(read().hooks as Record<string, unknown[]>)
      .flat()
      .filter((g) => !JSON.stringify(g).includes('--progress'));
    const pipe = fake(false);
    await remove(pipe.io, '--progress');
    expect(pipe.lines).toContain(t('progress.removed'));
    expect(pipe.raw).toEqual([]);
    expect(enabled()).toBe(false);
    const hooks = read().hooks as Record<string, unknown[]>;
    expect(progressGroups(hooks)).toEqual([]);
    expect(Object.values(hooks).flat()).toEqual(asyncGroups);
    expect(read().statusLine.command).toBe('/bin/ccinfobar');
    expect(findHookEntries(readManifest(), settings).some((e) => e.role)).toBe(false);

    await install(fake(false).io, '--progress', '--yes');
    const tty = fake(true);
    await remove(tty.io, '--progress');
    expect(tty.raw).toEqual([CLEAR]);
    const again = fake(true);
    await remove(again.io, '--progress');
    expect(again.lines.some((l) => l.startsWith('No progress handlers in'))).toBe(true);
    expect(again.raw).toEqual([]);
  });

  // a bar on screen can only be cleared by the next hook event (D-36)
  const showBar = (sid = 'live-sess') => {
    const files = progressFiles(sid, process.env)!;
    writeSmall(files.want, JSON.stringify({ v: 1, state: 4, pct: 72, channel: 'hook', always: false }));
    markSent(files.sent, { state: 4, pct: 72 });
    return files;
  };

  it('uninstall --progress holds the handlers once while a bar is showing', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    const files = showBar();
    const first = fake(false);
    await remove(first.io, '--progress');
    expect(first.lines).toContain(t('progress.held'));
    expect(first.lines).not.toContain(t('progress.removed'));
    expect(enabled()).toBe(false);
    expect(readWant(files.want)).toMatchObject({ state: 0, pct: 0 });
    expect(progressGroups(read().hooks)).toHaveLength(3);
    const second = fake(false);
    await remove(second.io, '--progress');
    expect(second.lines).toContain(t('progress.removed'));
    expect(progressGroups(read().hooks)).toEqual([]);
    expect(findHookEntries(readManifest(), settings).some((e) => e.role)).toBe(false);
  });

  it('uninstall --hooks --progress drops the regular hooks while holding progress', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    showBar();
    const f = fake(false);
    await remove(f.io, '--hooks', '--progress');
    expect(f.lines).toContain(t('progress.held'));
    expect(Object.keys(read().hooks).sort()).toEqual([...PROGRESS].sort());
    expect(progressGroups(read().hooks)).toHaveLength(3);
  });

  it('a full uninstall never holds and flips the bars to the clear state', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    const files = showBar();
    const f = fake(false);
    await remove(f.io);
    expect(read()).toEqual({ model: 'opus', theme: 'dark' });
    expect(readWant(files.want)).toMatchObject({ state: 0 });
    expect(f.lines).not.toContain(t('progress.held'));
  });

  it('uninstall --hooks keeps the progress handlers and progress.enabled', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    const f = fake(true);
    await remove(f.io, '--hooks');
    expect(progressGroups(read().hooks)).toHaveLength(3);
    expect(Object.keys(read().hooks).sort()).toEqual([...PROGRESS].sort());
    expect(enabled()).toBe(true);
    expect(f.raw).toEqual([]);
  });

  it('a full uninstall removes both roles and clears on a TTY', async () => {
    await install(fake(false).io, '--hooks', '--progress', '--yes');
    const f = fake(true);
    await remove(f.io);
    expect(f.lines).toContain(t('progress.removed'));
    expect(f.raw).toEqual([CLEAR]);
    expect(read()).toEqual({ model: 'opus', theme: 'dark' });
    expect(findHookEntries(readManifest(), settings)).toEqual([]);
    expect(enabled()).toBe(false);
  });

  it('a full uninstall without progress writes no clear', async () => {
    await install(fake(false).io, '--hooks', '--yes');
    const f = fake(true);
    await remove(f.io);
    expect(f.raw).toEqual([]);
    expect(read()).toEqual({ model: 'opus', theme: 'dark' });
  });
});
