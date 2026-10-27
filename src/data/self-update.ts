import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { PATH_VARS } from './jobs/runner.js';
import { writeAtomic } from './store.js';
import {
  compareVersions,
  effectiveUpdate,
  type InstallKind,
  installKind,
  localPrefix,
  safeCwd,
} from './update-state.js';

const ISOLATED_VARS = [...PATH_VARS, 'CLAUDE_POWERLINE_CONFIG', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'];

// the update check and npm install: the update job loads it with import()
export const REPO = 'alpadalar/ccinfobar';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function assertVersion(v: string): string {
  if (!VERSION_RE.test(v)) throw new Error(`invalid version "${v.slice(0, 40)}"`);
  return v;
}

export async function fetchLatest(timeoutMs = 4000, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(`https://github.com/${REPO}/releases/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'ccinfobar' },
  });
  const location = res.headers.get('location') ?? '';
  const tag = /\/tag\/v?([0-9][^/?#]*)$/.exec(location)?.[1];
  if (!tag) throw new Error(`unexpected response ${res.status} from GitHub`);
  return assertVersion(tag);
}

export function tarballUrl(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${assertVersion(version)}/ccinfobar.tgz`;
}

export interface NpmCommand {
  file: string;
  args: string[];
  shell: boolean;
}

export interface NpmDeps {
  execPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}

// npm-cli.js runs without a shell
export function npmCommand(deps: NpmDeps = {}): NpmCommand {
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? fs.existsSync;
  const dir = path.dirname(execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  if (env.npm_execpath && /npm-cli\.js$/.test(env.npm_execpath)) candidates.push(env.npm_execpath);
  const cli = candidates.find((c) => exists(c));
  if (cli) return { file: execPath, args: [cli], shell: false };
  if (platform === 'win32') return { file: 'npm.cmd', args: [], shell: true };
  return { file: 'npm', args: [], shell: false };
}

// cmd.exe joins args unquoted
export function shellArg(a: string): string {
  return /^[\w@./:=\\-]+$/.test(a) ? a : `"${a}"`;
}

// npm registry first, GitHub release if npm lags
export function installSources(version: string): string[] {
  return [`ccinfobar@${assertVersion(version)}`, tarballUrl(version)];
}

export function npmInstallRuns(
  version: string,
  prefix?: string,
  npm: NpmCommand = npmCommand(),
  localTarball?: string,
) {
  const where = prefix ? ['--prefix', prefix, '--save-exact'] : ['-g'];
  const sources = installSources(version);
  if (localTarball) sources[1] = localTarball;
  const runs = sources.map((spec) => {
    const args = [
      'install',
      ...where,
      spec,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ];
    return [...npm.args, ...(npm.shell ? args.map(shellArg) : args)];
  });
  const opts = {
    timeout: 120_000,
    windowsHide: true,
    shell: npm.shell,
    ...(npm.shell ? { cwd: safeCwd() } : {}),
  };
  return { file: npm.file, runs, opts };
}

function npmInstall(version: string, prefix?: string, localTarball?: string) {
  if (prefix) fs.mkdirSync(prefix, { recursive: true });
  return npmInstallRuns(version, prefix, undefined, localTarball);
}

const TARBALL_MAX = 20 * 1024 * 1024;

export async function releaseDigest(
  version: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<string | null> {
  try {
    const res = await fetcher(
      `https://api.github.com/repos/${REPO}/releases/tags/v${assertVersion(version)}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'ccinfobar' },
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { assets?: { name?: unknown; digest?: unknown }[] };
    const asset = body.assets?.find((a) => a.name === 'ccinfobar.tgz');
    return typeof asset?.digest === 'string'
      ? (/^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

export async function fetchTarball(
  version: string,
  expectedHex: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetcher(tarballUrl(version), {
    headers: { 'user-agent': 'ccinfobar' },
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`tarball-http-${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > TARBALL_MAX) throw new Error('tarball-too-large');
  const buf = await readCapped(res);
  if (createHash('sha256').update(buf).digest('hex') !== expectedHex) throw new Error('checksum-mismatch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-tgz-'));
  const file = path.join(dir, 'ccinfobar.tgz');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      for (let at = 0; at < buf.length; ) at += fs.writeSync(fd, buf, at);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('tarball-write-failed');
  }
  return file;
}

// aborts as soon as the running total passes the cap
async function readCapped(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > TARBALL_MAX) throw new Error('tarball-too-large');
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > TARBALL_MAX) {
      await reader.cancel().catch(() => {});
      throw new Error('tarball-too-large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function npmError(err: unknown, stderr: unknown): Error {
  const line = String(stderr ?? '')
    .split(/\r?\n/)
    .find((l) => /npm error (code|[A-Z])/.test(l));
  return new Error(line?.replace(/^npm error\s*/, '') || (err as Error).message.split('\n')[0]);
}

export function installVersion(version: string, prefix?: string): void {
  const { file, runs, opts } = npmInstall(version, prefix);
  let last: unknown;
  for (const args of runs) {
    try {
      execFileSync(file, args, { ...opts, stdio: ['ignore', 'ignore', 'pipe'] });
      return;
    } catch (err) {
      last = npmError(err, (err as { stderr?: Buffer }).stderr);
    }
  }
  throw last;
}

// does not block the event loop
// an aborted signal kills npm, so a timed-out job cannot leave an install running
export async function installVersionAsync(
  version: string,
  prefix?: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { file, runs, opts } = npmInstall(version, prefix);
  const run = (args: string[]) =>
    new Promise<Error | null>((resolve) => {
      const child = execFile(file, args, { ...opts, ...(signal ? { signal } : {}) }, (e, _out, stderr) =>
        resolve(e ? npmError(e, stderr) : null),
      );
      child.stdin?.end();
    });
  let last: unknown;
  for (const [i, args] of runs.entries()) {
    if (signal?.aborted) throw new Error('install cancelled');
    let err: Error | null;
    let local: string | undefined;
    try {
      if (i === 1) {
        const hex = await releaseDigest(version, fetcher);
        if (hex) local = await fetchTarball(version, hex, fetcher, signal);
      }
      err = await run(local ? npmInstall(version, prefix, local).runs[1]! : args);
    } finally {
      if (local) fs.rmSync(path.dirname(local), { recursive: true, force: true });
    }
    if (!err) return;
    if (signal?.aborted) throw new Error('install cancelled');
    last = err;
  }
  throw last;
}

export type Verify = (
  version: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<string | null>;

const VERIFY_TIMEOUT_MS = 15_000;

interface RunResult {
  code: number | string | null;
  stdout: string;
}

// static code only: dist/ was just replaced under us
export async function verifyInstall(
  version: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  entry: string = process.argv[1] ?? '',
): Promise<string | null> {
  let real: string;
  try {
    real = fs.realpathSync(entry);
  } catch {
    return 'entry-missing';
  }
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-verify-'));
  } catch {
    return 'verify-failed';
  }
  try {
    const payload = path.join(tmp, 'payload.json');
    writeAtomic(
      payload,
      JSON.stringify({
        session_id: 'verify',
        model: { id: 'claude-sonnet-4-5', display_name: 'Claude' },
        workspace: { current_dir: tmp },
        cwd: tmp,
      }),
    );
    // the user's config must not decide the verdict (D-01)
    const childEnv: NodeJS.ProcessEnv = { ...env };
    for (const k of ISOLATED_VARS) delete childEnv[k];
    Object.assign(childEnv, {
      CCINFOBAR_CONFIG_DIR: path.join(tmp, 'config'),
      CCINFOBAR_CACHE_DIR: path.join(tmp, 'cache'),
      CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
      CCINFOBAR_NO_JOBS: '1',
      CCINFOBAR_NO_UPDATE: '1',
      CCINFOBAR_NO_USAGE_API: '1',
      CCINFOBAR_LANG: 'en',
      NO_COLOR: '1',
    });
    const run = (args: string[]) =>
      new Promise<RunResult>((resolve) => {
        const child = execFile(
          process.execPath,
          [real, ...args],
          {
            env: childEnv,
            cwd: safeCwd(),
            timeout: VERIFY_TIMEOUT_MS,
            windowsHide: true,
            encoding: 'utf8',
            ...(signal ? { signal } : {}),
          },
          (err, stdout) => {
            const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
            const code = !e ? 0 : e.killed ? 'ETIMEDOUT' : (e.code ?? 'error');
            resolve({ code, stdout: String(stdout ?? '') });
          },
        );
        child.stdin?.end();
      });
    const v = await run(['--version']);
    if (v.code === 'ETIMEDOUT') return 'verify-timeout';
    if (v.stdout.trim() !== version) return `version-mismatch:${v.stdout.trim().slice(0, 40)}`;
    const r = await run(['--payload', payload, '--width', '80']);
    if (r.code === 'ETIMEDOUT') return 'verify-timeout';
    if (r.code !== 0 || !r.stdout.trim() || r.stdout.startsWith('ccinfobar: ')) {
      return `render-failed:${r.code}`;
    }
    return null;
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

export interface CheckDeps {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  kind?: InstallKind;
  fetchLatest?: (timeoutMs?: number) => Promise<string>;
  install?: (version: string, prefix?: string, signal?: AbortSignal) => void | Promise<void>;
  verify?: Verify;
  rejected?: string | null;
  recordRejected?: (r: { latest: string; rejected: string; rollback: 'failed'; reason: string }) => void;
  installMs?: number;
  rollbackMs?: number;
}

export const INSTALL_BUDGET_MS = 240_000;
export const ROLLBACK_BUDGET_MS = 180_000;

// aborts on the parent signal or after ms, whichever comes first
function within(ms: number, parent?: AbortSignal): AbortSignal {
  const c = new AbortController();
  const stop = () => c.abort();
  AbortSignal.timeout(ms).addEventListener('abort', stop, { once: true });
  if (parent?.aborted) stop();
  else parent?.addEventListener('abort', stop, { once: true });
  return c.signal;
}

const KEEP_REASONS = new Set(['entry-missing', 'verify-failed']);

// own budget: the install budget must not abort the rollback
async function rollBack(
  install: NonNullable<CheckDeps['install']>,
  verify: Verify,
  current: string,
  prefix: string | undefined,
  env: NodeJS.ProcessEnv,
  ms = ROLLBACK_BUDGET_MS,
): Promise<boolean> {
  const own = AbortSignal.timeout(ms);
  try {
    await install(current, prefix, own);
    return (await verify(current, env, own)) === null;
  } catch {
    return false;
  }
}

export async function checkForUpdate(
  config: Config,
  current: string = VERSION,
  env: NodeJS.ProcessEnv = process.env,
  deps: CheckDeps = {},
): Promise<{
  latest: string;
  installed?: string;
  rejected?: string;
  rollback?: 'ok' | 'failed';
  reason?: string;
  error?: string;
}> {
  const latest = deps.fetchLatest ? await deps.fetchLatest() : await fetchLatest(undefined, deps.fetch);
  const kind = deps.kind ?? installKind();
  if (
    effectiveUpdate(config, kind) === 'auto' &&
    compareVersions(latest, current) > 0 &&
    (kind === 'npm-global' || kind === 'local')
  ) {
    if (deps.rejected && deps.rejected === latest) return { latest, rejected: latest };
    const prefix = kind === 'local' ? localPrefix(env) : undefined;
    const install = deps.install ?? ((v, p, s) => installVersionAsync(v, p, s, deps.fetch));
    await install(latest, prefix, within(deps.installMs ?? INSTALL_BUDGET_MS, deps.signal));
    const verify: Verify = deps.verify ?? (deps.install ? async () => null : verifyInstall);
    const bad = await verify(latest, env, deps.signal);
    if (bad === null) return { latest, installed: latest };
    const reason = bad.slice(0, 200);
    // the machine, not the version, failed: keep the install, retry later
    if (KEEP_REASONS.has(bad)) return { latest, installed: latest, error: `verify-inconclusive:${bad}` };
    // a render that hangs is not safe to keep, but says nothing certain about the version
    if (bad === 'verify-timeout') {
      const ok = await rollBack(install, verify, current, prefix, env, deps.rollbackMs);
      return { latest, error: `verify-timeout:${ok ? 'rolled-back' : 'rollback-failed'}` };
    }
    // recorded first so a killed rollback still blacklists the version
    try {
      deps.recordRejected?.({ latest, rejected: latest, rollback: 'failed', reason });
    } catch {}
    const rollback = (await rollBack(install, verify, current, prefix, env, deps.rollbackMs))
      ? 'ok'
      : 'failed';
    return { latest, rejected: latest, rollback, reason };
  }
  return { latest };
}
