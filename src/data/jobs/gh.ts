import { execFile } from 'node:child_process';
import type { GhValue } from '../../core/job-values.js';
import { sanitizeText } from '../../core/sanitize.js';
import type { Config, StatusPayload } from '../../core/types.js';
import { ghKey } from './keys.js';
import {
  defaultDue,
  type ExecFileLike,
  failEnvelope,
  type Job,
  type JobEnvelope,
  okEnvelope,
  readEnvelope,
  safeCwd,
  writeEnvelope,
} from './runner.js';

export const GH_PARAM_RE =
  /^[a-z0-9.-]+(:\d{1,5})?\/[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*#[1-9]\d{0,9}$/;
export const GH_HOSTS_KEY = 'gh-hosts';

const RETRY_MS = 60_000;
const PENDING_TTL = 60_000;
const SETTLED_TTL = 300_000;
const EXEC_TIMEOUT = 10_000;
const HOSTS_TTL = 3_600_000;
const MISSING_BLOCK = 3_600_000;
const HOST_BLOCK = 3_600_000;
const AUTH_BLOCK = 1_800_000;
const RATE_BLOCK = 900_000;
const MAX_NAMES = 20;
const MAX_NAME = 80;
const MAX_HOSTS = 50;
const HOST_RE = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;
const ENTERPRISE = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];

export type GhError = 'gh-missing' | 'gh-auth' | 'gh-rate' | 'gh-failed';
export type GhResult = Awaited<ReturnType<ExecFileLike>>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const defaultExecFile: ExecFileLike = (file, args, opts) =>
  new Promise((resolve) => {
    try {
      // Windows looks up gh in the cwd first
      const cwd = safeCwd();
      const child = execFile(
        file,
        args,
        {
          timeout: opts.timeout,
          env: opts.env,
          maxBuffer: opts.maxBuffer,
          windowsHide: true,
          encoding: 'utf8',
          ...(cwd ? { cwd } : {}),
        },
        (e, stdout, stderr) => {
          const code = (e as NodeJS.ErrnoException | null)?.code as unknown;
          resolve({
            code: e ? (typeof code === 'number' ? code : null) : 0,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            ...(typeof code === 'string' ? { errno: code } : {}),
          });
        },
      );
      child.stdin?.end();
    } catch {
      resolve({ code: null, stdout: '', stderr: '', errno: 'spawn' });
    }
  });

export function ghParam(payload: StatusPayload): string | null {
  const pr = payload?.pr;
  const repo = payload?.workspace?.repo;
  if (!pr || pr.kind === 'mr' || !Number.isInteger(pr.number) || (pr.number ?? 0) <= 0) return null;
  const host = typeof repo?.host === 'string' ? repo.host.toLowerCase() : 'github.com';
  if (typeof repo?.owner !== 'string' || typeof repo?.name !== 'string') return null;
  const p = `${host}/${repo.owner}/${repo.name}#${pr.number}`;
  return GH_PARAM_RE.test(p) ? p : null;
}

function splitParam(param: string): { host: string; repo: string; number: string } | null {
  if (!GH_PARAM_RE.test(param)) return null;
  const hash = param.lastIndexOf('#');
  const repo = param.slice(0, hash);
  return { host: repo.slice(0, repo.indexOf('/')), repo, number: param.slice(hash + 1) };
}

function hasCiItem(config: Pick<Config, 'lines'>): boolean {
  const lines = Array.isArray(config?.lines) ? config.lines : [];
  return lines.some(
    (line) => Array.isArray(line) && line.some((i) => i?.type === 'pr' && i.options?.ci === true),
  );
}

export function countBuckets(rows: unknown): GhValue | null {
  if (!Array.isArray(rows)) return null;
  const v: GhValue = { pass: 0, fail: 0, pending: 0, skipped: 0, cancelled: 0, total: 0, names: [] };
  for (const row of rows) {
    if (!isObj(row)) continue;
    v.total++;
    const b = row.bucket;
    if (b === 'pass') v.pass++;
    else if (b === 'fail') v.fail++;
    else if (b === 'skipping') v.skipped++;
    else if (b === 'cancel') {
      v.fail++;
      v.cancelled++;
    } else v.pending++;
    if (typeof row.name === 'string' && v.names.length < MAX_NAMES)
      v.names.push(sanitizeText(row.name).slice(0, MAX_NAME));
  }
  return v;
}

const empty = (): GhValue => ({
  pass: 0,
  fail: 0,
  pending: 0,
  skipped: 0,
  cancelled: 0,
  total: 0,
  names: [],
});

// stderr can hold an attacker-chosen branch name: classify, never keep
export function classifyGh(
  r: GhResult,
): { kind: 'ok'; value: GhValue } | { kind: 'error'; code: GhError; blockMs?: number } {
  const out = r.stdout.trim();
  if (out) {
    try {
      const value = countBuckets(JSON.parse(out));
      if (value) return { kind: 'ok', value };
    } catch {}
  }
  if (r.errno === 'ENOENT') return { kind: 'error', code: 'gh-missing', blockMs: MISSING_BLOCK };
  const err = r.stderr;
  if (!out && /no (required )?checks reported/.test(err)) return { kind: 'ok', value: empty() };
  if (r.code === 4 || /gh auth login|not logged/i.test(err))
    return { kind: 'error', code: 'gh-auth', blockMs: AUTH_BLOCK };
  if (/rate limit/i.test(err)) return { kind: 'error', code: 'gh-rate', blockMs: RATE_BLOCK };
  return { kind: 'error', code: 'gh-failed' };
}

const defaultHost = (host: string) => host === 'github.com' || host.endsWith('.ghe.com');

function hostList(v: unknown): string[] {
  if (!isObj(v)) return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    const h = k.toLowerCase();
    if (HOST_RE.test(h) && !out.includes(h)) out.push(h);
    if (out.length >= MAX_HOSTS) break;
  }
  return out;
}

function childEnv(env: NodeJS.ProcessEnv, keepEnterprise: boolean): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    ...env,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_SPINNER_DISABLED: '1',
    NO_COLOR: '1',
  };
  if (!keepEnterprise) for (const k of ENTERPRISE) delete out[k];
  return out;
}

async function storedHosts(
  exec: ExecFileLike,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<string[] | 'missing'> {
  const prev = readEnvelope<{ hosts: string[] }>(GH_HOSTS_KEY, env);
  const cached = Array.isArray(prev?.value?.hosts)
    ? prev.value.hosts.filter((h) => typeof h === 'string' && HOST_RE.test(h))
    : null;
  if (prev && cached && now >= prev.fetchedAt && now - prev.fetchedAt < HOSTS_TTL) return cached;
  const r = await exec('gh', ['auth', 'status', '--json', 'hosts'], {
    timeout: EXEC_TIMEOUT,
    env: childEnv(env, false),
    maxBuffer: 1 << 20,
  });
  if (r.errno === 'ENOENT') return 'missing';
  let hosts: string[] | null = null;
  try {
    const body = JSON.parse(r.stdout) as unknown;
    if (isObj(body)) hosts = hostList(body.hosts);
  } catch {}
  if (!hosts) return cached ?? [];
  writeEnvelope(okEnvelope(GH_HOSTS_KEY, { hosts }, now), env);
  return hosts;
}

export const ghJob: Job<GhValue> = {
  id: 'gh',
  network: 'explicit',
  lockMs: 60_000,
  timeoutMs: 25_000,
  retryMs: RETRY_MS,
  keyRe: /^gh-[0-9a-f]{16}$/,
  paramRe: GH_PARAM_RE,
  keys({ config, payload }) {
    if (!hasCiItem(config)) return [];
    const p = ghParam(payload);
    return p ? [{ key: ghKey(p), param: p }] : [];
  },
  accepts(req, { config }) {
    const p = req.param;
    return typeof p === 'string' && GH_PARAM_RE.test(p) && req.key === ghKey(p) && hasCiItem(config);
  },
  due(e: JobEnvelope<GhValue> | null, now: number) {
    return defaultDue(e, now, (e?.value ?? e?.lastGood)?.pending ? PENDING_TTL : SETTLED_TTL);
  },
  async run(req, ctx) {
    const fail = (code: string, blockMs?: number) =>
      failEnvelope(req.key, ctx.prev, code, ctx.now, blockMs ? { blockMs } : { retryMs: RETRY_MS });
    const parts = splitParam(req.param ?? '');
    if (!parts) return fail('gh-failed');
    const exec = ctx.execFile ?? defaultExecFile;
    let stored = false;
    if (!defaultHost(parts.host)) {
      const hosts = await storedHosts(exec, ctx.env, ctx.now);
      if (hosts === 'missing') return fail('gh-missing', MISSING_BLOCK);
      if (!hosts.includes(parts.host)) return fail('gh-host', HOST_BLOCK);
      stored = true;
    }
    const r = await exec(
      'gh',
      ['pr', 'checks', parts.number, '-R', parts.repo, '--json', 'name,state,bucket'],
      {
        timeout: EXEC_TIMEOUT,
        env: childEnv(ctx.env, stored),
        maxBuffer: 1 << 20,
      },
    );
    const c = classifyGh(r);
    if (c.kind === 'ok') return okEnvelope(req.key, c.value, ctx.now);
    return fail(c.code, c.blockMs);
  },
};
