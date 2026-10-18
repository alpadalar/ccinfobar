import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { importNycuCcStatusline, TARGETS } from '../../src/importers/nycu-cc-statusline.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const FILE = path.join(FIXTURES, 'nycu-cc-statusline.json');
const fixture = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

type R = ReturnType<typeof importNycuCcStatusline>;
const types = (r: R) => r.config.lines!.map((l) => l.map((i) => i.type));
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);

const ROWS = [
  ['session-name'],
  ['cwd', 'lines-changed'],
  ['git-repo', 'git-branch', 'git-status'],
  ['model', 'effort', 'session-duration'],
  ['cost-week', 'session-cost'],
  ['tokens-total', 'context-bar', 'compactions'],
  ['five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-reset'],
  ['agents'],
];

describe('importNycuCcStatusline', () => {
  it('maps the rows.md example to a square tui panel, one line per row', () => {
    const r = importNycuCcStatusline(fixture());
    expect(r.source).toBe('nycu-cc-statusline');
    expect(types(r)).toEqual(ROWS);
    expect(r.config).toMatchObject({
      style: 'tui',
      tui: { box: 'square', title: { left: '', right: false } },
      maxWidth: 116,
      widthOffset: 4,
    });
    expect(item(r, 'cwd')!.options).toEqual({ style: 'segments', segments: 2 });
    expect(item(r, 'compactions')!.options).toEqual({ showZero: true });
    expect(item(r, 'five-hour-usage')!.options).toEqual({ display: 'bar' });
    expect(item(r, 'agents')!.hideEmpty).toBe(true);
    expect(item(r, 'model')!.id).toBe('nycu-cc-statusline-model');
    expect(r.notes).toEqual([
      {
        kind: 'approx',
        text: 'cc-statusline (NYCU-Chung) "summary" is approximated by the session-name widget',
      },
      {
        kind: 'approx',
        text: 'cc-statusline (NYCU-Chung) "duration" is approximated by the session-duration widget',
      },
      { kind: 'approx', text: 'cc-statusline (NYCU-Chung) "cost" is approximated by the cost-week widget' },
    ]);
  });

  it('imports every row for a missing file and names the rows it cannot show', () => {
    const r = importNycuCcStatusline({}, { defaulted: true });
    expect(types(r)).toEqual([...ROWS, ['env-counts']]);
    expect(item(r, 'env-counts')).toMatchObject({
      options: { showAgentsMd: false, showHooks: false, mcpHealth: true },
      hideEmpty: true,
    });
    expect(r.config.maxWidth).toBeUndefined();
    expect(r.config.widthOffset).toBeUndefined();
    expect(texts(r)).toEqual([
      'no cc-statusline (NYCU-Chung) config file found, imported its default layout',
      'cc-statusline (NYCU-Chung) "summary" is approximated by the session-name widget',
      'cc-statusline (NYCU-Chung) "duration" is approximated by the session-duration widget',
      'cc-statusline (NYCU-Chung) "cost" is approximated by the cost-week widget',
      'cc-statusline (NYCU-Chung) "memory_mcp" is approximated by the env-counts widget',
      'cc-statusline (NYCU-Chung) settings not imported: edited, history',
    ]);
  });

  it('still imports the rows when the master switch is off', () => {
    const r = importNycuCcStatusline({ ...fixture(), enabled: false });
    expect(types(r)).toEqual(ROWS);
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: 'cc-statusline (NYCU-Chung) is turned off ("enabled": false), its rows were imported anyway',
    });
  });

  it('follows the row toggles with upstream truthiness and keeps duration on the model row', () => {
    const r = importNycuCcStatusline({
      summary: 0,
      dir: 'false',
      repo: false,
      model: false,
      cost: null,
      usage: false,
      quota: false,
      agents: false,
      memory_mcp: false,
      edited: false,
      history: false,
    });
    expect(types(r)).toEqual([['cwd', 'lines-changed'], ['session-duration']]);
    const m = importNycuCcStatusline({ duration: false, summary: false, edited: false, history: false });
    expect(types(m)[2]).toEqual(['model', 'effort']);
    expect(texts(m)).not.toContain(
      'cc-statusline (NYCU-Chung) "duration" is approximated by the session-duration widget',
    );
  });

  it('maps the cost window and the width keys', () => {
    expect(types(importNycuCcStatusline({ aggWindowDays: 1 }))).toContainEqual([
      'cost-today',
      'session-cost',
    ]);
    expect(types(importNycuCcStatusline({ aggWindowDays: 30 }))).toContainEqual([
      'cost-week',
      'session-cost',
    ]);
    const w = (raw: Record<string, unknown>) => {
      const { maxWidth, widthOffset } = importNycuCcStatusline(raw).config;
      return { maxWidth, widthOffset };
    };
    expect(w({ statuslineWidth: 200 })).toEqual({ maxWidth: 196, widthOffset: undefined });
    expect(w({ statuslineWidth: 150.7, statuslineWidthOffset: 0 })).toEqual({
      maxWidth: 150,
      widthOffset: 0,
    });
    expect(w({ statuslineWidth: 10, statuslineWidthOffset: 6 })).toEqual({ maxWidth: 20, widthOffset: 6 });
    expect(w({ statuslineWidth: 0, statuslineWidthOffset: -2 })).toEqual({
      maxWidth: undefined,
      widthOffset: undefined,
    });
    expect(w({ statuslineWidth: '120', statuslineWidthOffset: '4' })).toEqual({
      maxWidth: undefined,
      widthOffset: undefined,
    });
  });

  it('names unknown keys and a changed summaryInterval, never their values', () => {
    const r = importNycuCcStatusline({
      edited: false,
      history: false,
      summaryInterval: 25,
      theme: 'neon-value',
      extraRow: true,
    });
    expect(r.notes.at(-1)).toEqual({
      kind: 'drop',
      text: 'cc-statusline (NYCU-Chung) settings not imported: summaryInterval, theme, extraRow',
    });
    expect(texts(r).join('\n')).not.toContain('neon-value');
    expect(
      texts(importNycuCcStatusline({ edited: false, history: false, summaryInterval: 10 })),
    ).not.toContain('cc-statusline (NYCU-Chung) settings not imported: summaryInterval');
  });

  it('imports every row with one note for a file that is not a JSON object', () => {
    for (const raw of [[1, 2], 'rows', 42, null]) {
      const r = importNycuCcStatusline(raw, { file: '~/.claude/cc-statusline-rows.json' });
      expect(types(r)).toEqual([...ROWS, ['env-counts']]);
      expect(r.notes[0]).toEqual({
        kind: 'info',
        text: '~/.claude/cc-statusline-rows.json is not a JSON object and was ignored',
      });
    }
  });

  it('ignores prototype keys', () => {
    const raw = JSON.parse(
      '{"__proto__": {"summary": false}, "constructor": 1, "edited": false, "history": false}',
    );
    const r = importNycuCcStatusline(raw);
    expect(types(r)[0]).toEqual(['session-name']);
    expect(({} as Record<string, unknown>).summary).toBeUndefined();
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = importNycuCcStatusline({ enabled: false, summary: false, duration: false, cost: false });
      expect(texts(r)).toEqual([
        'cc-statusline (NYCU-Chung) kapalı ("enabled": false), satırları yine de içe aktarıldı',
        'cc-statusline (NYCU-Chung) "memory_mcp", env-counts bileşeniyle yaklaşık olarak gösteriliyor',
        'cc-statusline (NYCU-Chung) ayarları içe aktarılmadı: edited, history',
      ]);
    });
  });
});

describe('nycu-cc-statusline importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-nycu-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const homeFile = () => path.join(env.HOME!, '.claude', 'cc-statusline-rows.json');

  it('reads --file', () => {
    const r = importFrom('nycu-cc-statusline', { file: FILE, env, cwd: dir });
    expect(r.file).toBe(FILE);
    expect(r.config.maxWidth).toBe(116);
  });

  it('finds ~/.claude/cc-statusline-rows.json even with CLAUDE_CONFIG_DIR, else imports every row', () => {
    const none = importFrom('nycu-cc-statusline', { env, cwd: dir });
    expect(none.file).toBeNull();
    expect(texts(none)[0]).toBe(
      'no cc-statusline (NYCU-Chung) config file found, imported its default layout',
    );

    const cc = path.join(dir, 'cc');
    fs.mkdirSync(cc);
    fs.writeFileSync(path.join(cc, 'cc-statusline-rows.json'), '{"quota": false}');
    fs.writeFileSync(homeFile(), '{"statuslineWidth": 90}');
    const r = importFrom('nycu-cc-statusline', { env: { ...env, CLAUDE_CONFIG_DIR: cc }, cwd: dir });
    expect(r.file).toBe(homeFile());
    expect(r.config.maxWidth).toBe(86);
  });

  it('notes a file that is not an object with the tilde path, and reports bad JSON', () => {
    fs.writeFileSync(homeFile(), '[true]');
    expect(importFrom('nycu-cc-statusline', { env, cwd: dir }).notes[0]!.text).toBe(
      `${path.join('~', '.claude', 'cc-statusline-rows.json')} is not a JSON object and was ignored`,
    );
    fs.writeFileSync(homeFile(), '{"dir": ');
    expect(() => importFrom('nycu-cc-statusline', { env, cwd: dir })).toThrow(
      /Cannot parse cc-statusline \(NYCU-Chung\) config/,
    );
  });

  it('is detected from its plugin path, but not from the bare plugin command', () => {
    for (const cmd of [
      'node /home/u/.claude/plugins/cache/cc-statusline/1.0/statusline.js',
      'node "C:\\Users\\u\\.claude\\plugins\\cache\\nycu\\cc-statusline\\1.0.0\\statusline.js"',
      'node ~/cc-statusline/statusline.js',
    ]) {
      expect(detectTool(cmd), cmd).toMatchObject({
        tool: 'nycu-cc-statusline',
        name: 'cc-statusline (NYCU-Chung)',
        importable: true,
      });
    }
    for (const cmd of [
      'node ${CLAUDE_PLUGIN_ROOT}/statusline.js',
      'bash ~/.claude/statusline.sh',
      'node ~/cc-statusline/other.js',
    ]) {
      expect(detectTool(cmd)?.tool, cmd).not.toBe('nycu-cc-statusline');
    }
    expect(detectTool('node ${CLAUDE_PLUGIN_ROOT}/statusline.js')?.tool).toBe('unknown');
  });
});
