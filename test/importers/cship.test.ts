import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { PromptIo } from '../../src/commands/io.js';
import { runImportCommand } from '../../src/commands/manage.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';
import { render } from '../../src/core/renderer.js';
import { sampleGit, sampleGsd, samplePayload, sampleTranscript } from '../../src/core/sample.js';
import type { Config } from '../../src/core/types.js';
import { sanitizeImport } from '../../src/importers/confirm.js';
import {
  CSHIP_MODULES,
  importCship,
  parseCshipConfigFlag,
  parseCshipLine,
  STARSHIP_MODULES,
  TARGETS,
  THRESHOLD_TARGETS,
} from '../../src/importers/cship.js';
import { cshipDiscover, detectTool, importFrom, resolveSource, toConfig } from '../../src/importers/index.js';
import { parseToml } from '../../src/importers/toml.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang, withLangAsync } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const fixture = (f: string) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
const NOW = new Date('2026-10-12T12:00:00Z');
const show = (config: Config) =>
  render(
    createContext({
      payload: samplePayload(NOW.getTime()),
      config: { ...config, colorLevel: 0, maxWidth: 120 },
      env: {},
      now: NOW,
      data: { git: sampleGit, gsd: sampleGsd, transcript: () => sampleTranscript(NOW.getTime()) },
    }),
  ).map(stripAnsi);

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cship-'));
  onTestFinished(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

const lines = (cfg: Record<string, unknown>) => importCship(cfg).config.lines!;
const types = (cfg: Record<string, unknown>) => lines(cfg).map((l) => l.map((i) => i.type));

const LINES = [
  [
    { id: 'cship-1', type: 'model', label: '\uf4bc ', color: 'cyan', bold: true },
    { id: 'cship-2', type: 'context-bar', options: { thresholdColors: true, width: 8 }, label: 'ctx ' },
    { id: 'cship-3', type: 'five-hour-usage', options: { thresholdColors: false } },
    { id: 'cship-4', type: 'weekly-usage', options: { thresholdColors: false } },
  ],
  [
    { id: 'cship-5', type: 'cwd', options: { style: 'segments', segments: 3 } },
    { id: 'cship-6', type: 'git-branch' },
    { id: 'cship-7', type: 'git-status' },
    { id: 'cship-8', type: 'flex' },
    { id: 'cship-9', type: 'session-cost', label: '\uf155 ', color: '#e0af68' },
  ],
];

const NOTES = [
  {
    kind: 'approx',
    text: 'cship module "cship.context_bar": warn/critical thresholds and styles became ccinfobar threshold colors (yellow from 50%, red from 80%)',
  },
  {
    kind: 'approx',
    text: 'cship module "cship.usage_limits": five_hour_format not imported, the widget uses its own format',
  },
  { kind: 'approx', text: 'cship fill character "." is shown as spaces' },
];

describe('cship line grammar', () => {
  it('splits variables, literals and styled spans like parse_line', () => {
    expect(parseCshipLine('$cship.model [ | ](fg:#888) $git_branch$fill$cship.cost')).toEqual([
      { kind: 'var', name: 'cship.model' },
      { kind: 'text', text: ' ' },
      { kind: 'span', text: ' | ', style: 'fg:#888' },
      { kind: 'text', text: ' ' },
      { kind: 'var', name: 'git_branch' },
      { kind: 'var', name: 'fill' },
      { kind: 'var', name: 'cship.cost' },
    ]);
  });

  it('keeps an unmatched [ literal and never re-tokenizes span content', () => {
    expect(parseCshipLine('a [b $x')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'text', text: '[' },
      { kind: 'text', text: 'b ' },
      { kind: 'var', name: 'x' },
    ]);
    expect(parseCshipLine('[$cship.model](bold)')).toEqual([
      { kind: 'span', text: '$cship.model', style: 'bold' },
    ]);
    expect(parseCshipLine('[](fg:red)$ x[y](z')).toEqual([
      { kind: 'span', text: '', style: 'fg:red' },
      { kind: 'text', text: ' x' },
      { kind: 'text', text: '[' },
      { kind: 'text', text: 'y](z' },
    ]);
  });

  it('ends a name at whitespace, [ or $', () => {
    expect(parseCshipLine('$a\t$b[c](d)$c$')).toEqual([
      { kind: 'var', name: 'a' },
      { kind: 'text', text: '\t' },
      { kind: 'var', name: 'b' },
      { kind: 'span', text: 'c', style: 'd' },
      { kind: 'var', name: 'c' },
    ]);
  });

  it('reads ${name} only with braces', () => {
    expect(parseCshipLine('${env_var.CLAUDE_MODEL} $x', { braces: true })).toEqual([
      { kind: 'var', name: 'env_var.CLAUDE_MODEL' },
      { kind: 'text', text: ' ' },
      { kind: 'var', name: 'x' },
    ]);
    expect(parseCshipLine('${env_var.CLAUDE_MODEL} $x')).toEqual([
      { kind: 'var', name: '{env_var.CLAUDE_MODEL}' },
      { kind: 'text', text: ' ' },
      { kind: 'var', name: 'x' },
    ]);
    expect(parseCshipLine('${a}${b}[c](d)${}$', { braces: true })).toEqual([
      { kind: 'var', name: 'a' },
      { kind: 'var', name: 'b' },
      { kind: 'span', text: 'c', style: 'd' },
    ]);
    expect(parseCshipLine('${open $x', { braces: true })).toEqual(parseCshipLine('${open $x'));
  });
});

describe('cship mapper', () => {
  it('keeps cship output when the Starship options are off', () => {
    const cfg = parseToml(fixture('cship.toml')).cship as Record<string, unknown>;
    expect(importCship(cfg, {})).toEqual(importCship(cfg));
    const plain = parseToml(fixture('starship.toml')).cship as Record<string, unknown>;
    expect(importCship(plain, { palette: {} })).toEqual(importCship(plain));
  });

  it('maps env_var modules, palettes and glyph spans only when asked', () => {
    const cfg = parseToml(
      [
        'format = "[\ue0b6](fg:base)$directory[\ue0b0](bg:base)${env_var.X}$env_var.Y"',
        '[directory]',
        'style = "fg:base"',
        'format = "[$path]($style)"',
        '[env_var.X]',
        'style = "bg:base"',
        'default = "?"',
        '',
      ].join('\n'),
    );
    const plain = importCship(cfg);
    expect(plain.config.lines!.flat().map((i) => i.type)).toEqual(['text', 'cwd', 'text']);
    const r = importCship(cfg, {
      source: 'claudebar',
      tool: 'demo',
      palette: { base: '#2e3440' },
      braces: true,
      moduleStyles: true,
      dropGlyphs: true,
      envVar: (name) => (name === 'X' ? { uses: [['model']] } : null),
    });
    expect(r.source).toBe('claudebar');
    expect(r.config.lines).toEqual([
      [
        {
          id: 'demo-1',
          type: 'cwd',
          options: { style: 'segments', segments: 3 },
          label: '',
          color: '#2e3440',
        },
        { id: 'demo-2', type: 'model', label: '', background: '#2e3440' },
      ],
    ]);
    expect(r.notes.map((n) => n.text)).toEqual([
      'demo module "env_var.X": default not imported, the widget uses its own format',
      'Starship module "env_var.Y" has no ccinfobar equivalent and was dropped; a command widget running "starship module env_var.Y" could show it (none was created)',
      'demo: 2 powerline glyph spans were dropped; the powerline style draws its own',
    ]);
  });
  it('maps the cship.toml fixture', () => {
    const r = importCship(parseToml(fixture('cship.toml')).cship as Record<string, unknown>);
    expect(r.source).toBe('cship');
    expect(r.config.separator).toBe(' ');
    expect(r.config.lines).toEqual(LINES);
    expect(r.notes).toEqual(NOTES);
  });

  it('maps the wrapper-free fixture to the same result', () => {
    const r = importCship(parseToml(fixture('cship-wrapperless.toml')));
    expect(r.config.lines).toEqual(LINES);
    expect(r.notes).toEqual(NOTES);
  });

  it('renders the fixture with sample data', () => {
    const r = importCship(parseToml(fixture('cship.toml')).cship as Record<string, unknown>);
    const out = show(toConfig(r));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^\uf4bc Opus 5\.5 ctx \S+ 34% 5h 42% 7d 61%$/);
    expect(out[1]!.startsWith('acme-app')).toBe(false);
    expect(out[1]).toMatch(/feat\/statusline .* +\uf155 \$1\.87$/);
  });

  it('lets format win over lines and splits it on $line_break', () => {
    expect(types({ format: '$cship.model$line_break$cship.cost', lines: ['$cship.vim'] })).toEqual([
      ['model'],
      ['session-cost'],
    ]);
    expect(types({ format: '$cship.model$line_break$line_break $fill ' })).toEqual([['model']]);
  });

  it('skips disabled modules silently', () => {
    const r = importCship({ lines: ['$cship.model $cship.cost'], cost: { disabled: true } });
    expect(r.config.lines).toEqual([[{ id: 'cship-1', type: 'model', label: '' }]]);
    expect(r.notes).toEqual([]);
    const sub = importCship({
      lines: ['$cship.cost.total_cost_usd $cship.cost.total_duration'],
      cost: { symbol: 'C', total_cost_usd: { disabled: true }, total_duration_ms: { symbol: 'T' } },
    });
    expect(sub.config.lines).toEqual([[{ id: 'cship-1', type: 'session-duration', label: 'T' }]]);
    expect(types({ lines: ['$cship.cost.total_lines_added $fill'], cost: { disabled: true } })).toEqual([]);
    expect(types({ lines: ['$cship.model $fill $cship.cost'], fill: { disabled: true } })).toEqual([
      ['model', 'session-cost'],
    ]);
  });

  it('maps thresholds to threshold colors only where the widget has them', () => {
    const r = importCship({
      lines: ['$cship.context_window $cship.cost $cship.usage_limits.five_hour'],
      context_window: { style: 'fg:blue', warn_threshold: 60 },
      cost: { style: 'fg:blue', critical_threshold: 5 },
      usage_limits: { style: 'fg:blue' },
    });
    expect(r.config.lines).toEqual([
      [
        { id: 'cship-1', type: 'context-percentage', options: { thresholdColors: true }, label: '' },
        { id: 'cship-2', type: 'session-cost', label: '', color: 'blue' },
        { id: 'cship-3', type: 'five-hour-usage', options: { thresholdColors: false }, color: 'blue' },
      ],
    ]);
    expect(r.notes.map((n) => n.text)).toEqual([
      'cship module "cship.context_window": warn/critical thresholds and styles became ccinfobar threshold colors (yellow from 50%, red from 80%)',
      'cship module "cship.cost": warn/critical thresholds were dropped, the session-cost widget has no threshold colors',
    ]);
    const src = fs.readFileSync(path.join(__dirname, '../../src/importers/cship.ts'), 'utf8');
    expect(src).not.toMatch(/showWhen|hideWhen/);
  });

  it('merges sub-field tables over the module table', () => {
    const r = importCship({
      lines: ['$cship.context_window.used_percentage'],
      context_window: {
        style: 'italic fg:red',
        symbol: 'A',
        used_percentage: { symbol: 'B', style: 'dimmed' },
      },
    });
    expect(r.config.lines).toEqual([
      [
        {
          id: 'cship-1',
          type: 'context-percentage',
          options: { thresholdColors: false },
          label: 'B',
          dim: true,
        },
      ],
    ]);
  });

  it('turns literals into text items, whitespace into the separator and adjacency into merge', () => {
    const r = importCship({
      lines: ['in: $cship.model | [(](dimmed)$cship.cost[)](dimmed)$cship.vim  x  $cship.agent'],
    });
    expect(r.config.separator).toBe(' ');
    expect(r.config.lines).toEqual([
      [
        { id: 'cship-1', type: 'text', options: { text: 'in:' } },
        { id: 'cship-2', type: 'model', label: '' },
        { id: 'cship-3', type: 'text', options: { text: '|' } },
        { id: 'cship-4', type: 'text', options: { text: '(' }, dim: true, merge: true },
        { id: 'cship-5', type: 'session-cost', label: '', merge: true },
        { id: 'cship-6', type: 'text', options: { text: ')' }, dim: true, merge: true },
        { id: 'cship-7', type: 'vim-mode', label: '' },
        { id: 'cship-8', type: 'text', options: { text: 'x' } },
        { id: 'cship-9', type: 'agent-name', label: '' },
      ],
    ]);
    // a name runs until whitespace, [ or $, as in cship
    expect(importCship({ lines: ['($cship.cost)'] }).notes[0]!.text).toContain('"cship.cost)"');
    expect(
      importCship({ lines: ['$cship.model | $cship.cost | $cship.vim $cship.agent'] }).config.separator,
    ).toBe(' ');
    const mixed = importCship({ lines: ['$cship.model  $cship.cost  $cship.vim $cship.agent'] });
    expect(mixed.config.separator).toBe('  ');
    expect(mixed.notes).toContainEqual({
      kind: 'approx',
      text: t('import.note.gapsReplaced', { tool: 'cship', gaps: '" "', separator: '"  "' }),
    });
    const wide = importCship({ lines: ['$cship.model  $cship.cost  $cship.vim     $cship.agent'] });
    expect(wide.notes.map((n) => n.text)).toContain(
      t('import.note.gapsReplaced', {
        tool: 'cship',
        gaps: t('import.spaces', { count: 5 }),
        separator: '"  "',
      }),
    );
    expect(importCship({ lines: ['$cship.model $cship.cost'] }).notes).toEqual([]);
  });

  it('styles spans, keeps $ inside spans literal and drops empty spans', () => {
    const r = importCship({
      lines: ['[](fg:#3d414a bg:#5f6366)[ ](bg:#5f6366)[$cship.model](bold)[ok](fg:#888 blink) $cship.model'],
    });
    expect(r.config.lines).toEqual([
      [
        { id: 'cship-1', type: 'text', options: { text: '$cship.model' }, bold: true, merge: true },
        { id: 'cship-2', type: 'text', options: { text: 'ok' }, color: '#888888' },
        { id: 'cship-3', type: 'model', label: '' },
      ],
    ]);
    expect(r.notes).toEqual([
      {
        kind: 'approx',
        text: 'cship styled text "$cship.model" is shown as written: variables inside [ ] are not expanded',
      },
      { kind: 'approx', text: 'cship style of "[ok]": blink not supported, ignored' },
      {
        kind: 'approx',
        text: 'cship: 2 styled spans without visible text (powerline transitions) were dropped',
      },
    ]);
  });

  it('drops account, unknown modules and Starship modules without a widget, never as commands', () => {
    const r = importCship({
      lines: ['$cship.account $cship.nope $battery $starship_prompt $cship.context_window.exceeds_200k'],
    });
    expect(r.config.lines).toEqual([]);
    expect(r.notes).toEqual([
      { kind: 'drop', text: 'cship module "cship.account" has no ccinfobar equivalent and was skipped' },
      { kind: 'drop', text: 'cship module "cship.nope" has no ccinfobar equivalent and was skipped' },
      {
        kind: 'drop',
        text: 'Starship module "battery" has no ccinfobar equivalent and was dropped; a command widget running "starship module battery" could show it (none was created)',
      },
      {
        kind: 'drop',
        text: 'cship $starship_prompt was dropped: ccinfobar does not run Starship; a command widget running "starship prompt" could show it (none was created)',
      },
      {
        kind: 'drop',
        text: 'cship module "cship.context_window.exceeds_200k" has no ccinfobar equivalent and was skipped',
      },
    ]);
    expect(JSON.stringify(r.config)).not.toContain('command');
  });

  it('maps the Starship modules natively', () => {
    const line = Object.keys(STARSHIP_MODULES)
      .map((k) => `$${k}`)
      .join(' ');
    expect(types({ lines: [line] })).toEqual([Object.values(STARSHIP_MODULES).map((u) => u[0])]);
  });

  it('notes approximated modules and ignored options', () => {
    const r = importCship({
      lines: ['$cship.context_window.remaining_percentage $cship.cost $cship.usage_limits.opus'],
      cost: { currency_symbol: '€', conversion_rate: 0.9, format: '[$value]($style)' },
    });
    expect(r.config.lines![0]![2]).toEqual({
      id: 'cship-3',
      type: 'weekly-model-usage',
      options: { model: 'Opus', thresholdColors: false },
    });
    expect(r.notes.map((n) => n.text)).toEqual([
      'cship module "cship.context_window.remaining_percentage" is approximated by the context-percentage widget',
      'cship module "cship.cost": currency_symbol, conversion_rate, format not imported, the widget uses its own format',
    ]);
  });

  it('maps every cship module and only emits listed targets that exist', () => {
    const all = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(all.has(type), type).toBe(true);
    for (const type of TARGETS) {
      const has = ALL_WIDGETS.find((w) => w.type === type)!.options?.some((o) => o.key === 'thresholdColors');
      expect(!!has, type).toBe(THRESHOLD_TARGETS.includes(type));
    }
    const names = Object.keys(CSHIP_MODULES).filter((k) => CSHIP_MODULES[k]);
    const r = importCship({ lines: [names.map((n) => `$${n}`).join(' '), '$fill [x](bold)'] });
    const emitted = new Set(r.config.lines!.flat().map((i) => i.type));
    for (const type of emitted) expect(TARGETS).toContain(type);
  });

  it('sanitizes names in notes', () => {
    const r = importCship({ lines: ['$cship.\u001b[31mx $evil\u202e'] });
    for (const n of r.notes) expect(n.text).not.toMatch(/[\u001b\u202e]/);
  });

  it('writes notes in Turkish', () => {
    withLang('tr', () => {
      const r = importCship({
        lines: ['$cship.account $battery [](fg:red) $cship.cost $fill'],
        cost: { warn_threshold: 1 },
      });
      expect(r.notes.map((n) => n.text)).toEqual([
        'cship modülü "cship.account" için ccinfobar karşılığı yok, atlandı',
        'Starship modülü "battery" için ccinfobar karşılığı yok, atlandı; "starship module battery" çalıştıran bir command bileşeni bunu gösterebilir (oluşturulmadı)',
        'cship modülü "cship.cost": uyarı/kritik eşikleri atlandı, session-cost bileşeninin eşik renkleri yok',
        'cship dolgu karakteri "." boşluk olarak gösterilir',
        'cship: görünür metni olmayan 1 stilli parça (powerline geçişi) atlandı',
      ]);
    });
  });
});

const ANCESTOR_FILES = ['cship.toml', 'starship.toml'];

// the walk goes to the root; skip when a real ancestor holds a config
function cleanAncestors(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (ANCESTOR_FILES.some((f) => fs.existsSync(path.join(d, f)))) return false;
    if (path.dirname(d) === d) return true;
  }
}

const MINI = '[cship]\nlines = ["$cship.model"]\n';

describe('cship discovery', () => {
  it('walks up from the cwd to the nearest cship.toml', () => {
    const root = tmp();
    const file = write(path.join(root, 'a', 'cship.toml'), MINI);
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    expect(cshipDiscover({ command: 'cship', cwd: path.join(root, 'a', 'b'), env: {} })).toEqual({
      file,
      table: 'wrapper-or-root',
      note: null,
    });
  });

  it('stops at the first starship.toml even without a [cship] table', () => {
    const root = tmp();
    write(path.join(root, 'cship.toml'), MINI);
    const starship = write(path.join(root, 'a', 'starship.toml'), 'format = "$all"\n');
    const cwd = path.join(root, 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    expect(cshipDiscover({ command: '', cwd, env: {} })).toEqual({
      file: starship,
      table: 'cship-only',
      note: null,
    });
    expect(() => importFrom('cship', { cwd, env: {} })).toThrow(
      `cship config has no lines (${tildify(starship)})`,
    );
  });

  it('prefers cship.toml over starship.toml in the same dir and ignores dirs', () => {
    const root = tmp();
    write(path.join(root, 'starship.toml'), '[cship]\nlines = ["$cship.cost"]\n');
    const own = write(path.join(root, 'cship.toml'), MINI);
    expect(cshipDiscover({ command: '', cwd: root, env: {} })?.file).toBe(own);
    const other = tmp();
    fs.mkdirSync(path.join(other, 'cship.toml'));
    const starship = write(path.join(other, 'starship.toml'), '[cship]\nlines = ["$cship.cost"]\n');
    expect(cshipDiscover({ command: '', cwd: other, env: {} })?.file).toBe(starship);
  });

  it('stops the walk at home when the cwd is under it', () => {
    const root = tmp();
    const above = write(path.join(root, 'cship.toml'), MINI);
    const home = path.join(root, 'home');
    const cwd = path.join(home, 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    expect(cshipDiscover({ command: '', cwd, env: { HOME: home } })).toBeNull();
    const own = write(path.join(home, 'cship.toml'), MINI);
    expect(cshipDiscover({ command: '', cwd, env: { HOME: home } })?.file).toBe(own);
    fs.rmSync(own);
    expect(cshipDiscover({ command: '', cwd, env: { HOME: path.join(root, 'elsewhere') } })?.file).toBe(
      above,
    );
    expect(cshipDiscover({ command: '', cwd, env: {} })?.file).toBe(above);
  });

  it('falls back to home .config with CLAUDE_HOME, HOME, then USERPROFILE', (ctx) => {
    const cwd = tmp();
    if (!cleanAncestors(cwd)) ctx.skip();
    const [a, b, c] = [tmp(), tmp(), tmp()];
    const ownA = write(path.join(a, '.config', 'cship.toml'), MINI);
    const starB = write(path.join(b, '.config', 'starship.toml'), fixture('starship.toml'));
    write(path.join(c, '.config', 'cship.toml'), MINI);
    const find = (env: NodeJS.ProcessEnv) => cshipDiscover({ command: '', cwd, env })?.file;
    expect(find({ CLAUDE_HOME: a, HOME: b, USERPROFILE: c })).toBe(ownA);
    expect(find({ CLAUDE_HOME: '', HOME: b, USERPROFILE: c })).toBe(starB);
    expect(find({ USERPROFILE: c })).toBe(path.join(c, '.config', 'cship.toml'));
    expect(find({ HOME: tmp() })).toBeUndefined();
    const both = tmp();
    write(path.join(both, '.config', 'starship.toml'), '[cship]\nlines = ["$cship.cost"]\n');
    const own = write(path.join(both, '.config', 'cship.toml'), MINI);
    expect(find({ HOME: both })).toBe(own);
  });

  it('reads the [cship] table of the home starship.toml', (ctx) => {
    const cwd = tmp();
    if (!cleanAncestors(cwd)) ctx.skip();
    const home = tmp();
    const file = write(path.join(home, '.config', 'starship.toml'), fixture('starship.toml'));
    const r = importFrom('cship', { cwd, env: { HOME: home } });
    expect(r.file).toBe(file);
    expect(r.config.lines).toEqual([
      [
        { id: 'cship-1', type: 'model', label: '' },
        { id: 'cship-2', type: 'text', options: { text: '|' }, color: '#888888' },
        { id: 'cship-3', type: 'session-cost', label: '$' },
      ],
      [
        { id: 'cship-4', type: 'git-branch' },
        { id: 'cship-5', type: 'context-percentage', options: { thresholdColors: false }, label: '' },
      ],
    ]);
    expect(r.notes.map((n) => n.kind)).toEqual(['approx']);
  });

  it('uses $STARSHIP_CONFIG only as a last fallback, with a note', (ctx) => {
    const cwd = tmp();
    if (!cleanAncestors(cwd)) ctx.skip();
    const file = write(path.join(tmp(), 'custom.toml'), fixture('starship.toml'));
    const empty = tmp();
    expect(cshipDiscover({ command: '', cwd, env: { HOME: empty, STARSHIP_CONFIG: file } })).toEqual({
      file,
      table: 'cship-only',
      note: 'starship-config',
    });
    const r = importFrom('cship', { cwd, env: { HOME: empty, STARSHIP_CONFIG: file } });
    expect(r.notes[0]).toEqual({
      kind: 'info',
      text: `read the cship config from $STARSHIP_CONFIG: ${tildify(file)} (cship itself only uses it for Starship modules)`,
    });
    const home = tmp();
    const own = write(path.join(home, '.config', 'cship.toml'), MINI);
    expect(cshipDiscover({ command: '', cwd, env: { HOME: home, STARSHIP_CONFIG: file } })?.file).toBe(own);
    expect(cshipDiscover({ command: '', cwd, env: { HOME: empty, STARSHIP_CONFIG: 'rel.toml' } })).toBeNull();
  });

  it('reads --config from the status line command', () => {
    const d = tmp();
    const custom = write(path.join(d, 'custom.toml'), `${MINI}[cship.model]\nsymbol = "M"\n`);
    const own = write(path.join(d, 'x', 'cship.toml'), 'lines = ["$cship.cost"]\n');
    expect(parseCshipConfigFlag(`cship --config "${custom}"`)).toBe(custom);
    expect(parseCshipConfigFlag(`cship --config=${custom}`)).toBe(custom);
    expect(parseCshipConfigFlag('cship -c x.toml')).toBeNull();
    expect(parseCshipConfigFlag('cship --config')).toBeNull();
    const cwd = tmp();
    expect(cshipDiscover({ command: `cship --config '${custom}'`, cwd, env: {} })).toEqual({
      file: custom,
      table: 'cship-only',
      note: null,
    });
    expect(importFrom('cship', { command: `cship --config=${custom}`, cwd, env: {} }).config.lines).toEqual([
      [{ id: 'cship-1', type: 'model', label: 'M' }],
    ]);
    const wrapperFree = importFrom('cship', { command: `cship --config "${own}"`, cwd, env: {} });
    expect(wrapperFree.config.lines).toEqual([[{ id: 'cship-1', type: 'session-cost', label: '' }]]);
    expect(wrapperFree.file).toBe(own);
    const rel = importFrom('cship', { command: 'cship --config custom.toml', cwd: d, env: {} });
    expect(rel.file).toBe(custom);
  });

  it('reads a custom --config file only for its [cship] table', () => {
    const d = tmp();
    const custom = write(path.join(d, 'custom.toml'), 'lines = ["$cship.cost"]\n');
    expect(() => importFrom('cship', { command: `cship --config ${custom}`, cwd: d, env: {} })).toThrow(
      'cship config has no lines',
    );
  });

  it('lets --file win and picks the table by file name', () => {
    const d = tmp();
    const own = write(path.join(d, 'cship.toml'), fixture('cship-wrapperless.toml'));
    const other = write(path.join(d, 'other.toml'), fixture('cship.toml'));
    const cwd = tmp();
    write(path.join(cwd, 'cship.toml'), 'lines = ["$cship.vim"]\n');
    expect(importFrom('cship', { file: own, cwd, env: {} }).config.lines).toEqual(LINES);
    expect(importFrom('cship', { file: other, cwd, env: {} }).config.lines).toEqual(LINES);
    expect(() => importFrom('cship', { file: path.join(d, 'cship-wrapperless.toml'), cwd, env: {} })).toThrow(
      'Cannot read cship config at',
    );
  });

  it('fails when no config exists', (ctx) => {
    const cwd = tmp();
    if (!cleanAncestors(cwd)) ctx.skip();
    expect(cshipDiscover({ command: 'cship', cwd, env: { HOME: tmp() } })).toBeNull();
    expect(() => importFrom('cship', { command: 'cship', cwd, env: { HOME: tmp() } })).toThrow(
      'no cship config found',
    );
  });

  it('reports TOML errors with file, line and column', () => {
    const d = tmp();
    const file = write(path.join(d, 'cship.toml'), '[cship]\nmodel = { a = 1,}\n');
    expect(() => importFrom('cship', { cwd: d, env: {} })).toThrow(
      new RegExp(`^${tildify(file).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}:2:\\d+ .*TOML 1\\.1`),
    );
  });

  it('detects cship in the status line command', () => {
    expect(resolveSource('cship')).toBe('cship');
    expect(detectTool('cship')).toMatchObject({ tool: 'cship', name: 'cship', importable: true });
    expect(detectTool('/usr/local/bin/cship --config x')).toMatchObject({ tool: 'cship', importable: true });
    expect(detectTool('C:\\tools\\cship.exe')).toMatchObject({ tool: 'cship' });
    expect(detectTool('relationship-tool')?.tool).not.toBe('cship');
    expect(detectTool('cshipper')?.tool).not.toBe('cship');
  });

  it('keeps imported text through sanitizeImport', () => {
    const r = sanitizeImport(importCship({ lines: ['[\u001b]8;;x\u0007hi](bold) $cship.model'] }));
    expect(JSON.stringify(r.config)).not.toMatch(/[\u001b\u0007]/);
  });
});

describe('import cship', () => {
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

  it('exits 1 when no cship config is found', async (ctx) => {
    const cwd = tmp();
    if (!cleanAncestors(cwd)) ctx.skip();
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    keepExit();
    const f = fake();
    await runImportCommand(parseArgs(['import', 'cship', '--dry-run']), path.join(tmp(), 'c.json'), f.io);
    expect(process.exitCode).toBe(1);
    expect(f.errors).toEqual(['✗ Import failed: no cship config found']);
  });

  it('imports a walked-up cship.toml with a dry run', async () => {
    const root = tmp();
    const file = write(path.join(root, 'cship.toml'), fixture('cship.toml'));
    const cwd = path.join(root, 'sub');
    fs.mkdirSync(cwd);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    keepExit();
    const f = fake();
    const cfg = path.join(tmp(), 'c.json');
    await runImportCommand(parseArgs(['import', 'cship', '--dry-run']), cfg, f.io);
    expect(process.exitCode ?? 0).toBe(0);
    expect(f.errors).toEqual([]);
    expect(f.out[0]).toBe(`✓ Imported 9 widgets from cship (${tildify(file)})`);
    expect(f.out.at(-1)).toBe('Dry run: nothing was written.');
    expect(fs.existsSync(cfg)).toBe(false);
  });

  it('prints the failure in Turkish', async () => {
    const d = tmp();
    const file = write(path.join(d, 'starship.toml'), 'format = "$all"\n');
    keepExit();
    const f = fake();
    await withLangAsync('tr', () =>
      runImportCommand(
        parseArgs(['import', 'cship', '--file', file, '--dry-run']),
        path.join(d, 'c.json'),
        f.io,
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(f.errors).toEqual([
      `✗ İçe aktarma başarısız oldu: cship yapılandırmasında satır yok (${tildify(file)})`,
    ]);
  });
});
