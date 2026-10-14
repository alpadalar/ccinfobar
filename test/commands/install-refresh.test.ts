import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { type InstallIo, runInstall } from '../../src/commands/install-cli.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import type { Config } from '../../src/core/types.js';

let saved: NodeJS.ProcessEnv;
let dir: string;
let settings: string;
let cfg: string;

beforeEach(() => {
  saved = { ...process.env };
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-refresh-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  settings = path.join(dir, 'claude', 'settings.json');
  cfg = path.join(dir, 'config', 'config.json');
});

afterEach(() => {
  process.env = saved;
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const fake = () => {
  const lines: string[] = [];
  const io: InstallIo = {
    tty: false,
    ask: async () => false,
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
    setup: (() => {
      throw new Error('setup must not run');
    }) as unknown as InstallIo['setup'],
    claudeVersion: () => '2.1.299',
  };
  return { io, lines };
};

const args = (...a: string[]) => parseArgs(['install', '--command', '/bin/ccinfobar', ...a]);
const layout = (types: string[], extra: Partial<Config> = {}) =>
  saveConfig({ ...defaultConfig(), ...extra, lines: [types.map((type) => ({ id: type, type }))] }, cfg);
const hint = (widgets: string) => t('install.refreshHint', { widgets });
const statusLine = () => JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine;
const count = (lines: string[], line: string) => lines.filter((l) => l === line).length;

describe('install refresh suggestion', () => {
  it('names the widgets and suggests --refresh 5 on a dry run without writing', async () => {
    layout(['model', 'turn-timer']);
    const before = fs.readFileSync(cfg, 'utf8');
    const f = fake();
    await runInstall(args('--dry-run'), cfg, f.io);
    expect(count(f.lines, hint('turn-timer'))).toBe(1);
    expect(hint('turn-timer')).toContain('turn-timer');
    expect(hint('turn-timer')).toContain('--refresh 5');
    expect(f.lines.join('\n')).not.toContain('--refresh 1');
    expect(f.lines.at(-1)).toBe(t('install.dryRun'));
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.readFileSync(cfg, 'utf8')).toBe(before);
  });

  it('says Claude Code does not re-run it on hooks or during a permission dialog', () => {
    expect(hint('clock')).toMatch(/hook events/);
    expect(hint('clock')).toMatch(/permission dialog/);
    expect(t('doctor.refreshHint', { widgets: 'clock' })).toContain('ccinfobar install --refresh 5');
    expect(t('doctor.refreshHint', { widgets: 'clock' })).toMatch(/permission dialog/);
  });

  it('prints the hint once on apply and writes no refreshInterval', async () => {
    layout(['turn-timer', 'clock']);
    const f = fake();
    await runInstall(args(), cfg, f.io);
    expect(statusLine().command).toBe('/bin/ccinfobar');
    expect('refreshInterval' in statusLine()).toBe(false);
    expect(count(f.lines, hint('clock, turn-timer'))).toBe(1);
  });

  it('stays quiet with --refresh or an existing refreshInterval', async () => {
    layout(['turn-timer']);
    const f = fake();
    await runInstall(args('--refresh', '10'), cfg, f.io);
    expect(statusLine().refreshInterval).toBe(10);
    expect(f.lines.some((l) => l.includes('--refresh 5'))).toBe(false);
    fs.rmSync(settings);
    await runInstall(args('--refresh', '3'), cfg, fake().io);
    const g = fake();
    await runInstall(args(), cfg, g.io);
    expect(statusLine().refreshInterval).toBe(3);
    expect(g.lines.some((l) => l.includes('--refresh 5'))).toBe(false);
    const d = fake();
    await runInstall(args('--dry-run'), cfg, d.io);
    expect(d.lines.some((l) => l.includes('--refresh 5'))).toBe(false);
  });

  it('accepts --refresh 1 with a note on its cost', async () => {
    layout(['turn-timer']);
    const f = fake();
    await runInstall(args('--refresh', '1'), cfg, f.io);
    expect(statusLine().refreshInterval).toBe(1);
    expect(f.lines).toContain(t('install.refreshOne'));
    expect(f.lines.some((l) => l.includes('--refresh 5'))).toBe(false);
  });

  it('prints nothing for a layout without time-based widgets', async () => {
    layout(['model', 'cwd']);
    const f = fake();
    await runInstall(args(), cfg, f.io);
    const g = fake();
    await runInstall(args('--dry-run'), cfg, g.io);
    expect([...f.lines, ...g.lines].some((l) => l.includes('--refresh 5'))).toBe(false);
    expect(f.lines).not.toContain(t('install.refreshOne'));
  });

  it('still prints the hint with --hooks', async () => {
    layout(['cache-timer']);
    const d = fake();
    await runInstall(args('--hooks', '--dry-run'), cfg, d.io);
    expect(count(d.lines, hint('cache-timer'))).toBe(1);
    const f = fake();
    await runInstall(args('--hooks'), cfg, f.io);
    expect(count(f.lines, hint('cache-timer'))).toBe(1);
    expect('refreshInterval' in statusLine()).toBe(false);
  });

  it('counts widgets used only in a tui title', async () => {
    layout(['model'], { style: 'tui', tui: { title: { left: '{model}', right: '{clock}' } } });
    const f = fake();
    await runInstall(args('--dry-run'), cfg, f.io);
    expect(count(f.lines, hint('clock'))).toBe(1);
  });
});
