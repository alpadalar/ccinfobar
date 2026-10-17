import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SEGMENTS, importClaudebar, TARGETS } from '../../src/importers/claudebar.js';
import { detectTool, importFrom, resolveSource } from '../../src/importers/index.js';
import { parseToml } from '../../src/importers/toml.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const fixture = () => parseToml(fs.readFileSync(path.join(FIXTURES, 'claudebar.toml'), 'utf8'));
const types = (r: ReturnType<typeof importClaudebar>) => r.config.lines!.flat().map((i) => i.type);
const item = (r: ReturnType<typeof importClaudebar>, type: string) =>
  r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: ReturnType<typeof importClaudebar>) => r.notes.map((n) => n.text);

describe('importClaudebar', () => {
  it('maps the fixture segments, theme, style and thresholds', () => {
    const r = importClaudebar(fixture());
    expect(r.source).toBe('claudebar');
    expect(r.config.lines).toHaveLength(1);
    expect(types(r)).toEqual([
      'cwd',
      'git-branch',
      'git-status',
      'model',
      'effort',
      'context-bar',
      'context-length',
      'five-hour-usage',
      'five-hour-reset',
      'weekly-usage',
      'weekly-reset',
      'session-cost',
      'limit-eta',
      'clock',
    ]);
    expect(item(r, 'cwd')!.options).toEqual({ style: 'short' });
    expect(item(r, 'context-bar')!.options).toEqual({ width: 8, style: 'line' });
    expect(item(r, 'five-hour-usage')!.options).toEqual({ display: 'bar', width: 8, style: 'line' });
    expect(item(r, 'weekly-usage')!.options).toEqual({ display: 'bar', width: 8, style: 'line' });
    expect(item(r, 'session-cost')!.options).toEqual({ decimals: 3 });
    expect(item(r, 'limit-eta')!.options).toEqual({ pace: 'recent' });
    expect(item(r, 'clock')!.options).toEqual({ h12: true });
    expect(item(r, 'context-bar')!.id).toBe('claudebar-context-context-bar');
    expect(r.config).toMatchObject({
      theme: 'kanagawa',
      style: 'text',
      separator: '  ',
      icons: 'nerd',
      autoWrap: true,
    });
    expect(r.config.charset).toBeUndefined();
  });

  it('explains what was dropped or approximated', () => {
    expect(importClaudebar(fixture()).notes).toEqual([
      {
        kind: 'drop',
        text: 'claudebar segment "dev-context" has no ccinfobar equivalent and was skipped',
      },
      { kind: 'drop', text: 'claudebar segment "update-notice" was dropped: ccinfobar updates itself' },
      {
        kind: 'approx',
        text: 'claudebar setting "weekly_show_at" = 75 hides weekly-usage below that value, ccinfobar always shows it',
      },
      { kind: 'approx', text: 'claudebar layout "auto" became ccinfobar line wrapping (autoWrap)' },
    ]);
  });

  it('notes thresholds, float, clock and ignored settings', () => {
    const r = importClaudebar({
      segments: ['clock', 'rate-limits'],
      thresholds: {
        warn: 40,
        crit: 90,
        weekly_show_at: 0,
        float: true,
        float_file: '~/x.txt',
        burn_lookback: 300,
        max_lines: 2,
      },
    });
    expect(item(r, 'clock')!.options).toBeUndefined();
    expect(texts(r)).toEqual([
      'claudebar clock_mode "auto" picks 12- or 24-hour time from the locale, ccinfobar shows 24-hour time',
      'claudebar bar thresholds 40%/90% became ccinfobar threshold colors (yellow from 50%, red from 80%)',
      'claudebar float readout was dropped: ccinfobar does not write a readout file',
      'claudebar settings not imported: burn_lookback, max_lines',
    ]);
    expect(r.config.autoWrap).toBe(false);
  });

  it('skips the clock when clock_mode is off', () => {
    const r = importClaudebar({ segments: ['model', 'clock'], thresholds: { clock_mode: 'off' } });
    expect(types(r)).toEqual(['model', 'effort']);
    expect(r.notes).toEqual([
      { kind: 'drop', text: 'claudebar clock_mode is "off", so the clock segment was skipped' },
    ]);
  });

  it('keeps the widget defaults for out-of-range thresholds', () => {
    const r = importClaudebar({
      segments: ['context', 'cost'],
      thresholds: { bar_width: 0, cost_decimals: 9 },
    });
    expect(item(r, 'context-bar')!.options).toEqual({ style: 'line' });
    expect(item(r, 'session-cost')!.options).toBeUndefined();
  });

  it('maps themes exactly, approximately or to its tokyo-night fallback', () => {
    expect(importClaudebar({ theme: 'everforest-dark' }).config.theme).toBe('everforest');
    expect(importClaudebar({}).config.theme).toBe('tokyo-night');
    const approx = importClaudebar({ theme: 'cobalt2', segments: [] });
    expect(approx.config.theme).toBe('dark');
    expect(approx.notes).toEqual([
      { kind: 'approx', text: 'claudebar theme "cobalt2" is approximated by the dark theme' },
    ]);
    const missing = importClaudebar({ theme: 'nope', segments: [] });
    expect(missing.config.theme).toBe('tokyo-night');
    expect(missing.notes).toEqual([
      {
        kind: 'info',
        text: 'claudebar theme "nope" has no ccinfobar equivalent, used the tokyo-night theme',
      },
    ]);
  });

  it('maps every style to text with its separator, bar, icons and charset', () => {
    const style = (name: string) => {
      const r = importClaudebar({ style: name, segments: ['context'] });
      const { separator, icons, charset } = r.config;
      return { separator, icons, charset, bar: item(r, 'context-bar')!.options!.style };
    };
    expect(style('powerline')).toEqual({ separator: '  ', icons: 'nerd', charset: undefined, bar: 'line' });
    expect(style('lean')).toEqual({ separator: ' ', icons: 'nerd', charset: undefined, bar: 'line' });
    expect(style('minimal')).toEqual({ separator: ' · ', icons: 'none', charset: undefined, bar: 'line' });
    expect(style('unicode')).toEqual({ separator: ' ❯ ', icons: 'text', charset: undefined, bar: 'blocks' });
    expect(style('ascii')).toEqual({ separator: ' | ', icons: 'none', charset: 'text', bar: 'ascii' });
    expect(style('plain')).toEqual({ separator: ' | ', icons: 'none', charset: 'text', bar: 'ascii' });
    expect(style('dots')).toEqual({ separator: '  ', icons: 'nerd', charset: undefined, bar: 'dots' });
    for (const name of ['powerline', 'ascii', 'dots']) {
      expect(importClaudebar({ style: name }).config.style).toBe('text');
    }
    const unknown = importClaudebar({ style: 'nope', segments: [] });
    expect(unknown.config.separator).toBe('  ');
    expect(unknown.notes).toEqual([
      { kind: 'info', text: 'claudebar style "nope" is unknown, imported its default style (powerline)' },
    ]);
  });

  it('imports the eight default segments with the defaultLayout note', () => {
    const r = importClaudebar({}, { defaulted: true });
    expect(DEFAULT_SEGMENTS).toHaveLength(8);
    expect(types(r)).toEqual([
      'cwd',
      'git-branch',
      'git-status',
      'model',
      'effort',
      'context-bar',
      'context-length',
      'lines-changed',
      'five-hour-usage',
      'five-hour-reset',
      'weekly-usage',
      'weekly-reset',
      'session-cost',
      'session-duration',
    ]);
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: 'no claudebar config file found, imported its default layout',
    });
    expect(r.config).toMatchObject({ theme: 'tokyo-night', separator: '  ', autoWrap: false });
  });

  it('drops unknown segments by name without prototype hits', () => {
    const r = importClaudebar({ segments: ['constructor', '__proto__', 'toString', 7, 'model'] });
    expect(types(r)).toEqual(['model', 'effort']);
    expect(texts(r)).toEqual([
      'claudebar segment "constructor" has no ccinfobar equivalent and was skipped',
      'claudebar segment "__proto__" has no ccinfobar equivalent and was skipped',
      'claudebar segment "toString" has no ccinfobar equivalent and was skipped',
      'claudebar segment "7" has no ccinfobar equivalent and was skipped',
    ]);
    const proto = importClaudebar({ theme: 'constructor', style: 'toString', segments: [] });
    expect(proto.config.theme).toBe('tokyo-night');
    expect(proto.config.separator).toBe('  ');
  });

  it('deduplicates repeated segments', () => {
    const ids = importClaudebar({ segments: ['model', 'model'] })
      .config.lines!.flat()
      .map((i) => i.id);
    expect(ids).toEqual([
      'claudebar-model-model',
      'claudebar-model-effort',
      'claudebar-model-model-2',
      'claudebar-model-effort-2',
    ]);
  });

  it('applies --theme, --style and --segments overrides', () => {
    const r = importClaudebar(
      { theme: 'nord', style: 'lean', segments: ['model'] },
      { overrides: { theme: 'dracula', style: 'ascii', segments: ['cost', 'duration'] } },
    );
    expect(r.config.theme).toBe('dracula');
    expect(r.config.charset).toBe('text');
    expect(types(r)).toEqual(['session-cost', 'session-duration']);
  });

  it('sanitizes foreign names in notes', () => {
    const r = importClaudebar({ segments: ['a\x1b[31mb‮c'], theme: 'x\x07y' });
    for (const n of texts(r)) expect(n).not.toMatch(/[\x00-\x1f‮]/);
    expect(texts(r)[0]).toContain('"abc"');
  });

  it('writes Turkish notes', () => {
    const r = withLang('tr', () => importClaudebar({}, { defaulted: true }));
    expect(r.notes[0]!.text).toBe(
      'claudebar yapılandırma dosyası bulunamadı, varsayılan düzeni içe aktarıldı',
    );
  });

  it('targets only existing widgets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });
});

describe('claudebar discovery', () => {
  let dir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  const MINI = 'theme = "nord"\nsegments = ["model"]\n';
  const write = (file: string, text = MINI) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-claudebar-')));
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
    env = { HOME: home, USERPROFILE: home };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads <home>/.config/claudebar/config.toml', () => {
    const file = write(path.join(home, '.config', 'claudebar', 'config.toml'));
    const r = importFrom('claudebar', { env, cwd: dir });
    expect(r.file).toBe(file);
    expect(r.config.theme).toBe('nord');
    expect(r.notes).toEqual([]);
  });

  it('prefers a non-empty XDG_CONFIG_HOME', () => {
    write(path.join(home, '.config', 'claudebar', 'config.toml'));
    const xdg = write(path.join(dir, 'xdg', 'claudebar', 'config.toml'), 'theme = "dracula"\n');
    expect(
      importFrom('claudebar', { env: { ...env, XDG_CONFIG_HOME: path.join(dir, 'xdg') }, cwd: dir }).file,
    ).toBe(xdg);
    const empty = importFrom('claudebar', { env: { ...env, XDG_CONFIG_HOME: '' }, cwd: dir });
    expect(empty.file).toBe(path.join(home, '.config', 'claudebar', 'config.toml'));
  });

  it('follows --config in the status line command', () => {
    const tilde = write(path.join(home, 'cb.toml'));
    expect(importFrom('claudebar', { command: 'claudebar --config ~/cb.toml', env, cwd: dir }).file).toBe(
      tilde,
    );
    const rel = write(path.join(dir, 'rel', 'cb.toml'));
    const command = 'claudebar render --config=rel/cb.toml';
    expect(importFrom('claudebar', { command, env, cwd: dir }).file).toBe(rel);
  });

  it('applies --theme and --segments from the command', () => {
    write(path.join(home, '.config', 'claudebar', 'config.toml'));
    const r = importFrom('claudebar', {
      command: 'claudebar --theme gruvbox --segments cost,lines',
      env,
      cwd: dir,
    });
    expect(r.config.theme).toBe('gruvbox');
    expect(types(r)).toEqual(['session-cost', 'lines-changed']);
  });

  it('imports the default layout when no file exists', () => {
    const r = importFrom('claudebar', { env, cwd: dir });
    expect(r.file).toBeNull();
    expect(r.notes[0]!.text).toBe('no claudebar config file found, imported its default layout');
    expect(types(r)).toHaveLength(14);
    const missing = importFrom('claudebar', { command: 'claudebar --config ~/none.toml', env, cwd: dir });
    expect(missing.file).toBeNull();
  });

  it('fails on a missing --file', () => {
    const file = path.join(dir, 'missing.toml');
    expect(() => importFrom('claudebar', { file, env, cwd: dir })).toThrow(
      `Cannot read claudebar config at ${file}`,
    );
  });

  it('shows a TOML error with its position', () => {
    const file = write(path.join(dir, 'bad.toml'), 'theme = "unclosed\n');
    expect(() => importFrom('claudebar', { file, env, cwd: dir })).toThrow(/bad\.toml:1:\d+ /);
  });

  it('is detected from its binary and resolved by name', () => {
    expect(resolveSource('claudebar')).toBe('claudebar');
    expect(resolveSource('ClaudeBar')).toBe('claudebar');
    for (const command of [
      'claudebar render',
      '/usr/local/bin/claudebar',
      'C:\\Users\\me\\.cargo\\bin\\claudebar.exe render',
    ]) {
      expect(detectTool(command), command).toMatchObject({
        tool: 'claudebar',
        name: 'claudebar',
        importable: true,
      });
    }
    expect(detectTool('claudebarista')!.tool).toBe('unknown');
    expect(detectTool('claude-statusbar')!.tool).not.toBe('claudebar');
  });
});
