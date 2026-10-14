import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { main } from '../../src/cli/main.js';
import { runConfig } from '../../src/commands/config-cmd.js';
import { defaultConfig, inspectConfigText } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';

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
