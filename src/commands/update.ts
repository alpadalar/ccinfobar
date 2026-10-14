import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { loadForUse } from '../core/load.js';
import type { Config } from '../core/types.js';
import { VERSION } from '../core/version.js';
import {
  compareVersions,
  installKind,
  localPrefix,
  readUpdateState,
  type UpdateState,
  updateFile,
  writeUpdateState,
} from '../data/update-state.js';
import { currentStatusLine, takeOverProjects } from './install.js';

export {
  availableUpdate,
  compareVersions,
  type InstallKind,
  installKind,
  localPrefix,
  readUpdateState,
  scheduleCheck,
  selfCommand,
  spawnSelf,
  type UpdateState,
  updateFile,
  updateNotice,
  updatesDisabled,
  writeUpdateState,
} from '../data/update-state.js';

export const REPO = 'alpadalar/ccinfobar';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function assertVersion(v: string): string {
  if (!VERSION_RE.test(v)) throw new Error(`invalid version "${v.slice(0, 40)}"`);
  return v;
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

export async function runUpdate(args: Args, cfgFile: string): Promise<void> {
  if (args.flags.background) {
    await backgroundUpdate(loadForUse(cfgFile).config, VERSION);
    try {
      const sl = currentStatusLine();
      if (sl?.command?.includes('ccinfobar')) takeOverProjects(sl.command, sl.refreshInterval);
    } catch {}
    return;
  }
  process.exitCode = await manualUpdate(VERSION, args.flags.check === true);
}
