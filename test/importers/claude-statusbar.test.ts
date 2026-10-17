import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { importClaudeStatusbar, TARGETS } from '../../src/importers/claude-statusbar.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const FILE = path.join(FIXTURES, 'claude-statusbar.json');
const fixture = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

type R = ReturnType<typeof importClaudeStatusbar>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const all = (r: R) => r.config.lines!.flat().map((i) => i.type);
const texts = (r: R) => r.notes.map((n) => n.text);

const MAIN = [
  'five-hour-usage',
  'five-hour-reset',
  'weekly-usage',
  'weekly-reset',
  'model',
  'context-length',
];
const IDENTITY = ['git-worktree', 'project-dir', 'git-branch', 'git-status', 'lines-changed'];
const MODE = ['effort', 'thinking', 'fast-mode', 'output-style'];

describe('importClaudeStatusbar', () => {
  it('maps the documented example: capsule style, twilight theme and the default toggles', () => {
    const r = importClaudeStatusbar(fixture());
    expect(r.source).toBe('claude-statusbar');
    expect(types(r)).toEqual([[...MAIN, 'cache-timer'], IDENTITY, MODE, ['todo-list']]);
    expect(r.config).toMatchObject({ theme: 'one-dark', style: 'capsule' });
    expect(r.config.separator).toBeUndefined();
    expect(item(r, 'five-hour-usage')!.options).toBeUndefined();
    expect(item(r, 'context-length')!.options).toEqual({ showMax: true });
    expect(item(r, 'git-status')!.options).toEqual({ counts: false });
    expect(item(r, 'todo-list')!.options).toEqual({ display: 'current' });
    expect(item(r, 'fast-mode')!.options).toEqual({ showOff: true });
    expect(item(r, 'output-style')!.options).toEqual({ showDefault: true });
    expect(item(r, 'model')!.id).toBe('claude-statusbar-model');
    expect(r.notes).toEqual([
      {
        kind: 'drop',
        text: 'claude-statusbar settings not imported: auto_compact_width, show_language, show_balance, balance_bar, show_ocs',
      },
      { kind: 'approx', text: 'claude-statusbar theme "twilight" is approximated by the one-dark theme' },
    ]);
  });

  it('imports the defaults: classic style with projections, risk chips and the graphite approximation', () => {
    const r = importClaudeStatusbar({}, { defaulted: true });
    expect(types(r)).toEqual([
      [
        'five-hour-usage',
        'five-hour-reset',
        'usage-projection',
        'limit-risk',
        'weekly-usage',
        'weekly-reset',
        'usage-projection',
        'limit-risk',
        'model',
        'context-length',
        'cache-timer',
      ],
      IDENTITY,
      MODE,
      ['todo-list'],
    ]);
    expect(r.config).toMatchObject({ theme: 'dark', style: 'text', separator: ' | ' });
    expect(item(r, 'five-hour-usage')!.options).toEqual({ display: 'bar' });
    const ids = r.config.lines![0]!.map((i) => i.id);
    expect(ids).toContain('claude-statusbar-usage-projection-2');
    expect(r.config.lines![0]!.filter((i) => i.type === 'limit-risk').map((i) => i.options)).toEqual([
      { window: '5h' },
      { window: '7d' },
    ]);
    expect(texts(r)).toEqual([
      'no claude-statusbar config file found, imported its default layout',
      'claude-statusbar theme "graphite" is approximated by the dark theme',
    ]);
  });

  it('removes the items of toggles that are off and omits empty lines', () => {
    const r = importClaudeStatusbar({
      style: 'classic',
      show_weekly: false,
      show_projection: false,
      show_forecast: 'off',
      show_cache_age: false,
      show_project_branch: false,
      show_mode: false,
      show_todos: false,
    });
    expect(types(r)).toEqual([['five-hour-usage', 'five-hour-reset', 'model', 'context-length']]);
  });

  it('adds the opt-in segments on their lines', () => {
    const r = importClaudeStatusbar({
      style: 'classic',
      show_cost: true,
      show_per_model: true,
      show_ahead_behind: 'yes',
      show_cwd: true,
      cwd_style: 'full',
      show_duration: 1,
      show_tools: true,
      show_tool_rollup: true,
      show_agents: true,
      show_projection: false,
      show_forecast: false,
    });
    expect(types(r)).toEqual([
      [...MAIN, 'session-cost', 'cache-timer'],
      ['weekly-model-usage', 'weekly-model-reset'],
      [
        'git-worktree',
        'project-dir',
        'git-branch',
        'git-status',
        'git-ahead-behind',
        'cwd',
        'session-duration',
        'lines-changed',
      ],
      MODE,
      ['todo-list', 'tool-activity'],
      ['agents'],
    ]);
    expect(item(r, 'cwd')!.options).toEqual({ style: 'full' });
    expect(item(r, 'tool-activity')!.options).toEqual({ mode: 'both' });
    expect(item(r, 'agents')!.options).toEqual({ runningOnly: true });
    expect(texts(r)).toContain(
      'claude-statusbar "show_per_model" is approximated by the weekly-model-usage widget',
    );
  });

  it('gives cwd its own line without the project line and maps the cwd and tool modes', () => {
    const r = importClaudeStatusbar({ show_project_branch: false, show_cwd: true, cwd_style: 'other' });
    expect(types(r)[1]).toEqual(['cwd']);
    expect(item(r, 'cwd')!.options).toEqual({ style: 'basename' });
    const tools = (show_tools: boolean, show_tool_rollup: boolean) =>
      item(importClaudeStatusbar({ show_tools, show_tool_rollup }), 'tool-activity')?.options;
    expect(tools(true, false)).toEqual({ mode: 'running' });
    expect(tools(false, true)).toEqual({ mode: 'counts' });
    expect(tools(false, false)).toBeUndefined();
  });

  it('maps themes exactly or with an approximation note', () => {
    const theme = (name: unknown) => importClaudeStatusbar({ theme: name });
    for (const name of ['nord', 'dracula', 'mono', 'catppuccin-mocha', 'tokyo-night']) {
      expect(theme(name).config.theme, name).toBe(name);
      expect(theme(name).notes, name).toEqual([]);
    }
    for (const [name, id] of [
      ['graphite', 'dark'],
      ['twilight', 'one-dark'],
      ['linen', 'light'],
      ['sakura', 'rose-pine'],
    ]) {
      const r = theme(name);
      expect(r.config.theme).toBe(id);
      expect(r.notes).toEqual([
        { kind: 'approx', text: `claude-statusbar theme "${name}" is approximated by the ${id} theme` },
      ]);
    }
    expect(texts(theme('ocean'))).toEqual([
      'claude-statusbar theme "ocean" has no ccinfobar equivalent, used the dark theme',
    ]);
  });

  it('maps hairline to text with its separator glyph, bar mini gauges and density padding', () => {
    const r = importClaudeStatusbar({ style: 'hairline', theme: 'nord' });
    expect(r.config).toMatchObject({ style: 'text', separator: ' ┊ ' });
    expect(item(r, 'five-hour-usage')!.options).toEqual({ display: 'bar', width: 3 });
    expect(all(r)).not.toContain('usage-projection');
    expect(all(r)).not.toContain('limit-risk');
    expect(r.notes).toEqual([
      { kind: 'approx', text: 'claude-statusbar style "hairline" is approximated by the text style' },
    ]);
    expect(importClaudeStatusbar({ style: 'hairline', density: 'compact' }).config.separator).toBe('┊');
    expect(importClaudeStatusbar({ style: 'hairline', density: 'cozy' }).config.separator).toBe('  ┊  ');
    expect(texts(importClaudeStatusbar({ style: 'capsule', density: 'cozy', theme: 'mono' }))).toEqual([
      'claude-statusbar settings not imported: density',
    ]);
  });

  it('falls back to classic for an unknown style', () => {
    const r = importClaudeStatusbar({ style: 'neon', theme: 'nord' });
    expect(r.config).toMatchObject({ style: 'text', separator: ' | ' });
    expect(texts(r)).toEqual([
      'claude-statusbar style "neon" is unknown, imported its default style (classic)',
    ]);
  });

  it('names dropped settings by key only, never their values', () => {
    const r = importClaudeStatusbar({
      theme: 'nord',
      show_balance: true,
      show_ip_risk: true,
      show_fp_risk: false,
      api_mode: 'on',
      auto_upgrade: true,
      bar_shimmer: false,
      warning_threshold: 41,
      critical_threshold: 87,
      color_ok: '#4ec85b',
      color_hot: '',
      worktree_glyph: '⑂',
      cache_ttl_seconds: 3600,
      relay_url: 'https://relay.example.com',
    });
    expect(r.notes).toEqual([
      {
        kind: 'drop',
        text: 'claude-statusbar settings not imported: show_balance, show_ip_risk, api_mode, warning_threshold, critical_threshold, color_ok, auto_upgrade',
      },
    ]);
    const joined = texts(r).join('\n');
    for (const v of ['41', '87', '4ec85b', 'example.com', '3600']) expect(joined).not.toContain(v);
    expect(texts(importClaudeStatusbar({ theme: 'nord', worktree_glyph: '\u{1f332}' }))).toEqual([
      'claude-statusbar settings not imported: worktree_glyph',
    ]);
  });

  it('imports the defaults with one note for a file that is not a JSON object', () => {
    for (const raw of [[1, 2], 'capsule', 42, null]) {
      const r = importClaudeStatusbar(raw, { file: '~/.claude/claude-statusbar.json' });
      expect(r.config).toMatchObject({ style: 'text', separator: ' | ', theme: 'dark' });
      expect(r.notes[0]).toEqual({
        kind: 'info',
        text: '~/.claude/claude-statusbar.json is not a JSON object and was ignored',
      });
      expect(r.notes.filter((n) => n.kind === 'info')).toHaveLength(1);
    }
  });

  it('ignores prototype keys', () => {
    const raw = JSON.parse('{"__proto__": {"show_cost": true}, "constructor": 1, "theme": "nord"}');
    const r = importClaudeStatusbar(raw);
    expect(all(r)).not.toContain('session-cost');
    expect(r.notes).toEqual([]);
    expect(({} as Record<string, unknown>).show_cost).toBeUndefined();
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = importClaudeStatusbar({ style: 'hairline', theme: 'sakura', show_ocs: true });
      expect(texts(r)).toEqual([
        'claude-statusbar stili "hairline", text stiliyle yaklaşık olarak gösteriliyor',
        'claude-statusbar ayarları içe aktarılmadı: show_ocs',
        'claude-statusbar teması "sakura", rose-pine temasıyla yaklaşık olarak gösteriliyor',
      ]);
    });
  });
});
