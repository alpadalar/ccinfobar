import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { main } from '../../src/cli/main.js';
import { runConfig } from '../../src/commands/config-cmd.js';
import { describeRuleError, validateRule } from '../../src/core/conditions.js';
import { defaultConfig, inspectConfigText } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';
import { withLang } from '../helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cfgcmd-'));

const SAMPLE = { theme: 'nord', lines: [[{ id: 'm', type: 'model' }]] };

function withFile(data: unknown = SAMPLE): string {
  const file = path.join(tmp(), 'config.json');
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

function run(argv: string[], file: string) {
  const out: string[] = [];
  const err: string[] = [];
  const args = parseArgs(['config', ...argv]);
  const cfgFile = typeof args.flags.config === 'string' ? path.resolve(args.flags.config) : file;
  runConfig(args, cfgFile, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { out, err, code: process.exitCode ?? 0 };
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('config get', () => {
  it('prints strings raw', () => {
    const r = run(['get', 'theme'], withFile());
    expect(r).toEqual({ out: ['nord'], err: [], code: 0 });
  });

  it('prints other values as pretty JSON', () => {
    const r = run(['get', 'lines.0.0'], withFile());
    expect(r.out).toEqual([JSON.stringify({ id: 'm', type: 'model' }, null, 2)]);
    expect(run(['get', 'autoWrap'], withFile()).out).toEqual(['true']);
  });

  it('exits 1 on a missing path', () => {
    const r = run(['get', 'nope'], withFile());
    expect(r).toEqual({ out: [], err: [t('cfg.missing', { path: 'nope' })], code: 1 });
  });

  it('shows the effective default without a config file', () => {
    const file = path.join(tmp(), 'config.json');
    const r = run(['get', 'theme'], file);
    expect(r.out).toEqual([defaultConfig().theme]);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('config set', () => {
  it('parses JSON values', () => {
    const file = withFile();
    expect(run(['set', 'padding', '2'], file)).toEqual({
      out: [t('cfg.set', { path: 'padding' })],
      err: [],
      code: 0,
    });
    expect(read(file).padding).toBe(2);
    run(['set', 'gitHardening', 'false'], file);
    expect(read(file).gitHardening).toBe(false);
  });

  it('falls back to a plain string', () => {
    const file = withFile();
    run(['set', 'theme', 'dracula'], file);
    expect(read(file).theme).toBe('dracula');
  });

  it('accepts quoted JSON strings in nested paths', () => {
    const file = withFile();
    expect(run(['set', 'lines.0.0.color', '"red"'], file).code).toBe(0);
    expect(read(file).lines[0][0]).toEqual({ id: 'm', type: 'model', color: 'red' });
  });

  it('keeps the effective config when creating the file', () => {
    const file = path.join(tmp(), 'config.json');
    run(['get', 'lines'], file);
    const before = run(['get', 'lines'], file).out;
    expect(run(['set', 'padding', '1'], file).code).toBe(0);
    expect(read(file).padding).toBe(1);
    expect(run(['get', 'lines'], file).out).toEqual(before);
  });

  it('refuses values that do not survive validation', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    for (const argv of [
      ['set', 'unknownTopKey', '1'],
      ['set', 'padding', '"wide"'],
      ['set', 'padding', '2.5'],
    ]) {
      const r = run(argv, file);
      expect(r.err).toEqual([t('cfg.rejected', { path: argv[1]! })]);
      expect(r.code).toBe(1);
      process.exitCode = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('passes negative numbers as values', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    expect(run(['set', 'padding', '-1'], file).err).toEqual([t('cfg.rejected', { path: 'padding' })]);
    process.exitCode = undefined;
    expect(run(['set', 'padding', '--', '-1'], file).err).toEqual([t('cfg.rejected', { path: 'padding' })]);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('rejects prototype segments without writing', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    const r = run(['set', '__proto__.x', '1'], file);
    expect(r.err).toEqual([t('cfg.protoSegment', { segment: '__proto__' })]);
    expect(r.code).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('rejects malformed paths', () => {
    const r = run(['set', 'a..b', '1'], withFile());
    expect(r.err).toEqual([t('cfg.badPath', { path: 'a..b' })]);
    expect(r.code).toBe(1);
    process.exitCode = undefined;
    expect(run(['set', 'lines.5.0', '1'], withFile()).err).toEqual([t('cfg.badPath', { path: 'lines.5.0' })]);
  });

  it('targets the --config file', () => {
    const file = withFile();
    const other = withFile({ theme: 'nord' });
    run(['set', 'padding', '3', '--config', other], file);
    expect(read(other).padding).toBe(3);
    expect(read(file).padding).toBeUndefined();
  });
});

describe('config unset', () => {
  it('removes an array element', () => {
    const file = withFile({
      lines: [
        [
          { id: 'a', type: 'model' },
          { id: 'b', type: 'cwd' },
        ],
      ],
    });
    expect(run(['unset', 'lines.0.0'], file)).toEqual({
      out: [t('cfg.unset', { path: 'lines.0.0' })],
      err: [],
      code: 0,
    });
    expect(read(file).lines).toEqual([[{ id: 'b', type: 'cwd' }]]);
  });

  it('reports when a default comes back', () => {
    const file = withFile({ ...SAMPLE, padding: 3, widthOffset: 3 });
    expect(run(['unset', 'widthOffset'], file).out).toEqual([
      t('cfg.resetDefault', { path: 'widthOffset', value: '10' }),
    ]);
    expect(read(file).widthOffset).toBe(10);
    expect(run(['unset', 'theme'], file).out).toEqual([
      t('cfg.resetDefault', { path: 'theme', value: JSON.stringify(defaultConfig().theme) }),
    ]);
    expect(run(['unset', 'padding'], file).out).toEqual([t('cfg.unset', { path: 'padding' })]);
    expect(read(file).padding).toBeUndefined();
  });

  it('exits 1 when the path is not set', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    const r = run(['unset', 'padding'], file);
    expect(r).toEqual({ out: [], err: [t('cfg.missing', { path: 'padding' })], code: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
});

describe('config budget', () => {
  it('sets, gets and unsets budget amounts', () => {
    const file = withFile();
    expect(run(['set', 'budget.daily', '10'], file)).toEqual({
      out: [t('cfg.set', { path: 'budget.daily' })],
      err: [],
      code: 0,
    });
    expect(read(file).budget).toEqual({ daily: 10 });
    run(['set', 'budget.warnAt', '0.9'], file);
    expect(read(file).budget).toEqual({ daily: 10, warnAt: 0.9 });
    expect(run(['get', 'budget.daily'], file).out).toEqual(['10']);
    expect(run(['unset', 'budget.daily'], file).out).toEqual([t('cfg.unset', { path: 'budget.daily' })]);
    expect(read(file).budget).toEqual({ warnAt: 0.9 });
    run(['unset', 'budget.warnAt'], file);
    expect(read(file).budget).toBeUndefined();
  });

  it('rejects invalid budget values without writing', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    for (const argv of [
      ['set', 'budget.daily', '--', '-3'],
      ['set', 'budget.daily', '0'],
      ['set', 'budget.session', '"ten"'],
      ['set', 'budget.warnAt', '2'],
      ['set', 'budget.weekly', '50'],
    ]) {
      const r = run(argv, file);
      expect(r.err).toEqual([t('cfg.rejected', { path: argv[1]! })]);
      expect(r.code).toBe(1);
      process.exitCode = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
});

describe('config profiles', () => {
  it('sets, gets and unsets profiles', () => {
    const file = withFile();
    expect(run(['set', 'profiles.builtIn', 'false'], file).code).toBe(0);
    expect(read(file).profiles).toEqual({ builtIn: false });
    run(['set', 'profiles.builtIn', 'true'], file);
    expect(read(file).profiles).toEqual({ builtIn: true });
    run(['set', 'profiles.builtIn', 'false'], file);
    const models = '[{"match":"glm-*","contextWindow":500000}]';
    expect(run(['set', 'profiles.models', models], file)).toEqual({
      out: [t('cfg.set', { path: 'profiles.models' })],
      err: [],
      code: 0,
    });
    expect(read(file).profiles).toEqual({
      builtIn: false,
      models: [{ match: 'glm-*', contextWindow: 500000 }],
    });
    expect(run(['get', 'profiles.models.0.contextWindow'], file).out).toEqual(['500000']);
    run(['set', 'profiles.models.0.input', '1.5'], file);
    expect(read(file).profiles.models[0].input).toBe(1.5);
    expect(run(['unset', 'profiles'], file).out).toEqual([t('cfg.unset', { path: 'profiles' })]);
    expect(read(file).profiles).toBeUndefined();
  });

  it('rejects invalid profile values without writing', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    for (const argv of [
      ['set', 'profiles.models', '[{"match":"glm-*","contextWindow":-5}]'],
      ['set', 'profiles.models', '[{"match":""}]'],
      ['set', 'profiles.models', '[{"match":"x","currency":"EURO"}]'],
      ['set', 'profiles.builtIn', '"no"'],
      ['set', 'profiles.extra', '1'],
    ]) {
      const r = run(argv, file);
      expect(r.err).toEqual([t('cfg.rejected', { path: argv[1]! })]);
      expect(r.code).toBe(1);
      process.exitCode = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
});

describe('config display keys', () => {
  it('sets overflow, glyph, progress and item keys', () => {
    const file = withFile();
    for (const argv of [
      ['set', 'overflow', 'priority'],
      ['set', 'glyphMode', 'paste-safe'],
      ['set', 'ambiguousWidth', '2'],
      ['set', 'progress.enabled', 'true'],
      ['set', 'lines.0.0.priority', '80'],
      ['set', 'lines.0.0.hideWhen', '!git'],
    ]) {
      expect(run(argv, file)).toEqual({ out: [t('cfg.set', { path: argv[1]! })], err: [], code: 0 });
    }
    const cfg = read(file);
    expect([cfg.overflow, cfg.glyphMode, cfg.ambiguousWidth, cfg.progress]).toEqual([
      'priority',
      'paste-safe',
      2,
      { enabled: true },
    ]);
    expect(cfg.lines[0][0]).toEqual({ id: 'm', type: 'model', priority: 80, hideWhen: '!git' });
    expect(run(['get', 'lines.0.0.hideWhen'], file).out).toEqual(['!git']);
  });

  it('rejects invalid enums without writing', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    for (const argv of [
      ['set', 'overflow', 'bogus'],
      ['set', 'progress.channel', 'x'],
      ['set', 'glyphMode', 'wide'],
      ['set', 'ambiguousWidth', '3'],
    ]) {
      const r = run(argv, file);
      expect(r.err).toEqual([t('cfg.rejected', { path: argv[1]! })]);
      expect(r.code).toBe(1);
      process.exitCode = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
});

describe('config set language', () => {
  it('sets a language, lowercased', () => {
    const file = withFile();
    for (const [v, want] of [
      ['tr', 'tr'],
      ['TR', 'tr'],
      ['"En"', 'en'],
      ['auto', 'auto'],
    ]) {
      expect(run(['set', 'language', v!], file)).toEqual({
        out: [t('cfg.set', { path: 'language' })],
        err: [],
        code: 0,
      });
      expect(read(file).language).toBe(want);
    }
    run(['set', 'language', 'tr'], file);
    expect(run(['get', 'language'], file).out).toEqual(['tr']);
  });

  it('prints the raw value with Turkish active', () => {
    const file = withFile({ ...SAMPLE, language: 'tr' });
    withLang('tr', () => expect(run(['get', 'language'], file).out).toEqual(['tr']));
  });

  it('lists the valid values and leaves the file unchanged', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    for (const v of ['xx', 'tr_TR', '5', '__proto__', 'İn']) {
      const r = run(['set', 'language', v], file);
      expect(r.err).toEqual([t('cfg.badLanguage', { values: 'auto, en, tr' })]);
      expect(r.err[0]).toContain('auto, en, tr');
      expect(r.code).toBe(1);
      process.exitCode = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('removes the key on unset', () => {
    const file = withFile({ ...SAMPLE, language: 'tr' });
    expect(run(['unset', 'language'], file).out).toEqual([t('cfg.unset', { path: 'language' })]);
    expect('language' in read(file)).toBe(false);
  });
});

describe('config set rules', () => {
  const problem = (src: unknown) => describeRuleError(validateRule(src)!);

  it('accepts a valid rule', () => {
    const file = withFile();
    const r = run(['set', 'lines.0.0.showWhen', 'context.pct >= 70'], file);
    expect(r).toEqual({ out: [t('cfg.set', { path: 'lines.0.0.showWhen' })], err: [], code: 0 });
    expect(run(['get', 'lines.0.0.showWhen'], file).out).toEqual(['context.pct >= 70']);
  });

  it('refuses rules that do not parse without writing', () => {
    const file = withFile();
    const bytes = fs.readFileSync(file, 'utf8');
    const cases: [string, string, string][] = [
      ['lines.0.0.showWhen', 'contxt.pct > 5', 'lines.0.0.showWhen'],
      ['lines.0.0.hideWhen', '["!git","time.hour in 9.."]', 'lines.0.0.hideWhen'],
      ['lines.0.0', '{"id":"a","type":"model","showWhen":"bad >"}', 'lines.0.0.showWhen'],
      ['lines.0', '[{"id":"a","type":"model","hideWhen":"git &&"}]', 'lines.0.0.hideWhen'],
    ];
    for (const [at, value, where] of cases) {
      const r = run(['set', at, value], file);
      const src = at.endsWith('When') ? parseLoose(value) : findRule(parseLoose(value));
      expect(r.err).toEqual([t('cfg.badRule', { path: where, problem: problem(src) })]);
      expect(r.out).toEqual([]);
      expect(r.code).toBe(1);
      process.exitCode = undefined;
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(problem('contxt.pct > 5')).toContain('unknown metric "contxt.pct"');
    expect(problem(['!git', 'time.hour in 9..'])).toBe(describeRuleError(validateRule('time.hour in 9..')!));
  });

  it('checks the whole rule when one entry is set', () => {
    const file = withFile({ lines: [[{ id: 'm', type: 'model', hideWhen: ['!git', 'context.pct > 5'] }]] });
    const r = run(['set', 'lines.0.0.hideWhen.1', 'contxt.pct > 5'], file);
    expect(r.err).toEqual([
      t('cfg.badRule', { path: 'lines.0.0.hideWhen', problem: problem('contxt.pct > 5') }),
    ]);
    expect(r.code).toBe(1);
  });

  it('still unsets a rule', () => {
    const file = withFile({ lines: [[{ id: 'm', type: 'model', showWhen: 'context.pct >= 70' }]] });
    const r = run(['unset', 'lines.0.0.showWhen'], file);
    expect(r).toEqual({ out: [t('cfg.unset', { path: 'lines.0.0.showWhen' })], err: [], code: 0 });
    expect(read(file).lines[0][0]).toEqual({ id: 'm', type: 'model' });
  });
});

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findRule(v: any): unknown {
  if (Array.isArray(v)) return findRule(v[0]);
  return v.showWhen ?? v.hideWhen;
}

describe('broken config', () => {
  for (const argv of [
    ['get', 'theme'],
    ['set', 'theme', 'nord'],
    ['unset', 'theme'],
  ]) {
    it(`${argv[0]} refuses an unparseable file`, () => {
      const file = withFile('{bad');
      const r = run(argv, file);
      expect(r.out).toEqual([]);
      expect(r.err).toHaveLength(1);
      const { line, column } = inspectConfigText('{bad').issue!;
      expect(r.err[0]).toBe(t('cfg.brokenFile', { file: tildify(file), line, column }));
      expect(r.code).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('{bad');
    });
  }
});

describe('usage', () => {
  it('needs a known subcommand and a path', () => {
    for (const argv of [[], ['nope', 'theme'], ['get'], ['set', 'theme']]) {
      const r = run(argv, withFile());
      expect(r.err).toEqual([t('cfg.usage')]);
      expect(r.code).toBe(1);
      process.exitCode = undefined;
    }
  });

  it('is wired into the CLI', async () => {
    const file = withFile();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    await main(['config', 'get', 'theme', '--config', file]);
    expect(writes).toEqual(['nord\n']);
  });
});
