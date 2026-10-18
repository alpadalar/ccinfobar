import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImport, runImportCommand } from '../../src/commands/manage.js';
import { importClaudeUsageMonitor, TARGETS } from '../../src/importers/claude-usage-monitor.js';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { restoreEnv, withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const FILE = path.join(FIXTURES, 'claude-usage-monitor.settings.json');

type R = ReturnType<typeof importClaudeUsageMonitor>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);

const GAUGE = { width: 5, style: 'geometric' };
const REMAINING =
  'claude-usage-monitor CQB_REMAINING shows the remaining share; ccinfobar bars and usage widgets show the used share';
const SHELL =
  'only the CQB_* keys in the settings.json env block are read for claude-usage-monitor; variables exported in your shell are not';
const DEFAULT = 'no claude-usage-monitor config file found, imported its default layout';
const USAGE = ['five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-reset'];

describe('importClaudeUsageMonitor', () => {
  it('maps the fixture toggles onto the two fixed lines', () => {
    const r = importClaudeUsageMonitor(JSON.parse(fs.readFileSync(FILE, 'utf8')).env);
    expect(r.source).toBe('claude-usage-monitor');
    expect(types(r)).toEqual([
      ['model', 'project-dir', 'git-branch'],
      [
        'context-bar',
        'context-percentage',
        'five-hour-usage',
        'usage-pace',
        'five-hour-reset',
        'weekly-usage',
        'usage-pace',
        'weekly-reset',
        'session-cost',
        'session-duration',
      ],
    ]);
    const line = r.config.lines![1]!;
    expect(line[0]).toMatchObject({ options: { ...GAUGE, showPercent: false }, merge: true });
    expect(line[1]).toMatchObject({ options: { mode: 'remaining' }, label: ' ' });
    expect(line[2]).toMatchObject({ options: { display: 'bar', ...GAUGE } });
    expect(line[3]).toEqual({
      id: 'claude-usage-monitor-usage-pace',
      type: 'usage-pace',
      options: { window: '5h' },
    });
    expect(line[6]).toEqual({
      id: 'claude-usage-monitor-usage-pace-2',
      type: 'usage-pace',
      options: { window: '7d' },
    });
    expect(r.config).toMatchObject({ style: 'text', separator: ' │ ' });
    expect(r.config.maxWidth).toBeUndefined();
    expect(r.notes).toEqual([
      { kind: 'approx', text: REMAINING },
      { kind: 'approx', text: 'claude-usage-monitor "CQB_PACE" is approximated by the usage-pace widget' },
    ]);
  });

  it('imports the defaults when nothing is set', () => {
    const r = importClaudeUsageMonitor({}, { defaulted: true });
    expect(types(r)).toEqual([
      ['model', 'project-dir', 'git-branch'],
      ['context-bar', 'context-percentage', 'tokens-input', 'tokens-output', ...USAGE, 'session-duration'],
    ]);
    expect(texts(r)).toEqual([DEFAULT, SHELL, REMAINING]);
  });

  it('follows the off switches, the size label and the used share', () => {
    const r = importClaudeUsageMonitor({
      CQB_REMAINING: '0',
      CQB_BAR: 0,
      CQB_BRANCH: '0',
      CQB_RESET: false,
      CQB_DURATION: '',
      CQB_TOKENS: '0',
      CQB_CONTEXT_SIZE: 1,
    });
    expect(types(r)).toEqual([
      ['model', 'project-dir'],
      ['context-bar', 'context-window-size', 'five-hour-usage', 'weekly-usage'],
    ]);
    expect(item(r, 'context-bar')!.options).toEqual(GAUGE);
    expect(item(r, 'five-hour-usage')!.options).toBeUndefined();
    expect(r.notes).toEqual([]);
  });

  it('turns a toggle on only for "1", as statusline.py does', () => {
    expect(item(importClaudeUsageMonitor({ CQB_COST: 'true' }), 'session-cost')).toBeUndefined();
    expect(item(importClaudeUsageMonitor({ CQB_COST: true }), 'session-cost')).toBeUndefined();
    expect(item(importClaudeUsageMonitor({ CQB_COST: 1 }), 'session-cost')).toBeDefined();
    expect(item(importClaudeUsageMonitor({ CQB_COST: {} }), 'session-cost')).toBeUndefined();
    expect(item(importClaudeUsageMonitor({ CQB_TOKENS: 'yes' }), 'tokens-input')).toBeUndefined();
  });

  it('maps CQB_MAX_WIDTH and names a bad width and unknown keys', () => {
    expect(importClaudeUsageMonitor({ CQB_MAX_WIDTH: '100' }).config.maxWidth).toBe(100);
    expect(importClaudeUsageMonitor({ CQB_MAX_WIDTH: 120 }).config.maxWidth).toBe(120);
    const bad = importClaudeUsageMonitor({ CQB_MAX_WIDTH: 'wide\u001b[31m', CQB_CACHE_PATH: '/x/y' });
    expect(bad.config.maxWidth).toBeUndefined();
    expect(bad.notes).toContainEqual({
      kind: 'drop',
      text: 'claude-usage-monitor settings not imported: CQB_MAX_WIDTH "wide", CQB_CACHE_PATH',
    });
    expect(JSON.stringify(bad)).not.toContain('/x/y');
    expect(importClaudeUsageMonitor({ CQB_MAX_WIDTH: '0' }).config.maxWidth).toBeUndefined();
  });

  it('drops the account email', () => {
    const r = importClaudeUsageMonitor({ CQB_EMAIL: '1' });
    expect(r.notes).toContainEqual({
      kind: 'drop',
      text: 'claude-usage-monitor CQB_EMAIL was not imported: ccinfobar never shows your account email',
    });
    for (const i of r.config.lines!.flat()) expect(TARGETS).toContain(i.type);
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      expect(texts(importClaudeUsageMonitor({ CQB_EMAIL: '1', CQB_REMAINING: '0' }))).toEqual([
        'claude-usage-monitor CQB_EMAIL içe aktarılmadı: ccinfobar hesap e-postanızı hiçbir zaman göstermez',
      ]);
      expect(texts(importClaudeUsageMonitor({}))).toEqual([
        'claude-usage-monitor için yalnızca settings.json env bloğundaki CQB_* anahtarları okunur; kabukta dışa aktarılan değişkenler okunmaz',
        'claude-usage-monitor CQB_REMAINING kalan payı gösterir; ccinfobar çubukları ve kullanım bileşenleri kullanılan payı gösterir',
      ]);
    });
  });
});

describe('claude-usage-monitor importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cum-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  });

  afterEach(() => {
    restoreEnv(saved);
    process.exitCode = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const settings = (json: unknown) => {
    const file = path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json));
    return file;
  };

  it('reads --file', () => {
    const r = importFrom('claude-usage-monitor', { file: FILE, env, cwd: dir });
    expect(r.file).toBe(FILE);
    expect(item(r, 'session-cost')).toBeDefined();
    expect(item(r, 'tokens-input')).toBeUndefined();
  });

  it('reads the env block of the Claude settings', () => {
    const file = settings({ env: { CQB_COST: '1' } });
    const r = importFrom('claude-usage-monitor', { env, cwd: dir });
    expect(r.file).toBe(file);
    expect(item(r, 'session-cost')).toBeDefined();
  });

  it('falls back to ~/.claude without CLAUDE_CONFIG_DIR', () => {
    const file = path.join(env.HOME!, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"env": {"CQB_DURATION": "0"}}');
    const r = importFrom('claude-usage-monitor', {
      env: { HOME: env.HOME, USERPROFILE: env.HOME },
      cwd: dir,
    });
    expect(r.file).toBe(file);
    expect(item(r, 'session-duration')).toBeUndefined();
    for (const empty of ['', '  ']) {
      const e = { HOME: env.HOME, USERPROFILE: env.HOME, CLAUDE_CONFIG_DIR: empty };
      expect(importFrom('claude-usage-monitor', { env: e, cwd: dir }).file, JSON.stringify(empty)).toBe(file);
    }
  });

  it('imports the defaults without a settings file and ignores the process env', () => {
    process.env.CQB_COST = '1';
    process.env.CQB_TOKENS = '0';
    const r = importFrom('claude-usage-monitor', { env: { ...env, CQB_COST: '1' }, cwd: dir });
    expect(r.file).toBeNull();
    expect(texts(r).slice(0, 2)).toEqual([DEFAULT, SHELL]);
    expect(item(r, 'session-cost')).toBeUndefined();
    expect(item(r, 'tokens-input')).toBeDefined();
  });

  it('never reads, keeps or prints other settings', async () => {
    const file = settings({
      env: { ANTHROPIC_API_KEY: 'REDACTED-TEST', OTHER_FLAG: '1', CQB_COST: '1' },
      apiKeyHelper: 'REDACTED-HELPER',
      statusLine: { type: 'command', command: 'bash ~/.claude/plugins/claude-usage-monitor/statusline.sh' },
    });
    const r = importFrom('claude-usage-monitor', { env, cwd: dir });
    const dump = JSON.stringify(r);
    for (const s of ['REDACTED', 'ANTHROPIC_API_KEY', 'OTHER_FLAG', 'apiKeyHelper', 'statusLine']) {
      expect(dump).not.toContain(s);
    }
    const lines: string[] = [];
    const io: PromptIo = {
      tty: false,
      ask: async (_q, fallback) => fallback,
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
      columns: 100,
    };
    const cfgFile = path.join(dir, 'config', 'config.json');
    const flags = { allowCommands: false, yes: true, dryRun: false };
    await runImportCommand(
      parseArgs(['import', 'claude-usage-monitor', '--dry-run', '--file', file]),
      cfgFile,
      io,
    );
    expect(await runImport('claude-usage-monitor', { file, command: '', flags }, cfgFile, io)).toBe(true);
    const out = lines.join('\n') + fs.readFileSync(cfgFile, 'utf8');
    for (const s of ['REDACTED', 'ANTHROPIC_API_KEY', 'OTHER_FLAG', 'apiKeyHelper'])
      expect(out).not.toContain(s);
  });

  it('fails on a settings file that is not JSON', () => {
    settings('x');
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), '{ nope');
    expect(() => importFrom('claude-usage-monitor', { env, cwd: dir })).toThrow(
      /Cannot parse claude-usage-monitor config/,
    );
  });

  it('is detected from its installed launchers', () => {
    for (const cmd of [
      'bash ~/.claude/plugins/claude-usage-monitor/statusline.sh',
      '"C:\\Users\\you\\.claude\\plugins\\claude-usage-monitor\\statusline.cmd"',
      'C:/Python313/python.exe -X utf8 C:/Users/you/.claude/plugins/claude-usage-monitor/statusline.py',
    ]) {
      expect(detectTool(cmd), cmd).toMatchObject({
        tool: 'claude-usage-monitor',
        name: 'claude-usage-monitor',
        importable: true,
      });
    }
  });
});
