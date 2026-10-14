import { describe, expect, it } from 'vitest';
import {
  benchEnv,
  benchPayload,
  clampRuns,
  overhead,
  stats,
  syntheticTranscript,
} from '../../src/commands/bench.js';
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
