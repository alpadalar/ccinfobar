import path from 'node:path';
import { configPath } from '../../core/paths.js';
import type { Config, StatusPayload } from '../../core/types.js';
import type { WorkspaceRepos } from '../repos.js';
import { updateJob } from '../update-state.js';
import { commandJob } from './command.js';
import { ghJob } from './gh.js';
import { httpJob } from './http.js';
import { reposJob } from './repos.js';
import {
  blockedByTraffic,
  type Job,
  type JobReader,
  type JobRequest,
  jobsDisabled,
  readEnvelope,
  scheduleRequests,
  type spawnSelf,
} from './runner.js';
import { statusJob } from './status.js';
import { usageJob } from './usage.js';

export const JOBS: Job<unknown>[] = [
  updateJob as Job<unknown>,
  usageJob as Job<unknown>,
  statusJob as Job<unknown>,
  httpJob as Job<unknown>,
  ghJob as Job<unknown>,
  reposJob as Job<unknown>,
  commandJob as Job<unknown>,
];

export function jobFor(key: string, jobs: Job<unknown>[] = JOBS): Job<unknown> | undefined {
  return jobs.find((j) => j.keyRe.test(key));
}

export function scheduleJobs(
  config: Config,
  payload: StatusPayload,
  env: NodeJS.ProcessEnv,
  cwd: string,
  cfgFile: string | null,
  opts: {
    now?: number;
    spawn?: typeof spawnSelf;
    jobs?: Job<unknown>[];
    repos?: () => WorkspaceRepos | null;
    reader?: JobReader;
  } = {},
): string[] {
  if (jobsDisabled(env)) return [];
  const now = opts.now ?? Date.now();
  const kept: { req: JobRequest; lockMs: number }[] = [];
  for (const job of opts.jobs ?? JOBS) {
    if (blockedByTraffic(job.network, env)) continue;
    try {
      const input = { config, payload, env, cwd, now, ...(opts.repos ? { repos: opts.repos } : {}) };
      for (const req of job.keys(input)) {
        const read = () =>
          job.readPrev
            ? job.readPrev(req.key, env, opts.reader)
            : opts.reader
              ? opts.reader.job(req.key)
              : readEnvelope(req.key, env);
        let prev = read();
        if (job.due(prev, now, req) && opts.reader?.refresh) {
          // a worker may have finished during this render
          opts.reader.refresh(req.key);
          prev = read();
        }
        if (job.due(prev, now, req)) kept.push({ req, lockMs: job.lockMs });
      }
    } catch {}
  }
  if (!kept.length) return [];
  const extra: string[] = [];
  // the worker loads the same config
  if (typeof cfgFile === 'string' && path.resolve(cfgFile) !== path.resolve(configPath(env)))
    extra.push(`--config=${path.resolve(cfgFile)}`);
  if (path.isAbsolute(cwd)) extra.push(`--cwd=${cwd}`);
  return scheduleRequests(kept, env, extra, { now, ...(opts.spawn ? { spawn: opts.spawn } : {}) });
}
