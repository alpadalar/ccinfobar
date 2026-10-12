import { readAgents } from '../data/agents.js';
import { readGit } from '../data/git.js';
import { readGsd } from '../data/gsd.js';
import { readTranscript } from '../data/transcript.js';
import type { Config, DataSources, RenderContext, StatusPayload } from './types.js';

function lazy<T>(fn: () => T): () => T {
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
      git: opts.data?.git ?? lazy(() => readGit(cwd)),
      transcript,
      gsd: opts.data?.gsd ?? lazy(() => readGsd(cwd)),
      ...(opts.data?.history ? { history: opts.data.history } : {}),
      agents:
        opts.data?.agents ??
        lazy(() => readAgents(opts.payload.transcript_path, transcript(), now.getTime(), env)),
    },
  };
}
