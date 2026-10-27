import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { planInstall } from '../../src/commands/install.js';
import { type InstallIo, runInstall, runUninstall } from '../../src/commands/install-cli.js';
import { t } from '../../src/core/i18n/index.js';
import { restoreEnv, withLangAsync } from '../helpers.js';

let saved: NodeJS.ProcessEnv;
let dir: string;
let settings: string;
let cfg: string;

beforeEach(() => {
  saved = { ...process.env };
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-subagents-cli-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  settings = path.join(dir, 'claude', 'settings.json');
  cfg = path.join(dir, 'config', 'config.json');
});

afterEach(() => {
  restoreEnv(saved);
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const fake = (tty = false, answer = false) => {
  const lines: string[] = [];
  const asked: string[] = [];
  const io: InstallIo = {
    tty,
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
    setup: (() => {
      throw new Error('setup must not run');
    }) as unknown as InstallIo['setup'],
    claudeVersion: () => '2.1.299',
  };
  return { io, lines, asked, text: () => lines.join('\n') };
};

const inst = (...a: string[]) => parseArgs(['install', '--command', '/bin/ccinfobar', '--no-import', ...a]);
const uninst = (...a: string[]) => parseArgs(['uninstall', ...a]);
const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
const write = (data: unknown) => {
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(data, null, 2));
};
const ours = { type: 'command', command: '/bin/ccinfobar subagent-line' };
const FOREIGN = { type: 'command', command: 'other-tool run' };
const OURS_SL = { type: 'command', command: '/bin/ccinfobar' };

describe('install --subagents', () => {
  it('sets the key, then a plain install keeps it without a subagent line', async () => {
    const f = fake();
    await runInstall(inst('--subagents'), cfg, f.io);
    expect(read().subagentStatusLine).toEqual(ours);
    expect(f.text()).toContain(t('install.subagentsAdded', { command: ours.command }));
    const g = fake();
    await runInstall(inst(), cfg, g.io);
    expect(read().subagentStatusLine).toEqual(ours);
    expect(g.text()).not.toContain('subagentStatusLine set');
  });

  it('previews on a dry run and writes nothing', async () => {
    write({ model: 'opus' });
    const before = fs.readFileSync(settings, 'utf8');
    const f = fake();
    await runInstall(inst('--subagents', '--dry-run'), cfg, f.io);
    expect(f.text()).toContain(t('install.dry.subagentAdd', { command: ours.command }));
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
  });

  it('ignores the flag with --project', async () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const cwd = process.cwd();
    process.chdir(proj);
    try {
      const f = fake();
      await runInstall(inst('--subagents', '--project'), cfg, f.io);
      expect(f.text()).toContain(t('install.subagentsProjectIgnored'));
      const file = path.join(proj, '.claude', 'settings.local.json');
      const data = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      expect(data).not.toContain('subagentStatusLine');
    } finally {
      process.chdir(cwd);
    }
  });

  it('asks before replacing a foreign value: No keeps it, statusLine still installed', async () => {
    write({ subagentStatusLine: FOREIGN });
    const f = fake(true, false);
    await runInstall(inst('--subagents'), cfg, f.io);
    expect(f.asked).toHaveLength(1);
    expect(f.text()).toContain(t('install.subagentsKept'));
    expect(read().subagentStatusLine).toEqual(FOREIGN);
    expect(read().statusLine.command).toBe('/bin/ccinfobar');
  });

  it('replaces after a yes, and uninstall brings the foreign value back', async () => {
    write({ subagentStatusLine: FOREIGN });
    const f = fake(true, true);
    await runInstall(inst('--subagents'), cfg, f.io);
    expect(read().subagentStatusLine).toEqual(ours);
    expect(f.text()).toContain('replaced');
    await runUninstall(uninst(), cfg, fake().io);
    expect(read().subagentStatusLine).toEqual(FOREIGN);
  });

  it('--yes replaces without asking on a non-TTY; no --yes on a non-TTY keeps', async () => {
    write({ subagentStatusLine: FOREIGN });
    const kept = fake(false, true);
    await runInstall(inst('--subagents'), cfg, kept.io);
    expect(kept.asked).toHaveLength(0);
    expect(kept.text()).toContain(t('install.subagentsKept'));
    expect(read().subagentStatusLine).toEqual(FOREIGN);
    const yes = fake(false, false);
    await runInstall(inst('--subagents', '--yes'), cfg, yes.io);
    expect(yes.asked).toHaveLength(0);
    expect(read().subagentStatusLine).toEqual(ours);
  });

  it('without the flag a foreign value is untouched and unmentioned', async () => {
    write({ subagentStatusLine: FOREIGN });
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(read().subagentStatusLine).toEqual(FOREIGN);
    expect(f.asked).toHaveLength(0);
    expect(f.text()).not.toContain('subagentStatusLine');
  });

  it('a foreign subagent entry over an owned statusLine prints only subagent lines', async () => {
    await runInstall(inst(), cfg, fake().io);
    write({ statusLine: OURS_SL, ...read(), subagentStatusLine: FOREIGN });
    const plan = planInstall({ file: settings, command: '/bin/ccinfobar', subagents: true });
    expect(plan.needsConfirm).toBe(true);
    expect(plan.owner).toBe('ours');
    const yes = fake();
    await runInstall(inst('--subagents', '--yes'), cfg, yes.io);
    expect(yes.text()).toContain('replaced');
    expect(yes.text()).not.toContain(t('install.replaced', { command: OURS_SL.command }));
    expect(yes.text()).not.toContain(t('install.foreignHeader', { file: settings }));
    write({ ...read(), subagentStatusLine: FOREIGN });
    const no = fake(true, false);
    await runInstall(inst('--subagents'), cfg, no.io);
    expect(no.text()).toContain(t('install.subagentsKept'));
    expect(no.text()).not.toContain(t('install.replaced', { command: OURS_SL.command }));
    expect(no.text()).not.toContain(t('install.replacePrompt'));
  });

  it('speaks Turkish with a Turkish config language', async () => {
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ language: 'tr', lines: [] }));
    const f = fake();
    let expected = '';
    await withLangAsync('tr', async () => {
      expected = t('install.subagentsAdded', { command: ours.command });
      await runInstall(inst('--subagents'), cfg, f.io);
    });
    expect(expected).toContain('alt ajan');
    expect(f.text()).toContain(expected);
  });
});

describe('uninstall --subagents', () => {
  it('does nothing else with --project', async () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const cwd = process.cwd();
    process.chdir(proj);
    try {
      await runInstall(inst('--project'), cfg, fake().io);
      const file = path.join(proj, '.claude', 'settings.local.json');
      const before = fs.readFileSync(file, 'utf8');
      expect(before).toContain('statusLine');
      const f = fake();
      await runUninstall(uninst('--subagents', '--project'), cfg, f.io);
      expect(f.text()).toContain(t('install.subagentsUninstallProject'));
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });

  it('removes only the subagent key, then reports nothing to remove', async () => {
    await runInstall(inst('--subagents'), cfg, fake().io);
    const f = fake();
    await runUninstall(uninst('--subagents'), cfg, f.io);
    expect(f.text()).toContain(t('install.subagentsRemoved'));
    expect(read().subagentStatusLine).toBeUndefined();
    expect(read().statusLine.command).toBe('/bin/ccinfobar');
    const g = fake();
    await runUninstall(uninst('--subagents'), cfg, g.io);
    expect(g.text()).toContain(t('install.subagentsNone', { file: settings.replace(os.homedir(), '~') }));
  });
});
