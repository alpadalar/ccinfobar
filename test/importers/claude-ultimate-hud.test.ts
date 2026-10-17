import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importClaudeUltimateHud, TARGETS } from '../../src/importers/claude-ultimate-hud.js';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const FILE = path.join(FIXTURES, 'claude-ultimate-hud.json');
const fixture = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

type R = ReturnType<typeof importClaudeUltimateHud>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const all = (r: R) => r.config.lines!.flat().map((i) => i.type);
const texts = (r: R) => r.notes.map((n) => n.text);

const HEAD = ['model', 'context-bar', 'context-length', 'tokens-input', 'tokens-cached'];
const PROJECT = ['cwd', 'git-branch', 'git-status', 'git-ahead-behind', 'env-counts', 'session-duration'];
const BREAKDOWN = 'claude-ultimate-hud "showTokenBreakdown" is approximated by the tokens-input widget';
const WARNING = 'claude-ultimate-hud "contextWarning" is approximated by the context-bar widget';

describe('importClaudeUltimateHud', () => {
  it('maps the setup example: enterprise cost, toggles off, language and cache notes', () => {
    const r = importClaudeUltimateHud(fixture());
    expect(r.source).toBe('claude-ultimate-hud');
    expect(types(r)).toEqual([
      [...HEAD, 'session-cost', 'five-hour-usage', 'five-hour-reset'],
      PROJECT,
      ['tool-activity'],
      ['agents'],
    ]);
    expect(r.config).toMatchObject({ style: 'text', separator: ' │ ' });
    expect(r.config.theme).toBeUndefined();
    expect(item(r, 'context-length')!.options).toEqual({ showMax: true });
    expect(item(r, 'tokens-input')!.showWhen).toBe('context.pct >= 85');
    expect(item(r, 'tokens-cached')!.showWhen).toBe('context.pct >= 85');
    expect(item(r, 'agents')).toMatchObject({ options: { maxAgents: 3 }, hideEmpty: true });
    expect(item(r, 'tool-activity')).toMatchObject({
      options: { mode: 'both', scope: 'session' },
      hideEmpty: true,
    });
    expect(item(r, 'git-status')!.options).toEqual({ counts: false });
    expect(item(r, 'env-counts')!.options).toEqual({ showAgentsMd: false });
    expect(item(r, 'model')!.id).toBe('claude-ultimate-hud-model');
    expect(r.notes).toEqual([
      {
        kind: 'info',
        text: 'claude-ultimate-hud language "ko" was not imported: ccinfobar keeps its own language setting',
      },
      {
        kind: 'info',
        text: 'claude-ultimate-hud cache.ttlSeconds was not imported: ccinfobar keeps its own usage cache',
      },
      { kind: 'approx', text: BREAKDOWN },
      { kind: 'approx', text: WARNING },
    ]);
  });

  it('imports the defaults: max100 limits with the Sonnet weekly usage and every line', () => {
    const r = importClaudeUltimateHud({}, { defaulted: true });
    expect(types(r)).toEqual([
      [...HEAD, 'five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-model-usage'],
      ['thinking', 'skills', 'lines-changed'],
      PROJECT,
      ['tool-activity'],
      ['agents'],
      ['todo-list'],
    ]);
    expect(item(r, 'weekly-model-usage')!.options).toEqual({ model: 'Sonnet' });
    expect(item(r, 'thinking')!.options).toEqual({ hideOff: true });
    expect(item(r, 'lines-changed')!.options).toEqual({ hideZero: true });
    expect(item(r, 'todo-list')).toMatchObject({ options: { display: 'current' }, hideEmpty: true });
    expect(texts(r)).toEqual([
      'no claude-ultimate-hud config file found, imported its default layout',
      'claude-ultimate-hud language "ko" was not imported: ccinfobar keeps its own language setting',
      BREAKDOWN,
      WARNING,
    ]);
  });

  it('shows the weekly limits only on max plans', () => {
    const limits = (plan: string) =>
      importClaudeUltimateHud({ plan, language: 'en' })
        .config.lines![0]!.slice(HEAD.length)
        .map((i) => i.type);
    expect(limits('max200')).toEqual([
      'five-hour-usage',
      'five-hour-reset',
      'weekly-usage',
      'weekly-model-usage',
    ]);
    expect(limits('pro')).toEqual(['five-hour-usage', 'five-hour-reset']);
    const r = importClaudeUltimateHud({ plan: 'team', language: 'auto' });
    expect(all(r)).not.toContain('weekly-usage');
    expect(texts(r)[0]).toBe('claude-ultimate-hud plan "team" is unknown, imported it as the pro plan');
  });

  it('follows the display toggles, where only false hides a line', () => {
    const r = importClaudeUltimateHud({
      language: 'en',
      display: {
        showTools: false,
        showAgents: 'false',
        showTodos: false,
        showStats: false,
        showTokenBreakdown: false,
      },
    });
    expect(types(r)).toEqual([
      [
        'model',
        'context-bar',
        'context-length',
        'five-hour-usage',
        'five-hour-reset',
        'weekly-usage',
        'weekly-model-usage',
      ],
      PROJECT,
      ['agents'],
    ]);
    expect(texts(r)).toEqual([WARNING]);
  });

  it('notes cache.ttlSeconds only when the file sets it', () => {
    expect(texts(importClaudeUltimateHud({ language: 'en', cache: {} }))).toEqual([BREAKDOWN, WARNING]);
    expect(texts(importClaudeUltimateHud({ language: 'en', cache: { ttlSeconds: 60 } }))[0]).toBe(
      'claude-ultimate-hud cache.ttlSeconds was not imported: ccinfobar keeps its own usage cache',
    );
  });

  it('imports the defaults with one note for a file that is not a JSON object', () => {
    for (const raw of [[1, 2], 'max200', 42, null]) {
      const r = importClaudeUltimateHud(raw, { file: '~/.claude/claude-ultimate-hud.local.json' });
      expect(all(r)).toContain('weekly-model-usage');
      expect(r.notes[0]).toEqual({
        kind: 'info',
        text: '~/.claude/claude-ultimate-hud.local.json is not a JSON object and was ignored',
      });
    }
  });

  it('ignores prototype keys', () => {
    const raw = JSON.parse(
      '{"__proto__": {"plan": "enterprise"}, "language": "en", "display": {"__proto__": {"showTools": false}}}',
    );
    const r = importClaudeUltimateHud(raw);
    expect(all(r)).not.toContain('session-cost');
    expect(all(r)).toContain('tool-activity');
    expect(({} as Record<string, unknown>).showTools).toBeUndefined();
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = importClaudeUltimateHud({
        plan: 'team',
        cache: { ttlSeconds: 30 },
        display: { showTokenBreakdown: false },
      });
      expect(texts(r)).toEqual([
        'claude-ultimate-hud dili "ko" içe aktarılmadı: ccinfobar kendi dil ayarını korur',
        'claude-ultimate-hud planı "team" bilinmiyor, pro planı olarak içe aktarıldı',
        'claude-ultimate-hud cache.ttlSeconds içe aktarılmadı: ccinfobar kendi kullanım önbelleğini kullanır',
        'claude-ultimate-hud "contextWarning", context-bar bileşeniyle yaklaşık olarak gösteriliyor',
      ]);
    });
  });
});

describe('claude-ultimate-hud importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cuh-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const homeFile = () => path.join(env.HOME!, '.claude', 'claude-ultimate-hud.local.json');

  it('reads --file', () => {
    const r = importFrom('claude-ultimate-hud', { file: FILE, env, cwd: dir });
    expect(r.file).toBe(FILE);
    expect(all(r)).toContain('session-cost');
  });

  it('finds ~/.claude/claude-ultimate-hud.local.json even with CLAUDE_CONFIG_DIR, else imports the defaults', () => {
    const none = importFrom('claude-ultimate-hud', { env, cwd: dir });
    expect(none.file).toBeNull();
    expect(texts(none)[0]).toBe('no claude-ultimate-hud config file found, imported its default layout');

    const cc = path.join(dir, 'cc');
    fs.mkdirSync(cc);
    fs.writeFileSync(path.join(cc, 'claude-ultimate-hud.local.json'), '{"plan": "pro"}');
    fs.writeFileSync(homeFile(), '{"plan": "enterprise"}');
    const r = importFrom('claude-ultimate-hud', { env: { ...env, CLAUDE_CONFIG_DIR: cc }, cwd: dir });
    expect(r.file).toBe(homeFile());
    expect(all(r)).toContain('session-cost');
  });

  it('notes a file that is not an object with the tilde path, and reports bad JSON', () => {
    fs.writeFileSync(homeFile(), '"pro"');
    expect(importFrom('claude-ultimate-hud', { env, cwd: dir }).notes[0]!.text).toBe(
      `${path.join('~', '.claude', 'claude-ultimate-hud.local.json')} is not a JSON object and was ignored`,
    );
    fs.writeFileSync(homeFile(), '{"plan": ');
    expect(() => importFrom('claude-ultimate-hud', { env, cwd: dir })).toThrow(
      /Cannot parse claude-ultimate-hud config/,
    );
  });

  it('is detected from its plugin commands and never as claude-hud', () => {
    for (const cmd of [
      'node ~/.claude/plugins/claude-ultimate-hud/dist/index.js',
      `bash -c '"/usr/bin/node" "$(ls -td ~/.claude/plugins/cache/claude-ultimate-hud/claude-ultimate-hud/*/ 2>/dev/null | head -1)dist/index.js"'`,
      `powershell -Command "& {$cache='$env:USERPROFILE\\.claude\\plugins\\cache\\claude-ultimate-hud\\claude-ultimate-hud'; & 'C:\\node.exe' (Join-Path $cache 'dist\\index.js')}"`,
    ]) {
      expect(detectTool(cmd), cmd).toMatchObject({
        tool: 'claude-ultimate-hud',
        name: 'claude-ultimate-hud',
        importable: true,
      });
    }
    expect(detectTool('claude-hud')?.tool).toBe('claude-hud');
    expect(detectTool('node ~/.claude/plugins/claude-hud/dist/index.js')?.tool).toBe('claude-hud');
    expect(detectTool('~/.claude/best-claude-hud/best-claude-hud')?.tool).toBe('best-claude-hud');
  });
});
