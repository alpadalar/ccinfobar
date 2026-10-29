import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { type InstallIo, offerImport, runInstall } from '../../src/commands/install-cli.js';
import { pasteArg } from '../../src/commands/manage.js';
import { t } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';
import { ccstatuslinePath, detectTool, hudPaths, sniffTool } from '../../src/importers/index.js';

vi.mock('../../src/importers/index.js', async (orig) => {
  const mod = await orig<typeof import('../../src/importers/index.js')>();
  return { ...mod, sniffTool: vi.fn(mod.sniffTool) };
});

const writeJson = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

const fake = (tty: boolean, answers: boolean[] = []) => {
  const lines: string[] = [];
  const asked: { q: string; fallback: boolean }[] = [];
  const io: InstallIo = {
    tty,
    ask: async (q, fallback) => {
      asked.push({ q, fallback });
      return answers.shift() ?? fallback;
    },
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
    setup: vi.fn(() => {
      throw new Error('setup must not run');
    }) as unknown as InstallIo['setup'],
  };
  return { io, lines, asked };
};

describe('install import offer', () => {
  let saved: NodeJS.ProcessEnv;
  let dir: string;
  let cfg: string;
  let ccFile: string;

  beforeEach(() => {
    saved = { ...process.env };
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-offer-')));
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'config');
    process.env.CCINFOBAR_CACHE_DIR = path.join(dir, 'cache');
    process.env.XDG_CONFIG_HOME = path.join(dir, 'xdg');
    cfg = path.join(dir, 'config', 'config.json');
    ccFile = ccstatuslinePath(process.env);
    writeJson(ccFile, {
      lines: [
        [
          { id: 'c', type: 'custom-command', commandPath: 'echo hi' },
          { id: 'm', type: 'model' },
        ],
      ],
    });
  });

  // in place, so os.homedir() keeps following HOME
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const tool = () => detectTool('npx ccstatusline')!;
  const offer = (io: InstallIo, ...argv: string[]) =>
    offerImport(tool(), parseArgs(['install', ...argv]), cfg, io);
  const types = () => (read(cfg).lines as { type: string }[][]).flat().map((i) => i.type);

  it('imports with --yes, drops the command and prints the hint', async () => {
    expect(ccFile.startsWith(dir)).toBe(true);
    const f = fake(true);
    await offer(f.io, '--yes');
    expect(f.asked).toEqual([]);
    expect(types()).toEqual(['model']);
    expect(f.lines).toContain('  command: echo hi');
    expect(f.lines).toContain(
      t('import.rerun', {
        command: `ccinfobar import ccstatusline --allow-commands --force --file ${pasteArg(ccFile)} --command ${pasteArg('npx ccstatusline')}`,
      }),
    );
  });

  it('keeps and lists the command with --yes --allow-commands', async () => {
    const f = fake(false);
    await offer(f.io, '--yes', '--allow-commands');
    expect(f.asked).toEqual([]);
    expect(types()).toEqual(['command', 'model']);
    expect(f.lines.slice(0, 2)).toEqual([t('import.targetsHeader'), '  command: echo hi']);
  });

  it('asks about the import first (default yes), then about keeping (default no)', async () => {
    const f = fake(true);
    await offer(f.io);
    expect(f.asked).toEqual([
      { q: t('install.importPrompt', { tool: 'ccstatusline' }), fallback: true },
      { q: t('import.keepPrompt', { count: 1 }), fallback: false },
    ]);
    expect(types()).toEqual(['model']);
    const g = fake(true, [true, true]);
    await offer(g.io, '--force');
    expect(g.asked).toHaveLength(2);
    expect(types()).toEqual(['command', 'model']);
  });

  it('offers the CCometixLine import too', async () => {
    const bin = path.join(dir, 'tools', 'ccline');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'config.toml'),
      '[style]\nmode = "plain"\nseparator = " | "\n\n[[segments]]\nid = "git"\nenabled = true\n',
    );
    const f = fake(false);
    const tool = detectTool(`"${path.join(bin, 'ccline')}"`)!;
    await offerImport(tool, parseArgs(['install', '--yes']), cfg, f.io);
    expect(types()).toEqual(['git-branch', 'git-status']);
    expect(read(cfg).separator).toBe(' | ');
  });

  it('offers the cship import too', async () => {
    const file = path.join(dir, 'tools', 'cship.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[cship]\nlines = ["$cship.model $git_branch"]\n');
    const f = fake(false);
    const tool = detectTool(`cship --config "${file}"`)!;
    expect(tool).toMatchObject({ tool: 'cship', importable: true });
    await offerImport(tool, parseArgs(['install', '--yes']), cfg, f.io);
    expect(types()).toEqual(['model', 'git-branch']);
  });

  it('offers the claude-hud import too and drops its extra command on --yes', async () => {
    writeJson(hudPaths(process.env).config, {
      elementOrder: ['project'],
      gitStatus: { enabled: false },
      display: { showProject: false },
    });
    const f = fake(false);
    const tool = detectTool('node ~/.claude/plugins/claude-hud/dist/index.js --extra-cmd "echo hi"')!;
    expect(tool).toMatchObject({ tool: 'claude-hud', importable: true });
    await offerImport(tool, parseArgs(['install', '--yes']), cfg, f.io);
    expect(types()).toEqual(['model']);
    expect(f.lines).toContain('  command: echo hi');
  });

  it('skips everything with --no-import', async () => {
    const f = fake(true);
    await offer(f.io, '--no-import', '--allow-commands');
    expect(f.asked).toEqual([]);
    expect(f.lines).toEqual([]);
    expect(fs.existsSync(cfg)).toBe(false);
  });

  it('runs the same step from install --yes over ccstatusline', async () => {
    const settings = path.join(dir, 'claude', 'settings.json');
    writeJson(settings, { statusLine: { type: 'command', command: 'npx ccstatusline' } });
    const f = fake(false);
    await runInstall(parseArgs(['install', '--command', '/bin/ccinfobar', '--yes']), cfg, f.io);
    expect(read(settings).statusLine.command).toBe('/bin/ccinfobar');
    expect(types()).toEqual(['model']);
    expect(f.lines).toContain(t('import.targetsDropped', { count: 1 }));
  });

  it('tells how to import a recognised tool by hand', async () => {
    const f = fake(true);
    const other = detectTool('~/.claude/arcade-statusline --theme pacman')!;
    await offerImport(other, parseArgs(['install', '--yes']), cfg, f.io);
    expect(f.lines).toEqual([t('install.importManual', { tool: 'arcade-statusline' })]);
    expect(f.asked).toEqual([]);
    expect(fs.existsSync(cfg)).toBe(false);
  });

  describe('header sniff', () => {
    const sniff = vi.mocked(sniffTool);
    const settings = () => path.join(dir, 'claude', 'settings.json');
    const install = async (command: string) => {
      writeJson(settings(), { statusLine: { type: 'command', command } });
      const f = fake(false);
      await runInstall(parseArgs(['install', '--command', '/bin/ccinfobar', '--yes']), cfg, f.io);
      expect(read(settings()).statusLine.command).toBe('/bin/ccinfobar');
      return f;
    };

    beforeEach(() => sniff.mockClear());

    it('sniffs only an unknown command and offers what it finds', async () => {
      const command = 'bash ~/.claude/statusline.sh';
      sniff.mockReturnValueOnce({ tool: 'ccstatusline', name: 'Sniffed', importable: true, command });
      const f = await install(command);
      expect(sniff).toHaveBeenCalledTimes(1);
      expect(sniff).toHaveBeenCalledWith(command, { env: process.env, cwd: process.cwd() });
      expect(types()).toEqual(['model']);
      expect(f.lines).toContain(t('import.targetsDropped', { count: 1 }));
    });

    it('keeps the custom line message when the sniff finds nothing', async () => {
      const f = await install('bash ~/my-line.sh');
      expect(sniff).toHaveBeenCalledTimes(1);
      expect(f.lines).toContain(t('install.importManual', { tool: t('import.tool.custom') }));
      expect(f.lines.some((l) => l.startsWith('✓ Imported'))).toBe(false);
    });

    it('offers the cc-statusline import for a generated script, and only with the marker', async () => {
      const home = path.join(dir, 'home');
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const script = path.join(home, '.claude', 'statusline.sh');
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '../fixtures/import/cc-statusline.sh'), script);
      const f = await install(`bash "${script}"`);
      expect(sniff).toHaveBeenCalledTimes(1);
      expect(f.lines.some((l) => l.startsWith('✓ Imported'))).toBe(true);
      expect(f.lines).not.toContain(t('install.importManual', { tool: t('import.tool.custom') }));
      expect((read(cfg).lines[0] as { type: string }[]).map((i) => i.type)).toEqual([
        'cwd',
        'git-branch',
        'model',
        'claude-version',
        'output-style',
      ]);

      fs.rmSync(cfg);
      fs.writeFileSync(script, '#!/bin/bash\necho "my own line"\n');
      const plain = await install(`bash "${script}"`);
      expect(plain.lines).toContain(t('install.importManual', { tool: 'a custom status line' }));
      expect(plain.lines.some((l) => l.startsWith('✓ Imported'))).toBe(false);
    });

    it('never sniffs a recognised command', async () => {
      await install('npx ccstatusline');
      await install('~/.claude/arcade-statusline --theme pacman');
      expect(sniff).not.toHaveBeenCalled();
    });
  });

  describe('the three newer tools', () => {
    const home = () => path.join(dir, 'home');
    const ccline = () => path.join(home(), '.claude', 'ccline', 'config.toml');
    const cship = () => path.join(dir, 'tools', 'cship.toml');
    const hudCmd = 'node ~/.claude/plugins/claude-hud/dist/index.js --extra-cmd "echo hi"';

    beforeEach(() => {
      process.env.HOME = home();
      process.env.USERPROFILE = home();
      fs.mkdirSync(path.dirname(ccline()), { recursive: true });
      fs.writeFileSync(
        ccline(),
        '[style]\nmode = "plain"\nseparator = " | "\n\n[[segments]]\nid = "model"\n\n[[segments]]\nid = "directory"\n',
      );
      fs.mkdirSync(path.dirname(cship()), { recursive: true });
      fs.writeFileSync(cship(), '[cship]\nlines = ["$cship.cost $git_branch"]\n');
      writeJson(hudPaths(process.env).config, {
        elementOrder: ['project'],
        gitStatus: { enabled: false },
        display: { showProject: false },
      });
    });

    const cases = [
      {
        cmd: () => 'ccline',
        tool: 'ccometixline',
        name: 'CCometixLine',
        file: ccline,
        first: ['model', 'cwd'],
      },
      {
        cmd: () => `/usr/local/bin/cship --config "${cship()}"`,
        tool: 'cship',
        name: 'cship',
        file: cship,
        first: ['session-cost', 'git-branch'],
      },
      {
        cmd: () => hudCmd,
        tool: 'claude-hud',
        name: 'claude-hud',
        file: () => hudPaths(process.env).config,
        first: ['model'],
      },
    ];

    it.each(cases)('detects $tool as importable', ({ cmd, tool, name }) => {
      expect(detectTool(cmd())).toEqual({ tool, name, importable: true, command: cmd() });
    });

    it.each(cases)('imports $tool from its temp config with --yes', async ({ cmd, tool, file, first }) => {
      const f = fake(false);
      await offerImport(detectTool(cmd())!, parseArgs(['install', '--yes']), cfg, f.io);
      expect(f.asked).toEqual([]);
      expect((read(cfg).lines[0] as { type: string }[]).map((i) => i.type)).toEqual(first);
      const count = (read(cfg).lines as unknown[][]).flat().length;
      expect(f.lines).toContain(t('cmd.import.doneFile', { count, source: tool, file: tildify(file()) }));
    });

    it.each(cases)('writes nothing when the $tool import is declined', async ({ cmd, name }) => {
      const f = fake(true, [false]);
      await offerImport(detectTool(cmd())!, parseArgs(['install']), cfg, f.io);
      expect(f.asked).toEqual([{ q: t('install.importPrompt', { tool: name }), fallback: true }]);
      expect(f.lines).toEqual([]);
      expect(fs.existsSync(path.dirname(cfg))).toBe(false);
    });

    it('drops the claude-hud extra command on --yes and prints the re-run hint', async () => {
      const f = fake(false);
      await offerImport(detectTool(hudCmd)!, parseArgs(['install', '--yes']), cfg, f.io);
      expect(types()).toEqual(['model']);
      const file = pasteArg(hudPaths(process.env).config)!;
      const base = `ccinfobar import claude-hud --allow-commands --force --file ${file}`;
      const cmd = pasteArg(hudCmd);
      expect(f.lines).toContain(
        cmd
          ? t('import.rerun', { command: `${base} --command ${cmd}` })
          : t('import.rerunAddCommand', { command: base }),
      );
      expect(f.lines.find((l) => l.startsWith('To keep them, run: '))).toContain('--allow-commands');
    });

    it('keeps the claude-hud extra command with --yes --allow-commands', async () => {
      const f = fake(false);
      await offerImport(detectTool(hudCmd)!, parseArgs(['install', '--yes', '--allow-commands']), cfg, f.io);
      expect(types()).toEqual(['model', 'command']);
      const cmd = (read(cfg).lines as { type: string; options?: { command?: string } }[][])
        .flat()
        .find((i) => i.type === 'command');
      expect(cmd?.options?.command).toBe('echo hi');
      expect(f.lines).toContain('  command: echo hi');
      expect(f.lines.some((l) => l.startsWith('To keep them, run: '))).toBe(false);
    });
  });

  describe('over an existing config', () => {
    const settings = () => path.join(dir, 'claude', 'settings.json');
    const original = { version: 1, lines: [[{ id: 'x', type: 'cwd' }]] };
    beforeEach(() => {
      writeJson(cfg, original);
      writeJson(settings(), { statusLine: { type: 'command', command: 'npx ccstatusline' } });
    });
    const bytes = () => fs.readFileSync(cfg, 'utf8');
    const backups = () => fs.readdirSync(path.dirname(cfg)).filter((f) => f.endsWith('.bak'));
    const importAsk = (f: ReturnType<typeof fake>) =>
      f.asked.find((a) => a.q === t('install.importPrompt', { tool: 'ccstatusline' }));
    const install = (f: ReturnType<typeof fake>, ...argv: string[]) =>
      runInstall(parseArgs(['install', '--command', '/bin/ccinfobar', ...argv]), cfg, f.io);

    it('does not import with --yes alone and without a terminal', async () => {
      const before = bytes();
      const f = fake(false);
      await install(f, '--yes');
      expect(bytes()).toBe(before);
      expect(f.lines).toContain(t('install.importSkipped'));
      expect(read(settings()).statusLine.command).toBe('/bin/ccinfobar');
    });

    it('imports with --import and keeps a backup', async () => {
      const f = fake(false);
      await install(f, '--import');
      expect(types()).toEqual(['model']);
      expect(backups().length).toBeGreaterThan(0);
    });

    it('asks with default no on a terminal', async () => {
      const before = bytes();
      const f = fake(true, [true, false]);
      await install(f);
      expect(importAsk(f)?.fallback).toBe(false);
      expect(bytes()).toBe(before);
      writeJson(settings(), { statusLine: { type: 'command', command: 'npx ccstatusline' } });
      const g = fake(true, [true, true]);
      await install(g);
      expect(importAsk(g)?.fallback).toBe(false);
      expect(types()).toEqual(['model']);
    });

    it('asks with default yes when there is no config yet', async () => {
      fs.rmSync(cfg);
      const f = fake(true, [true]);
      await install(f);
      expect(importAsk(f)?.fallback).toBe(true);
      expect(types()).toEqual(['model']);
    });

    it('imports with --yes when there is no config yet', async () => {
      fs.rmSync(cfg);
      await install(fake(false), '--yes');
      expect(types()).toEqual(['model']);
    });

    it('never imports with --no-import', async () => {
      const before = bytes();
      const f = fake(false);
      await install(f, '--import', '--no-import');
      expect(bytes()).toBe(before);
    });

    it('imports nothing when the plan went stale', async () => {
      const before = bytes();
      const f = fake(false);
      const mod = await import('../../src/commands/install.js');
      const spy = vi.spyOn(mod, 'applyInstall').mockImplementation(() => {
        throw new mod.InstallNeedsConfirmError({} as never);
      });
      try {
        await install(f, '--import');
      } finally {
        spy.mockRestore();
      }
      expect(bytes()).toBe(before);
      expect(process.exitCode).toBe(1);
    });
  });
});
