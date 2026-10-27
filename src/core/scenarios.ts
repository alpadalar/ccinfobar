import type { AgentInfo } from '../data/agents.js';
import type { JobEnvelope } from '../data/jobs/runner.js';
import type { AgentCall } from '../data/transcript.js';
import type { GhValue, StatusValue } from './job-values.js';
import {
  sampleAgents,
  sampleEnvironment,
  sampleGit,
  sampleGsd,
  sampleHistory,
  sampleHooks,
  sampleJobs,
  sampleLedger,
  sampleLimits,
  samplePayload,
  sampleRepos,
  sampleTranscript,
} from './sample.js';
import type { Config, DataSources, StatusPayload } from './types.js';

export const SCENARIO_NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

export interface ScenarioBundle {
  payload: StatusPayload;
  data: Required<DataSources>;
  env: Record<string, string>;
  config?: Partial<Config>;
}

export interface Scenario {
  id: string;
  label: string;
  description: string;
  build(now: number): ScenarioBundle;
}

function base(now: number): ScenarioBundle {
  const b: ScenarioBundle = {
    payload: samplePayload(now),
    data: {
      git: sampleGit,
      transcript: () => sampleTranscript(now),
      gsd: () => null,
      jj: () => null,
      history: () => sampleHistory(now),
      agents: () => sampleAgents(now),
      // follows the bundle's rate_limits
      limits: () => sampleLimits(now, b.payload.rate_limits ?? null),
      ledger: () => sampleLedger(now),
      jobs: () => sampleJobs(now),
      repos: () => null,
      hooks: () => sampleHooks(now),
      environment: sampleEnvironment,
    },
    env: {},
  };
  return b;
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
  b.data.ledger = () => null;
  b.data.hooks = () => null;
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
  // history sized for this window, ending at 188k
  b.data.history = () =>
    sampleHistory(now).map((s, i, a) => ({ ...s, ctx: Math.round(120_000 + (i / (a.length - 1)) * 68_000) }));
  return b;
}

function near5hLimit(now: number): ScenarioBundle {
  const b = base(now);
  const sec = Math.floor(now / 1000);
  const r = b.payload.rate_limits ?? {};
  b.payload.rate_limits = { ...r, five_hour: { used_percentage: 92, resets_at: sec + 25 * 60 } };
  return b;
}

function near7dLimit(now: number): ScenarioBundle {
  const b = base(now);
  const sec = Math.floor(now / 1000);
  const r = b.payload.rate_limits ?? {};
  // base limits() follows the payload
  b.payload.rate_limits = { ...r, seven_day: { used_percentage: 80, resets_at: sec + 86_400 } };
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

function workspaceFolder(now: number): ScenarioBundle {
  const b = noGit(now);
  const ws = { ...sampleRepos(now), dirty: { api: true } };
  b.data.repos = () => ws;
  b.payload.cwd = ws.root;
  if (b.payload.workspace) {
    b.payload.workspace.current_dir = ws.root;
    b.payload.workspace.project_dir = ws.root;
  }
  return b;
}

function apiKeyUser(now: number): ScenarioBundle {
  const b = base(now);
  delete b.payload.rate_limits;
  b.env = { ANTHROPIC_API_KEY: 'sk-ant-scenario' };
  b.data.ledger = () => null;
  return b;
}

function bedrockUser(now: number): ScenarioBundle {
  const b = base(now);
  delete b.payload.rate_limits;
  b.env = { CLAUDE_CODE_USE_BEDROCK: '1' };
  b.data.ledger = () => null;
  return b;
}

function gatewayGlm(now: number): ScenarioBundle {
  const b = base(now);
  b.payload.rate_limits = {
    spend_limit: { used_percentage: 63, resets_at: Math.floor(now / 1000) + 6 * 3600 },
  };
  b.payload.model = { id: 'glm-5.3', display_name: 'glm-5.3' };
  b.env = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'scenario-token' };
  b.data.ledger = () => null;
  return b;
}

function overBudget(now: number): ScenarioBundle {
  const b = base(now);
  b.config = { budget: { daily: 3, warnAt: 0.8 } };
  b.data.ledger = () => ({ ...sampleLedger(now), today: 4.12 });
  return b;
}

function waitingPermission(now: number): ScenarioBundle {
  const b = base(now);
  const h = { ...sampleHooks(now), lastPermission: { since: now - 60_000, end: now - 18_000, tool: 'Bash' } };
  b.data.hooks = () => h;
  return b;
}

function serviceIncident(now: number): ScenarioBundle {
  const b = base(now);
  const at = now - 30_000;
  const value: StatusValue = {
    indicator: 'major',
    description: 'Partial System Outage',
    incidents: [
      {
        name: 'Elevated errors on Claude Opus',
        impact: 'major',
        components: ['Claude API (api.anthropic.com)'],
        updatedAt: new Date(now - 12 * 60_000).toISOString(),
      },
    ],
  };
  const status: JobEnvelope<StatusValue> = {
    v: 1,
    key: 'status',
    fetchedAt: at,
    ok: true,
    value,
    attempts: 0,
    lastGood: value,
    lastGoodAt: at,
  };
  const jobs = sampleJobs(now);
  b.data.jobs = () => ({
    job: <V>(key: string) => (key === 'status' ? (status as JobEnvelope<V>) : jobs.job<V>(key)),
  });
  return b;
}

function prCiFailing(now: number): ScenarioBundle {
  const b = base(now);
  b.payload.pr = {
    number: 128,
    review_state: 'approved',
    url: 'https://github.com/acme/api/pull/128',
    kind: 'pr',
  };
  b.payload.workspace = { ...b.payload.workspace, repo: { host: 'github.com', owner: 'acme', name: 'api' } };
  const at = now - 30_000;
  const value: GhValue = {
    pass: 9,
    fail: 2,
    pending: 0,
    skipped: 0,
    cancelled: 0,
    total: 11,
    names: ['test (node 20)', 'lint'],
  };
  const jobs = sampleJobs(now);
  b.data.jobs = () => ({
    job: <V>(key: string) =>
      key.startsWith('gh-')
        ? ({
            v: 1,
            key,
            fetchedAt: at,
            ok: true,
            value,
            attempts: 0,
            lastGood: value,
            lastGoodAt: at,
          } as JobEnvelope<V>)
        : jobs.job<V>(key),
  });
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
    id: 'near-7d-limit',
    label: 'Near the weekly limit',
    description: '80% of the weekly limit used, resets in 1 day',
    build: near7dLimit,
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
  {
    id: 'bedrock-user',
    label: 'Bedrock user',
    description: 'Claude on Amazon Bedrock, so there are no plan limits',
    build: bedrockUser,
  },
  {
    id: 'gateway-glm',
    label: 'GLM gateway',
    description: 'GLM-5.3 through the Z.ai Anthropic gateway, with the profile window and prices',
    build: gatewayGlm,
  },
  {
    id: 'over-budget',
    label: 'Over budget',
    description: 'Daily budget of $3 exceeded',
    build: overBudget,
  },
  {
    id: 'workspace-folder',
    label: 'Workspace folder',
    description: 'A folder holding several repos that is not a repo itself',
    build: workspaceFolder,
  },
  {
    id: 'waiting-permission',
    label: 'Permission wait',
    description: 'The last permission prompt in this turn waited 42 s',
    build: waitingPermission,
  },
  {
    id: 'service-incident',
    label: 'Service incident',
    description: 'Claude has a major incident: elevated errors on Claude Opus',
    build: serviceIncident,
  },
  {
    id: 'pr-ci-failing',
    label: 'PR with failing CI',
    description: 'Pull request #128 is approved but 2 CI checks fail (shown by pr with the ci option)',
    build: prCiFailing,
  },
];

export function getScenario(id: string): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

export function scenarioList(): { id: string; label: string; description: string }[] {
  return SCENARIOS.map(({ id, label, description }) => ({ id, label, description }));
}

// shallow: a scenario key replaces the user's
export function scenarioConfig(config: Config, bundle: ScenarioBundle): Config {
  return bundle.config ? { ...config, ...bundle.config } : config;
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
