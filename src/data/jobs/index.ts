import path from 'node:path';
import { configPath } from '../../core/paths.js';
import type { Config, StatusPayload } from '../../core/types.js';
import {
  blockedByTraffic,
  type Job,
  type JobRequest,
  jobsDisabled,
  readEnvelope,
  scheduleRequests,
  type spawnSelf,
} from './runner.js';
import { statusJob } from './status.js';
import { updateJob } from './update.js';
import { usageJob } from './usage.js';

// later plans register http, gh and repos here
export const JOBS: Job<unknown>[] = [
  updateJob as Job<unknown>,
  usageJob as Job<unknown>,
  statusJob as Job<unknown>,
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
  opts: { now?: number; spawn?: typeof spawnSelf; jobs?: Job<unknown>[] } = {},
): string[] {
  if (jobsDisabled(env)) return [];
  const now = opts.now ?? Date.now();
  const kept: { req: JobRequest; lockMs: number }[] = [];
  for (const job of opts.jobs ?? JOBS) {
    if (blockedByTraffic(job.network, env)) continue;
    try {
      for (const req of job.keys({ config, payload, env, cwd, now })) {
        const prev = job.readPrev ? job.readPrev(req.key, env) : readEnvelope(req.key, env);
        if (job.due(prev, now, req)) kept.push({ req, lockMs: job.lockMs });
      }
    } catch {}
  }
  if (!kept.length) return [];
  const extra: string[] = [];
  // the worker loads the same config
  if (typeof cfgFile === 'string' && cfgFile !== configPath(env)) extra.push(`--config=${cfgFile}`);
  if (path.isAbsolute(cwd)) extra.push(`--cwd=${cwd}`);
  return scheduleRequests(kept, env, extra, { now, ...(opts.spawn ? { spawn: opts.spawn } : {}) });
}
