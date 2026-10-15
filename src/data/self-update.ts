import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { compareVersions, installKind, localPrefix } from './update-state.js';

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

export function npmInstallRuns(version: string, prefix?: string, npm: NpmCommand = npmCommand()) {
  const where = prefix ? ['--prefix', prefix, '--save-exact'] : ['-g'];
  const runs = installSources(version).map((spec) => {
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
  const opts = { timeout: 120_000, windowsHide: true, shell: npm.shell };
  return { file: npm.file, runs, opts };
}

function npmInstall(version: string, prefix?: string) {
  if (prefix) fs.mkdirSync(prefix, { recursive: true });
  return npmInstallRuns(version, prefix);
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
export async function installVersionAsync(version: string, prefix?: string): Promise<void> {
  const { file, runs, opts } = npmInstall(version, prefix);
  let last: unknown;
  for (const args of runs) {
    const err = await new Promise<Error | null>((resolve) => {
      const child = execFile(file, args, opts, (e, _out, stderr) => resolve(e ? npmError(e, stderr) : null));
      child.stdin?.end();
    });
    if (!err) return;
    last = err;
  }
  throw last;
}

export async function checkForUpdate(
  config: Config,
  current: string = VERSION,
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch?: typeof fetch } = {},
): Promise<{ latest: string; installed?: string }> {
  const latest = await fetchLatest(undefined, deps.fetch);
  const kind = installKind();
  if (
    config.update === 'auto' &&
    compareVersions(latest, current) > 0 &&
    (kind === 'npm-global' || kind === 'local')
  ) {
    await installVersionAsync(latest, kind === 'local' ? localPrefix(env) : undefined);
    return { latest, installed: latest };
  }
  return { latest };
}
