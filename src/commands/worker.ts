import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { defaultConfig } from '../core/config.js';
import { loadForUse } from '../core/load.js';
import { cacheDir } from '../core/paths.js';
import type { Config, StatusPayload } from '../core/types.js';
import { gsdInstalled } from '../data/gsd.js';
import {
  type ExecFileLike,
  executeJob,
  type Job,
  type JobRequest,
  jobOff,
  jobsDir,
  parseArg,
  readEnvelope,
  releaseLock,
  SAFE_KEY,
} from '../data/jobs/runner.js';
import { pruneTmp } from '../data/store.js';

export interface WorkerDeps {
  // main passes the registry, so it stays in the cli chunk
  jobs: Job<unknown>[];
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  execFile?: ExecFileLike;
  exit?: (code: number) => void;
  now?: () => number;
  silent?: boolean;
  takeOver?: (env: NodeJS.ProcessEnv) => void;
}

// longer than the update job's install, verify and rollback budgets
export const WORKER_DEADLINE_MS = 570_000;
const MAX_REQUESTS = 32;
const MAX_ARG = 4200;
const SWEEP_AGE = 7 * 86_400_000;
const CACHE_AGE = 30 * 86_400_000;
const CACHE_RE =
  /^(transcript|agent3|cmd|repos|repos-dirty|env|bin|git|jj|jj-miss|jj-backoff|agents-dir)-[0-9a-f]{20}\.json$/;
const WIDTH_RE = /^width-[A-Za-z0-9_-]{1,128}\.json$/;
const LEGACY_RE = /^agent2-[0-9a-f]{20}\.json$/;
const SWEEP_RE = /^((?:http|gh)-[0-9a-f]{16})\.json$/;

// own copy: importing cli/silence.ts would split it out of bin.ts
function quiet(): void {
  const noop = (() => true) as typeof process.stdout.write;
  process.stdout.write = noop;
  process.stderr.write = noop;
  process.removeAllListeners('warning');
  const bye = () => process.exit(0);
  process.on('uncaughtException', bye);
  process.on('unhandledRejection', bye);
  setTimeout(bye, WORKER_DEADLINE_MS).unref();
}

export function parseWorkerArgs(positional: string[]): JobRequest[] {
  const out: JobRequest[] = [];
  const seen = new Set<string>();
  for (const a of positional) {
    if (out.length >= MAX_REQUESTS) break;
    if (a.length > MAX_ARG) continue;
    const req = parseArg(a);
    if (!SAFE_KEY.test(req.key) || seen.has(req.key)) continue;
    seen.add(req.key);
    out.push(req);
  }
  return out;
}

export function sweepJobs(env: NodeJS.ProcessEnv, keep: Set<string>, now: number): void {
  const dir = jobsDir(env);
  pruneTmp(dir, 3_600_000, now);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const key = SWEEP_RE.exec(name)?.[1];
    if (!key || keep.has(key)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && now - st.mtimeMs > SWEEP_AGE) fs.unlinkSync(p);
    } catch {}
  }
}

// per-session files only; account and update state stay
export function sweepCache(env: NodeJS.ProcessEnv, now: number): void {
  const dir = cacheDir(env);
  pruneTmp(dir, 3_600_000, now);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const legacy = LEGACY_RE.test(name);
    if (!legacy && !CACHE_RE.test(name) && !WIDTH_RE.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && (legacy || now - st.mtimeMs > CACHE_AGE)) fs.unlinkSync(p);
    } catch {}
  }
}

function accepted(job: Job<unknown> | undefined, req: JobRequest, ok: (job: Job<unknown>) => boolean) {
  if (!job) return false;
  const param = req.param;
  if (param !== undefined ? !job.paramRe?.test(param) : !!job.paramRe && !job.paramOptional) return false;
  try {
    return ok(job);
  } catch {
    return false;
  }
}

// ran keys too: gh keys need the payload, which the worker never gets
function liveKeys(
  jobs: Job<unknown>[],
  config: Config,
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: number,
  ran: string[],
) {
  const keep = new Set<string>(ran);
  const payload = {} as StatusPayload;
  for (const job of jobs) {
    try {
      for (const r of job.keys({ config, payload, env, cwd, now })) keep.add(r.key);
    } catch {}
  }
  return keep;
}

export async function runWorker(args: Args, cfgFile: string, deps: WorkerDeps): Promise<void> {
  if (deps.silent !== false) quiet();
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  try {
    const env = deps.env ?? process.env;
    const jobs = deps.jobs;
    const now = deps.now?.() ?? Date.now();
    const file = typeof args.flags.config === 'string' ? path.resolve(args.flags.config) : cfgFile;
    const cwdFlag = args.flags.cwd;
    const cwd = typeof cwdFlag === 'string' && path.isAbsolute(cwdFlag) ? cwdFlag : process.cwd();
    const loaded = loadForUse(file, () => gsdInstalled(env));
    const broken = !!(loaded.issue || loaded.error);
    const config = broken ? defaultConfig() : loaded.config;
    const runs: Promise<unknown>[] = [];
    const ran: string[] = [];
    for (const req of parseWorkerArgs(args.positional)) {
      const job = jobs.find((j) => j.keyRe.test(req.key));
      const ok = accepted(
        job,
        req,
        (j) =>
          !jobOff(j.network, env) &&
          (!broken || j.id === 'update') &&
          j.accepts(req, { config, env, cwd }) === true,
      );
      if (!ok || !job) {
        releaseLock(req.key, env);
        continue;
      }
      ran.push(req.key);
      runs.push(
        Promise.resolve().then(() => {
          let prev = null;
          try {
            prev = job.readPrev?.(req.key, env) ?? readEnvelope(req.key, env);
          } catch {}
          return executeJob(
            job,
            req,
            {
              env,
              config,
              cwd,
              prev,
              fetch: deps.fetch ?? globalThis.fetch,
              ...(deps.execFile ? { execFile: deps.execFile } : {}),
              now,
              clock: deps.now ?? Date.now,
            },
            env,
          );
        }),
      );
    }
    await Promise.allSettled(runs);
    // the update job may have moved the binary; keep project status lines on it
    if (ran.includes('update')) {
      try {
        (deps.takeOver ?? (await import('./update.js')).takeOverAfterUpdate)(env);
      } catch {}
    }
    const end = deps.now?.() ?? Date.now();
    // a broken config would look like every http key is gone
    if (broken) pruneTmp(jobsDir(env), 3_600_000, end);
    else sweepJobs(env, liveKeys(jobs, config, env, cwd, end, ran), end);
    sweepCache(env, end);
  } catch {}
  exit(0);
}
