import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { configWarnings } from '../../src/commands/doctor.js';
import { runExplain } from '../../src/commands/explain.js';
import type { CliIo } from '../../src/commands/io.js';
import { t } from '../../src/core/i18n/index.js';
import { configDir, lastPayloadPath } from '../../src/core/paths.js';

afterEach(() => {
  process.exitCode = undefined;
  fs.rmSync(lastPayloadPath(), { force: true });
});

function run(argv: string[], cfg: object): string[] {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), 'aliases-test.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  const out: string[] = [];
  const io: CliIo = { tty: false, log: (l) => out.push(l), error: (l) => out.push(l) };
  runExplain(parseArgs(['explain', ...argv]), file, io);
  return out;
}

const warn = (options: object) => configWarnings({ lines: [[{ type: 'budget', options }]] });

describe('doctor with old option names', () => {
  it('warns about a bad value under the old name', () => {
    expect(warn({ display: 'nope' })).toEqual([t('doctor.badOption', { type: 'budget', key: 'display' })]);
  });

  it('accepts a good value under either name', () => {
    expect(warn({ display: 'bar' })).toEqual([]);
    expect(warn({ show: 'bar' })).toEqual([]);
  });

  it('warns about a bad value under the canonical name', () => {
    expect(warn({ show: 'nope' })).toEqual([t('doctor.badOption', { type: 'budget', key: 'show' })]);
  });
});

describe('explain with old option names', () => {
  const options = (cfg: object) =>
    run(['b'], { lines: [[{ id: 'b', type: 'budget', options: cfg }]] }).find((l) =>
      l.startsWith(t('explain.detail.options', { options: '' })),
    );

  it('does not mask a select value under the old name', () => {
    expect(options({ display: 'percent' })).toBe(
      t('explain.detail.options', { options: '{"display":"percent"}' }),
    );
  });

  it('still masks a text option', () => {
    const cfg = { lines: [[{ id: 'c', type: 'command', options: { command: 'echo secret-1' } }]] };
    const out = run(['c'], cfg).join('\n');
    expect(out).not.toContain('secret-1');
  });
});

describe('hide options under old names', () => {
  it('warns about a bad old-name boolean', () => {
    expect(configWarnings({ lines: [[{ type: 'compactions', options: { showZero: 'maybe' } }]] })).toContain(
      t('doctor.badOption', { type: 'compactions', key: 'showZero' }),
    );
  });

  it('explains an old hide name like a canonical key', () => {
    const out = run(['f'], { lines: [[{ id: 'f', type: 'fast-mode', options: { showOff: true } }]] });
    const line = out.find((l) => l.startsWith(t('explain.detail.options', { options: '' })));
    expect(line).toBe(t('explain.detail.options', { options: '{"showOff":true}' }));
  });
});
