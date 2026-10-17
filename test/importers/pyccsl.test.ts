import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandArgs } from '../../src/importers/args.js';
import { detectTool, importFrom } from '../../src/importers/index.js';
import { importPyccsl, pyccslCommand, TARGETS } from '../../src/importers/pyccsl.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const FIXTURES = path.join(__dirname, '../fixtures/import');
const ENV_FIXTURE = path.join(FIXTURES, 'pyccsl.env');

type R = ReturnType<typeof importPyccsl>;
const types = (r: R) => r.config.lines!.flat().map((i) => i.type);
const item = (r: R, type: string) => r.config.lines!.flat().find((i) => i.type === type);
const texts = (r: R) => r.notes.map((n) => n.text);
const fromCommand = (command: string, env: Record<string, string> = {}) =>
  importPyccsl({ ...pyccslCommand(commandArgs(command)), env });

describe('importPyccsl', () => {
  it('maps the fields, theme, style and --no-emoji from the command', () => {
    const r = fromCommand(
      'python3 ~/.claude/pyccsl.py badge,model,cost --theme nord --style powerline --no-emoji',
    );
    expect(r.source).toBe('pyccsl');
    expect(types(r)).toEqual(['performance', 'model', 'session-cost']);
    expect(item(r, 'performance')!.options).toEqual({ display: 'badge', hitWarn: 95, timeWarn: 10 });
    expect(item(r, 'performance')!.id).toBe('pyccsl-badge-performance');
    expect(r.config).toMatchObject({ theme: 'nord', style: 'powerline', icons: 'text' });
    expect(r.config.separator).toBeUndefined();
    expect(r.config.colorLevel).toBeUndefined();
    expect(r.notes).toEqual([
      { kind: 'approx', text: 'pyccsl "badge" is approximated by the performance widget' },
    ]);
  });

  it('uses the six default fields when none are given', () => {
    const r = fromCommand('python3 ~/.claude/pyccsl.py');
    expect(types(r)).toEqual([
      'performance',
      'cwd',
      'git-branch',
      'git-status',
      'model',
      'context-length',
      'session-cost',
    ]);
    expect(item(r, 'git-status')!.options).toEqual({ counts: false });
    expect(r.config).toMatchObject({ theme: 'classic', style: 'text', separator: ' > ' });
    expect(r.config.icons).toBeUndefined();
    expect(types(fromCommand('pyccsl.py " , "'))).toHaveLength(7);
  });

  it('expands perf-all-metrics and keeps pyccsl field order', () => {
    const r = fromCommand('pyccsl cost,perf-all-metrics,input,output,folder');
    expect(types(r)).toEqual([
      'cwd',
      'cache-hit-rate',
      'performance',
      'session-duration',
      'message-count',
      'tokens-input',
      'tokens-output',
      'session-cost',
    ]);
    expect(item(r, 'performance')!.options).toEqual({ show: 'time' });
    const each = fromCommand(
      'pyccsl perf-cache-rate,perf-response-time,perf-session-time,perf-message-count',
    );
    expect(types(each)).toEqual(['cache-hit-rate', 'performance', 'session-duration', 'message-count']);
    expect(r.notes).toEqual([]);
  });

  it('maps every theme and separator style', () => {
    const themes: Record<string, string> = {
      default: 'classic',
      solarized: 'solarized',
      nord: 'nord',
      dracula: 'dracula',
      gruvbox: 'gruvbox',
      tokyo: 'tokyo-night',
      catppuccin: 'catppuccin',
      minimal: 'minimal',
    };
    for (const [name, theme] of Object.entries(themes)) {
      const r = fromCommand(`pyccsl.py model --theme ${name}`);
      expect(r.config.theme, name).toBe(theme);
      expect(r.config.colorLevel, name).toBeUndefined();
      expect(r.notes, name).toEqual([]);
    }
    const seps: Record<string, string> = { simple: ' > ', arrows: ' → ', pipes: ' | ', dots: ' · ' };
    for (const [name, separator] of Object.entries(seps)) {
      expect(fromCommand(`pyccsl.py model --style=${name}`).config, name).toMatchObject({
        style: 'text',
        separator,
      });
    }
  });

  it('turns theme none into mono without colors, and powerline into its plain separator', () => {
    const r = fromCommand('pyccsl.py model --theme none --style powerline');
    expect(r.config).toMatchObject({ theme: 'mono', colorLevel: 0, style: 'text', separator: ' > ' });
    expect(r.notes).toEqual([]);
  });

  it('falls back for an unknown theme or style and drops unknown fields', () => {
    const r = fromCommand('pyccsl.py model,constructor,__proto__,model', {
      PYCCSL_THEME: 'neon-x',
      PYCCSL_STYLE: 'zigzag',
    });
    expect(types(r)).toEqual(['model']);
    expect(r.config).toMatchObject({ theme: 'classic', style: 'text', separator: ' > ' });
    expect(r.notes).toEqual([
      { kind: 'drop', text: 'pyccsl segment "constructor" has no ccinfobar equivalent and was skipped' },
      { kind: 'drop', text: 'pyccsl segment "__proto__" has no ccinfobar equivalent and was skipped' },
      { kind: 'info', text: 'pyccsl theme "neon-x" has no ccinfobar equivalent, used the classic theme' },
      { kind: 'info', text: 'pyccsl style "zigzag" is unknown, imported its default style (simple)' },
    ]);
  });

  it('notes --numbers and explicit badge thresholds', () => {
    const r = fromCommand('pyccsl.py badge --numbers full --perf-response 30,60,90');
    expect(item(r, 'performance')!.options).toEqual({ display: 'badge', hitWarn: 95, timeWarn: 30 });
    expect(texts(r)).toEqual([
      'pyccsl "badge" is approximated by the performance widget',
      'pyccsl performance thresholds became the badge warnings from their first values (hit rate below 95%, time above 30s)',
      'pyccsl number format "full" was not imported, ccinfobar shows compact numbers',
    ]);
    expect(r.notes.map((n) => n.kind)).toEqual(['approx', 'approx', 'info']);
    expect(texts(fromCommand('pyccsl.py model --perf-cache 50,40,30'))).toEqual([]);
  });

  it('lets env keys override flags, as pyccsl does', () => {
    const r = fromCommand('pyccsl.py model --theme nord --no-emoji --perf-cache 80,70,60', {
      PYCCSL_THEME: 'gruvbox',
      PYCCSL_NO_EMOJI: 'False',
      PYCCSL_FIELDS: 'badge,cost',
      PYCCSL_PERF_CACHE: 'x',
    });
    expect(types(r)).toEqual(['performance', 'session-cost']);
    expect(item(r, 'performance')!.options).toMatchObject({ hitWarn: 95 });
    expect(r.config.theme).toBe('gruvbox');
    expect(r.config.icons).toBeUndefined();
    expect(fromCommand('pyccsl.py model', { PYCCSL_NO_EMOJI: 'TRUE' }).config.icons).toBe('text');
    expect(types(fromCommand('pyccsl.py model', { PYCCSL_FIELDS: '' }))).toHaveLength(7);
  });

  it('only reads args after the pyccsl script', () => {
    expect(pyccslCommand(commandArgs('python3 --theme x other.py model'))).toEqual({
      fields: null,
      flags: {},
    });
    const c = pyccslCommand(
      commandArgs('python C:\\Users\\me\\.claude\\pyccsl.py --env=C:\\x.env --debug "model, cost" extra'),
    );
    expect(c.fields).toEqual(['model', 'cost']);
    expect({ ...c.flags }).toEqual({ env: 'C:\\x.env', debug: true });
    expect(Object.getPrototypeOf(c.flags)).toBeNull();
  });

  it('lists only existing widgets as targets', () => {
    const known = new Set(ALL_WIDGETS.map((w) => w.type));
    for (const type of TARGETS) expect(known.has(type), type).toBe(true);
  });

  it('writes its notes in Turkish', () => {
    withLang('tr', () => {
      const r = fromCommand('pyccsl.py badge --numbers raw --perf-cache 60,40,20');
      expect(texts(r)).toEqual([
        'pyccsl "badge", performance bileşeniyle yaklaşık olarak gösteriliyor',
        'pyccsl performans eşikleri ilk değerleriyle rozet uyarılarına dönüştürüldü (isabet oranı %60 altında, süre 10 saniyenin üstünde)',
        'pyccsl sayı biçimi "raw" içe aktarılmadı, ccinfobar sayıları kısa biçimde gösterir',
      ]);
    });
  });
});

describe('pyccsl importer', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-pyccsl-')));
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    env = { HOME: home, USERPROFILE: home, PYCCSL_FIELDS: 'cost', PYCCSL_THEME: 'tokyo' };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the --env file, where PYCCSL_* keys win over flags', () => {
    fs.copyFileSync(ENV_FIXTURE, path.join(env.HOME!, '.claude', 'pyccsl.env'));
    const r = importFrom('pyccsl', {
      command: 'python3 ~/.claude/pyccsl.py model,cost --theme nord --env ~/.claude/pyccsl.env',
      env,
      cwd: dir,
    });
    expect(r.file).toBe(path.join(env.HOME!, '.claude', 'pyccsl.env'));
    expect(types(r)).toEqual(['performance', 'cwd', 'git-branch', 'git-status', 'model']);
    expect(item(r, 'performance')!.options).toEqual({ display: 'badge', hitWarn: 60, timeWarn: 10 });
    expect(r.config).toMatchObject({ theme: 'dracula', style: 'text', separator: ' | ' });
    expect(r.config.icons).toBeUndefined();
    expect(r.notes).toEqual([
      { kind: 'approx', text: 'pyccsl "badge" is approximated by the performance widget' },
      {
        kind: 'approx',
        text: 'pyccsl performance thresholds became the badge warnings from their first values (hit rate below 60%, time above 10s)',
      },
      {
        kind: 'drop',
        text: 'pyccsl: line 27 is not a plain assignment and was skipped; nothing in the file is run',
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('vim');
  });

  it('resolves a relative --env against the cwd and reads --file instead', () => {
    fs.writeFileSync(path.join(dir, 'rel.env'), 'PYCCSL_FIELDS=output\r\n');
    const other = path.join(dir, 'x.env');
    fs.writeFileSync(other, 'PYCCSL_FIELDS=input\n. ./themes.sh\nif true; then\n');
    const command = 'pyccsl.py model --env rel.env';
    expect(types(importFrom('pyccsl', { command, env, cwd: dir }))).toEqual(['tokens-output']);
    const r = importFrom('pyccsl', { command, file: other, env, cwd: dir });
    expect(r.file).toBe(other);
    expect(types(r)).toEqual(['tokens-input']);
    expect(texts(r)).toEqual([
      'pyccsl: lines 2, 3 are not plain assignments and were skipped; nothing in the file is run',
    ]);
  });

  it('imports the flags alone without an env file, never the process env', () => {
    for (const command of [
      'pyccsl.py model --theme nord',
      'pyccsl.py model --theme nord --env missing.env',
    ]) {
      const r = importFrom('pyccsl', { command, env, cwd: dir });
      expect(r.file, command).toBeNull();
      expect(types(r), command).toEqual(['model']);
      expect(r.config.theme, command).toBe('nord');
      expect(r.notes, command).toEqual([]);
    }
    expect(types(importFrom('pyccsl', { env, cwd: dir }))).toHaveLength(7);
  });

  it('reports an unreadable env file with the tilde path', () => {
    const file = path.join(env.HOME!, '.claude', 'dir.env');
    fs.mkdirSync(file);
    expect(() => importFrom('pyccsl', { file, env, cwd: dir })).toThrow(
      `Cannot read pyccsl config at ${path.join('~', '.claude', 'dir.env')}`,
    );
  });

  it('is detected from its status line command', () => {
    expect(detectTool('python3 ~/.claude/pyccsl.py model,cost')).toMatchObject({
      tool: 'pyccsl',
      name: 'pyccsl',
      importable: true,
    });
    expect(detectTool('python3 ~/.claude/pyccsl.py --env ~/.claude/pyccsl.env')?.tool).toBe('pyccsl');
    expect(detectTool('python3 ~/.claude/other.py')?.tool).toBe('unknown');
  });
});
