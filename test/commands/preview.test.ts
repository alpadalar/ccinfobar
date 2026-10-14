import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { CliIo } from '../../src/commands/io.js';
import { runPreview } from '../../src/commands/manage.js';
import { t } from '../../src/core/i18n/index.js';
import { configDir } from '../../src/core/paths.js';
import { scenarioFlag, scenarioListLines } from '../../src/core/preview.js';
import { SCENARIOS } from '../../src/core/scenarios.js';
import { withoutSideEffects } from '../helpers.js';

const ESC = '\u001b';

const cfgFile = () => {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'preview-test.json');
  fs.writeFileSync(file, JSON.stringify({ colorLevel: 3 }));
  return file;
};

function run(argv: string[], tty = false): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { tty, log: (l) => out.push(l), error: (l) => err.push(l) };
  withoutSideEffects(() => runPreview(parseArgs(['preview', ...argv]), cfgFile(), io));
  return { out, err };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('scenarioFlag', () => {
  it('maps the flag to a kind', () => {
    expect(scenarioFlag(undefined)).toEqual({ kind: 'none' });
    expect(scenarioFlag(false)).toEqual({ kind: 'none' });
    expect(scenarioFlag(true)).toEqual({ kind: 'list' });
    expect(scenarioFlag('')).toEqual({ kind: 'list' });
    expect(scenarioFlag('context-full')).toEqual({ kind: 'scenario', id: 'context-full' });
    expect(scenarioFlag('nope')).toEqual({ kind: 'unknown', name: 'nope' });
  });

  it('lists every scenario under a header', () => {
    const lines = scenarioListLines();
    expect(lines[0]).toBe(t('preview.scenariosHeader'));
    expect(lines).toHaveLength(SCENARIOS.length + 1);
    for (const s of SCENARIOS)
      expect(lines.some((l) => l.includes(s.id) && l.includes(s.description))).toBe(true);
  });
});

describe('runPreview --scenario', () => {
  it('renders a scenario as plain text when not a TTY', () => {
    const { out, err } = run(['--scenario', 'context-full', '--width', '140']);
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text).not.toContain(ESC);
    expect(text).toContain('94');
    expect(process.exitCode).toBeUndefined();
  });

  it('lists scenarios for a bare flag', () => {
    const { out, err } = run(['--scenario']);
    expect(err).toEqual([]);
    for (const s of SCENARIOS)
      expect(out.some((l) => l.includes(s.id) && l.includes(s.description))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses an unknown name with the list', () => {
    const { out, err } = run(['--scenario', 'nope']);
    expect(out).toEqual([]);
    expect(err[0]).toBe(t('preview.unknownScenario', { name: 'nope' }));
    for (const s of SCENARIOS) expect(err.some((l) => l.includes(s.id))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('sanitizes the unknown name', () => {
    const { err } = run(['--scenario', 'x\u001b[31my']);
    expect(err[0]).not.toContain(ESC);
    expect(process.exitCode).toBe(1);
  });

  it('refuses --scenario with --last', () => {
    const { out, err } = run(['--scenario', 'context-full', '--last']);
    expect(out).toEqual([]);
    expect(err).toEqual([t('preview.scenarioWithLast')]);
    expect(process.exitCode).toBe(1);
  });

  it('keeps colors off a TTY with FORCE_COLOR and drops them with NO_COLOR', () => {
    try {
      vi.stubEnv('FORCE_COLOR', '1');
      expect(run(['--width', '140']).out.join('\n')).toContain(`${ESC}[`);
      vi.stubEnv('FORCE_COLOR', '0');
      expect(run(['--width', '140'], true).out.join('\n')).not.toContain(ESC);
      vi.unstubAllEnvs();
      vi.stubEnv('NO_COLOR', '1');
      expect(run(['--width', '140'], true).out.join('\n')).not.toContain(ESC);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps sample preview, plain off a TTY and colored on one', () => {
    const plain = run(['--width', '140']).out.join('\n');
    expect(plain.length).toBeGreaterThan(0);
    expect(plain).not.toContain(ESC);
    const tty = run(['--width', '140'], true).out.join('\n');
    expect(tty).toContain(`${ESC}[`);
  });
});
