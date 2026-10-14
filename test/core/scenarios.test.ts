import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { lastPayloadPath } from '../../src/core/paths.js';
import { isFreshSession } from '../../src/core/payload.js';
import { renderPreview } from '../../src/core/preview.js';
import { sampleHooks, sampleLimits, samplePayload } from '../../src/core/sample.js';
import {
  getScenario,
  SCENARIO_NOW,
  SCENARIOS,
  scenarioConfig,
  scenarioEnv,
  scenarioList,
} from '../../src/core/scenarios.js';
import type { RenderContext } from '../../src/core/types.js';
import { limitsFile, recordLimits } from '../../src/data/limits.js';
import { getWidget } from '../../src/widgets/index.js';
import { renderWidget, withoutSideEffects } from '../helpers.js';

const IDS = [
  'fresh-session',
  'context-full',
  'near-5h-limit',
  'near-7d-limit',
  'many-subagents',
  'gsd-project',
  'no-git',
  'api-key-user',
  'over-budget',
  'workspace-folder',
  'waiting-permission',
];

function ctxFor(id: string): RenderContext {
  const b = getScenario(id)!.build(SCENARIO_NOW);
  return createContext({
    payload: b.payload,
    config: scenarioConfig({ ...defaultConfig(), colorLevel: 0 }, b),
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
  it('has the ids in order with text', () => {
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
      for (const k of ['git', 'transcript', 'gsd', 'history', 'agents', 'limits', 'ledger'] as const) {
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
      expect(view(id), id).toEqual({ windows: {}, expired: [] });
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

  it('supplies hook state in every scenario except fresh-session', () => {
    for (const id of IDS) {
      const b = getScenario(id)!.build(SCENARIO_NOW);
      expect(typeof b.data.hooks, id).toBe('function');
      if (id === 'waiting-permission') continue;
      expect(b.data.hooks(), id).toEqual(id === 'fresh-session' ? null : sampleHooks(SCENARIO_NOW));
    }
    expect(getScenario('waiting-permission')!.build(SCENARIO_NOW).data.hooks()).toEqual({
      ...sampleHooks(SCENARIO_NOW),
      lastPermission: { since: SCENARIO_NOW - 60_000, end: SCENARIO_NOW - 18_000, tool: 'Bash' },
    });
  });

  it('near-5h-limit is at 92% and resets in 25 minutes', () => {
    expect(widget('near-5h-limit', 'five-hour-usage')).toContain('92');
    const b = getScenario('near-5h-limit')!.build(SCENARIO_NOW);
    expect(b.payload.rate_limits?.five_hour?.resets_at).toBe(Math.floor(SCENARIO_NOW / 1000) + 25 * 60);
  });

  it('near-5h-limit shows a red risk chip and an ETA', () => {
    const def = getWidget('limit-risk')!;
    const item = { id: 'r', type: 'limit-risk' };
    expect(withoutSideEffects(() => def.render(ctxFor('near-5h-limit'), item))).toEqual({
      text: '5h 100%',
      color: 'red',
    });
    expect(widget('near-5h-limit', 'limit-eta')).toBe('5h 100% in 24m');
  });

  it('near-7d-limit is at 80% weekly and shows an amber chip', () => {
    const b = getScenario('near-7d-limit')!.build(SCENARIO_NOW);
    expect(b.payload.rate_limits?.seven_day?.resets_at).toBe(Math.floor(SCENARIO_NOW / 1000) + 86_400);
    expect(b.data.limits()?.windows.seven_day?.pct).toBe(80);
    const def = getWidget('limit-risk')!;
    expect(
      withoutSideEffects(() => def.render(ctxFor('near-7d-limit'), { id: 'r', type: 'limit-risk' })),
    ).toEqual({
      text: '7d 93%',
      color: 'yellow',
    });
    const proj = getWidget('usage-projection')!;
    const item = { id: 'p', type: 'usage-projection', options: { window: '7d' } };
    expect(withoutSideEffects(() => proj.render(ctxFor('near-7d-limit'), item))).toEqual({
      text: '7d →93%',
      color: 'yellow',
    });
  });

  it('base-derived scenarios show no risk chip', () => {
    for (const id of ['context-full', 'gsd-project', 'no-git', 'many-subagents', 'api-key-user']) {
      expect(widget(id, 'limit-risk'), id).toBeNull();
    }
    expect(widget('fresh-session', 'limit-risk')).toBe(t('loading.default'));
  });

  it('renders the projection widgets under every scenario', () => {
    for (const id of IDS) {
      for (const type of ['usage-projection', 'limit-eta', 'limit-risk']) {
        expect(() => widget(id, type), `${id} ${type}`).not.toThrow();
      }
    }
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

  it('over-budget sets a $3 daily budget and $4.12 spent today', () => {
    const b = getScenario('over-budget')!.build(SCENARIO_NOW);
    expect(b.config?.budget).toEqual({ daily: 3, warnAt: 0.8 });
    expect(b.data.ledger()?.today).toBe(4.12);
    for (const s of SCENARIOS.filter((x) => x.id !== 'over-budget')) {
      expect(s.build(SCENARIO_NOW).config, s.id).toBeUndefined();
    }
  });

  it('scenarioConfig merges a copy and keeps the user config', () => {
    const user = { ...defaultConfig(), budget: { daily: 50, session: 5 } };
    const b = getScenario('over-budget')!.build(SCENARIO_NOW);
    const merged = scenarioConfig(user, b);
    expect(merged.budget).toEqual({ daily: 3, warnAt: 0.8 });
    expect(merged.lines).toBe(user.lines);
    expect(user.budget).toEqual({ daily: 50, session: 5 });
    const plain = getScenario('no-git')!.build(SCENARIO_NOW);
    expect(scenarioConfig(user, plain)).toBe(user);
  });

  it('builders never share state', () => {
    const s = getScenario('no-git')!;
    const a = s.build(SCENARIO_NOW);
    a.payload.session_name = 'changed';
    expect(s.build(SCENARIO_NOW).payload.session_name).not.toBe('changed');
    expect(getScenario('gsd-project')!.build(SCENARIO_NOW).payload.workspace?.repo).toBeDefined();
  });
});

const NEW_WIDGETS = [
  'usage-projection',
  'limit-eta',
  'limit-risk',
  'cost-today',
  'cost-week',
  'cost-project',
  'budget',
  'performance',
  'workspace-repos',
  'tool-activity',
  'turn-timer',
  'permission-wait',
  'env-counts',
];

const raw = (id: string, type: string) =>
  withoutSideEffects(() => getWidget(type)!.render(ctxFor(id), { id: type, type }));

describe('new widgets across scenarios', () => {
  it('render a string, an object or null under every scenario', () => {
    for (const id of IDS) {
      for (const type of NEW_WIDGETS) {
        const out = raw(id, type);
        if (out === null || out === undefined || typeof out === 'string') continue;
        expect(typeof out.text, `${id} ${type}`).toBe('string');
      }
    }
  });

  it('turn-timer shows the sample hook turn, and nothing in a fresh session', () => {
    expect(widget('context-full', 'turn-timer')).toBe('2m14s');
    expect(widget('fresh-session', 'turn-timer')).toBeNull();
  });

  it('waiting-permission shows the closed 42 s Bash wait, other scenarios none', () => {
    expect(widget('waiting-permission', 'permission-wait')).toBe('Bash 42s');
    for (const id of IDS.filter((x) => x !== 'waiting-permission'))
      expect(widget(id, 'permission-wait'), id).toBeNull();
  });

  it('api-key-user shows no limits or projection', () => {
    for (const type of ['usage-projection', 'limit-eta', 'limit-risk']) {
      expect(widget('api-key-user', type), type).toBeNull();
    }
  });

  it('near-5h-limit is red and has an ETA', () => {
    expect(raw('near-5h-limit', 'limit-risk')).toMatchObject({ color: 'red' });
    expect(widget('near-5h-limit', 'limit-eta')).toMatch(/ in \d+m$/);
  });

  it('near-7d-limit is amber and base-derived scenarios have no chip', () => {
    expect(raw('near-7d-limit', 'limit-risk')).toMatchObject({ color: 'yellow' });
    for (const id of ['gsd-project', 'no-git', 'many-subagents', 'over-budget']) {
      expect(widget(id, 'limit-risk'), id).toBeNull();
    }
  });

  it('fresh-session has no ledger costs', () => {
    for (const type of ['cost-today', 'cost-week', 'cost-project']) {
      expect(widget('fresh-session', type), type).toBeNull();
    }
  });

  it('only over-budget shows a budget, in red', () => {
    expect(raw('over-budget', 'budget')).toEqual({ text: '~$4.12/$3', color: 'red' });
    for (const id of IDS.filter((x) => x !== 'over-budget')) {
      expect(widget(id, 'budget'), id).toBeNull();
    }
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
    expect(sampleLimits(SCENARIO_NOW, null)).toEqual({ windows: {}, expired: [] });
    expect(sampleLimits(SCENARIO_NOW, {})).toEqual({ windows: {}, expired: [] });
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
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now - 3 * 3_600_000).toISOString(),
        message: { id: 'm1', model: 'x', usage: { input_tokens: 1, output_tokens: 1 } },
      })}\n`,
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

describe('workspace-folder scenario', () => {
  it('shows child repos there and nowhere else', () => {
    for (const id of IDS) {
      const out = withoutSideEffects(() => renderWidget('workspace-repos', ctxFor(id)));
      if (id === 'workspace-folder') {
        expect(out).toBe('api (main) · docs (main) · infra (main) · mobile (release/2.1) · web (dev) +2');
      } else expect(out, id).toBeNull();
    }
  });
});
