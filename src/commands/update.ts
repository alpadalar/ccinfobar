import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../core/paths.js';
import type { Config } from '../core/types.js';

export const REPO = 'alpadalar/ccinfobar';
const DAY = 86_400_000;
const LOCK_MS = 10 * 60_000;

export interface UpdateState {
  checkedAt: number;
  latest: string | null;
  installed?: string;
  error?: string;
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

function writeUpdateState(state: UpdateState, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.mkdirSync(path.dirname(updateFile(env)), { recursive: true });
    fs.writeFileSync(updateFile(env), JSON.stringify(state));
  } catch {}
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
  if (config.update !== 'notify' || updatesDisabled(config, env)) return null;
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
  return tag;
}

export function tarballUrl(version: string): string {
  return `https://github.com/${REPO}/releases/download/v${version}/ccinfobar.tgz`;
}

export type InstallKind = 'npm-global' | 'npx' | 'source' | 'unknown';

export function installKind(entry = process.argv[1] ?? ''): InstallKind {
  let real = entry;
  try {
    real = fs.realpathSync(entry);
  } catch {}
  const p = real.replace(/\\/g, '/');
  if (/\/_npx\//.test(p)) return 'npx';
  if (/\/node_modules\/ccinfobar\/dist\//.test(p)) return 'npm-global';
  if (fs.existsSync(path.join(path.dirname(path.dirname(real)), '.git'))) return 'source';
  return 'unknown';
}

export function installVersion(version: string): void {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['install', '-g', tarballUrl(version), '--no-audit', '--no-fund', '--silent'], {
    stdio: 'ignore',
    timeout: 120_000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

export function scheduleCheck(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (updatesDisabled(config, env)) return;
  const state = readUpdateState(env);
  const now = Date.now();
  if (state && now - state.checkedAt < DAY) return;
  const lock = `${updateFile(env)}.lock`;
  try {
    if (now - fs.statSync(lock).mtimeMs < LOCK_MS) return;
  } catch {}
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, String(now));
    const entry = process.argv[1];
    if (!entry || !/ccinfobar(\.js)?$/.test(entry)) return;
    const child = spawn(process.execPath, [entry, 'update', '--background'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.unref();
  } catch {}
}

export async function backgroundUpdate(
  config: Config,
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const state: UpdateState = { checkedAt: Date.now(), latest: null };
  try {
    state.latest = await fetchLatest();
    if (
      config.update === 'auto' &&
      compareVersions(state.latest, current) > 0 &&
      installKind() === 'npm-global'
    ) {
      installVersion(state.latest);
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
    console.log('  Running through npx: the next run already uses the latest release.');
    return 0;
  }
  try {
    console.log(`  Installing ${tarballUrl(latest)} ...`);
    installVersion(latest);
    writeUpdateState({ checkedAt: Date.now(), latest, installed: latest });
    console.log(`✓ Updated to ${latest}`);
    return 0;
  } catch (err) {
    console.error(`✗ npm install failed: ${(err as Error).message}`);
    console.error(`  Run it yourself: npm install -g ${tarballUrl(latest)}`);
    return 1;
  }
}
