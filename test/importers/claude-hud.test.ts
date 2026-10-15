import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImport, runImportCommand } from '../../src/commands/manage.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';
import { render } from '../../src/core/renderer.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { Config, WidgetItem } from '../../src/core/types.js';
import {
  HUD_DEFAULTS,
  type HudConfig,
  importClaudeHud,
  mergeHud,
  normalizeHud,
  parseExtraCmd,
  TARGETS,
} from '../../src/importers/claude-hud.js';
import {
  detectTool,
  hudPaths,
  importFrom,
  MAX_SOURCE_BYTES,
  SourceTooLargeError,
  toConfig,
} from '../../src/importers/index.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang, withLangAsync } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const fixture = (f: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
const NOW = new Date('2026-10-12T12:00:00Z');
const show = (config: Config) =>
  render(
    createContext({
      payload: samplePayload(NOW.getTime()),
      config: { ...config, colorLevel: 0, maxWidth: 200 },
      env: {},
      now: NOW,
      data: { git: sampleGit, gsd: sampleGsd, transcript: () => sampleTranscript(NOW.getTime()) },
    }),
  ).map(stripAnsi);

const tmp = () => {
  const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hud-')));
  onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};

const hud = (raw: unknown) => normalizeHud(raw);
const lines = (raw: unknown, opts?: Parameters<typeof importClaudeHud>[1]) =>
  importClaudeHud(hud(raw), opts).config.lines!;
const types = (raw: unknown, opts?: Parameters<typeof importClaudeHud>[1]) =>
  lines(raw, opts).map((l) => l.map((i) => i.type));
const notes = (raw: unknown, opts?: Parameters<typeof importClaudeHud>[1]) =>
  importClaudeHud(hud(raw), opts).notes;
const find = (ls: WidgetItem[][], type: string) => ls.flat().find((i) => i.type === type);

const DIM = { dim: true };

describe('claude-hud config', () => {
  it('normalizes an empty config to the defaults', () => {
    expect(normalizeHud({})).toEqual(HUD_DEFAULTS);
    expect(normalizeHud(null)).toEqual(HUD_DEFAULTS);
    expect(normalizeHud([1, 2])).toEqual(HUD_DEFAULTS);
  });

  it('falls back to the default for wrong types and bad enum values', () => {
    const cfg = hud({
      showSeparators: 'yes',
      pathLevels: 7,
      lineLayout: 'wide',
      unknownKey: true,
      elementOrder: ['nope'],
      display: { showModel: 'yes', contextWarningThreshold: 140, mergeGroups: [['context']], customLine: 5 },
      gitStatus: 'off',
      colors: { model: 'purple', project: 300, git: '#abc' },
    });
    expect(cfg.showSeparators).toBe(false);
    expect(cfg.pathLevels).toBe(1);
    expect(cfg.lineLayout).toBe('expanded');
    expect(cfg).not.toHaveProperty('unknownKey');
    expect(cfg.elementOrder).toEqual(HUD_DEFAULTS.elementOrder);
    expect(cfg.display.showModel).toBe(true);
    expect(cfg.display.contextWarningThreshold).toBe(100);
    expect(cfg.display.mergeGroups).toEqual([['context', 'usage']]);
    expect(cfg.display.customLine).toBe('');
    expect(cfg.gitStatus).toEqual(HUD_DEFAULTS.gitStatus);
    expect(cfg.colors).toEqual(HUD_DEFAULTS.colors);
  });

  it('keeps known element names once each and drops the rest', () => {
    const cfg = hud({
      elementOrder: ['usage', 'x', 'project', 'usage'],
      projectLineOrder: ['cost', 'nope', 'model'],
      display: { mergeGroups: [['tools', 'agents', 'x'], ['agents', 'todos'], 'bad', ['memory', 'context']] },
    });
    expect(cfg.elementOrder).toEqual(['usage', 'project']);
    expect(cfg.projectLineOrder).toEqual(['cost', 'model']);
    expect(cfg.display.mergeGroups).toEqual([
      ['tools', 'agents'],
      ['memory', 'context'],
    ]);
  });

  it('migrates the legacy layout key like claude-hud', () => {
    expect(hud({ layout: 'separators' })).toMatchObject({ lineLayout: 'compact', showSeparators: true });
    expect(hud({ layout: 'default' })).toMatchObject({ lineLayout: 'compact', showSeparators: false });
    expect(hud({ layout: 'separators', lineLayout: 'expanded' })).toMatchObject({
      lineLayout: 'expanded',
      showSeparators: false,
    });
    expect(hud({ layout: { lineLayout: 'compact', pathLevels: 'full' } })).toMatchObject({
      lineLayout: 'compact',
      pathLevels: 'full',
    });
  });

  it('merges objects key by key and replaces arrays and scalars', () => {
    const merged = mergeHud(fixture('claude-hud.json'), fixture('claude-hud.override.json'));
    const cfg = hud(merged);
    expect(cfg.lineLayout).toBe('compact');
    expect(cfg.elementOrder).toEqual(['project', 'tools']);
    expect(cfg.display.showTools).toBe(false);
    expect(cfg.display.showAgents).toBe(true);
    expect(cfg.display.customLine).toBe('hello');
    expect(cfg.colors.project).toBe(208);
    expect(
      hud(mergeHud({ display: { mergeGroups: [['tools', 'agents']] } }, { display: { mergeGroups: [] } }))
        .display.mergeGroups,
    ).toEqual([]);
  });

  it('skips __proto__, constructor and prototype keys while merging', () => {
    const over = JSON.parse(
      '{"__proto__": {"polluted": 1}, "display": {"constructor": {"x": 1}, "prototype": 1, "showCost": true}}',
    );
    const merged = mergeHud({ display: { showDuration: true } }, over);
    expect(Object.hasOwn(merged, '__proto__')).toBe(false);
    expect(Object.keys(merged.display as object)).toEqual(['showDuration', 'showCost']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const cfg = hud(merged);
    expect(cfg.display).toMatchObject({ showCost: true, showDuration: true });
  });

  it('caps the merge depth', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    let node = mergeHud({}, deep) as Record<string, unknown>;
    let depth = 0;
    while (node && typeof node.n === 'object') {
      node = node.n as Record<string, unknown>;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(9);
  });
});

describe('claude-hud layouts', () => {
  it('imports the expanded default layout', () => {
    const result = importClaudeHud(HUD_DEFAULTS);
    expect(result.source).toBe('claude-hud');
    expect(result.config.separator).toBe(' │ ');
    expect(result.config).not.toHaveProperty('language');
    expect(result.config.lines!.map((l) => l.map((i) => i.type))).toEqual([
      ['model', 'cwd', 'git-branch', 'git-status'],
      [
        'context-bar',
        'tokens-input',
        'tokens-cached',
        'five-hour-usage',
        'five-hour-reset',
        'weekly-usage',
        'weekly-reset',
        'weekly-model-usage',
      ],
    ]);
    const first = result.config.lines![0]!;
    expect(first[0]).toEqual({ id: 'hud-model-model', type: 'model', color: 'cyan' });
    expect(first[1]).toEqual({
      id: 'hud-project-cwd',
      type: 'cwd',
      options: { style: 'basename' },
      color: 'yellow',
    });
    expect(first[3]).toEqual({
      id: 'hud-project-git-status',
      type: 'git-status',
      options: { counts: false },
      color: 'cyan',
    });
    expect(find(result.config.lines!, 'five-hour-usage')!.options).toEqual({ display: 'bar' });
    expect(result.notes.map((n) => n.kind)).toEqual(['drop', 'approx', 'approx', 'approx', 'approx']);
    expect(result.notes[0]!.text).toBe(
      'claude-hud segment "addedDirs" has no ccinfobar equivalent and was skipped',
    );
    expect(result.notes[1]!.text).toBe(
      'claude-hud context thresholds 70%/85% became ccinfobar threshold colors (yellow from 50%, red from 80%)',
    );
  });

  it('maps the expanded fixture with its order, groups and colors', () => {
    const ls = lines(fixture('claude-hud.json'));
    expect(ls).toEqual([
      [
        { id: 'hud-model-model', type: 'model', color: 'cyan' },
        {
          id: 'hud-project-cwd',
          type: 'cwd',
          options: { style: 'segments', segments: 2 },
          color: 'ansi256:208',
        },
        { id: 'hud-project-git-branch', type: 'git-branch', color: 'cyan' },
        { id: 'hud-project-git-status', type: 'git-status', options: { counts: false }, color: 'cyan' },
        { id: 'hud-project-git-worktree', type: 'git-worktree', color: '#a1b2c3' },
        { id: 'hud-duration-session-duration', type: 'session-duration', ...DIM },
        { id: 'hud-cost-session-cost', type: 'session-cost', ...DIM },
        { id: 'hud-cost-cost-today', type: 'cost-today', ...DIM },
        { id: 'hud-custom-text', type: 'text', options: { text: 'hello' }, color: 'ansi256:208' },
      ],
      [
        { id: 'hud-tools-tool-activity', type: 'tool-activity', options: { scope: 'session', maxTools: 4 } },
        { id: 'hud-agents-agents', type: 'agents' },
      ],
      [
        { id: 'hud-context-context-bar', type: 'context-bar' },
        { id: 'hud-usage-five-hour-usage', type: 'five-hour-usage', options: { display: 'bar' } },
        { id: 'hud-usage-five-hour-reset', type: 'five-hour-reset' },
        { id: 'hud-usage-weekly-usage', type: 'weekly-usage', options: { display: 'bar' } },
        { id: 'hud-usage-weekly-reset', type: 'weekly-reset' },
      ],
      [{ id: 'hud-memory-memory', type: 'memory' }],
    ]);
    expect(notes(fixture('claude-hud.json')).map((n) => n.text)).toEqual([
      'claude-hud segment "addedDirs" has no ccinfobar equivalent and was skipped',
    ]);
  });

  it('renders the fixture with sample data', () => {
    const out = show(toConfig(importClaudeHud(hud(fixture('claude-hud.json')))));
    expect(out).toHaveLength(4);
    expect(out[0]).toMatch(/hello$/);
    expect(out[0]).toContain(' │ ');
  });

  it('merges only adjacent group members and splits a group broken by another element', () => {
    const cfg = {
      elementOrder: ['context', 'memory', 'usage'],
      display: { showMemoryUsage: true, showTokenBreakdown: false },
    };
    expect(types(cfg)).toEqual([
      ['context-bar'],
      ['memory'],
      ['five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-reset', 'weekly-model-usage'],
    ]);
    expect(types({ ...cfg, display: { ...cfg.display, mergeGroups: [] } })).toHaveLength(3);
  });

  it('keeps a lone group member on its own row when its partner is empty', () => {
    expect(types({ display: { showUsage: false, showTokenBreakdown: false } })).toEqual([
      ['model', 'cwd', 'git-branch', 'git-status'],
      ['context-bar'],
    ]);
  });

  it('imports the compact layout: one session line plus activity lines', () => {
    const merged = mergeHud(fixture('claude-hud.json'), fixture('claude-hud.override.json'));
    const result = importClaudeHud(hud(merged));
    expect(result.config.separator).toBe(' | ');
    expect(result.config.lines!.map((l) => l.map((i) => i.type))).toEqual([
      [
        'model',
        'context-bar',
        'cwd',
        'git-branch',
        'git-status',
        'git-worktree',
        'five-hour-usage',
        'five-hour-reset',
        'weekly-usage',
        'weekly-reset',
        'session-duration',
        'session-cost',
        'cost-today',
        'text',
      ],
      ['agents'],
    ]);
    expect(find(result.config.lines!, 'tool-activity')).toBeUndefined();
  });

  it('adds a separator line before the activity lines', () => {
    const compact = types({ layout: 'separators', display: { showTodos: true, showUsage: false } });
    expect(compact).toEqual([
      ['model', 'context-bar', 'cwd', 'git-branch', 'git-status', 'tokens-input', 'tokens-cached'],
      ['text'],
      ['todo-list'],
    ]);
    expect(types({ layout: 'default', display: { showTodos: true, showUsage: false } })).toHaveLength(2);
    const ls = lines({ showSeparators: true, display: { showTools: true, showUsage: false } });
    expect(ls.map((l) => l[0]!.type)).toEqual(['model', 'context-bar', 'text', 'tool-activity']);
    expect(ls[2]![0]).toMatchObject({ options: { text: '─'.repeat(40) }, dim: true });
    expect(types({ showSeparators: true, display: { showUsage: false } })).toHaveLength(2);
  });

  it('orders the project line by projectLineOrder and keeps the custom line at its edge', () => {
    const cfg = {
      projectLineOrder: ['cost', 'duration', 'model'],
      gitStatus: { enabled: false },
      display: { showCost: true, showDuration: true, customLine: 'hi', customLinePosition: 'first' },
    };
    expect(types(cfg)[0]).toEqual(['text', 'session-cost', 'session-duration', 'model', 'cwd']);
    expect(types({ ...cfg, projectLineOrder: [] })[0]).toEqual([
      'text',
      'model',
      'cwd',
      'session-duration',
      'session-cost',
    ]);
    const compact = { ...cfg, lineLayout: 'compact', display: { ...cfg.display, showUsage: false } };
    expect(types(compact)[0]).toEqual([
      'text',
      'session-cost',
      'session-duration',
      'model',
      'context-bar',
      'cwd',
      'tokens-input',
      'tokens-cached',
    ]);
  });

  it('maps every project line segment', () => {
    const ls = lines(
      {
        pathLevels: 'full',
        gitStatus: { showAheadBehind: true, showFileStats: true },
        display: {
          showSessionName: true,
          showClaudeCodeVersion: true,
          showDuration: true,
          showCost: true,
          showDailyCost: true,
          showWeeklyCost: true,
          showSpeed: true,
          showAuth: true,
          showEffortLevel: true,
          modelOverride: 'My model',
        },
      },
      { extraCmd: 'echo hi', extraAllowed: true },
    );
    expect(ls[0]!.map((i) => i.type)).toEqual([
      'text',
      'effort',
      'cwd',
      'git-branch',
      'git-status',
      'git-ahead-behind',
      'git-changes',
      'session-name',
      'claude-version',
      'command',
      'session-duration',
      'session-cost',
      'cost-today',
      'cost-week',
      'output-speed',
      'provider',
    ]);
    expect(ls[0]![0]).toMatchObject({ options: { text: 'My model' }, color: 'cyan' });
    expect(find(ls, 'cwd')!.options).toEqual({ style: 'full' });
    expect(find(ls, 'command')).toEqual({
      id: 'hud-extra-command',
      type: 'command',
      options: { command: 'echo hi', timeout: 3000 },
      dim: true,
    });
  });

  it('maps the context value modes', () => {
    const ctx = (display: Record<string, unknown>) =>
      types({ elementOrder: ['context'], display: { showTokenBreakdown: false, ...display } })[0];
    expect(ctx({})).toEqual(['context-bar']);
    expect(ctx({ showContextBar: false })).toEqual(['context-percentage']);
    expect(ctx({ contextValue: 'remaining' })).toEqual(['context-bar', 'context-percentage']);
    expect(ctx({ contextValue: 'tokens', showContextBar: false })).toEqual(['context-length']);
    expect(ctx({ contextValue: 'both' })).toEqual(['context-bar', 'context-length']);
    const ls = lines({
      elementOrder: ['context'],
      display: { contextValue: 'remaining', showTokenBreakdown: false },
    });
    expect(ls[0]![0]!.options).toEqual({ showPercent: false });
    expect(ls[0]![1]!.options).toEqual({ mode: 'remaining' });
  });

  it('maps the other elements', () => {
    const ls = lines({
      elementOrder: [
        'promptCache',
        'cacheHitRate',
        'memory',
        'environment',
        'tools',
        'skills',
        'mcp',
        'agents',
        'todos',
        'sessionTime',
        'sessionTokens',
      ],
      display: {
        showPromptCache: true,
        showCacheHitRate: true,
        showMemoryUsage: true,
        showConfigCounts: true,
        showOutputStyle: true,
        showTools: true,
        toolsMaxVisible: 0,
        showSkills: true,
        skillsMaxVisible: 2,
        showMcp: true,
        showAgents: true,
        showTodos: true,
        showSessionStartDate: true,
        showSessionTokens: true,
        showCompactions: true,
        mergeGroups: [],
      },
    });
    expect(ls.map((l) => l.map((i) => i.type))).toEqual([
      ['cache-timer'],
      ['cache-hit-rate'],
      ['memory'],
      ['env-counts', 'output-style'],
      ['tool-activity'],
      ['skills'],
      ['env-counts'],
      ['agents'],
      ['todo-list'],
      ['session-duration'],
      ['tokens-total'],
      ['compactions'],
    ]);
    expect(ls[4]![0]!.options).toEqual({ scope: 'session' });
    expect(ls[5]![0]!.options).toEqual({ mode: 'list', limit: 2 });
    expect(ls[6]![0]!.options).toEqual({
      showClaudeMd: false,
      showAgentsMd: false,
      showRules: false,
      showHooks: false,
      mcpHealth: true,
    });
    expect(ls[8]![0]!.options).toEqual({ display: 'current' });
  });

  it('puts session tokens on a last line until placed', () => {
    const display = { showSessionTokens: true, showUsage: false, showTokenBreakdown: false };
    expect(types({ display }).at(-1)).toEqual(['tokens-total']);
    expect(types({ elementOrder: ['sessionTokens', 'project'], display })[0]).toEqual(['tokens-total']);
  });

  it('maps threshold settings to notes, never to showWhen or hideWhen', () => {
    const raw = {
      gitStatus: { showAheadBehind: true, pushWarningThreshold: 2, pushCriticalThreshold: 5 },
      display: {
        contextWarningThreshold: 60,
        contextCriticalThreshold: 90,
        usageThreshold: 20,
        sevenDayThreshold: 50,
        showConfigCounts: true,
        environmentThreshold: 3,
      },
    };
    const result = importClaudeHud(hud(raw));
    expect(JSON.stringify(result.config)).not.toMatch(/showWhen|hideWhen/);
    expect(find(result.config.lines!, 'context-bar')!.options).toBeUndefined();
    const texts = result.notes.map((n) => n.text);
    expect(texts).toContain(
      'claude-hud context thresholds 60%/90% became ccinfobar threshold colors (yellow from 50%, red from 80%)',
    );
    expect(texts).toContain(
      'claude-hud token breakdown is always shown (claude-hud shows it from 90% context)',
    );
    expect(texts).toContain(
      'claude-hud setting "usageThreshold" = 20 hides five-hour-usage below that value, ccinfobar always shows it',
    );
    expect(texts).toContain(
      'claude-hud setting "sevenDayThreshold" = 50 hides weekly-usage below that value, ccinfobar always shows it',
    );
    expect(texts).toContain(
      'claude-hud setting "environmentThreshold" = 3 hides env-counts below that value, ccinfobar always shows it',
    );
    expect(texts).toContain(
      'claude-hud setting "pushWarningThreshold" = 2 was dropped, the git-ahead-behind widget has no threshold colors',
    );
    expect(
      notes({ display: { contextWarningThreshold: 50, contextCriticalThreshold: 80 } }).map((n) => n.text),
    ).not.toContain(
      'claude-hud context thresholds 50%/80% became ccinfobar threshold colors (yellow from 50%, red from 80%)',
    );
  });

  it('drops language, external usage files and the advisor with a reason', () => {
    const result = importClaudeHud(
      hud({
        language: 'zh',
        display: {
          externalUsagePath: '~/usage.json',
          externalUsageWritePath: '/tmp/x.json',
          showAdvisor: true,
        },
      }),
    );
    expect(result.config).not.toHaveProperty('language');
    expect(toConfig(result).language).toBeUndefined();
    const drops = result.notes.filter((n) => n.kind === 'drop').map((n) => n.text);
    expect(drops).toEqual([
      'claude-hud language "zh" was not imported: ccinfobar keeps its own language setting',
      'claude-hud setting "externalUsagePath" was dropped: ccinfobar takes usage only from Claude Code and never reads or writes other files',
      'claude-hud setting "externalUsageWritePath" was dropped: ccinfobar takes usage only from Claude Code and never reads or writes other files',
      'claude-hud segment "addedDirs" has no ccinfobar equivalent and was skipped',
      'claude-hud segment "advisor" has no ccinfobar equivalent and was skipped',
    ]);
    expect(notes({ language: 'en' }).some((n) => n.text.includes('language'))).toBe(false);
  });

  it('copies maxWidth', () => {
    expect(importClaudeHud(hud({ maxWidth: 90 })).config.maxWidth).toBe(90);
    expect(importClaudeHud(hud({ maxWidth: -1 })).config).not.toHaveProperty('maxWidth');
  });

  it('sanitizes the custom line', () => {
    const ls = lines({ display: { customLine: 'a\u001b[31mb‮c' } });
    expect(find(ls, 'text')!.options).toEqual({ text: 'abc' });
  });

  it('only emits listed targets, and every target exists', () => {
    const types = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const target of TARGETS) expect(types.has(target), target).toBe(true);
    const all: HudConfig = hud({
      elementOrder: [...HUD_DEFAULTS.elementOrder, 'sessionTokens'],
      gitStatus: { showAheadBehind: true, showFileStats: true, showWorktree: true },
      display: Object.fromEntries(
        Object.entries(HUD_DEFAULTS.display).map(([k, v]) => [k, typeof v === 'boolean' ? true : v]),
      ),
    });
    for (const layout of ['expanded', 'compact']) {
      for (const contextValue of ['percent', 'tokens', 'remaining', 'both']) {
        const cfg = { ...all, lineLayout: layout, display: { ...all.display, contextValue } };
        for (const it of importClaudeHud(cfg, { extraCmd: 'x' }).config.lines!.flat()) {
          expect(TARGETS, it.type).toContain(it.type);
        }
      }
    }
  });

  it('writes notes in Turkish', () => {
    withLang('tr', () => {
      const texts = notes({ language: 'zh' }, { extraCmd: 'x', defaulted: true }).map((n) => n.text);
      expect(texts.slice(0, 3)).toEqual([
        'claude-hud yapılandırma dosyası bulunamadı, varsayılan düzeni içe aktarıldı',
        'claude-hud, --extra-cmd komutunu yalnızca CLAUDE_HUD_ALLOW_EXTRA_CMD ayarlıysa çalıştırır; bu değişken ortamınızda veya settings.json içinde ayarlı değil',
        'claude-hud dili "zh" içe aktarılmadı: ccinfobar kendi dil ayarını korur',
      ]);
      expect(texts).toContain(
        "claude-hud bağlam eşikleri %70/%85, ccinfobar eşik renklerine dönüştürüldü (%50'den itibaren sarı, %80'den itibaren kırmızı)",
      );
    });
  });
});

describe('claude-hud --extra-cmd', () => {
  it('parses both forms and lets the first occurrence win', () => {
    expect(parseExtraCmd('node claude-hud --extra-cmd "echo hi"')).toBe('echo hi');
    expect(parseExtraCmd('node claude-hud --extra-cmd=uptime')).toBe('uptime');
    expect(parseExtraCmd('node x --extra-cmd="echo a=b"')).toBe('echo a=b');
    expect(parseExtraCmd('x --extra-cmd=first --extra-cmd second')).toBe('first');
    expect(parseExtraCmd('x --extra-cmd one --extra-cmd=two')).toBe('one');
    expect(parseExtraCmd('x --extra-cmd')).toBeNull();
    expect(parseExtraCmd('x --extra-cmd=')).toBeNull();
    expect(parseExtraCmd('x --extra-cmd ""')).toBeNull();
    expect(parseExtraCmd('node claude-hud')).toBeNull();
    expect(parseExtraCmd('x --extra-cmdx y')).toBeNull();
  });

  it('finds the flag inside a quoted bash -c script', () => {
    const cmd = `bash -c 'plugin_dir=$(ls -d "$HOME"/x | tail -1); exec node "\${plugin_dir}dist/index.js" --extra-cmd "git log -1"'`;
    expect(parseExtraCmd(cmd)).toBe('git log -1');
  });

  it('notes the env gate unless it is set', () => {
    const gate = t('import.note.hudExtraCmd', { tool: 'claude-hud' });
    expect(notes({}, { extraCmd: 'x' }).map((n) => n.text)).toContain(gate);
    expect(notes({}, { extraCmd: 'x', extraAllowed: true }).map((n) => n.text)).not.toContain(gate);
    expect(notes({}).map((n) => n.text)).not.toContain(gate);
  });
});

describe('claude-hud files', () => {
  const setup = () => {
    const d = tmp();
    const claude = path.join(d, 'claude');
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claude };
    return { d, claude, env, ...hudPaths(env) };
  };

  it('resolves the paths like claude-hud', () => {
    const d = tmp();
    const claude = path.join(d, 'claude');
    expect(hudPaths({ CLAUDE_CONFIG_DIR: `  ${claude}  ` })).toEqual({
      dir: claude,
      config: path.join(claude, 'plugins', 'claude-hud', 'config.json'),
      override: path.join(claude, 'claude-hud.json'),
    });
    const home = path.join(d, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    expect(hudPaths({ CLAUDE_CONFIG_DIR: '~/x' }).dir).toBe(path.join(home, 'x'));
    expect(hudPaths({ CLAUDE_CONFIG_DIR: '~' }).dir).toBe(home);
    expect(hudPaths({ CLAUDE_CONFIG_DIR: '   ' }).dir).toBe(path.join(home, '.claude'));
    expect(hudPaths({}).dir).toBe(path.join(home, '.claude'));
    expect(hudPaths({ CLAUDE_CONFIG_DIR: 'rel' }).dir).toBe(path.resolve('rel'));
  });

  it('imports the config file alone', () => {
    const s = setup();
    write(s.config, fixture('claude-hud.json'));
    const result = importFrom('claude-hud', { env: s.env });
    expect(result.file).toBe(s.config);
    expect(result.config.lines).toHaveLength(4);
    expect(result.notes.some((n) => n.text.includes('default layout'))).toBe(false);
  });

  it('imports the override alone', () => {
    const s = setup();
    write(s.override, { display: { showCost: true } });
    const result = importFrom('claude-hud', { env: s.env });
    expect(result.file).toBe(s.override);
    expect(find(result.config.lines!, 'session-cost')).toBeDefined();
    expect(result.notes.some((n) => n.kind === 'info')).toBe(false);
  });

  it('merges the override over the config', () => {
    const s = setup();
    write(s.config, fixture('claude-hud.json'));
    write(s.override, fixture('claude-hud.override.json'));
    const result = importFrom('claude-hud', { env: s.env });
    expect(result.config.separator).toBe(' | ');
    expect(result.config.lines!.map((l) => l[0]!.type)).toEqual(['model', 'agents']);
  });

  it('imports the default layout with a note when neither file exists', () => {
    const s = setup();
    const result = importFrom('claude-hud', { env: s.env });
    expect(result.file).toBeNull();
    expect(result.notes[0]).toEqual({
      kind: 'info',
      text: 'no claude-hud config file found, imported its default layout',
    });
    expect(result.config.lines).toEqual(importClaudeHud(HUD_DEFAULTS).config.lines);
  });

  it('lets --file replace the config and still applies the override', () => {
    const s = setup();
    write(s.config, { display: { showCost: true } });
    const file = write(path.join(s.d, 'mine.json'), { display: { showDuration: true } });
    write(s.override, { display: { showSpeed: true } });
    const result = importFrom('claude-hud', { env: s.env, file });
    expect(result.file).toBe(file);
    const got = result.config.lines![0]!.map((i) => i.type);
    expect(got).toContain('session-duration');
    expect(got).toContain('output-speed');
    expect(got).not.toContain('session-cost');
    expect(() => importFrom('claude-hud', { env: s.env, file: path.join(s.d, 'missing.json') })).toThrow(
      `Cannot read claude-hud config at ${tildify(path.join(s.d, 'missing.json'))}`,
    );
  });

  it('ignores an override that is not an object, with a note', () => {
    const s = setup();
    write(s.config, { display: { showCost: true } });
    write(s.override, '[1, 2]');
    const result = importFrom('claude-hud', { env: s.env });
    expect(result.notes[0]).toEqual({
      kind: 'info',
      text: `${tildify(s.override)} is not a JSON object and was ignored`,
    });
    expect(find(result.config.lines!, 'session-cost')).toBeDefined();
  });

  it('refuses a file over 1 MB and reports invalid JSON', () => {
    const s = setup();
    write(s.config, `{"a":"${'x'.repeat(MAX_SOURCE_BYTES)}"}`);
    expect(() => importFrom('claude-hud', { env: s.env })).toThrow(SourceTooLargeError);
    write(s.config, '{ "lineLayout": ');
    expect(() => importFrom('claude-hud', { env: s.env })).toThrow(
      `Cannot parse claude-hud config at ${tildify(s.config)}`,
    );
  });

  it('turns --extra-cmd into a command item at the extra slot', () => {
    const s = setup();
    write(s.config, {
      gitStatus: { enabled: false },
      display: { showDuration: true, showClaudeCodeVersion: true },
    });
    const result = importFrom('claude-hud', { env: s.env, command: 'node claude-hud --extra-cmd "echo hi"' });
    expect(result.config.lines![0]!.map((i) => i.type)).toEqual([
      'model',
      'cwd',
      'claude-version',
      'command',
      'session-duration',
    ]);
    expect(find(result.config.lines!, 'command')!.options).toEqual({ command: 'echo hi', timeout: 3000 });
    expect(result.notes.map((n) => n.text)).toContain(t('import.note.hudExtraCmd', { tool: 'claude-hud' }));
  });

  it('reads the env gate from the environment or the settings.json env block', () => {
    const s = setup();
    const gate = t('import.note.hudExtraCmd', { tool: 'claude-hud' });
    const run = (env: NodeJS.ProcessEnv) =>
      importFrom('claude-hud', { env, command: 'claude-hud --extra-cmd=uptime' }).notes.map((n) => n.text);
    expect(run(s.env)).toContain(gate);
    expect(run({ ...s.env, CLAUDE_HUD_ALLOW_EXTRA_CMD: ' On ' })).not.toContain(gate);
    expect(run({ ...s.env, CLAUDE_HUD_ALLOW_EXTRA_CMD: '0' })).toContain(gate);
    write(path.join(s.claude, 'settings.json'), { env: { CLAUDE_HUD_ALLOW_EXTRA_CMD: '1' } });
    expect(run(s.env)).not.toContain(gate);
    write(path.join(s.claude, 'settings.json'), '{ broken');
    expect(run(s.env)).toContain(gate);
  });

  it('detects claude-hud as importable', () => {
    expect(
      detectTool('bash -c \'exec node "$HOME/.claude/plugins/cache/claude-hud/dist/index.js"\''),
    ).toMatchObject({
      tool: 'claude-hud',
      name: 'claude-hud',
      importable: true,
    });
  });
});

describe('import claude-hud', () => {
  const fake = () => {
    const out: string[] = [];
    const errors: string[] = [];
    const io: PromptIo = {
      tty: false,
      columns: 200,
      ask: async (_q, fallback) => fallback,
      log: (l) => out.push(l),
      error: (l) => errors.push(l),
    };
    return { io, out, errors };
  };

  const keepExit = () => {
    const prev = process.exitCode;
    onTestFinished(() => {
      process.exitCode = prev;
    });
  };

  const claudeDir = () => {
    const d = tmp();
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(d, 'claude'));
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    return { d, ...hudPaths(process.env) };
  };

  it('drops the extra command without a TTY and prints the re-run hint', async () => {
    const s = claudeDir();
    write(s.config, fixture('claude-hud.json'));
    const f = fake();
    const cfg = path.join(s.d, 'c.json');
    const ok = await runImport('claude-hud', { command: 'node claude-hud --extra-cmd "echo hi"' }, cfg, f.io);
    expect(ok).toBe(true);
    expect(f.out).toContain('  command: echo hi');
    expect(f.out.some((l) => l.startsWith(t('import.rerun', { command: '' }).trim()))).toBe(true);
    expect(f.out.join('\n')).toContain('ccinfobar import claude-hud --allow-commands');
    const saved = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    expect(JSON.stringify(saved)).not.toContain('echo hi');
    expect(saved.lines[0].map((i: WidgetItem) => i.type)).not.toContain('command');
  });

  it('keeps the extra command with --allow-commands', async () => {
    const s = claudeDir();
    const f = fake();
    const cfg = path.join(s.d, 'c.json');
    await runImport(
      'claude-hud',
      {
        command: 'node claude-hud --extra-cmd=uptime',
        flags: { allowCommands: true, yes: false, dryRun: false },
      },
      cfg,
      f.io,
    );
    const saved = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    expect(saved.lines[0].map((i: WidgetItem) => i.type)).toContain('command');
  });

  it('prints a parse failure through runImportCommand, also in Turkish', async () => {
    const s = claudeDir();
    write(s.config, '{ nope');
    keepExit();
    const f = fake();
    await runImportCommand(parseArgs(['import', 'claude-hud', '--dry-run']), path.join(s.d, 'c.json'), f.io);
    expect(process.exitCode).toBe(1);
    expect(f.errors).toEqual([`✗ Import failed: Cannot parse claude-hud config at ${tildify(s.config)}`]);
    const g = fake();
    await withLangAsync('tr', () =>
      runImportCommand(parseArgs(['import', 'claude-hud', '--dry-run']), path.join(s.d, 'c.json'), g.io),
    );
    expect(g.errors).toEqual([
      `✗ İçe aktarma başarısız oldu: ${tildify(s.config)} konumundaki claude-hud yapılandırması ayrıştırılamıyor`,
    ]);
  });

  it('runs a dry run of the default layout', async () => {
    const s = claudeDir();
    keepExit();
    const f = fake();
    const cfg = path.join(s.d, 'c.json');
    await runImportCommand(parseArgs(['import', 'claude-hud', '--dry-run']), cfg, f.io);
    expect(process.exitCode ?? 0).toBe(0);
    expect(f.errors).toEqual([]);
    expect(f.out[0]).toBe('✓ Imported 12 widgets from claude-hud');
    expect(f.out.at(-1)).toBe('Dry run: nothing was written.');
    expect(fs.existsSync(cfg)).toBe(false);
  });
});
