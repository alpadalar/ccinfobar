import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PromptIo } from '../../src/commands/io.js';
import { runImport } from '../../src/commands/manage.js';
import { importClaudeCodeStatusline, TARGETS } from '../../src/importers/claude-code-statusline.js';
import { parseToml } from '../../src/importers/toml.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const FIXTURE = path.join(FIXTURES, 'claude-code-statusline.toml');
const fixture = () => parseToml(fs.readFileSync(FIXTURE, 'utf8'));
type R = ReturnType<typeof importClaudeCodeStatusline>;
const lineTypes = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const types = (r: R) => r.config.lines!.flat().map((i) => i.type);
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);
const TOOL = 'claude-code-statusline';
const toml = (lines: string[]) => parseToml(`${lines.join('\n')}\n`);

describe('importClaudeCodeStatusline', () => {
  it('maps the fixture lines, theme and separator', () => {
    const r = importClaudeCodeStatusline(fixture());
    expect(r.source).toBe('claude-code-statusline');
    expect(lineTypes(r)).toEqual([
      ['cwd', 'git-branch', 'git-status', 'model', 'claude-version'],
      ['session-cost', 'cost-today', 'cost-rate', 'cache-hit-rate'],
      ['five-hour-usage', 'weekly-usage', 'five-hour-reset', 'weekly-reset'],
    ]);
    expect(r.config).toMatchObject({ theme: 'everforest', style: 'text', separator: ' │ ' });
    expect(item(r, 'git-branch')!.id).toBe('ccs-repo_info-git-branch');
  });

  it('explains what was dropped or approximated', () => {
    expect(importClaudeCodeStatusline(fixture()).notes).toEqual([
      { kind: 'drop', text: `${TOOL} segment "prayer_times" has no ccinfobar equivalent and was skipped` },
      {
        kind: 'approx',
        text: `${TOOL} lines use different separators; every line now uses the most common one, " │ "`,
      },
      { kind: 'approx', text: `${TOOL} theme "garden" is approximated by the everforest theme` },
      {
        kind: 'info',
        text: `${TOOL} settings not imported: colors (2), prayer (3), labels (2), cache (1), plugins (2)`,
      },
    ]);
  });

  it('never copies plugin keys', async () => {
    const r = importClaudeCodeStatusline(fixture());
    expect(JSON.stringify(r)).not.toContain('REDACTED-TEST');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ccs-run-'));
    try {
      const lines: string[] = [];
      const io: PromptIo = {
        tty: false,
        ask: async (_q, fallback) => fallback,
        log: (l) => lines.push(l),
        error: (l) => lines.push(l),
        columns: 100,
      };
      const cfgFile = path.join(dir, 'config.json');
      for (const dryRun of [true, false]) {
        const flags = { allowCommands: false, yes: true, dryRun };
        expect(
          await runImport('claude-code-statusline', { file: FIXTURE, command: '', flags }, cfgFile, io),
        ).toBe(true);
      }
      const out = `${lines.join('\n')}\n${fs.readFileSync(cfgFile, 'utf8')}`;
      expect(out).not.toContain('REDACTED-TEST');
      expect(out).not.toContain('local_gps');
      expect(out).toContain('plugins (2)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads only display.lines lines and defaults to five', () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `display.line${i + 1}.components = ["model_info"]`);
    expect(importClaudeCodeStatusline(toml(['display.lines = 2', ...lines(3)])).config.lines).toHaveLength(2);
    expect(importClaudeCodeStatusline(toml(lines(7))).config.lines).toHaveLength(5);
    expect(importClaudeCodeStatusline(toml(['display.lines = 12', ...lines(10)])).config.lines).toHaveLength(
      9,
    );
    expect(importClaudeCodeStatusline(toml(['display.lines = 0', ...lines(1)])).config.lines).toHaveLength(1);
  });

  it('omits lines whose components all drop and approximates the close ones', () => {
    const r = importClaudeCodeStatusline(
      toml([
        'display.lines = 3',
        'display.line1.components = ["prayer_times", "hijri_calendar"]',
        'display.line2.components = ["cost_monthly", "mcp_status", "mcp_servers", "session_info"]',
        'display.line3.components = ["prayer_times"]',
      ]),
    );
    expect(lineTypes(r)).toEqual([['cost-project', 'env-counts', 'session-id', 'session-name']]);
    expect(item(r, 'cost-project')!.options).toEqual({ period: 'month' });
    expect(item(r, 'session-id')!.options).toEqual({ short: true });
    expect(item(r, 'env-counts')!.options).toEqual({
      showClaudeMd: false,
      showAgentsMd: false,
      showRules: false,
      showHooks: false,
    });
    expect(texts(r)).toEqual([
      `${TOOL} segment "prayer_times" has no ccinfobar equivalent and was skipped`,
      `${TOOL} segment "hijri_calendar" has no ccinfobar equivalent and was skipped`,
      `${TOOL} "cost_monthly" is approximated by the cost-project widget`,
      `${TOOL} "mcp_status" is approximated by the env-counts widget`,
    ]);
    expect(r.config.separator).toBe(' │ ');
    expect(r.config.theme).toBe('catppuccin');
  });

  it('maps the remaining components', () => {
    const r = importClaudeCodeStatusline(
      toml([
        'display.lines = 2',
        'display.line1.components = ["bedrock_model", "version_display", "time_display", "cost_repo", "cost_weekly", "block_projection"]',
        'display.line2.components = "code_productivity, context_window, reset_timer, session_mode, total_tokens, vim_mode, agent_display, github, commits, context_alert"',
        'display.line2.separator = ""',
      ]),
    );
    expect(lineTypes(r)).toEqual([
      ['provider', 'claude-version', 'clock', 'cost-project', 'cost-week', 'usage-projection'],
      [
        'lines-changed',
        'context-percentage',
        'five-hour-reset',
        'output-style',
        'tokens-input',
        'tokens-output',
        'vim-mode',
        'agent-name',
        'pr',
      ],
    ]);
    expect(item(r, 'cost-project')!.options).toBeUndefined();
    expect(r.notes.filter((n) => n.kind === 'drop').map((n) => n.text)).toEqual([
      `${TOOL} segment "commits" has no ccinfobar equivalent and was skipped`,
      `${TOOL} segment "context_alert" has no ccinfobar equivalent and was skipped`,
    ]);
    expect(r.notes.filter((n) => n.kind === 'approx')).toHaveLength(4);
  });

  it('maps the themes', () => {
    const theme = (name: string) => importClaudeCodeStatusline(toml([`theme.name = "${name}"`]));
    expect(theme('classic').config.theme).toBe('classic');
    expect(theme('Catppuccin').config.theme).toBe('catppuccin');
    expect(theme('classic').notes).toEqual([]);
    expect(texts(theme('custom'))).toEqual([`${TOOL} theme "custom" is approximated by the classic theme`]);
    expect(theme('ocean').config.theme).toBe('nord');
    expect(texts(theme('neon'))).toEqual([
      `${TOOL} theme "neon" has no ccinfobar equivalent, used the catppuccin theme`,
    ]);
  });

  it('keeps the same component twice under unique ids', () => {
    const r = importClaudeCodeStatusline(
      toml([
        'display.lines = 2',
        'display.line1.components = ["model_info"]',
        'display.line2.components = ["model_info"]',
      ]),
    );
    expect(r.config.lines!.flat().map((i) => i.id)).toEqual([
      'ccs-model_info-model',
      'ccs-model_info-model-2',
    ]);
  });

  it('drops prototype names without prototype access', () => {
    const r = importClaudeCodeStatusline({
      display: { lines: 1, line1: { components: ['__proto__', 'constructor', 'toString', 7, 'model_info'] } },
    });
    expect(types(r)).toEqual(['model']);
    expect(r.notes.filter((n) => n.kind === 'drop')).toHaveLength(4);
    expect(({} as Record<string, unknown>).components).toBeUndefined();
    const proto = importClaudeCodeStatusline(JSON.parse('{"display": {"lines": 1, "constructor": {}}}'));
    expect(proto.config.lines).toEqual([]);
  });

  it('writes Turkish notes', () => {
    const r = withLang('tr', () =>
      importClaudeCodeStatusline(
        toml([
          'display.lines = 2',
          'display.line1.components = ["model_info", "wellness"]',
          'display.line1.separator = " | "',
          'display.line2.components = ["model_info"]',
          'display.line2.separator = " | "',
        ]),
      ),
    );
    expect(texts(r)).toEqual([`${TOOL} bölümü "wellness" için ccinfobar karşılığı yok, atlandı`]);
    const merged = withLang('tr', () => importClaudeCodeStatusline(fixture()));
    expect(texts(merged)[1]).toBe(
      `${TOOL} satırları farklı ayraçlar kullanıyor; artık her satır en sık kullanılan ayracı (" │ ") kullanıyor`,
    );
  });

  it('targets only existing widgets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });
});
