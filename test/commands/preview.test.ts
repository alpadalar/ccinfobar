import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { CliIo } from '../../src/commands/io.js';
import { runPreview } from '../../src/commands/manage.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { configDir, lastPayloadPath } from '../../src/core/paths.js';
import { renderPreview, scenarioFlag, scenarioListLines } from '../../src/core/preview.js';
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

describe('renderPreview ledger widgets', () => {
  const cfg = () => ({
    ...defaultConfig(),
    colorLevel: 0 as const,
    lines: [
      [
        { id: 'a', type: 'cost-today' },
        { id: 'b', type: 'cost-week' },
        { id: 'c', type: 'cost-project' },
      ],
    ],
  });

  it('shows the sample ledger', () => {
    const out = withoutSideEffects(() => renderPreview(cfg(), 'sample', 200));
    const line = stripAnsi(out[0] ?? '');
    expect(line).toContain('Today ~$4.12');
    expect(line).toContain('Week ~$18.40');
    expect(line).toContain('Project ~$62.00');
  });

  it('shows the scenario ledger', () => {
    const out = withoutSideEffects(() => renderPreview(cfg(), { scenario: 'context-full' }, 200));
    expect(stripAnsi(out[0] ?? '')).toContain('Today ~$4.12');
  });
});

describe('renderPreview with a scenario config', () => {
  const cfg = () => ({
    ...defaultConfig(),
    colorLevel: 1 as const,
    lines: [[{ id: 'b', type: 'budget' }]],
  });

  it('over-budget shows the exceeded budget in red without changing the config', () => {
    const config = cfg();
    const before = JSON.stringify(config);
    const out = withoutSideEffects(() => renderPreview(config, { scenario: 'over-budget' }, 200));
    expect(stripAnsi(out[0] ?? '')).toContain('~$4.12/$3');
    expect(out[0]).toContain(`${ESC}[31m`);
    expect(JSON.stringify(config)).toBe(before);
    expect(config.budget).toBeUndefined();
  });

  it('applies the override only to its scenario', () => {
    for (const source of ['sample', { scenario: 'context-full' }] as const) {
      const out = withoutSideEffects(() => renderPreview(cfg(), source, 200));
      expect(stripAnsi(out.join('\n'))).not.toContain('$3');
    }
  });
});

describe('renderPreview of the last payload', () => {
  let dir = '';
  let saved: string | undefined;

  afterEach(() => {
    if (saved === undefined) delete process.env.CCINFOBAR_CACHE_DIR;
    else process.env.CCINFOBAR_CACHE_DIR = saved;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('writes no transcript or agent cache', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-preview-'));
    saved = process.env.CCINFOBAR_CACHE_DIR;
    const cache = path.join(dir, 'cache');
    process.env.CCINFOBAR_CACHE_DIR = cache;
    const transcript = path.join(dir, 'session.jsonl');
    fs.copyFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'transcript.jsonl'), transcript);
    const sub = path.join(dir, 'session', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore' }));
    fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), '{"type":"user"}\n');
    const resets = Math.floor(Date.now() / 1000) + 3600;
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      lastPayloadPath(),
      JSON.stringify({
        session_id: 's1',
        transcript_path: transcript,
        rate_limits: { five_hour: { used_percentage: 10, resets_at: resets } },
      }),
    );
    const config = {
      ...defaultConfig(),
      lines: [
        [
          { id: 'f', type: 'five-hour-usage' },
          { id: 'a', type: 'agents' },
        ],
      ],
    };
    renderPreview(config, 'last', 200);
    expect(fs.readdirSync(cache, { recursive: true })).toEqual(['last-payload.json']);
  });
});
