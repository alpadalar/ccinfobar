import { readAgents } from '../data/agents.js';
import { readEnvironment } from '../data/environment.js';
import { execCommand } from '../data/exec.js';
import { readGit } from '../data/git.js';
import { readGsd } from '../data/gsd.js';
import { readHookState } from '../data/hooks.js';
import { readJj } from '../data/jj.js';
import { createJobReader } from '../data/jobs/runner.js';
import { hookTurnStart } from '../data/live.js';
import { readRepos } from '../data/repos.js';
import { readTranscript } from '../data/transcript.js';
import { COMMAND_BUDGET_DEFAULT } from './display-opts.js';
import type { Config, DataSources, RenderContext, StatusPayload } from './types.js';

export function lazy<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      try {
        value = fn();
      } catch {
        value = null as T;
      }
      done = true;
    }
    return value;
  };
}

export interface ContextOptions {
  payload: StatusPayload;
  config: Config;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  preview?: boolean;
  terminalWidth?: number | null;
  data?: Partial<DataSources>;
  theme?: import('./themes.js').Theme;
  clock?: () => number;
}

export function resolveCwd(payload: StatusPayload): string {
  return payload.workspace?.current_dir ?? payload.cwd ?? process.cwd();
}

export function createContext(opts: ContextOptions): RenderContext {
  const cwd = resolveCwd(opts.payload);
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.config.commandBudgetMs ?? COMMAND_BUDGET_DEFAULT);
  const transcript = opts.data?.transcript ?? lazy(() => readTranscript(opts.payload.transcript_path));
  const hooks =
    opts.data?.hooks ??
    lazy(() => {
      const sid = opts.payload.session_id;
      return typeof sid === 'string' && sid
        ? readHookState(sid, env, { persist: !(opts.preview ?? false) })
        : null;
    });
  return {
    payload: opts.payload,
    config: opts.config,
    cwd,
    env,
    now,
    preview: opts.preview ?? false,
    terminalWidth: opts.terminalWidth ?? null,
    clock,
    budget: { deadline },
    ...(opts.theme ? { theme: opts.theme } : {}),
    data: {
      git:
        opts.data?.git ??
        lazy(() =>
          readGit(cwd, {
            harden: opts.config.gitHardening !== false,
            env,
            ...(opts.preview ? {} : { cache: { now: now.getTime(), persist: true } }),
          }),
        ),
      transcript,
      exec: opts.data?.exec ?? execCommand,
      gsd: opts.data?.gsd ?? lazy(() => readGsd(cwd)),
      jj:
        opts.data?.jj ??
        lazy(() => readJj(cwd, { env, now: now.getTime(), persist: !(opts.preview ?? false) })),
      ...(opts.data?.history ? { history: opts.data.history } : {}),
      ...(opts.data?.limits ? { limits: opts.data.limits } : {}),
      ...(opts.data?.ledger ? { ledger: opts.data.ledger } : {}),
      repos:
        opts.data?.repos ??
        lazy(() => readRepos(cwd, env, { persist: !(opts.preview ?? false), now: now.getTime() })),
      hooks,
      jobs: opts.data?.jobs ?? lazy(() => createJobReader(env)),
      environment:
        opts.data?.environment ??
        lazy(() =>
          readEnvironment(opts.payload.workspace?.project_dir ?? cwd, cwd, env, {
            persist: !(opts.preview ?? false),
            now: now.getTime(),
          }),
        ),
      agents:
        opts.data?.agents ??
        lazy(() => {
          const h = hooks();
          const t = transcript();
          const n = now.getTime();
          return readAgents(opts.payload.transcript_path, t, n, env, {
            hooks: h,
            turnStart: hookTurnStart(h, t, opts.payload.prompt_id, n),
          });
        }),
    },
  };
}
