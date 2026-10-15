import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { applyLanguage } from '../cli/lang.js';
import { t, withLanguage } from '../core/i18n/index.js';
import { loadForUse } from '../core/load.js';
import { configDir } from '../core/paths.js';
import { scenarioFlag, scenarioListLines } from '../core/preview.js';
import { samplePayload } from '../core/sample.js';
import { sanitizeText } from '../core/sanitize.js';
import { getScenario, SCENARIO_NOW, scenarioConfig, scenarioEnv } from '../core/scenarios.js';
import type { Config, StatusPayload } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { writeAtomic } from '../data/store.js';
import { type CliIo, cliIo, reportConfigIssue } from './io.js';

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

// null for a bare or non-numeric --runs
export function parseRuns(v: string | boolean | undefined): number | null {
  if (v === undefined || v === false) return 20;
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
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
  env.CCINFOBAR_NO_JOBS = '1';
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

// payload and env only; data injectors cannot reach the child
export function benchBaseEnv(base: NodeJS.ProcessEnv, scenarioId: string | undefined): NodeJS.ProcessEnv {
  const scenario = scenarioId ? getScenario(scenarioId) : undefined;
  return scenario ? scenarioEnv(base, scenario.build(SCENARIO_NOW).env) : base;
}

// null when the scenario keeps the user's config
export function benchConfig(scenarioId: string | undefined, config: Config): Config | null {
  const bundle = scenarioId ? getScenario(scenarioId)?.build(SCENARIO_NOW) : undefined;
  return bundle?.config ? scenarioConfig(config, bundle) : null;
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

export interface BenchOptions {
  entry?: string;
  runs: number;
  scenario?: string;
  json: boolean;
  cfgFile: string;
  cwd?: string;
}

type RowName = 'control' | 'cold' | 'warm' | 'warm-no-compile-cache' | 'hook';

const LABELS = {
  control: 'bench.row.control',
  cold: 'bench.row.cold',
  warm: 'bench.row.warm',
  'warm-no-compile-cache': 'bench.row.warmNoCache',
  hook: 'bench.row.hook',
} as const;

const HOOK_INPUT = JSON.stringify({
  session_id: 'bench-hook',
  hook_event_name: 'UserPromptSubmit',
  prompt_id: 'bench',
});

class RunFailed extends Error {
  constructor(
    readonly row: RowName,
    readonly code: string | number,
    readonly stderr: string,
  ) {
    super(row);
  }
}

function inGitRepo(dir: string): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function priority(): number | null {
  try {
    return os.getPriority();
  } catch {
    return null;
  }
}

function prepareDirs(base: string, cfgFile: string, config: Config | null): BenchDirs {
  const dirs: BenchDirs = {
    cache: path.join(base, 'cache'),
    config: path.join(base, 'config'),
    claude: path.join(base, 'claude'),
    compile: path.join(base, 'compile'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const copy = path.join(dirs.config, 'config.json');
  if (config) {
    if (!writeAtomic(copy, `${JSON.stringify(config, null, 2)}\n`)) throw new Error(`cannot write ${copy}`);
  } else if (fs.existsSync(cfgFile)) fs.copyFileSync(cfgFile, copy);
  if (fs.existsSync(copy) && process.platform !== 'win32') fs.chmodSync(copy, 0o444);
  const themes = path.join(configDir(), 'themes');
  if (fs.existsSync(themes)) fs.cpSync(themes, path.join(dirs.config, 'themes'), { recursive: true });
  return dirs;
}

const rm = (p: string) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

const round = (n: number) => Math.round(n * 100) / 100;

export function runBench(opts: BenchOptions, io: CliIo = cliIo()): number {
  const flag = scenarioFlag(opts.scenario);
  if (flag.kind === 'list') {
    for (const line of scenarioListLines()) io.log(line);
    return 0;
  }
  if (flag.kind === 'unknown') {
    io.error(t('preview.unknownScenario', { name: sanitizeText(flag.name) }));
    for (const line of scenarioListLines().slice(1)) io.error(line);
    return 1;
  }
  const loaded = loadForUse(opts.cfgFile);
  if (reportConfigIssue(loaded, io)) return 1;
  applyLanguage(loaded.config);
  const entry = opts.entry ?? process.argv[1];
  if (!entry) {
    io.error(t('bench.noEntry'));
    return 1;
  }
  const scenario = flag.kind === 'scenario' ? flag.id : undefined;
  const runs = opts.runs;
  const cwd = opts.cwd ?? process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-bench-'));
  try {
    const transcript = path.join(root, 'transcript.jsonl');
    if (!writeAtomic(transcript, syntheticTranscript(SCENARIO_NOW)))
      throw new Error(`cannot write ${transcript}`);
    const input = JSON.stringify(benchPayload(scenario, cwd, transcript));

    const time = (row: RowName, args: string[], env: NodeJS.ProcessEnv, stdin = input): number => {
      const t0 = process.hrtime.bigint();
      const r = spawnSync(process.execPath, args, {
        input: stdin,
        env,
        cwd,
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: 15_000,
        windowsHide: true,
      });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (r.error || r.signal || r.status !== 0) {
        const code = r.status ?? r.signal ?? (r.error as NodeJS.ErrnoException | undefined)?.code ?? '?';
        throw new RunFailed(row, code, String(r.stderr ?? '').slice(0, 4000));
      }
      return ms;
    };
    const repeat = (fn: () => number) => Array.from({ length: runs }, fn);

    const baseEnv = benchBaseEnv(process.env, scenario);
    const config = benchConfig(scenario, loaded.config);
    const shared = prepareDirs(path.join(root, 'shared'), opts.cfgFile, config);
    const control = repeat(() => time('control', ['-e', '0'], benchEnv(baseEnv, shared)));
    let i = 0;
    const cold = repeat(() => {
      const base = path.join(root, `cold-${i++}`);
      const env = benchEnv(baseEnv, prepareDirs(base, opts.cfgFile, config));
      const ms = time('cold', [entry], env);
      rm(base);
      return ms;
    });
    const warmEnv = benchEnv(baseEnv, shared);
    for (let w = 0; w < 2; w++) time('warm', [entry], warmEnv);
    const warm = repeat(() => time('warm', [entry], warmEnv));
    const noCacheEnv = benchEnv(baseEnv, shared, { compileCache: false });
    const noCache = repeat(() => time('warm-no-compile-cache', [entry], noCacheEnv));
    const hookArgs = [entry, 'hook', 'UserPromptSubmit'];
    for (let w = 0; w < 2; w++) time('hook', hookArgs, warmEnv, HOOK_INPUT);
    const hook = repeat(() => time('hook', hookArgs, warmEnv, HOOK_INPUT));

    const rows: [RowName, Stats][] = [
      ['control', stats(control)],
      ['cold', stats(cold)],
      ['warm', stats(warm)],
      ['warm-no-compile-cache', stats(noCache)],
      ['hook', stats(hook)],
    ];
    report(io, {
      scenario: scenario ?? 'sample',
      runs,
      gitRepo: inGitRepo(cwd),
      rows,
      overheadMs: overhead(rows[2]![1], rows[0]![1]),
      hookOverheadMs: overhead(rows[4]![1], rows[0]![1]),
      json: opts.json,
    });
    return 0;
  } catch (err) {
    if (!(err instanceof RunFailed)) throw err;
    io.error(t('bench.failed', { row: t(LABELS[err.row]), code: sanitizeText(String(err.code)) }));
    const stderr = err.stderr.trim();
    for (const line of stderr ? stderr.split(/\r?\n/) : []) io.error(`  ${sanitizeText(line)}`);
    return 1;
  } finally {
    rm(root);
  }
}

function report(
  io: CliIo,
  r: {
    scenario: string;
    runs: number;
    gitRepo: boolean;
    rows: [RowName, Stats][];
    overheadMs: number;
    hookOverheadMs: number;
    json: boolean;
  },
): void {
  const cpus = os.cpus();
  const cpu = { model: sanitizeText(cpus[0]?.model?.trim() || 'unknown'), count: cpus.length };
  const prio = priority();
  const sys = { type: os.type(), platform: process.platform, arch: process.arch, release: os.release() };
  if (r.json) {
    io.log(
      withLanguage('en', () =>
        JSON.stringify({
          schema: 1,
          version: VERSION,
          node: process.version,
          os: sys,
          cpu,
          priority: prio,
          scenario: r.scenario,
          runs: r.runs,
          gitRepo: r.gitRepo,
          rows: r.rows.map(([name, s]) => ({
            name,
            n: s.n,
            median: round(s.median),
            p95: round(s.p95),
            min: round(s.min),
            max: round(s.max),
          })),
          overheadMs: round(r.overheadMs),
          hookOverheadMs: round(r.hookOverheadMs),
        }),
      ),
    );
    return;
  }
  io.log(t('bench.title', { version: VERSION }));
  io.log(t('bench.node', { node: process.version }));
  io.log(
    t('bench.os', {
      os: sanitizeText(sys.type),
      release: sanitizeText(sys.release),
      platform: sys.platform,
      arch: sys.arch,
    }),
  );
  io.log(t('bench.cpu', cpu));
  io.log(t('bench.priority', { priority: prio ?? '?' }));
  io.log(t('bench.scenario', { scenario: r.scenario }));
  io.log(t('bench.runs', { runs: r.runs }));
  io.log(t(r.gitRepo ? 'bench.gitRepo' : 'bench.notGitRepo'));
  if (prio !== null && prio > 0) io.log(t('bench.niceWarning'));
  if (process.platform === 'win32') io.log(t('bench.windowsNote'));
  io.log('');
  const head = [
    'bench.col.n',
    'bench.col.median',
    'bench.col.p95',
    'bench.col.min',
    'bench.col.max',
  ] as const;
  const labels = r.rows.map(([name]) => t(LABELS[name]));
  const pad = Math.max(t('bench.col.row').length, ...labels.map((l) => l.length));
  const cols = r.rows.map(([, s]) => [
    String(s.n),
    ...[s.median, s.p95, s.min, s.max].map((v) => v.toFixed(1)),
  ]);
  const widths = head.map((h, c) => Math.max(t(h).length, ...cols.map((row) => row[c]!.length)));
  const line = (label: string, cells: string[]) =>
    [label.padEnd(pad), ...cells.map((v, c) => v.padStart(widths[c]!))].join('  ');
  io.log(
    `${line(
      t('bench.col.row'),
      head.map((h) => t(h)),
    )}  ${t('bench.unit')}`,
  );
  for (let k = 0; k < r.rows.length; k++) io.log(line(labels[k]!, cols[k]!));
  io.log('');
  io.log(t('bench.overhead', { ms: r.overheadMs.toFixed(1) }));
  io.log(t('bench.hookOverhead', { ms: r.hookOverheadMs.toFixed(1) }));
}

export function runBenchCommand(args: Args, cfgFile: string, io: CliIo = cliIo()): void {
  const scenario = args.flags.scenario;
  const runs = parseRuns(args.flags.runs);
  if (runs === null) {
    io.error(t('bench.badRuns'));
    process.exitCode = 1;
    return;
  }
  const code = runBench(
    {
      runs,
      ...(scenario === true ? { scenario: '' } : typeof scenario === 'string' ? { scenario } : {}),
      json: args.flags.json === true,
      cfgFile,
    },
    io,
  );
  if (code !== 0) process.exitCode = code;
}
