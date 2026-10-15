import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import type { CliIo } from '../../src/commands/io.js';
import { runPreview } from '../../src/commands/manage.js';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { scenarioText } from '../../src/core/i18n/catalog-text.js';
import { t } from '../../src/core/i18n/index.js';
import { configDir, lastPayloadPath } from '../../src/core/paths.js';
import { renderPreview, scenarioFlag, scenarioListLines } from '../../src/core/preview.js';
import { SCENARIOS } from '../../src/core/scenarios.js';
import { visibleWidth } from '../../src/core/width.js';
import { withLang, withoutSideEffects } from '../helpers.js';

const ESC = '\u001b';

const cfgFile = (cfg: object = { colorLevel: 3 }) => {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'preview-test.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
};

function run(argv: string[], tty = false, cfg?: object): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { tty, log: (l) => out.push(l), error: (l) => err.push(l) };
  withoutSideEffects(() => runPreview(parseArgs(['preview', ...argv]), cfgFile(cfg), io));
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

  it('lists Turkish descriptions with ids unchanged and one description column', () => {
    const en = scenarioListLines();
    const tr = withLang('tr', () => scenarioListLines());
    expect(tr[0]).toBe(withLang('tr', () => t('preview.scenariosHeader')));
    expect(tr).toHaveLength(en.length);
    const ids = (lines: string[]) => lines.slice(1).map((l) => l.trim().split(' ')[0]);
    expect(ids(tr)).toEqual(SCENARIOS.map((s) => s.id));
    expect(ids(en)).toEqual(ids(tr));
    const start = (lines: string[]) =>
      new Set(lines.slice(1).map((l) => visibleWidth(/^ {2}\S+ +/.exec(l)![0])));
    expect(start(tr).size).toBe(1);
    expect(start(tr)).toEqual(start(en));
    for (const [i, s] of SCENARIOS.entries()) {
      expect(en[i + 1]!.endsWith(`  ${s.description}`)).toBe(true);
      expect(tr[i + 1]!.endsWith(`  ${withLang('tr', () => scenarioText(s, 'description'))}`)).toBe(true);
      expect(tr[i + 1]).not.toContain(s.description);
    }
    expect(tr).toContain(
      en
        .find((l) => l.includes('context-full'))!
        .replace(/The context.*$/, 'Bağlam penceresi yaklaşık %94 dolu'),
    );
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

describe('runPreview --glyph-mode', () => {
  const PUA = /[\uE000-\uF8FF\u{F0000}-\u{10FFFF}]/u;

  const NERD = { colorLevel: 3, icons: 'nerd', charset: 'nerd', style: 'powerline' };

  it('renders paste-safe text and leaves the config alone', () => {
    const { out, err } = run(['--glyph-mode', 'paste-safe', '--width', '200'], true, NERD);
    expect(err).toEqual([]);
    const text = out.join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(PUA);
    expect(text).not.toContain(`${ESC}]8;`);
    expect(text).not.toContain('\u00A0');
    expect(out.every((l) => l.startsWith(`${ESC}[0m`))).toBe(true);
    expect(fs.readFileSync(path.join(configDir(), 'preview-test.json'), 'utf8')).toBe(JSON.stringify(NERD));
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the normal preview without the flag', () => {
    expect(run(['--width', '200'], true, NERD).out.join('\n')).toMatch(PUA);
  });

  it('refuses an unknown mode', () => {
    const { out, err } = run(['--glyph-mode', 'wide']);
    expect(out).toEqual([]);
    expect(err).toEqual([t('preview.badGlyphMode', { mode: 'wide' })]);
    expect(process.exitCode).toBe(1);
  });

  it('refuses a bare flag', () => {
    const { err } = run(['--glyph-mode']);
    expect(err).toEqual([t('preview.badGlyphMode', { mode: '' })]);
    expect(process.exitCode).toBe(1);
  });
});
