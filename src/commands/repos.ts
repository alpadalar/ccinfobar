import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { loadForUse } from '../core/load.js';
import { executeJob, type Job, jobOff, releaseLock } from '../data/jobs/runner.js';
import { legacyDirtyFile, reposKey } from '../data/repos.js';

export { checkRepos, computeDirty, dirtyOrder } from '../data/repos-dirty.js';

// hidden alias for renders that still spawn `repos --background`
export async function runRepos(args: Args, cfgFile: string, jobs: Job<unknown>[]): Promise<void> {
  const cwd = args.positional[0];
  if (args.flags.background !== true || !cwd || !path.isAbsolute(cwd)) return;
  const root = path.resolve(cwd);
  const env = process.env;
  const req = { key: reposKey(root), param: root };
  try {
    const loaded = loadForUse(cfgFile);
    if (loaded.issue || loaded.error) return;
    const input = { config: loaded.config, env, cwd: root };
    const reposJob = jobs.find((j) => j.keyRe.test(req.key));
    if (!reposJob?.paramRe?.test(root) || jobOff(reposJob.network, env) || !reposJob.accepts(req, input))
      return;
    const prev = reposJob.readPrev?.(req.key, env) ?? null;
    const ctx = { ...input, prev, fetch: globalThis.fetch, now: Date.now() };
    await executeJob(reposJob, req, ctx, env);
  } catch {
  } finally {
    releaseLock(req.key, env);
    try {
      fs.unlinkSync(`${legacyDirtyFile(root, env)}.lock`);
    } catch {}
  }
}
