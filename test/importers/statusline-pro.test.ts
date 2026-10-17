import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PromptIo } from '../../src/commands/io.js';
import { runImport } from '../../src/commands/manage.js';
import { detectTool, importFrom, resolveSource } from '../../src/importers/index.js';
import { importStatuslinePro, TARGETS } from '../../src/importers/statusline-pro.js';
import { parseToml } from '../../src/importers/toml.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const FIXTURE = path.join(FIXTURES, 'statusline-pro.toml');
const fixture = () => parseToml(fs.readFileSync(FIXTURE, 'utf8'));
type R = ReturnType<typeof importStatuslinePro>;
const types = (r: R) => r.config.lines!.flat().map((i) => i.type);
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);
const TOOL = 'claude-code-statusline-pro';

describe('importStatuslinePro', () => {
  it('maps the fixture preset, components, icons and colours', () => {
    const r = importStatuslinePro(fixture());
    expect(r.source).toBe('statusline-pro');
    expect(r.config.lines).toHaveLength(1);
    expect(types(r)).toEqual([
      'project-dir',
      'model',
      'git-branch',
      'git-status',
      'context-bar',
      'context-length',
      'session-cost',
      'lines-changed',
    ]);
    expect(r.config).toMatchObject({ style: 'powerline', icons: 'nerd', maxWidth: 120 });
    expect(r.config.separator).toBeUndefined();
    expect(r.config.colorLevel).toBeUndefined();
    expect(r.config.theme).toBeUndefined();
    expect(item(r, 'model')).toMatchObject({ color: 'brightBlue', label: '\uee0d' });
    expect(item(r, 'project-dir')).toMatchObject({ color: 'white', label: '\uf07c' });
    expect(item(r, 'git-status')!.label).toBe('');
    expect(item(r, 'context-bar')!.options).toEqual({ width: 15 });
    expect(item(r, 'context-length')).toMatchObject({ label: '', options: { showMax: true } });
    expect(item(r, 'session-cost')!.options).toEqual({ decimals: 2 });
    expect(item(r, 'lines-changed')!.label).toBe('');
    expect(item(r, 'git-branch')!.id).toBe('ccsp-branch-git-branch');
  });

  it('explains what was dropped or approximated', () => {
    expect(importStatuslinePro(fixture()).notes).toEqual([
      { kind: 'approx', text: `${TOOL} segment "model": icon color dropped, the widget has one color` },
      { kind: 'approx', text: `${TOOL} settings not imported: model.mapping, tokens.thresholds` },
      {
        kind: 'drop',
        text: `${TOOL} [multiline] rows and 1 [widgets] table were dropped: ccinfobar does not import them and never copies their URLs or headers`,
      },
      {
        kind: 'info',
        text: `${TOOL} language "zh" was not imported: ccinfobar keeps its own language setting`,
      },
    ]);
  });

  it('never copies widget URLs or headers', async () => {
    const r = importStatuslinePro(fixture());
    const all = JSON.stringify(r);
    for (const secret of ['REDACTED-TEST', 'api.example.com', 'X-API-Key', '/v1/balance']) {
      expect(all).not.toContain(secret);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ccsp-run-'));
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
        expect(await runImport('statusline-pro', { file: FIXTURE, command: '', flags }, cfgFile, io)).toBe(
          true,
        );
      }
      const out = `${lines.join('\n')}\n${fs.readFileSync(cfgFile, 'utf8')}`;
      for (const secret of ['REDACTED-TEST', 'api.example.com', 'X-API-Key']) {
        expect(out).not.toContain(secret);
      }
      expect(out).toContain('1 [widgets] table');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a preset override the file and maps the rate-limit windows', () => {
    const r = importStatuslinePro(fixture(), { preset: 'MR' });
    expect(types(r)).toEqual(['model', 'five-hour-usage', 'five-hour-reset', 'weekly-usage', 'weekly-reset']);
    expect(item(r, 'five-hour-usage')!.label).toBe('\uf017 5h');
    expect(item(r, 'weekly-usage')!.label).toBe('7d');
    expect(item(r, 'five-hour-reset')!.label).toBeUndefined();
    const some = importStatuslinePro(
      {
        components: { rate_limit: { show_five_hour: false, show_reset: false } },
        style: { enable_nerd_font: false },
      },
      { preset: 'r' },
    );
    expect(types(some)).toEqual(['weekly-usage']);
    expect(item(some, 'weekly-usage')!.label).toBe('\u23f1\ufe0f 7d');
  });

  it('uses components.order over the file preset, but not over a command preset', () => {
    const raw = { preset: 'PM', components: { order: ['usage', 'project'] } };
    expect(types(importStatuslinePro(raw))).toEqual(['session-cost', 'project-dir']);
    expect(types(importStatuslinePro(raw, { preset: 'M' }))).toEqual(['model']);
    expect(types(importStatuslinePro({ preset: 'pmm' }))).toEqual(['project-dir', 'model']);
  });

  it('skips disabled components and applies the sub-toggles', () => {
    const r = importStatuslinePro({
      preset: 'PBTUS',
      components: {
        project: { enabled: false },
        branch: { status: { show_dirty: false, show_ahead_behind: true, show_stash_count: true } },
        tokens: { show_progress_bar: false, show_percentage: true },
        usage: { show_lines_removed: true, precision: 9 },
      },
    });
    expect(types(r)).toEqual([
      'git-branch',
      'git-ahead-behind',
      'git-stash',
      'context-percentage',
      'context-length',
      'session-cost',
      'lines-changed',
      'tool-activity',
    ]);
    expect(item(r, 'session-cost')!.options).toBeUndefined();
    expect(item(r, 'tool-activity')!.options).toEqual({ mode: 'running' });
    expect(texts(r)).toContain(`${TOOL} "status" is approximated by the tool-activity widget`);
    const noPct = importStatuslinePro({ preset: 'T', components: { tokens: { show_percentage: false } } });
    expect(item(noPct, 'context-bar')!.options).toEqual({ width: 15, showPercent: false });
  });

  it('maps classic to text with the joined separator, and the colour and width settings', () => {
    const r = importStatuslinePro({
      preset: 'PM',
      theme: 'classic',
      style: {
        separator: '|',
        separator_before: '  ',
        separator_after: ' ',
        enable_colors: false,
        max_width: 120,
      },
      components: { model: { text_color: 'red', icon_color: 'blue' } },
    });
    expect(r.config).toMatchObject({ style: 'text', separator: '  | ', colorLevel: 0, maxWidth: 120 });
    expect(item(r, 'model')!.color).toBeUndefined();
    expect(r.notes).toEqual([]);
    expect(importStatuslinePro({}).config.separator).toBe(' | ');
    expect(importStatuslinePro({ theme: 'capsule' }).config.style).toBe('capsule');
    expect(importStatuslinePro({ theme: 'capsule' }, { theme: 'powerline' }).config.style).toBe('powerline');
  });

  it('falls back to classic for an unknown theme', () => {
    const r = importStatuslinePro({ preset: 'M', theme: 'neon' });
    expect(r.config.style).toBe('text');
    expect(texts(r)).toEqual([`${TOOL} theme "neon" has no ccinfobar equivalent, used the classic theme`]);
  });

  it('picks the icon set from force_text, enable_emoji and enable_nerd_font', () => {
    const label = (raw: unknown, opts = {}) => {
      const r = importStatuslinePro(raw, { preset: 'P', ...opts });
      return [r.config.icons, item(r, 'project-dir')!.label];
    };
    expect(label({})).toEqual(['emoji', '\u{1f4c1}']);
    expect(label({ style: { enable_nerd_font: true } })).toEqual(['nerd', '\uf07c']);
    expect(label({ style: { enable_emoji: false } })).toEqual(['text', '[P]']);
    expect(label({ style: { enable_nerd_font: true }, terminal: { force_text: true } })).toEqual([
      'text',
      '[P]',
    ]);
    expect(label({ terminal: { force_nerd_font: true } })).toEqual(['nerd', '\uf07c']);
    expect(label({ style: { enable_nerd_font: true } }, { force: 'emoji' })).toEqual(['emoji', '\u{1f4c1}']);
    expect(label({ components: { project: { text_icon: '' } } }, { force: 'text' })).toEqual(['text', '']);
    expect(label({ style: { enable_nerd_font: true } }, { noIcons: true })).toEqual(['emoji', '\u{1f4c1}']);
  });

  it('maps text colours through namedColor, with ccsp extras', () => {
    const r = importStatuslinePro({
      preset: 'PMB',
      components: {
        project: { text_color: 'orange' },
        model: { text_color: 'Purple' },
        branch: { text_color: 'nope' },
      },
    });
    expect(item(r, 'project-dir')!.color).toBe('yellow');
    expect(item(r, 'model')!.color).toBe('magenta');
    expect(item(r, 'git-branch')!.color).toBeUndefined();
  });

  it('drops unknown preset letters and components by name without prototype hits', () => {
    const r = importStatuslinePro({
      preset: 'PXW',
      preset_mapping: { W: 'weather', constructor: 'model' },
    });
    expect(types(r)).toEqual(['project-dir']);
    expect(texts(r)).toEqual([
      `${TOOL} segment "X" has no ccinfobar equivalent and was skipped`,
      `${TOOL} segment "weather" has no ccinfobar equivalent and was skipped`,
    ]);
    const order = importStatuslinePro({
      components: {
        order: ['constructor', 'toString', '__proto__', 'model', 7],
        constructor: { enabled: true },
      },
    });
    expect(types(order)).toEqual(['model']);
    expect(order.notes.filter((n) => n.kind === 'drop')).toHaveLength(4);
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });

  it('notes the project layer and the default layout', () => {
    const r = importStatuslinePro({}, { defaulted: true, projectLayer: true });
    expect(types(r)).toHaveLength(11);
    expect(texts(r)).toEqual([
      `no ${TOOL} config file found, imported its default layout`,
      `${TOOL} "status" is approximated by the tool-activity widget`,
      `${TOOL} project configs under ~/.claude/projects/ were not read; pass one with --file to import it`,
    ]);
  });

  it('writes Turkish notes', () => {
    const r = withLang('tr', () =>
      importStatuslinePro({ widgets: { a: {}, b: {} } }, { preset: 'P', projectLayer: true }),
    );
    expect(texts(r)).toEqual([
      `${TOOL} [multiline] satırları ve 2 [widgets] tablosu atlandı: ccinfobar bunları içe aktarmaz, URL'lerini ve HTTP başlıklarını asla kopyalamaz`,
      `${TOOL} proje yapılandırmaları (~/.claude/projects/ altında) okunmadı; birini içe aktarmak için yolunu --file ile verin`,
    ]);
  });

  it('targets only existing widgets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });
});

describe('statusline-pro discovery', () => {
  let dir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  const MINI = 'preset = "PM"\ntheme = "capsule"\n';
  const write = (file: string, text = MINI) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const userFile = () => path.join(home, '.claude', 'statusline-pro', 'config.toml');
  const LAYER = `${TOOL} project configs under ~/.claude/projects/ were not read; pass one with --file to import it`;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ccsp-')));
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads <home>/.claude/statusline-pro/config.toml', () => {
    const file = write(userFile());
    const r = importFrom('statusline-pro', { env, cwd: dir });
    expect(r.file).toBe(file);
    expect(types(r)).toEqual(['project-dir', 'model']);
    expect(r.config.style).toBe('capsule');
    expect(texts(r)).toEqual([LAYER]);
  });

  it('imports the default layout when no file exists', () => {
    const r = importFrom('statusline-pro', { env, cwd: dir });
    expect(r.file).toBeNull();
    expect(texts(r)[0]).toBe(`no ${TOOL} config file found, imported its default layout`);
    expect(texts(r)).toContain(LAYER);
    expect(types(r)).toEqual([
      'project-dir',
      'model',
      'git-branch',
      'context-bar',
      'context-length',
      'session-cost',
      'five-hour-usage',
      'five-hour-reset',
      'weekly-usage',
      'weekly-reset',
      'tool-activity',
    ]);
    expect(r.config).toMatchObject({ style: 'text', separator: ' | ', icons: 'emoji' });
  });

  it('applies --preset and --theme from the command', () => {
    write(userFile());
    for (const command of [
      'ccsp --preset MB --theme powerline',
      'npx ccsp@latest -p MB -t powerline',
      'npx ccsp@latest MB --theme=powerline',
    ]) {
      const r = importFrom('statusline-pro', { command, env, cwd: dir });
      expect(types(r), command).toEqual(['model', 'git-branch']);
      expect(r.config.style, command).toBe('powerline');
    }
    const flagged = importFrom('statusline-pro', {
      command: 'npx ccsp@latest PT --preset M --force-text --no-colors',
      env,
      cwd: dir,
    });
    expect(types(flagged)).toEqual(['model']);
    expect(flagged.config).toMatchObject({ icons: 'text', colorLevel: 0 });
  });

  it('follows -c/--config and skips the layer note for --file', () => {
    const custom = write(path.join(home, 'ccsp.toml'), 'preset = "U"\n');
    const r = importFrom('statusline-pro', { command: 'ccsp --config ~/ccsp.toml', env, cwd: dir });
    expect(r.file).toBe(custom);
    expect(types(r)).toEqual(['session-cost']);
    const rel = write(path.join(dir, 'rel', 'c.toml'), 'preset = "M"\n');
    expect(importFrom('statusline-pro', { command: 'ccsp -c rel/c.toml', env, cwd: dir }).file).toBe(rel);
    const other = importFrom('statusline-pro', { file: custom, env, cwd: dir });
    expect(texts(other)).toEqual([]);
  });

  it('fails on a missing --file and shows TOML errors with their position', () => {
    const file = path.join(dir, 'missing.toml');
    expect(() => importFrom('statusline-pro', { file, env, cwd: dir })).toThrow(
      `Cannot read ${TOOL} config at ${file}`,
    );
    const bad = write(path.join(dir, 'bad.toml'), 'preset = "unclosed\n');
    expect(() => importFrom('statusline-pro', { file: bad, env, cwd: dir })).toThrow(/bad\.toml:1:\d+ /);
  });

  it('is detected from its documented commands and resolved by its aliases', () => {
    for (const name of ['statusline-pro', 'ccsp', 'claude-code-statusline-pro', 'CCSP']) {
      expect(resolveSource(name), name).toBe('statusline-pro');
    }
    for (const command of [
      'npx ccsp@latest',
      'npx claude-code-statusline-pro@latest',
      'ccsp --preset PMBTURS --theme powerline',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\ccsp.cmd',
    ]) {
      expect(detectTool(command), command).toMatchObject({
        tool: 'statusline-pro',
        name: TOOL,
        importable: true,
      });
    }
    expect(detectTool('ccspx')!.tool).toBe('unknown');
  });

  it('leaves detection of the other tools unchanged', () => {
    const cases: [string, string][] = [
      ['npx ccstatusline@latest', 'ccstatusline'],
      ['npx -y ccstatusline-zh@latest', 'ccstatusline'],
      ['npx -y @owloops/claude-powerline@latest', 'claude-powerline'],
      ['~/.claude/ccline/ccline', 'ccometixline'],
      ['cship', 'cship'],
      ['bash ~/.claude/plugins/claude-hud/run.sh', 'claude-hud'],
      ['~/.claude/best-claude-hud/best-claude-hud', 'best-claude-hud'],
      ['~/.claude/byebyecode/byebyecode', 'byebyecode'],
      ['claudebar render', 'claudebar'],
      ['bunx ccusage statusline', 'ccusage'],
    ];
    for (const [command, tool] of cases) expect(detectTool(command)!.tool, command).toBe(tool);
  });
});
