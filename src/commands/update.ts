import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir, configDir } from '../core/paths.js';
import type { Config } from '../core/types.js';
import { acquireLock, writeAtomic } from '../data/store.js';

export const REPO = 'alpadalar/ccinfobar';
const DAY = 86_400_000;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function assertVersion(v: string): string {
  if (!VERSION_RE.test(v)) throw new Error(`invalid version "${v.slice(0, 40)}"`);
  return v;
}
const LOCK_MS = 10 * 60_000;
const SESSION_GAP = 60_000;

export interface UpdateState {
  checkedAt: number;
  latest: string | null;
  installed?: string;
  error?: string;
  session?: string;
}

export function updateFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cacheDir(env), 'update.json');
}

export function readUpdateState(env: NodeJS.ProcessEnv = process.env): UpdateState | null {
  try {
    return JSON.parse(fs.readFileSync(updateFile(env), 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

export function writeUpdateState(state: UpdateState, env: NodeJS.ProcessEnv = process.env): void {
  writeAtomic(updateFile(env), JSON.stringify(state));
}

export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => Number.parseInt(x, 10) || 0);
  const pb = b
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function updatesDisabled(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return config.update === 'off' || !!env.CI || !!env.CCINFOBAR_NO_UPDATE;
}

export function availableUpdate(current: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const s = readUpdateState(env);
  return s?.latest && compareVersions(s.latest, current) > 0 ? s.latest : null;
}

export function updateNotice(
  config: Config,
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (config.update !== 'notify' || updatesDisabled(config, env) || installKind() === 'npx') return null;
  const latest = availableUpdate(current, env);
  return latest ? `⬆ ccinfobar ${latest} · ccinfobar update` : null;
}

export async function fetchLatest(timeoutMs = 4000): Promise<string> {
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
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

export type InstallKind = 'npm-global' | 'local' | 'npx' | 'source' | 'unknown';

// pinned copy when global install is not possible
export function localPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'app');
}

export function installKind(entry = process.argv[1] ?? ''): InstallKind {
  let real = entry;
  try {
    real = fs.realpathSync(entry);
  } catch {}
  const p = real.replace(/\\/g, '/');
  if (/\/_npx\//.test(p)) return 'npx';
  if (p.startsWith(`${localPrefix().replace(/\\/g, '/')}/`)) return 'local';
  if (/\/node_modules\/ccinfobar\/dist\//.test(p)) return 'npm-global';
  if (fs.existsSync(path.join(path.dirname(path.dirname(real)), '.git'))) return 'source';
  return 'unknown';
}

export function npmCommand(): { file: string; args: string[]; shell: boolean } {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return { file: process.execPath, args: [cli], shell: false };
  const unixCli = path.join(
    path.dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (fs.existsSync(unixCli)) return { file: process.execPath, args: [unixCli], shell: false };
  if (process.platform === 'win32') return { file: 'npm.cmd', args: [], shell: true };
  return { file: 'npm', args: [], shell: false };
}

// npm registry first, GitHub release if npm lags
export function installSources(version: string): string[] {
  return [`ccinfobar@${assertVersion(version)}`, tarballUrl(version)];
}

export function installVersion(version: string, prefix?: string): void {
  const npm = npmCommand();
  const where = prefix ? ['--prefix', prefix, '--save-exact'] : ['-g'];
  if (prefix) fs.mkdirSync(prefix, { recursive: true });
  let last: unknown;
  for (const spec of installSources(version)) {
    try {
      execFileSync(
        npm.file,
        [...npm.args, 'install', ...where, spec, '--no-audit', '--no-fund', '--loglevel=error'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 120_000,
          windowsHide: true,
          shell: npm.shell,
        },
      );
      return;
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
      const line = stderr.split(/\r?\n/).find((l) => /npm error (code|[A-Z])/.test(l)) ?? '';
      last = new Error(line.replace(/^npm error\s*/, '') || (err as Error).message.split('\n')[0]);
    }
  }
  throw last;
}

export function selfCommand(kind: InstallKind = installKind()): string {
  return kind === 'npx' || kind === 'local' ? 'npx ccinfobar@latest' : 'ccinfobar';
}

// on every new Claude Code session, else daily
export function scheduleCheck(config: Config, session?: string, env: NodeJS.ProcessEnv = process.env): void {
  if (updatesDisabled(config, env)) return;
  const state = readUpdateState(env);
  const now = Date.now();
  const age = state ? now - state.checkedAt : Number.POSITIVE_INFINITY;
  const newSession = !!session && session !== state?.session && age >= SESSION_GAP;
  if (age < DAY && !newSession) return;
  if (!acquireLock(`${updateFile(env)}.lock`, LOCK_MS, now)) return;
  try {
    if (state && session) writeUpdateState({ ...state, session }, env);
    spawnSelf(['update', '--background'], env);
  } catch {}
}

export function spawnSelf(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const entry = process.argv[1];
  if (!entry || !/ccinfobar(\.js)?$/.test(entry)) return;
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
}

export async function backgroundUpdate(
  config: Config,
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const state: UpdateState = { checkedAt: Date.now(), latest: null };
  const session = readUpdateState(env)?.session;
  if (session) state.session = session;
  try {
    state.latest = await fetchLatest();
    const kind = installKind();
    if (
      config.update === 'auto' &&
      compareVersions(state.latest, current) > 0 &&
      (kind === 'npm-global' || kind === 'local')
    ) {
      installVersion(state.latest, kind === 'local' ? localPrefix(env) : undefined);
      state.installed = state.latest;
    }
  } catch (err) {
    state.error = (err as Error).message;
    state.latest = readUpdateState(env)?.latest ?? null;
  }
  writeUpdateState(state, env);
  try {
    fs.unlinkSync(`${updateFile(env)}.lock`);
  } catch {}
}

export async function manualUpdate(current: string, checkOnly: boolean): Promise<number> {
  let latest: string;
  try {
    latest = await fetchLatest(8000);
  } catch (err) {
    console.error(`✗ Could not reach GitHub: ${(err as Error).message}`);
    return 1;
  }
  writeUpdateState({ checkedAt: Date.now(), latest });
  if (compareVersions(latest, current) <= 0) {
    console.log(`✓ ccinfobar ${current} is the latest version`);
    return 0;
  }
  console.log(`New version available: ${current} → ${latest}`);
  if (checkOnly) return 0;
  const kind = installKind();
  if (kind === 'source') {
    console.log('  This is a source checkout; update it with git pull && npm run build.');
    return 0;
  }
  if (kind === 'npx') {
    console.log('  Running through npx: run `npx ccinfobar@latest install` to set up the newest release.');
    return 0;
  }
  try {
    console.log(`  Installing ccinfobar@${latest} ...`);
    installVersion(latest, kind === 'local' ? localPrefix() : undefined);
    writeUpdateState({ checkedAt: Date.now(), latest, installed: latest });
    console.log(`✓ Updated to ${latest}`);
    return 0;
  } catch (err) {
    console.error(`✗ npm install failed: ${(err as Error).message}`);
    console.error(`  Run it yourself: npm install -g ccinfobar@${latest}`);
    return 1;
  }
}
