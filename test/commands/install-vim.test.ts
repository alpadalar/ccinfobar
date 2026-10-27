import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { type InstallIo, runInstall } from '../../src/commands/install-cli.js';
import { t } from '../../src/core/i18n/index.js';
import { claudeJsonPath } from '../../src/core/paths.js';
import { restoreEnv } from '../helpers.js';

let saved: NodeJS.ProcessEnv;
let dir: string;
let settings: string;
let cfg: string;
let cwd: string;

beforeEach(() => {
  saved = { ...process.env };
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-vim-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
  process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
  settings = path.join(dir, 'claude', 'settings.json');
  cfg = path.join(dir, 'config', 'config.json');
  cwd = path.join(dir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv(saved);
  process.exitCode = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const fake = (tty: boolean, answer = false) => {
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
const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};
const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
const config = (vim: boolean) =>
  writeJson(cfg, { lines: [[{ type: 'model' }, ...(vim ? [{ type: 'vim-mode' }] : [])]] });
const prompt = () => t('install.hideVimPrompt');
const set = () => t('install.hideVimSet');

describe('install hide-vim offer', () => {
  it('asks and writes the key on yes', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBe(true);
    expect(read().editorMode).toBe('vim');
    expect(f.text()).toContain(set());
  });

  it('keeps the key absent on no and still installs', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    const f = fake(true, false);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).toContain(prompt());
    expect(read().statusLine.command).toBe('/bin/ccinfobar');
    expect(read().statusLine.hideVimModeIndicator).toBeUndefined();
    expect(f.text()).not.toContain(set());
  });

  it('does not offer without a tty', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    const f = fake(false, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBeUndefined();
  });

  it('never offers with --yes, but --hide-vim-indicator still applies', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    const f = fake(true, true);
    await runInstall(inst('--yes'), cfg, f.io);
    expect(f.asked).toEqual([]);
    expect(read().statusLine.command).toBe('/bin/ccinfobar');
    expect(read().statusLine.hideVimModeIndicator).toBeUndefined();
    await runInstall(inst('--yes', '--hide-vim-indicator'), cfg, fake(true, true).io);
    expect(read().statusLine.hideVimModeIndicator).toBe(true);
  });

  it('does not offer without a vim-mode widget', async () => {
    config(false);
    writeJson(settings, { editorMode: 'vim' });
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBeUndefined();
  });

  it('does not offer when editorMode is normal', async () => {
    config(true);
    writeJson(settings, { editorMode: 'normal' });
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBeUndefined();
  });

  it('applies --hide-vim-indicator without asking', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    const f = fake(true, false);
    await runInstall(inst('--hide-vim-indicator'), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBe(true);
    expect(f.text()).toContain(set());
  });

  it('removes the key with --no-hide-vim-indicator', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    await runInstall(inst('--hide-vim-indicator'), cfg, fake(false).io);
    const f = fake(true, true);
    await runInstall(inst('--no-hide-vim-indicator'), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBeUndefined();
    expect(f.text()).toContain(t('install.hideVimUnset'));
  });

  it('prints the dry-run lines and writes nothing', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    const before = fs.readFileSync(settings, 'utf8');
    const f = fake(true, true);
    await runInstall(inst('--hide-vim-indicator', '--dry-run'), cfg, f.io);
    expect(f.text()).toContain(t('install.dry.hideVim'));
    const g = fake(true, true);
    await runInstall(inst('--no-hide-vim-indicator', '--dry-run'), cfg, g.io);
    expect(g.text()).toContain(t('install.dry.hideVimOff'));
    const h = fake(true, true);
    await runInstall(inst('--dry-run'), cfg, h.io);
    expect(h.asked).toEqual([]);
    expect(fs.readFileSync(settings, 'utf8')).toBe(before);
  });

  it('does not offer or write with --project', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    const f = fake(true, true);
    await runInstall(inst('--project'), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
    const local = path.join(cwd, '.claude', 'settings.local.json');
    const written = fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : '';
    expect(written).not.toContain('hideVimModeIndicator');
  });

  it('does not offer when the statusLine already hides it', async () => {
    config(true);
    writeJson(settings, {
      editorMode: 'vim',
      statusLine: { type: 'command', command: '/bin/ccinfobar', padding: 0, hideVimModeIndicator: true },
    });
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBe(true);
  });

  it('falls back to editorMode in .claude.json', async () => {
    config(true);
    writeJson(settings, {});
    writeJson(claudeJsonPath(), { editorMode: 'vim' });
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).toContain(prompt());
    expect(read().statusLine.hideVimModeIndicator).toBe(true);
  });

  it('lets a project layer override user vim', async () => {
    config(true);
    writeJson(settings, { editorMode: 'vim' });
    writeJson(path.join(cwd, '.claude', 'settings.local.json'), { editorMode: 'normal' });
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
  });

  it('survives a malformed .claude.json', async () => {
    config(true);
    writeJson(settings, {});
    fs.writeFileSync(claudeJsonPath(), '{ nope');
    const f = fake(true, true);
    await runInstall(inst(), cfg, f.io);
    expect(f.asked).not.toContain(prompt());
  });
});
