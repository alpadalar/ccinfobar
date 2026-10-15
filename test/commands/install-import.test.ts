import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { type InstallIo, offerImport, runInstall } from '../../src/commands/install-cli.js';
import { t } from '../../src/core/i18n/index.js';
import { ccstatuslinePath, detectTool, hudPaths } from '../../src/importers/index.js';

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

  afterEach(() => {
    process.env = saved;
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
        command: `ccinfobar import ccstatusline --allow-commands --force --file ${ccFile}`,
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
});
