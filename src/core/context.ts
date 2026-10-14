import { readAgents } from '../data/agents.js';
import { readEnvironment } from '../data/environment.js';
import { readGit } from '../data/git.js';
import { readGsd } from '../data/gsd.js';
import { readHookState } from '../data/hooks.js';
import { hookTurnStart } from '../data/live.js';
import { readRepos } from '../data/repos.js';
import { readTranscript } from '../data/transcript.js';
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
}

export function resolveCwd(payload: StatusPayload): string {
  return payload.workspace?.current_dir ?? payload.cwd ?? process.cwd();
}

export function createContext(opts: ContextOptions): RenderContext {
  const cwd = resolveCwd(opts.payload);
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
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
    ...(opts.theme ? { theme: opts.theme } : {}),
    data: {
      git: opts.data?.git ?? lazy(() => readGit(cwd, { harden: opts.config.gitHardening !== false })),
      transcript,
      gsd: opts.data?.gsd ?? lazy(() => readGsd(cwd)),
      ...(opts.data?.history ? { history: opts.data.history } : {}),
      ...(opts.data?.limits ? { limits: opts.data.limits } : {}),
      ...(opts.data?.ledger ? { ledger: opts.data.ledger } : {}),
      repos:
        opts.data?.repos ??
        lazy(() => readRepos(cwd, env, { persist: !(opts.preview ?? false), now: now.getTime() })),
      hooks,
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
