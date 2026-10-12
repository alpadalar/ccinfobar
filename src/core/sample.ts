import type { AgentInfo } from '../data/agents.js';
import type { GitInfo } from '../data/git.js';
import type { GsdInfo } from '../data/gsd.js';
import type { HistorySample } from '../data/history.js';
import type { TranscriptInfo } from '../data/transcript.js';
import type { StatusPayload } from './types.js';

export function samplePayload(now = Date.now()): StatusPayload {
  const sec = Math.floor(now / 1000);
  return {
    hook_event_name: 'Status',
    session_id: '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f',
    session_name: 'statusline refactor',
    transcript_path: '',
    version: '2.1.300',
    cwd: '/home/dev/projects/acme-app',
    output_style: { name: 'default' },
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    effort: { level: 'high' },
    thinking: { enabled: true },
    fast_mode: false,
    workspace: {
      current_dir: '/home/dev/projects/acme-app',
      project_dir: '/home/dev/projects/acme-app',
      added_dirs: [],
      repo: { host: 'github.com', owner: 'acme', name: 'acme-app' },
    },
    cost: {
      total_cost_usd: 1.87,
      total_duration_ms: 2_730_000,
      total_api_duration_ms: 812_000,
      total_lines_added: 214,
      total_lines_removed: 63,
    },
    context_window: {
      context_window_size: 1_000_000,
      total_input_tokens: 412_000,
      total_output_tokens: 38_400,
      used_percentage: 34,
      remaining_percentage: 66,
      current_usage: {
        input_tokens: 2_100,
        output_tokens: 1_350,
        cache_creation_input_tokens: 4_800,
        cache_read_input_tokens: 333_100,
      },
    },
    exceeds_200k_tokens: true,
    prompt_cache: {
      warm: true,
      caching_observed: true,
      ttl: '1h',
      expires_at: sec + 41 * 60,
      requests: 48,
      misses: 3,
      expected_rebuilds: 1,
      hit_ratio: 0.94,
      last_miss_cause: 'tools_changed',
    },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: sec + 2 * 3600 + 14 * 60 },
      seven_day: { used_percentage: 61, resets_at: sec + 3 * 86400 + 5 * 3600 },
      seven_day_models: [{ model: 'Fable', used_percentage: 23, resets_at: sec + 3 * 86400 + 5 * 3600 }],
    },
    pr: {
      number: 128,
      url: 'https://github.com/acme/acme-app/pull/128',
      review_state: 'pending',
      kind: 'pr',
    },
    vim: { mode: 'INSERT' },
    terminal_width: 140,
  };
}

export function sampleGit(): GitInfo {
  return {
    root: '/home/dev/projects/acme-app',
    branch: 'feat/statusline',
    detached: false,
    sha: 'a1b2c3d',
    upstream: 'origin/feat/statusline',
    ahead: 2,
    behind: 0,
    staged: 3,
    unstaged: 2,
    untracked: 1,
    conflicts: 0,
    insertions: 148,
    deletions: 37,
    stash: 1,
    operation: null,
    remoteUrl: 'git@github.com:acme/acme-app.git',
    isWorktree: false,
  };
}

export function sampleTranscript(now = Date.now()): TranscriptInfo {
  return {
    inputTokens: 412_000,
    outputTokens: 38_400,
    cacheReadTokens: 3_120_000,
    cacheWriteTokens: 96_000,
    totalTokens: 3_666_400,
    contextLength: 340_000,
    messageCount: 86,
    userMessageCount: 14,
    compactions: 1,
    lastCommand: 'gsd-execute-phase',
    lastGsdCommand: 'gsd-execute-phase',
    skills: ['gsd-execute-phase', 'frontend-design'],
    sessionName: 'statusline refactor',
    firstTimestamp: now - 2_730_000,
    lastTimestamp: now - 4_000,
    outputSpeed: 72.4,
    currentTask: 'Wiring GSD widgets into renderer',
    todos: [
      { content: 'Parse GSD state', status: 'completed' },
      { content: 'Add sparkline buckets', status: 'completed' },
      {
        content: 'Wire GSD widgets into renderer',
        status: 'in_progress',
        activeForm: 'Wiring GSD widgets into renderer',
      },
      { content: 'Backfill renderer tests', status: 'pending' },
      { content: 'Update the README', status: 'pending' },
    ],
    agentCalls: [
      { id: 'toolu_explore', start: now - 90_000, done: null },
      { id: 'toolu_review', start: now - 75_000, done: null },
      { id: 'toolu_fix', start: now - 200_000, done: now - 30_000 },
    ],
    turnStart: now - 240_000,
  };
}

export function sampleAgents(now = Date.now()): AgentInfo[] {
  const agent = (
    id: string,
    type: string,
    description: string,
    tool: string,
    total: number,
    output: number,
    secs: number,
    model: string,
    running = true,
  ): AgentInfo => ({
    id,
    type,
    description,
    model,
    input: total - output,
    output,
    total,
    fresh: total,
    start: now - secs * 1000,
    last: now,
    tool,
    running,
  });
  return [
    agent(
      'a1',
      'Explore',
      'Find where token totals are computed',
      'Bash[grep -rn "billed_in" src/]',
      3_200,
      420,
      80,
      'claude-sonnet-5-5',
    ),
    agent(
      'a2',
      'general-purpose',
      'Review the border math',
      'Read[src/core/panel.ts]',
      5_400,
      980,
      76,
      'claude-sonnet-5-5',
    ),
    agent(
      'a3',
      'general-purpose',
      'Fix sparkline buckets',
      'Edit[src/widgets/charts.ts]',
      8_700,
      1_900,
      74,
      'claude-haiku-5-5',
      false,
    ),
  ];
}

// ends at the sample payload's numbers
export function sampleHistory(now = Date.now()): HistorySample[] {
  const n = 40;
  const wave = [3, 5, 9, 14, 11, 6, 4, 8, 13, 16, 12, 7, 5, 4, 6, 10, 15, 12, 8, 6];
  // steady growth with a compaction 12 samples ago
  const ctxAt = (back: number) => (back < 12 ? 340_000 - back * 9_000 : 520_000 - (back - 12) * 8_000);
  const out: HistorySample[] = [];
  let tok = 450_000;
  let cost = 1.87;
  for (let i = n - 1; i >= 0; i--) {
    out.unshift({
      t: now - (n - 1 - i) * 10_000,
      tok,
      ctx: Math.round(ctxAt(n - 1 - i)),
      cost: Math.round(cost * 1000) / 1000,
      h5: Math.max(0, 42 - (n - 1 - i) * 0.35),
      d7: 61,
      spd: 48 + wave[(i + 7) % wave.length]! * 2,
    });
    const step = wave[i % wave.length]! * 180;
    tok -= step;
    cost -= step * 0.0000035;
  }
  return out;
}

export function sampleGsd(): GsdInfo {
  return {
    planningDir: '/home/dev/projects/acme-app/.planning',
    projectDir: '/home/dev/projects/acme-app',
    workstream: null,
    milestone: 'v1.2',
    milestoneName: 'Billing',
    status: 'executing',
    statusText: 'In progress',
    activePhase: '4',
    phase: {
      number: '4',
      name: 'Invoice export',
      dir: '04-invoice-export',
      plans: 5,
      summaries: 3,
      complete: false,
    },
    phaseIndex: 4,
    phasesCompleted: 3,
    phasesTotal: 6,
    plansCompleted: 17,
    plansTotal: 26,
    percent: 50,
    nextAction: 'execute-phase',
    nextPhases: ['4'],
    blockers: ['Stripe sandbox keys pending'],
    pendingTodos: 2,
    requirementsDone: 14,
    requirementsTotal: 22,
    lastActivity: '2026-10-12',
    stoppedAt: null,
    update: { available: false, staleHooks: false, installed: '1.40.0', latest: '1.40.0' },
  };
}
