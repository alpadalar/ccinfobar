import { samplePayload } from '../core/sample.js';
import { getScenario, SCENARIO_NOW } from '../core/scenarios.js';
import type { StatusPayload } from '../core/types.js';

export interface Stats {
  n: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

export interface BenchDirs {
  cache: string;
  config: string;
  claude: string;
  compile: string;
}

// median: mean of the two middle values for even n; p95: nearest rank
export function stats(ms: number[]): Stats {
  const s = [...ms].sort((a, b) => a - b);
  const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
  return { n, median, p95: s[Math.max(0, Math.ceil(0.95 * n) - 1)]!, min: s[0]!, max: s[n - 1]! };
}

export function overhead(warm: Stats, control: Stats): number {
  return warm.median - control.median;
}

export function clampRuns(v: string | boolean | undefined): number {
  if (typeof v !== 'string' || v.trim() === '') return 20;
  const n = Number(v);
  if (!Number.isFinite(n)) return 20;
  return Math.min(1000, Math.max(1, Math.floor(n)));
}

export function benchEnv(
  base: NodeJS.ProcessEnv,
  dirs: BenchDirs,
  opts: { compileCache?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CCINFOBAR_CONFIG;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  env.CCINFOBAR_CACHE_DIR = dirs.cache;
  env.CCINFOBAR_CONFIG_DIR = dirs.config;
  env.CLAUDE_CONFIG_DIR = dirs.claude;
  env.NODE_COMPILE_CACHE = dirs.compile;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.COLUMNS = '140';
  if (opts.compileCache === false) env.NODE_DISABLE_COMPILE_CACHE = '1';
  return env;
}

export function benchPayload(
  scenarioId: string | undefined,
  cwd: string,
  transcriptPath: string,
): StatusPayload {
  const scenario = scenarioId ? getScenario(scenarioId) : undefined;
  const p = scenario ? scenario.build(SCENARIO_NOW).payload : samplePayload(SCENARIO_NOW);
  p.cwd = cwd;
  p.workspace = { ...p.workspace, current_dir: cwd, project_dir: cwd };
  p.transcript_path = transcriptPath;
  return p;
}

const TOOLS = ['Read', 'Grep', 'Edit', 'Bash', 'Glob'];

export function syntheticTranscript(now: number): string {
  const lines: string[] = [];
  const turns = 100;
  const start = now - turns * 30_000;
  const session = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const ts = (ms: number) => new Date(start + i * 30_000 + ms).toISOString();
    const userId = `u-${i}`;
    const tool = i % 10 === 5 ? `toolu_${i}` : null;
    const prevTool = i % 10 === 6 ? `toolu_${i - 1}` : null;
    const userContent = prevTool
      ? [{ type: 'tool_result', tool_use_id: prevTool, content: 'ok' }]
      : `Step ${i}: refactor the status line renderer`;
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: userId,
        parentUuid: parent,
        sessionId: session,
        timestamp: ts(0),
        message: { role: 'user', content: userContent },
      }),
    );
    const content: unknown[] = [{ type: 'text', text: `Done with step ${i}.` }];
    if (tool) {
      content.push({
        type: 'tool_use',
        id: tool,
        name: TOOLS[i % TOOLS.length],
        input: { file_path: `src/file-${i}.ts`, pattern: 'x', command: 'true' },
      });
    }
    const asstId = `a-${i}`;
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: asstId,
        parentUuid: userId,
        sessionId: session,
        requestId: `req_${i}`,
        timestamp: ts(12_000),
        message: {
          id: `msg_${i}`,
          role: 'assistant',
          model: 'claude-opus-5-5',
          content,
          usage: {
            input_tokens: 40 + (i % 7),
            output_tokens: 300 + ((i * 37) % 500),
            cache_creation_input_tokens: 1_200 + ((i * 13) % 900),
            cache_read_input_tokens: 20_000 + i * 2_500,
          },
        },
      }),
    );
    parent = asstId;
  }
  return `${lines.join('\n')}\n`;
}
