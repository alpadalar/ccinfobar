import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import {
  benchBaseEnv,
  benchEnv,
  benchPayload,
  clampRuns,
  overhead,
  runBench,
  runBenchCommand,
  stats,
  syntheticTranscript,
} from '../../src/commands/bench.js';
import type { CliIo } from '../../src/commands/io.js';
import { t } from '../../src/core/i18n/index.js';
import { cacheDir, configDir } from '../../src/core/paths.js';
import { samplePayload } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW } from '../../src/core/scenarios.js';
import { parseTranscriptText } from '../../src/data/transcript.js';

describe('stats', () => {
  it('computes median, nearest-rank p95, min and max', () => {
    expect(stats([5, 1, 3])).toEqual({ n: 3, median: 3, p95: 5, min: 1, max: 5 });
    expect(stats([1, 2, 3, 4]).median).toBe(2.5);
    expect(stats(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
    expect(stats([7])).toEqual({ n: 1, median: 7, p95: 7, min: 7, max: 7 });
  });

  it('does not reorder the input', () => {
    const ms = [3, 1, 2];
    stats(ms);
    expect(ms).toEqual([3, 1, 2]);
  });

  it('computes overhead from medians', () => {
    expect(overhead(stats([10, 12]), stats([4]))).toBe(7);
  });
});

describe('clampRuns', () => {
  it('defaults, floors and clamps', () => {
    expect(clampRuns(undefined)).toBe(20);
    expect(clampRuns(true)).toBe(20);
    expect(clampRuns(false)).toBe(20);
    expect(clampRuns('0')).toBe(1);
    expect(clampRuns('5000')).toBe(1000);
    expect(clampRuns('abc')).toBe(20);
    expect(clampRuns('7.9')).toBe(7);
    expect(clampRuns('-3')).toBe(1);
  });
});

describe('benchEnv', () => {
  const dirs = { cache: '/t/cache', config: '/t/config', claude: '/t/claude', compile: '/t/compile' };

  it('points every dir at temp and turns off background traffic', () => {
    const env = benchEnv(
      { PATH: '/bin', CCINFOBAR_CONFIG: '/x', CCINFOBAR_CACHE_DIR: '/real', NODE_COMPILE_CACHE: '/real' },
      dirs,
    );
    expect(env.PATH).toBe('/bin');
    expect(env.CCINFOBAR_CACHE_DIR).toBe('/t/cache');
    expect(env.CCINFOBAR_CONFIG_DIR).toBe('/t/config');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/t/claude');
    expect(env.NODE_COMPILE_CACHE).toBe('/t/compile');
    expect('CCINFOBAR_CONFIG' in env).toBe(false);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.COLUMNS).toBe('140');
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBeUndefined();
  });

  it('can turn the compile cache off', () => {
    const env = benchEnv({ NODE_DISABLE_COMPILE_CACHE: undefined }, dirs, { compileCache: false });
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe('1');
  });

  it('does not change the base env', () => {
    const base = { CCINFOBAR_CONFIG: '/x' };
    benchEnv(base, dirs);
    expect(base).toEqual({ CCINFOBAR_CONFIG: '/x' });
  });
});

describe('benchPayload', () => {
  it('starts from the sample and points cwd and transcript at real paths', () => {
    const p = benchPayload(undefined, '/work/repo', '/t/transcript.jsonl');
    const expected = samplePayload(SCENARIO_NOW);
    expect(p.model).toEqual(expected.model);
    expect(p.cost).toEqual(expected.cost);
    expect(p.cwd).toBe('/work/repo');
    expect(p.workspace?.current_dir).toBe('/work/repo');
    expect(p.workspace?.project_dir).toBe('/work/repo');
    expect(p.transcript_path).toBe('/t/transcript.jsonl');
  });

  it('starts from a scenario payload', () => {
    const p = benchPayload('context-full', '/w', '/t.jsonl');
    const expected = getScenario('context-full')!.build(SCENARIO_NOW).payload;
    expect(p.context_window).toEqual(expected.context_window);
    expect(p.cwd).toBe('/w');
  });
});

describe('benchBaseEnv', () => {
  it('applies the scenario env without provider keys from the real env', () => {
    const base = { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gw' };
    const env = benchBaseEnv(base, 'api-key-user');
    expect(env.ANTHROPIC_API_KEY).toBe(
      getScenario('api-key-user')!.build(SCENARIO_NOW).env.ANTHROPIC_API_KEY,
    );
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/bin');
    expect(benchEnv(env, { cache: 'c', config: 'g', claude: 'l', compile: 'p' }).ANTHROPIC_API_KEY).toBe(
      env.ANTHROPIC_API_KEY,
    );
  });

  it('keeps the real env without a scenario', () => {
    const base = { CLAUDE_CODE_USE_BEDROCK: '1' };
    expect(benchBaseEnv(base, undefined)).toBe(base);
  });
});

describe('syntheticTranscript', () => {
  it('writes about 200 entries the parser counts', () => {
    const text = syntheticTranscript(SCENARIO_NOW);
    const lines = text.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(190);
    expect(lines.length).toBeLessThanOrEqual(220);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    const info = parseTranscriptText(text);
    expect(info.totalTokens).toBeGreaterThan(0);
    expect(info.messageCount).toBeGreaterThan(50);
    expect(info.userMessageCount).toBeGreaterThan(10);
  });
});

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const ESC = '\u001b';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { tty: false, log: (l) => out.push(l), error: (l) => err.push(l) }, out, err };
}

function benchDirs(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith('ccib-bench-'))
    .sort();
}

function cfg(text = '{}'): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bench-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, text);
  return file;
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('runBench', () => {
  it('lists scenarios on a bare --scenario', () => {
    const c = capture();
    runBenchCommand(parseArgs(['bench', '--scenario']), cfg(), c.io);
    expect(process.exitCode).toBeUndefined();
    expect(c.out[0]).toBe(t('preview.scenariosHeader'));
  });

  it('refuses an unknown scenario with the list', () => {
    const c = capture();
    expect(runBench({ runs: 1, scenario: 'nope', json: false, cfgFile: cfg() }, c.io)).toBe(1);
    expect(c.err[0]).toBe(t('preview.unknownScenario', { name: 'nope' }));
    expect(c.err.some((l) => l.includes('context-full'))).toBe(true);
  });

  it('reports a broken config', () => {
    const c = capture();
    const file = cfg('{ "theme": ');
    expect(runBench({ entry: bin, runs: 1, json: false, cfgFile: file }, c.io)).toBe(1);
    expect(c.err[0]).toContain('has an error at line');
    expect(c.err[1]).toBe(t('explain.runDoctor'));
    expect(c.out).toEqual([]);
  });

  it('stops on a failing run and prints its stderr', () => {
    const before = benchDirs();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-benchfail-'));
    try {
      const entry = path.join(dir, 'fail.mjs');
      fs.writeFileSync(entry, "process.stderr.write('boom\\u001b[31m red'); process.exit(3);\n");
      const c = capture();
      expect(runBench({ entry, runs: 2, json: false, cfgFile: cfg() }, c.io)).toBe(1);
      expect(c.err[0]).toBe(t('bench.failed', { row: t('bench.row.cold'), code: 3 }));
      expect(c.err.join('\n')).toContain('boom');
      expect(c.err.join('\n')).not.toContain(ESC);
      expect(benchDirs()).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!fs.existsSync(bin))('runBench with the built cli', () => {
  it('prints one JSON object with four rows and leaves no temp dirs', { timeout: 60_000 }, () => {
    const before = benchDirs();
    const cache = listFiles(cacheDir());
    const c = capture();
    expect(runBench({ entry: bin, runs: 2, json: true, cfgFile: cfg() }, c.io)).toBe(0);
    expect(c.err).toEqual([]);
    expect(c.out).toHaveLength(1);
    const o = JSON.parse(c.out[0]!);
    expect(o.schema).toBe(1);
    expect(typeof o.version).toBe('string');
    expect(o.node).toBe(process.version);
    expect(o.os.platform).toBe(process.platform);
    expect(typeof o.os.arch).toBe('string');
    expect(typeof o.os.release).toBe('string');
    expect(typeof o.cpu.model).toBe('string');
    expect(typeof o.cpu.count).toBe('number');
    expect(o.scenario).toBe('sample');
    expect(o.runs).toBe(2);
    expect(typeof o.gitRepo).toBe('boolean');
    expect(o.rows.map((r: { name: string }) => r.name)).toEqual([
      'control',
      'cold',
      'warm',
      'warm-no-compile-cache',
    ]);
    for (const r of o.rows) {
      expect(r.n).toBe(2);
      for (const k of ['median', 'p95', 'min', 'max']) expect(r[k]).toBeGreaterThan(0);
    }
    expect(o.overheadMs).toBeCloseTo(o.rows[2].median - o.rows[0].median, 1);
    expect(benchDirs()).toEqual(before);
    expect(listFiles(cacheDir())).toEqual(cache);
  });

  it('prints plain text with the overhead line', { timeout: 60_000 }, () => {
    const c = capture();
    expect(
      runBench({ entry: bin, runs: 1, scenario: 'context-full', json: false, cfgFile: cfg() }, c.io),
    ).toBe(0);
    const text = c.out.join('\n');
    expect(text).not.toContain(ESC);
    expect(text).toContain('ccinfobar overhead = warm median');
    expect(text).toContain(t('bench.row.warmNoCache'));
    expect(text).toContain('context-full');
  });
});
