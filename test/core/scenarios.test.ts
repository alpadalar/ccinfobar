import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { lastPayloadPath } from '../../src/core/paths.js';
import { isFreshSession } from '../../src/core/payload.js';
import { renderPreview } from '../../src/core/preview.js';
import { sampleLimits, samplePayload } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW, SCENARIOS, scenarioEnv, scenarioList } from '../../src/core/scenarios.js';
import type { RenderContext } from '../../src/core/types.js';
import { limitsFile, recordLimits } from '../../src/data/limits.js';
import { renderWidget, withoutSideEffects } from '../helpers.js';

const IDS = [
  'fresh-session',
  'context-full',
  'near-5h-limit',
  'many-subagents',
  'gsd-project',
  'no-git',
  'api-key-user',
];

function ctxFor(id: string): RenderContext {
  const b = getScenario(id)!.build(SCENARIO_NOW);
  return createContext({
    payload: b.payload,
    config: { ...defaultConfig(), colorLevel: 0 },
    env: { ...b.env },
    now: new Date(SCENARIO_NOW),
    preview: true,
    terminalWidth: 140,
    data: b.data,
  });
}

const widget = (id: string, type: string) => withoutSideEffects(() => renderWidget(type, ctxFor(id)));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scenarios', () => {
  it('has the seven ids in order with text', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(IDS);
    for (const s of SCENARIOS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
    expect(scenarioList().map((s) => s.id)).toEqual(IDS);
  });

  it('supplies every data source', () => {
    for (const s of SCENARIOS) {
      const { data } = s.build(SCENARIO_NOW);
      for (const k of ['git', 'transcript', 'gsd', 'history', 'agents', 'limits'] as const) {
        expect(typeof data[k], `${s.id}.${k}`).toBe('function');
      }
    }
  });

  it('carries limits that follow each bundle', () => {
    const view = (id: string) => getScenario(id)!.build(SCENARIO_NOW).data.limits();
    expect(view('near-5h-limit')?.windows.five_hour?.pct).toBe(92);
    expect(view('near-5h-limit')?.windows.seven_day?.pct).toBe(61);
    expect(view('context-full')?.windows.five_hour?.pct).toBe(42);
    for (const id of ['api-key-user', 'fresh-session']) {
      expect(view(id), id).toEqual({ windows: {}, expired: [], storeAt: null });
    }
  });

  it('looks up by exact id only', () => {
    expect(getScenario('context-full')?.id).toBe('context-full');
    expect(getScenario('Context-Full')).toBeNull();
    expect(getScenario('../context-full')).toBeNull();
    expect(getScenario('nope')).toBeNull();
  });

  it('context-full is about 94% full', () => {
    expect(widget('context-full', 'context-percentage')).toContain('94');
  });

  it('fresh-session shows the loading placeholder', () => {
    const b = getScenario('fresh-session')!.build(SCENARIO_NOW);
    expect(isFreshSession(b.payload, b.data.transcript())).toBe(true);
    expect(widget('fresh-session', 'context-bar')).toBe(t('loading.default'));
  });

  it('near-5h-limit is at 92% and resets in 25 minutes', () => {
    expect(widget('near-5h-limit', 'five-hour-usage')).toContain('92');
    const b = getScenario('near-5h-limit')!.build(SCENARIO_NOW);
    expect(b.payload.rate_limits?.five_hour?.resets_at).toBe(Math.floor(SCENARIO_NOW / 1000) + 25 * 60);
  });

  it('many-subagents has eight agents, running and done', () => {
    const b = getScenario('many-subagents')!.build(SCENARIO_NOW);
    const agents = b.data.agents();
    expect(agents).toHaveLength(8);
    expect(agents.some((a) => a.running)).toBe(true);
    expect(agents.some((a) => !a.running)).toBe(true);
    expect(new Set(agents.map((a) => a.id)).size).toBe(8);
    const calls = b.data.transcript()!.agentCalls;
    expect(calls).toHaveLength(8);
    expect(calls.filter((c) => c.done === null)).toHaveLength(agents.filter((a) => a.running).length);
  });

  it('only gsd-project carries GSD data', () => {
    expect(widget('gsd-project', 'gsd-phase')).not.toBeNull();
    expect(widget('no-git', 'gsd-phase')).toBeNull();
  });

  it('no-git has no repo', () => {
    const b = getScenario('no-git')!.build(SCENARIO_NOW);
    expect(b.data.git()).toBeNull();
    expect(b.payload.workspace?.repo).toBeUndefined();
    expect(b.payload.pr).toBeUndefined();
    expect(widget('no-git', 'git-branch')).toBeNull();
  });

  it('api-key-user hides plan limits', () => {
    const b = getScenario('api-key-user')!.build(SCENARIO_NOW);
    expect(b.env.ANTHROPIC_API_KEY).toBeTruthy();
    expect(b.payload.rate_limits).toBeUndefined();
    expect(widget('api-key-user', 'five-hour-usage')).toBeNull();
  });

  it('builders never share state', () => {
    const s = getScenario('no-git')!;
    const a = s.build(SCENARIO_NOW);
    a.payload.session_name = 'changed';
    expect(s.build(SCENARIO_NOW).payload.session_name).not.toBe('changed');
    expect(getScenario('gsd-project')!.build(SCENARIO_NOW).payload.workspace?.repo).toBeDefined();
  });
});

describe('scenarioEnv', () => {
  it('drops provider, auth and color keys, then adds the scenario env', () => {
    const base = {
      ANTHROPIC_API_KEY: 'x',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 't',
      NO_COLOR: '1',
      FORCE_COLOR: '3',
      PATH: '/bin',
    };
    const env = scenarioEnv(base, {});
    expect(env.PATH).toBe('/bin');
    for (const k of [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NO_COLOR',
      'FORCE_COLOR',
    ]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(scenarioEnv(base, { ANTHROPIC_API_KEY: 'sk' }).ANTHROPIC_API_KEY).toBe('sk');
    expect(base.ANTHROPIC_API_KEY).toBe('x');
  });
});

describe('renderPreview with a scenario', () => {
  it('is byte-identical across runs', () => {
    vi.stubEnv('TZ', 'UTC');
    const config = { ...defaultConfig(), colorLevel: 0 as const };
    for (const id of IDS) {
      const a = withoutSideEffects(() => renderPreview(config, { scenario: id }, 140));
      const b = withoutSideEffects(() => renderPreview(config, { scenario: id }, 140));
      expect(a.length, id).toBeGreaterThan(0);
      expect(b, id).toEqual(a);
    }
  });

  it('renders the scenario situation', () => {
    const config = { ...defaultConfig(), colorLevel: 0 as const };
    const lines = withoutSideEffects(() => renderPreview(config, { scenario: 'context-full' }, 140));
    expect(lines.join('\n')).toContain('94');
  });

  it('throws on an unknown scenario', () => {
    expect(() => renderPreview(defaultConfig(), { scenario: 'nope' }, 140)).toThrow();
  });
});

describe('sampleLimits', () => {
  const LEN = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 } as const;

  it('ends at the sample payload windows with samples inside each window', () => {
    const now = SCENARIO_NOW;
    const r = samplePayload(now).rate_limits!;
    const v = sampleLimits(now);
    expect(v.expired).toEqual([]);
    expect(v.storeAt).toBeNull();
    for (const key of ['five_hour', 'seven_day'] as const) {
      const w = v.windows[key]!;
      expect(w.pct).toBe(r[key]!.used_percentage);
      expect(w.resetsAt).toBe((r[key]!.resets_at as number) * 1000);
      expect(w.source).toBe('payload');
      expect(w.at).toBe(now - 5_000);
      expect(w.samples.length).toBeGreaterThanOrEqual(8);
      expect(w.samples.length).toBeLessThanOrEqual(12);
      expect(w.samples.at(-1)).toEqual({ t: now - 5_000, pct: w.pct });
      let prev = -1;
      for (const p of w.samples) {
        expect(p.t).toBeGreaterThanOrEqual(w.resetsAt! - LEN[key]);
        expect(p.t).toBeLessThanOrEqual(w.resetsAt!);
        expect(p.pct).toBeLessThanOrEqual(w.pct);
        expect(p.pct).toBeGreaterThanOrEqual(prev);
        prev = p.pct;
      }
    }
  });

  it('is empty without rate limits', () => {
    expect(sampleLimits(SCENARIO_NOW, null)).toEqual({ windows: {}, expired: [], storeAt: null });
    expect(sampleLimits(SCENARIO_NOW, {})).toEqual({ windows: {}, expired: [], storeAt: null });
  });
});

describe('createContext limits', () => {
  const base = { payload: {}, config: defaultConfig(), env: {} };

  it('passes data.limits through and reads nothing by default', () => {
    const limits = () => sampleLimits(SCENARIO_NOW);
    expect(createContext({ ...base, data: { limits } }).data.limits).toBe(limits);
    expect(createContext(base).data.limits).toBeUndefined();
  });
});

describe('preview of the last payload', () => {
  it('shows the shared limits read-only', () => {
    const keys = Object.keys(process.env).filter((k) =>
      /^(CLAUDE_CODE_USE_|ANTHROPIC_)|^CLAUDE_CODE_OAUTH_TOKEN$/.test(k),
    );
    for (const k of keys) vi.stubEnv(k, undefined);
    const now = Date.now();
    const resets_at = Math.floor(now / 1000) + 3600;
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'preview-last-'));
    const transcript = path.join(dir, 's.jsonl');
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now - 3 * 3_600_000).toISOString(),
        message: { id: 'm1', model: 'x', usage: { input_tokens: 1, output_tokens: 1 } },
      }) + '\n',
    );
    fs.mkdirSync(path.dirname(lastPayloadPath()), { recursive: true });
    fs.writeFileSync(
      lastPayloadPath(),
      JSON.stringify({
        transcript_path: transcript,
        rate_limits: { five_hour: { used_percentage: 40, resets_at } },
      }),
    );
    recordLimits(
      process.env,
      { rate_limits: { five_hour: { used_percentage: 70, resets_at } } },
      now - 60_000,
      now,
    );
    const before = fs.readFileSync(limitsFile(), 'utf8');
    try {
      const config = {
        ...defaultConfig(),
        colorLevel: 0 as const,
        lines: [[{ id: 'five', type: 'five-hour-usage' }]],
      };
      const lines = withoutSideEffects(() => renderPreview(config, 'last', 140));
      expect(lines.join('\n')).toContain('70%');
      expect(fs.readFileSync(limitsFile(), 'utf8')).toBe(before);
    } finally {
      fs.rmSync(lastPayloadPath(), { force: true });
      fs.rmSync(limitsFile(), { force: true });
    }
  });
});
