import type { AgentInfo } from '../data/agents.js';
import type { AgentCall } from '../data/transcript.js';
import {
  sampleAgents,
  sampleGit,
  sampleGsd,
  sampleHistory,
  samplePayload,
  sampleTranscript,
} from './sample.js';
import type { DataSources, StatusPayload } from './types.js';

export const SCENARIO_NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

export interface ScenarioBundle {
  payload: StatusPayload;
  data: Required<DataSources>;
  env: Record<string, string>;
}

export interface Scenario {
  id: string;
  label: string;
  description: string;
  build(now: number): ScenarioBundle;
}

function base(now: number): ScenarioBundle {
  return {
    payload: samplePayload(now),
    data: {
      git: sampleGit,
      transcript: () => sampleTranscript(now),
      gsd: () => null,
      history: () => sampleHistory(now),
      agents: () => sampleAgents(now),
    },
    env: {},
  };
}

function freshSession(now: number): ScenarioBundle {
  const b = base(now);
  const p = b.payload;
  p.context_window = {
    context_window_size: 200_000,
    current_usage: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
  };
  p.exceeds_200k_tokens = false;
  p.cost = {
    total_cost_usd: 0,
    total_duration_ms: 0,
    total_api_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
  delete p.prompt_cache;
  delete p.rate_limits;
  b.data.transcript = () => null;
  b.data.agents = () => [];
  b.data.history = () => [];
  return b;
}

function contextFull(now: number): ScenarioBundle {
  const b = base(now);
  b.payload.context_window = {
    context_window_size: 200_000,
    total_input_tokens: 188_000,
    total_output_tokens: 24_600,
    used_percentage: 94,
    remaining_percentage: 6,
    current_usage: {
      input_tokens: 2_000,
      output_tokens: 800,
      cache_creation_input_tokens: 6_000,
      cache_read_input_tokens: 180_000,
    },
  };
  b.payload.exceeds_200k_tokens = false;
  b.data.transcript = () => ({ ...sampleTranscript(now), contextLength: 188_000 });
  return b;
}

function near5hLimit(now: number): ScenarioBundle {
  const b = base(now);
  const sec = Math.floor(now / 1000);
  const r = b.payload.rate_limits ?? {};
  b.payload.rate_limits = { ...r, five_hour: { used_percentage: 92, resets_at: sec + 25 * 60 } };
  return b;
}

const SUBAGENTS: [string, string, string, number, boolean][] = [
  ['Explore', 'Map the billing module', 'Grep[invoice]', 140, true],
  ['Explore', 'Find the export entry points', 'Glob[src/**/*.ts]', 128, true],
  ['general-purpose', 'Review the CSV writer', 'Read[src/export/csv.ts]', 110, true],
  ['general-purpose', 'Write invoice tests', 'Edit[test/invoice.test.ts]', 95, true],
  ['general-purpose', 'Check currency rounding', 'Bash[npm test]', 60, true],
  ['Explore', 'List Stripe webhooks', 'Grep[webhook]', 300, false],
  ['general-purpose', 'Fix the date parser', 'Edit[src/core/date.ts]', 260, false],
  ['general-purpose', 'Update the API docs', 'Edit[docs/API.md]', 220, false],
];

function manySubagents(now: number): ScenarioBundle {
  const b = base(now);
  const [tpl] = sampleAgents(now);
  const agents: AgentInfo[] = SUBAGENTS.map(([type, description, tool, secs, running], i) => {
    const total = 3_000 + i * 1_100;
    const output = 400 + i * 150;
    return {
      ...tpl!,
      id: `s${i + 1}`,
      type,
      description,
      tool,
      model: i % 3 === 2 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5',
      total,
      output,
      input: total - output,
      fresh: total,
      start: now - secs * 1000,
      last: running ? now : now - (secs - 90) * 1000,
      running,
    };
  });
  const calls: AgentCall[] = agents.map((a) => ({
    id: `toolu_${a.id}`,
    start: a.start ?? now,
    done: a.running ? null : a.last,
  }));
  b.data.agents = () => agents.map((a) => ({ ...a }));
  b.data.transcript = () => ({ ...sampleTranscript(now), agentCalls: calls.map((c) => ({ ...c })) });
  return b;
}

function gsdProject(now: number): ScenarioBundle {
  const b = base(now);
  b.data.gsd = sampleGsd;
  return b;
}

function noGit(now: number): ScenarioBundle {
  const b = base(now);
  const p = b.payload;
  b.data.git = () => null;
  if (p.workspace) {
    delete p.workspace.repo;
    delete p.workspace.git_worktree;
  }
  delete p.pr;
  delete p.worktree;
  return b;
}

function apiKeyUser(now: number): ScenarioBundle {
  const b = base(now);
  delete b.payload.rate_limits;
  b.env = { ANTHROPIC_API_KEY: 'sk-ant-scenario' };
  return b;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'fresh-session',
    label: 'Fresh session',
    description: 'A new session before the first reply',
    build: freshSession,
  },
  {
    id: 'context-full',
    label: 'Context nearly full',
    description: 'The context window is about 94% full',
    build: contextFull,
  },
  {
    id: 'near-5h-limit',
    label: 'Near the 5h limit',
    description: '92% of the five-hour limit used, resets in 25 minutes',
    build: near5hLimit,
  },
  {
    id: 'many-subagents',
    label: 'Many subagents',
    description: 'Eight subagents, five running and three done',
    build: manySubagents,
  },
  {
    id: 'gsd-project',
    label: 'GSD project',
    description: 'A project with GSD planning in progress',
    build: gsdProject,
  },
  {
    id: 'no-git',
    label: 'No git repo',
    description: 'A folder that is not a git repository',
    build: noGit,
  },
  {
    id: 'api-key-user',
    label: 'API key user',
    description: 'Billed by API key, so there are no plan limits',
    build: apiKeyUser,
  },
];

export function getScenario(id: string): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

export function scenarioList(): { id: string; label: string; description: string }[] {
  return SCENARIOS.map(({ id, label, description }) => ({ id, label, description }));
}

const DROP = [/^CLAUDE_CODE_USE_/, /^ANTHROPIC_/];

export function scenarioEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN' || DROP.some((re) => re.test(k))) delete env[k];
  }
  env.NO_COLOR = undefined;
  env.FORCE_COLOR = undefined;
  return Object.assign(env, extra);
}
