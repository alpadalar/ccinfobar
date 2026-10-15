import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImportCommand } from '../../src/commands/manage.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { createContext } from '../../src/core/context.js';
import { tildify } from '../../src/core/paths.js';
import { render } from '../../src/core/renderer.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { Config } from '../../src/core/types.js';
import {
  CCLINE_DEFAULT,
  importCcometixline,
  parseCclineTheme,
  TARGETS,
} from '../../src/importers/ccometixline.js';
import { CCLINE_THEMES } from '../../src/importers/ccometixline-themes.js';
import { sanitizeImport } from '../../src/importers/confirm.js';
import {
  ccometixlinePaths,
  detectTool,
  importFrom,
  MAX_SOURCE_BYTES,
  resolveSource,
  toConfig,
} from '../../src/importers/index.js';
import { parseToml } from '../../src/importers/toml.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang, withLangAsync } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const toml = (f: string) => parseToml(fs.readFileSync(path.join(FIXTURES, f), 'utf8'));
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

const ITEMS = [
  { id: 'model-model', type: 'model', label: '\ue26d', color: 'brightCyan', bold: true },
  {
    id: 'directory-cwd',
    type: 'cwd',
    options: { style: 'basename' },
    label: '\u{f024b}',
    color: 'ansi256:208',
    background: '#282c34',
  },
  { id: 'git-git-branch', type: 'git-branch', label: '\u{f02a2}', color: 'brightBlue' },
  { id: 'git-git-status', type: 'git-status', color: 'brightBlue' },
  { id: 'git-git-sha', type: 'git-sha', color: 'brightBlue' },
  { id: 'context_window-context-percentage', type: 'context-percentage', label: '\uf49b' },
  { id: 'cost-session-cost', type: 'session-cost', label: '\ueec1', color: 'yellow' },
  { id: 'session-session-duration', type: 'session-duration', label: '\u{f19bb}', color: 'green' },
  { id: 'session-lines-changed', type: 'lines-changed', color: 'green' },
  { id: 'output_style-output-style', type: 'output-style', label: '\u{f12f5}' },
];

const DROPS = [
  {
    kind: 'drop',
    text: 'CCometixLine segment "cost": usage API options (api_base_url) were dropped, ccinfobar never sends your token to a custom host',
  },
  { kind: 'drop', text: 'CCometixLine segment "update" was dropped: ccinfobar updates itself' },
];

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ccline-'));
  onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// os.homedir() follows HOME (POSIX) and USERPROFILE (Windows)
const withHome = (home: string) => {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  onTestFinished(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
};

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

const q = (p: string) => `"${p}"`;
const homeConfig = (home: string) => path.join(home, '.claude', 'ccline', 'config.toml');
const MINI = '[style]\nmode = "plain"\nseparator = " / "\n\n[[segments]]\nid = "model"\nenabled = true\n';

describe('CCometixLine mapper', () => {
  it('maps the table-form fixture', () => {
    const r = importCcometixline(toml('ccometixline.toml'));
    expect(r.source).toBe('ccometixline');
    expect(r.config.icons).toBe('nerd');
    expect(r.config.separator).toBe(' | ');
    expect(r.config.style).toBeUndefined();
    expect(r.config.lines).toEqual([ITEMS]);
    expect(r.notes).toEqual(DROPS);
  });

  it('renders the fixture with sample data', () => {
    expect(show(toConfig(importCcometixline(toml('ccometixline.toml'))))).toEqual([
      '\ue26d Opus 5.5 | \u{f024b} acme-app | \u{f02a2} feat/statusline | \u25cf +3 ~2 ?1 | a1b2c3d | \uf49b 34% | \ueec1 $1.87 | \u{f19bb} 45m | \u{f0992} +214 -63 | \u{f12f5} \u2014',
    ]);
  });

  it('maps the inline-table variant to the same layout plus an icon color note', () => {
    const r = importCcometixline(toml('ccometixline-inline.toml'));
    expect(r.config.lines).toEqual([ITEMS]);
    expect(r.notes).toEqual([
      DROPS[0],
      {
        kind: 'approx',
        text: 'CCometixLine segment "session": icon color dropped, the widget has one color',
      },
      DROPS[1],
    ]);
  });

  it('maps plain mode to emoji icons and the powerline arrow to the powerline style', () => {
    const seg = { id: 'model', enabled: true, icon: { plain: '\u{1f916}', nerd_font: '\ue26d' } };
    const plain = importCcometixline({ style: { mode: 'plain', separator: '\ue0b0' }, segments: [seg] });
    expect(plain.config.icons).toBe('emoji');
    expect(plain.config.style).toBe('powerline');
    expect('separator' in plain.config).toBe(false);
    expect(plain.config.lines![0]![0]!.label).toBe('\u{1f916}');
    const pl = importCcometixline({ style: { mode: 'powerline', separator: ' > ' }, segments: [seg] });
    expect(pl.config.icons).toBe('nerd');
    expect(pl.config.separator).toBe(' > ');
    expect(pl.config.lines![0]![0]!.label).toBe('\ue26d');
    const empty = importCcometixline({ style: { mode: 'plain' }, segments: [{ id: 'model', icon: {} }] });
    expect(empty.config.lines![0]![0]!.label).toBe('');
  });

  it('drops unknown segments with a sanitized name and skips disabled ones silently', () => {
    const r = importCcometixline({
      style: { mode: 'plain', separator: ' ' },
      segments: [
        { id: 'weather', enabled: true },
        { id: 'we\u001b[31mird', enabled: true },
        { id: 'cost', enabled: false, options: { api_base_url: 'https://x.example' } },
      ],
    });
    expect(r.config.lines).toEqual([[]]);
    expect(r.notes).toEqual([
      { kind: 'drop', text: 'CCometixLine segment "weather" has no ccinfobar equivalent and was skipped' },
      { kind: 'drop', text: 'CCometixLine segment "weird" has no ccinfobar equivalent and was skipped' },
    ]);
  });

  it('drops every usage API option and keeps the usage widgets', () => {
    const r = importCcometixline({
      style: { mode: 'plain', separator: ' ' },
      segments: [
        {
          id: 'usage',
          enabled: true,
          icon: { plain: 'U', nerd_font: 'N' },
          options: { api_base_url: 'https://x.example', cache_duration: 180, timeout: 2 },
        },
      ],
    });
    expect(r.config.lines![0]!.map((i) => i.type)).toEqual(['five-hour-usage', 'weekly-reset']);
    expect(r.config.lines![0]![1]!.label).toBeUndefined();
    expect(r.notes.map((n) => n.text)).toEqual([
      'CCometixLine segment "usage": usage API options (api_base_url, cache_duration, timeout) were dropped, ccinfobar never sends your token to a custom host',
    ]);
  });

  it('keeps item ids unique when a segment repeats', () => {
    const seg = { id: 'model', enabled: true };
    const r = importCcometixline({ style: { mode: 'plain', separator: ' ' }, segments: [seg, seg] });
    expect(r.config.lines![0]!.map((i) => i.id)).toEqual(['model-model', 'model-model-2']);
  });

  it('cleans escape sequences out of icons', () => {
    const r = sanitizeImport(
      importCcometixline({
        style: { mode: 'plain', separator: ' \u001b]0;x\u0007| ' },
        segments: [{ id: 'model', enabled: true, icon: { plain: '\u001b[31m\u202eM', nerd_font: '' } }],
      }),
    );
    expect(r.config.lines![0]![0]!.label).toBe('M');
    expect(r.config.separator).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('builds the CCometixLine default layout', () => {
    const r = importCcometixline(CCLINE_DEFAULT, { defaulted: true });
    expect(r.config.icons).toBe('emoji');
    expect(r.config.separator).toBe(' | ');
    expect(r.config.lines![0]!.map((i) => i.type)).toEqual([
      'model',
      'cwd',
      'git-branch',
      'git-status',
      'context-percentage',
    ]);
    expect(r.notes).toEqual([
      { kind: 'info', text: 'no CCometixLine config file found, imported its default layout' },
      {
        kind: 'approx',
        text: 'CCometixLine segment "directory": icon color dropped, the widget has one color',
      },
    ]);
  });

  it('only emits listed targets and every target exists', () => {
    const types = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(types.has(type), type).toBe(true);
    const all = (CCLINE_DEFAULT.segments as Record<string, unknown>[]).map((s) => ({
      ...s,
      enabled: true,
      options: s.id === 'git' ? { show_sha: true } : {},
    }));
    const r = importCcometixline({ style: { mode: 'plain', separator: ' ' }, segments: all });
    expect(new Set(r.config.lines![0]!.map((i) => i.type))).toEqual(new Set(TARGETS));
  });

  it('writes notes in Turkish', () => {
    withLang('tr', () => {
      const r = importCcometixline({
        style: { mode: 'plain', separator: ' ' },
        segments: [
          { id: 'update', enabled: true },
          { id: 'weather', enabled: true },
          { id: 'cost', enabled: true, options: { timeout: 2 } },
          { id: 'model', icon: { plain: 'M' }, colors: { icon: { c16: 1 }, text: { c16: 2 } } },
        ],
      });
      expect(r.notes.map((n) => n.text)).toEqual([
        'CCometixLine bölümü "update" atlandı: ccinfobar kendini günceller',
        'CCometixLine bölümü "weather" için ccinfobar karşılığı yok, atlandı',
        'CCometixLine bölümü "cost": kullanım API seçenekleri (timeout) atlandı, ccinfobar token\'ınızı asla özel bir sunucuya göndermez',
        'CCometixLine bölümü "model": simge rengi atlandı, bileşenin tek rengi var',
      ]);
    });
  });
});

describe('CCometixLine discovery', () => {
  it('reads the home config even when CLAUDE_CONFIG_DIR points elsewhere', () => {
    const home = tmp();
    withHome(home);
    write(homeConfig(home), MINI);
    const r = importFrom('ccometixline', { env: { CLAUDE_CONFIG_DIR: path.join(home, 'elsewhere') } });
    expect(r.file).toBe(homeConfig(home));
    expect(r.config.separator).toBe(' / ');
    expect(r.notes).toEqual([]);
  });

  it('falls back to a config.toml next to the status line command', () => {
    const home = tmp();
    withHome(home);
    const tools = path.join(tmp(), 'opt', 'tools', 'ccline');
    const local = write(path.join(tools, 'config.toml'), MINI);
    const command = `${q(path.join(tools, 'ccline'))} --flag`;
    expect(ccometixlinePaths(command, home)).toEqual({ file: local, note: 'command-dir' });
    const r = importFrom('ccometixline', { command });
    expect(r.file).toBe(local);
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: `read the CCometixLine config next to the status line command: ${tildify(local)}`,
    });
    const nested = path.join(tools, 'bin', 'ccline');
    expect(ccometixlinePaths(q(nested), home)).toEqual({ file: local, note: 'command-dir' });
    write(homeConfig(home), MINI);
    expect(ccometixlinePaths(command, home)).toEqual({ file: homeConfig(home), note: null });
  });

  it('ignores relative commands, missing files and symlinked configs', () => {
    const home = tmp();
    const dir = path.join(tmp(), 'ccline');
    expect(ccometixlinePaths('ccline', home)).toEqual({ file: null, note: null });
    expect(ccometixlinePaths('./ccline/ccline', home)).toEqual({ file: null, note: null });
    expect(ccometixlinePaths(q(path.join(dir, 'ccline')), home)).toEqual({ file: null, note: null });
    fs.mkdirSync(path.join(dir, 'config.toml'), { recursive: true });
    expect(ccometixlinePaths(q(path.join(dir, 'ccline')), home)).toEqual({ file: null, note: null });
    const other = write(path.join(tmp(), 'secret.toml'), MINI);
    const linkDir = path.join(tmp(), 'ccline');
    fs.mkdirSync(linkDir);
    try {
      fs.symlinkSync(other, path.join(linkDir, 'config.toml'));
    } catch {
      return;
    }
    expect(ccometixlinePaths(q(path.join(linkDir, 'ccline')), home)).toEqual({ file: null, note: null });
  });

  it('imports the default layout when no file exists', () => {
    withHome(tmp());
    const r = importFrom('ccometixline', { command: 'ccline' });
    expect(r.file).toBeNull();
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: 'no CCometixLine config file found, imported its default layout',
    });
    expect(r.config.lines![0]!.map((i) => i.type)).toContain('context-percentage');
  });

  it('lets --file override discovery', () => {
    const home = tmp();
    withHome(home);
    write(homeConfig(home), MINI);
    const file = path.join(FIXTURES, 'ccometixline.toml');
    const r = importFrom('ccometixline', { file });
    expect(r.file).toBe(file);
    expect(r.config.lines).toEqual([ITEMS]);
  });

  it('reports TOML errors with file, line and column and refuses big files', () => {
    const d = tmp();
    const bad = write(path.join(d, 'bad.toml'), '[style\nmode = 1\n');
    expect(() => importFrom('ccometixline', { file: bad })).toThrow(/^.+bad\.toml:1:7 /);
    let message = '';
    try {
      importFrom('ccometixline', { file: bad });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message.startsWith(`${tildify(bad)}:1:7 `)).toBe(true);
    const big = write(path.join(d, 'big.toml'), `#${' '.repeat(MAX_SOURCE_BYTES)}`);
    expect(() => importFrom('ccometixline', { file: big })).toThrow('is larger than 1 MB');
    expect(() => importFrom('ccometixline', { file: path.join(d, 'none.toml') })).toThrow(
      `Cannot read CCometixLine config at ${path.join(d, 'none.toml')}`,
    );
  });

  it('resolves the ccline alias and is importable', () => {
    expect(resolveSource('ccline')).toBe('ccometixline');
    expect(resolveSource('CCometixLine')).toBe('ccometixline');
    expect(detectTool('ccline')).toMatchObject({ tool: 'ccometixline', importable: true });
  });
});

describe('import ccline --dry-run', () => {
  const fake = () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const io: PromptIo = {
      tty: false,
      columns: 200,
      ask: async (_q, fallback) => fallback,
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
    };
    return { io, lines, errors };
  };

  it('prints the report and a preview and writes nothing', async () => {
    const home = tmp();
    withHome(home);
    write(homeConfig(home), fs.readFileSync(path.join(FIXTURES, 'ccometixline.toml'), 'utf8'));
    const cfg = path.join(tmp(), 'config.json');
    const f = fake();
    const prev = process.exitCode;
    onTestFinished(() => {
      process.exitCode = prev;
    });
    await runImportCommand(parseArgs(['import', 'ccline', '--dry-run']), cfg, f.io);
    expect(process.exitCode ?? 0).toBe(0);
    expect(f.errors).toEqual([]);
    expect(fs.existsSync(cfg)).toBe(false);
    expect(f.lines[0]).toBe(`✓ Imported 10 widgets from ccometixline (${tildify(homeConfig(home))})`);
    expect(f.lines).toContain('  Dropped:');
    expect(f.lines).toContain('    - CCometixLine segment "update" was dropped: ccinfobar updates itself');
    expect(f.lines).toContain('Preview with sample data:');
    expect(f.lines.at(-1)).toBe('Dry run: nothing was written.');
    expect(f.lines.some((l) => l.includes('Opus 5.5 | '))).toBe(true);
  });

  it('prints a positioned TOML error in Turkish', async () => {
    const d = tmp();
    const bad = write(path.join(d, 'bad.toml'), '[style\n');
    const f = fake();
    const prev = process.exitCode;
    onTestFinished(() => {
      process.exitCode = prev;
    });
    await withLangAsync('tr', () =>
      runImportCommand(
        parseArgs(['import', 'ccline', '--file', bad, '--dry-run']),
        path.join(d, 'c.json'),
        f.io,
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(f.errors).toHaveLength(1);
    expect(
      f.errors[0]!.startsWith(`✗ İçe aktarma başarısız oldu: ${tildify(bad)}:1:7 "]" bekleniyordu`),
    ).toBe(true);
  });
});

describe('CCometixLine themes', () => {
  const NAMES = [
    'cometix',
    'default',
    'minimal',
    'gruvbox',
    'nord',
    'powerline-dark',
    'powerline-light',
    'powerline-rose-pine',
    'powerline-tokyo-night',
  ];
  const themeFile = (home: string, name: string) =>
    path.join(home, '.claude', 'ccline', 'themes', `${name}.toml`);
  const types = new Set(ALL_WIDGETS.map((w) => w.type));

  it('parses -t, --theme and --theme= with quotes', () => {
    expect(parseCclineTheme('ccline -t nord')).toBe('nord');
    expect(parseCclineTheme('"/opt/my tools/ccline" --theme "powerline-dark"')).toBe('powerline-dark');
    expect(parseCclineTheme("ccline --theme='a b'")).toBe('a b');
    expect(parseCclineTheme('ccline --theme=x -t y')).toBe('x');
    expect(parseCclineTheme('ccline -t')).toBeNull();
    expect(parseCclineTheme('ccline --tx nord')).toBeNull();
    expect(parseCclineTheme('ccline')).toBeNull();
  });

  it('carries all nine built-in themes', () => {
    expect(Object.keys(CCLINE_THEMES).sort()).toEqual([...NAMES].sort());
    expect(CCLINE_DEFAULT).toBe(CCLINE_THEMES.default);
    for (const name of NAMES) {
      const r = importCcometixline(CCLINE_THEMES[name as keyof typeof CCLINE_THEMES]);
      const items = r.config.lines![0]!;
      expect(items.map((i) => i.type)).toEqual([
        'model',
        'cwd',
        'git-branch',
        'git-status',
        'context-percentage',
      ]);
      for (const it of items) expect(types.has(it.type), it.type).toBe(true);
      expect(r.config.style === 'powerline', name).toBe(name.startsWith('powerline-'));
      expect(r.config.icons).toBe(name === 'default' || name === 'minimal' ? 'emoji' : 'nerd');
    }
  });

  it('transcribes theme colors, icons and separators', () => {
    const items = (name: keyof typeof CCLINE_THEMES) => {
      const r = importCcometixline(CCLINE_THEMES[name]);
      return { r, items: r.config.lines![0]! };
    };
    const nord = items('nord');
    expect(nord.r.config.separator).toBe('');
    expect(nord.items[0]).toMatchObject({ label: '\ue26d', color: '#2e3440', background: '#88c0d0' });
    const minimal = items('minimal');
    expect(minimal.r.config.separator).toBe(' \u2502 ');
    expect(minimal.items[0]).toMatchObject({ label: '\u273d', color: 'brightCyan' });
    const gruvbox = items('gruvbox');
    expect(gruvbox.items[0]).toMatchObject({ color: 'ansi256:208', bold: true });
    expect(gruvbox.items.find((i) => i.type === 'context-percentage')).toMatchObject({ color: 'magenta' });
    const dark = items('powerline-dark');
    expect(dark.r.config.separator).toBeUndefined();
    expect(dark.items[1]).toMatchObject({ color: '#ffffff', background: '#8b4513' });
    const tokyo = CCLINE_THEMES['powerline-tokyo-night'].segments as Record<string, any>[];
    expect(tokyo.find((s) => s.id === 'session')!.icon.nerd_font).toBe('\u{f1ad3}');
    expect(tokyo.find((s) => s.id === 'usage')!.colors.background).toEqual({ r: 36, g: 40, b: 59 });
  });

  it('imports a theme file named by -t instead of config.toml', () => {
    const home = tmp();
    withHome(home);
    write(homeConfig(home), MINI);
    const file = write(
      themeFile(home, 'mytheme'),
      fs.readFileSync(path.join(FIXTURES, 'ccline-theme.toml'), 'utf8'),
    );
    const r = importFrom('ccometixline', { command: 'ccline -t mytheme' });
    expect(r.file).toBe(file);
    expect(r.config.separator).toBe(' \u00bb ');
    expect(r.config.icons).toBe('emoji');
    expect(r.config.lines).toEqual([
      [
        { id: 'model-model', type: 'model', label: 'M', color: 'ansi256:33', bold: true },
        { id: 'cost-session-cost', type: 'session-cost', label: '$', color: '#e5c07b', background: 'black' },
      ],
    ]);
    expect(r.notes).toEqual([
      {
        kind: 'info',
        text: `CCometixLine theme "mytheme" is set in the status line command, read from ${tildify(file)}`,
      },
    ]);
  });

  it('falls back to the built-in theme when no theme file exists', () => {
    const home = tmp();
    withHome(home);
    write(homeConfig(home), MINI);
    const nord = importFrom('ccometixline', { command: 'ccline --theme nord' });
    expect(nord.file).toBeNull();
    expect(nord.config).toEqual(importCcometixline(CCLINE_THEMES.nord).config);
    expect(nord.notes[0]).toEqual({
      kind: 'info',
      text: 'CCometixLine theme "nord" is set in the status line command, imported its built-in theme',
    });
    const dark = importFrom('ccometixline', { command: 'ccline --theme=powerline-dark' });
    expect(dark.config.style).toBe('powerline');
    fs.mkdirSync(themeFile(home, 'gruvbox'), { recursive: true });
    expect(importFrom('ccometixline', { command: 'ccline -t gruvbox' }).config.lines![0]![0]!.color).toBe(
      'ansi256:208',
    );
  });

  it('imports the default theme for an unknown name', () => {
    const home = tmp();
    withHome(home);
    write(homeConfig(home), MINI);
    const r = importFrom('ccometixline', { command: 'ccline -t unknown' });
    expect(r.file).toBeNull();
    expect(r.config).toEqual(importCcometixline(CCLINE_THEMES.default).config);
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: 'CCometixLine theme "unknown" is set in the status line command but was not found, imported its default theme',
    });
  });

  it('ignores unsafe theme names and reads config.toml', () => {
    const home = tmp();
    withHome(home);
    write(homeConfig(home), MINI);
    write(path.join(home, '.claude', 'x.toml'), MINI.replace(' / ', ' # '));
    for (const [command, name] of [
      ['ccline -t ../../etc/x', '../../etc/x'],
      ['ccline -t ../x', '../x'],
      ['ccline -t ../../x', '../../x'],
      ['ccline -t "a b"', 'a b'],
      ['ccline -t ..', '..'],
      ['ccline -t ""', ''],
      [`ccline -t ${path.join(home, '.claude', 'x')}`, path.join(home, '.claude', 'x')],
    ]) {
      const r = importFrom('ccometixline', { command });
      expect(r.file, command).toBe(homeConfig(home));
      expect(r.config.separator, command).toBe(' / ');
      expect(r.notes, command).toEqual([
        {
          kind: 'info',
          text: `CCometixLine theme "${name}" in the status line command is not a safe theme name and was ignored`,
        },
      ]);
    }
    const r = importFrom('ccometixline', { command: 'ccline -t "\u001b[31mx"' });
    expect(r.notes[0]!.text).not.toMatch(/\u001b/);
  });

  it('lets --file win over the theme flag', () => {
    const home = tmp();
    withHome(home);
    write(themeFile(home, 'mytheme'), fs.readFileSync(path.join(FIXTURES, 'ccline-theme.toml'), 'utf8'));
    const file = path.join(FIXTURES, 'ccometixline.toml');
    const r = importFrom('ccometixline', { file, command: 'ccline -t mytheme' });
    expect(r.file).toBe(file);
    expect(r.config.lines).toEqual([ITEMS]);
    expect(importFrom('ccometixline', { file, command: 'ccline -t nord' }).config.lines).toEqual([ITEMS]);
  });

  it('writes theme notes in Turkish', () => {
    const home = tmp();
    withHome(home);
    const file = write(
      themeFile(home, 'mytheme'),
      fs.readFileSync(path.join(FIXTURES, 'ccline-theme.toml'), 'utf8'),
    );
    withLang('tr', () => {
      const note = (command: string) => importFrom('ccometixline', { command }).notes[0]!.text;
      expect(note('ccline -t mytheme')).toBe(
        `CCometixLine teması "mytheme" durum satırı komutunda seçili, şu dosyadan okundu: ${tildify(file)}`,
      );
      expect(note('ccline -t nord')).toBe(
        'CCometixLine teması "nord" durum satırı komutunda seçili, yerleşik tema içe aktarıldı',
      );
      expect(note('ccline -t yok')).toBe(
        'CCometixLine teması "yok" durum satırı komutunda seçili ama bulunamadı, varsayılan tema içe aktarıldı',
      );
      expect(note('ccline -t ../x')).toBe(
        'durum satırı komutundaki CCometixLine teması "../x" güvenli bir tema adı değil, yok sayıldı',
      );
    });
  });
});
