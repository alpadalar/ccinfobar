import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheDir } from '../../core/paths.js';
import { deepSanitize, sanitizeText } from '../../core/sanitize.js';
import type { Config, StatusPayload } from '../../core/types.js';
import type { WorkspaceRepos } from '../repos.js';
import { acquireLock, writeAtomic } from '../store.js';

export type JobId = 'usage' | 'update' | 'status' | 'http' | 'gh' | 'repos';
export type JobNetwork = 'auto' | 'explicit' | 'none';

export interface JobRequest {
  key: string;
  param?: string;
  ttlMs?: number;
}

export interface JobEnvelope<V> {
  v: 1;
  key: string;
  fetchedAt: number;
  ok: boolean;
  value: V | null;
  error?: string;
  blockedUntil?: number;
  attempts?: number;
  lastGood?: V | null;
  lastGoodAt?: number;
  param?: string;
}

export interface JobInput {
  config: Config;
  payload: StatusPayload;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: number;
  // render's lazy scan, so keys() never scans twice
  repos?: () => WorkspaceRepos | null;
}

export interface AcceptInput {
  config: Config;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; errno?: string }>;

export interface JobCtx<V> {
  env: NodeJS.ProcessEnv;
  config: Config;
  cwd: string;
  prev: JobEnvelope<V> | null;
  fetch: typeof fetch;
  execFile?: ExecFileLike;
  now: number;
}

export interface Job<V> {
  id: JobId;
  network: JobNetwork;
  lockMs: number;
  timeoutMs: number;
  retryMs: number;
  keyRe: RegExp;
  paramRe?: RegExp;
  // a request may come without a param
  paramOptional?: boolean;
  keys(input: JobInput): JobRequest[];
  accepts(req: JobRequest, input: AcceptInput): boolean;
  due(envelope: JobEnvelope<V> | null, now: number, req: JobRequest): boolean;
  readPrev?(key: string, env: NodeJS.ProcessEnv): JobEnvelope<V> | null;
  run(req: JobRequest, ctx: JobCtx<V>): Promise<JobEnvelope<V>>;
}

export interface JobReader {
  job<V = unknown>(key: string): JobEnvelope<V> | null;
}

export const SAFE_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BACKOFF_MS = 1_800_000;
const MAX_RETRY_AFTER_MS = 86_400_000;
const MAX_ATTEMPTS = 16;

export function jobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'jobs');
}

export function envelopeFile(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(jobsDir(env), `${key}.json`);
}

export function lockFile(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(jobsDir(env), `${key}.lock`);
}

const checked = new Set<string>();

// writeAtomic and acquireLock create dirs with the default mode
function ensureJobsDir(env: NodeJS.ProcessEnv): void {
  const dir = jobsDir(env);
  if (checked.has(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
    checked.add(dir);
  } catch {}
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function readEnvelope<V>(key: string, env: NodeJS.ProcessEnv = process.env): JobEnvelope<V> | null {
  if (!SAFE_KEY.test(key)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(envelopeFile(key, env), 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = deepSanitize(v as Record<string, unknown>);
    if (o.v !== 1 || o.key !== key || !finite(o.fetchedAt) || typeof o.ok !== 'boolean') return null;
    for (const k of ['blockedUntil', 'attempts', 'lastGoodAt'] as const) if (!finite(o[k])) delete o[k];
    for (const k of ['error', 'param'] as const) if (typeof o[k] !== 'string') delete o[k];
    if (!('value' in o)) o.value = null;
    return o as unknown as JobEnvelope<V>;
  } catch {
    return null;
  }
}

export function createJobReader(env: NodeJS.ProcessEnv = process.env): JobReader {
  const seen = new Map<string, JobEnvelope<unknown> | null>();
  return {
    job<V = unknown>(key: string): JobEnvelope<V> | null {
      if (!seen.has(key)) {
        let e: JobEnvelope<unknown> | null = null;
        try {
          e = readEnvelope(key, env);
        } catch {}
        seen.set(key, e);
      }
      return (seen.get(key) ?? null) as JobEnvelope<V> | null;
    },
  };
}

export function writeEnvelope<V>(e: JobEnvelope<V>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!SAFE_KEY.test(e.key)) return false;
  try {
    ensureJobsDir(env);
    return writeAtomic(envelopeFile(e.key, env), JSON.stringify(deepSanitize(e)), { mode: 0o600 });
  } catch {
    return false;
  }
}

export function okEnvelope<V>(key: string, value: V, now: number, param?: string): JobEnvelope<V> {
  return {
    v: 1,
    key,
    fetchedAt: now,
    ok: true,
    value,
    attempts: 0,
    lastGood: value,
    lastGoodAt: now,
    ...(param !== undefined ? { param } : {}),
  };
}

export function failEnvelope<V>(
  key: string,
  prev: JobEnvelope<V> | null,
  error: string,
  now: number,
  opts: {
    retryMs?: number;
    maxBackoffMs?: number;
    retryAfterMs?: number | null;
    blockMs?: number;
    param?: string;
  } = {},
): JobEnvelope<V> {
  const lastGood = prev ? (prev.value ?? prev.lastGood ?? null) : null;
  const lastGoodAt = lastGood === null ? undefined : prev?.ok ? prev.fetchedAt : prev?.lastGoodAt;
  const attempts = Math.min((prev?.attempts ?? 0) + 1, MAX_ATTEMPTS);
  const backoff = finite(opts.retryMs) ? backoffMs(opts.retryMs, attempts, opts.maxBackoffMs) : undefined;
  let wait: number | undefined;
  if (finite(opts.blockMs)) wait = opts.blockMs;
  // a floor: a short Retry-After never undercuts the backoff
  else if (finite(opts.retryAfterMs) && opts.retryAfterMs > 0)
    wait = Math.max(opts.retryAfterMs, backoff ?? 0);
  else wait = backoff;
  return {
    v: 1,
    key,
    fetchedAt: now,
    ok: false,
    value: null,
    error: sanitizeText(String(error)).slice(0, 200),
    attempts,
    ...(wait !== undefined ? { blockedUntil: now + wait } : {}),
    lastGood,
    ...(finite(lastGoodAt) ? { lastGoodAt } : {}),
    ...(opts.param !== undefined ? { param: opts.param } : {}),
  };
}

export function jobValue<V>(
  e: JobEnvelope<V> | null,
): { value: V | null; at: number | null; stale: boolean; error: string | null } | null {
  if (!e) return null;
  if (e.ok) return { value: e.value ?? null, at: e.fetchedAt, stale: false, error: null };
  return {
    value: e.value ?? e.lastGood ?? null,
    at: e.lastGoodAt ?? null,
    stale: true,
    error: e.error ?? null,
  };
}

export function backoffMs(retryMs: number, attempts: number, maxMs = MAX_BACKOFF_MS): number {
  const n = Math.max(0, Math.min(attempts, MAX_ATTEMPTS) - 1);
  return Math.max(0, Math.min(maxMs, retryMs * 2 ** n));
}

// seconds or an HTTP date; zero, past or garbage means none
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  const v = header?.trim();
  if (!v) return null;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

export function defaultDue<V>(e: JobEnvelope<V> | null, now: number, ttlMs: number): boolean {
  if (!e) return true;
  if (now < e.fetchedAt) return true;
  const until = e.blockedUntil;
  if (finite(until) && now < until && until - now <= MAX_RETRY_AFTER_MS) return false;
  if (!e.ok && finite(until)) return true;
  return now - e.fetchedAt >= ttlMs;
}

// Claude Code's opt-out of nonessential network traffic
export function nonessentialTrafficOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
}

export function jobsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.CCINFOBAR_NO_JOBS;
}

export function blockedByTraffic(network: JobNetwork, env: NodeJS.ProcessEnv = process.env): boolean {
  return network === 'auto' && nonessentialTrafficOff(env);
}

// home, else temp: never a cwd that may hold a planted binary
export function safeCwd(): string | undefined {
  for (const d of [os.homedir(), os.tmpdir()]) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {}
  }
  return undefined;
}

const PATH_VARS = [
  'CCINFOBAR_CONFIG',
  'CCINFOBAR_CONFIG_DIR',
  'CCINFOBAR_CACHE_DIR',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
];

// the worker runs elsewhere, so relative dirs must not move
export function absoluteEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let out = env;
  for (const k of PATH_VARS) {
    const v = env[k];
    if (!v || path.isAbsolute(v)) continue;
    if (out === env) out = { ...env };
    out[k] = path.resolve(v);
  }
  return out;
}

function launch(args: string[], env: NodeJS.ProcessEnv, cwd?: string, onError?: () => void) {
  const entry = process.argv[1];
  if (!entry || !/ccinfobar(\.js)?$/.test(entry)) return null;
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
    ...(cwd ? { cwd } : {}),
  });
  // an unhandled 'error' would crash the renderer
  child.on('error', () => onError?.());
  child.unref();
  return child;
}

export function spawnSelf(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  onError?: () => void,
): boolean {
  return launch(args, absoluteEnv(env), safeCwd(), onError) !== null;
}

export function spawnSelfDetached(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): number | null {
  return launch(args, env, cwd)?.pid ?? null;
}

export function formatArg(req: JobRequest): string {
  return req.param ? `${req.key}=${req.param}` : req.key;
}

export function parseArg(text: string): JobRequest {
  const i = text.indexOf('=');
  if (i < 0) return { key: text };
  const param = text.slice(i + 1);
  return param ? { key: text.slice(0, i), param } : { key: text.slice(0, i) };
}

export function releaseLock(key: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!SAFE_KEY.test(key)) return;
  try {
    fs.unlinkSync(lockFile(key, env));
  } catch {}
}

export function scheduleRequests(
  items: { req: JobRequest; lockMs: number }[],
  env: NodeJS.ProcessEnv,
  extra: string[],
  opts: { now?: number; spawn?: typeof spawnSelf } = {},
): string[] {
  if (jobsDisabled(env)) return [];
  const now = opts.now ?? Date.now();
  const taken: JobRequest[] = [];
  try {
    for (const { req, lockMs } of items) {
      if (!SAFE_KEY.test(req.key)) continue;
      if (!taken.length) ensureJobsDir(env);
      if (acquireLock(lockFile(req.key, env), lockMs, now)) taken.push(req);
    }
  } catch {}
  if (!taken.length) return [];
  const release = () => {
    for (const req of taken) releaseLock(req.key, env);
  };
  const keys = taken.map(formatArg);
  try {
    (opts.spawn ?? spawnSelf)(['worker', ...keys, ...extra], env, release);
  } catch {
    release();
    return [];
  }
  return keys;
}

const TIMEOUT = Symbol('timeout');

function validResult<V>(e: unknown): e is JobEnvelope<V> {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  return o.v === 1 && finite(o.fetchedAt) && typeof o.ok === 'boolean';
}

export async function executeJob<V>(
  job: Job<V>,
  req: JobRequest,
  ctx: JobCtx<V>,
  env: NodeJS.ProcessEnv = ctx.env,
): Promise<JobEnvelope<V>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: string) =>
    failEnvelope(req.key, ctx.prev, error, ctx.now, {
      ...(job.retryMs > 0 ? { retryMs: job.retryMs } : {}),
      ...(req.param !== undefined ? { param: req.param } : {}),
    });
  let out: JobEnvelope<V>;
  try {
    const run = Promise.resolve().then(() => job.run(req, ctx));
    run.catch(() => {});
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), job.timeoutMs);
    });
    const res = await Promise.race([run, timeout]);
    if (res === TIMEOUT) out = fail('timeout');
    else if (!validResult<V>(res)) out = fail('failed');
    else {
      const { param: _, ...rest } = res;
      out = { ...rest, key: req.key, ...(req.param !== undefined ? { param: req.param } : {}) };
    }
  } catch {
    out = fail('failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    out = deepSanitize(out);
    writeEnvelope(out, env);
  } catch {
  } finally {
    releaseLock(req.key, env);
  }
  return out;
}
