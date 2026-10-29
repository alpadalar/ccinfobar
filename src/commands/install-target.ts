import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../core/i18n/index.js';
import { safeCwd } from '../data/update-state.js';
import { type BuiltCommand, buildCommand, type CommandTarget } from './command.js';
import { brewPrefix, type InstallKind, installKind, localPrefix } from './update.js';

export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
  [key: string]: unknown;
}

// npx puts its cache on PATH; that is not an install
export function isTransientBin(p: string): boolean {
  return /[\\/](_npx|node_modules[\\/]\.bin)[\\/]/.test(p);
}

export function globalBinary(): string | null {
  try {
    const win = process.platform === 'win32';
    const out = execFileSync(win ? 'where' : 'which', win ? ['ccinfobar'] : ['-a', 'ccinfobar'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      // Windows looks up where in the cwd first
      ...(win ? { cwd: safeCwd() } : {}),
    });
    const hit = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !isTransientBin(l));
    return hit ?? null;
  } catch {
    return null;
  }
}

export function localBin(env: NodeJS.ProcessEnv = process.env): string {
  const bin = path.join(localPrefix(env), 'node_modules', '.bin');
  return path.join(bin, process.platform === 'win32' ? 'ccinfobar.cmd' : 'ccinfobar');
}

export function acceptCommand(built: BuiltCommand, log: (line: string) => void = () => {}): string | null {
  if (built.ok) return built.command;
  log(t('install.unsafePath', { path: built.path, chars: built.chars }));
  return null;
}

export interface TargetDeps {
  globalBinary?: () => string | null;
  entry?: string;
  exists?: (p: string) => boolean;
  realpath?: (p: string) => string;
}

const slash = (p: string) => p.replace(/\\/g, '/');
const inCellar = (p: string) => slash(p).includes('/Cellar/');

// an npm copy can own <prefix>/bin/ccinfobar
function ownsKeg(p: string, prefix: string | null, realpath: (p: string) => string): boolean {
  try {
    const real = slash(realpath(p));
    return prefix
      ? real.startsWith(`${slash(prefix)}/Cellar/ccinfobar/`)
      : real.includes('/Cellar/ccinfobar/');
  } catch {
    return false;
  }
}

// the prefix bin and opt link survive brew upgrade, Cellar paths do not
function brewTarget(deps: TargetDeps): CommandTarget | null {
  const exists = deps.exists ?? fs.existsSync;
  const realpath = deps.realpath ?? fs.realpathSync;
  const prefix = brewPrefix(deps.entry);
  const candidates: CommandTarget[] = prefix
    ? [
        { kind: 'bin', bin: path.join(prefix, 'bin', 'ccinfobar'), onPath: true },
        { kind: 'bin', bin: path.join(prefix, 'opt', 'ccinfobar', 'bin', 'ccinfobar'), onPath: false },
      ]
    : [];
  const hit = (deps.globalBinary ?? globalBinary)();
  if (hit && !inCellar(hit)) candidates.push({ kind: 'bin', bin: hit, onPath: true });
  return (
    candidates.find((c) => c.kind === 'bin' && exists(c.bin) && ownsKeg(c.bin, prefix, realpath)) ?? null
  );
}

// never npx@latest: it runs whatever npm serves
function defaultTarget(kind: InstallKind, deps: TargetDeps = {}): CommandTarget | null {
  if (kind === 'brew') return brewTarget(deps);
  const exists = deps.exists ?? fs.existsSync;
  const bin = (deps.globalBinary ?? globalBinary)();
  if (bin) return { kind: 'bin', bin, onPath: true };
  if (exists(localBin())) return { kind: 'bin', bin: localBin(), onPath: false };
  const raw = deps.entry ?? process.argv[1];
  const entry = raw ? path.resolve(raw) : null;
  if (kind !== 'npx' && entry && exists(entry)) return { kind: 'script', script: entry };
  return null;
}

export function defaultCommand(
  kind: InstallKind = installKind(),
  log?: (line: string) => void,
  deps?: TargetDeps,
): string | null {
  const target = defaultTarget(kind, deps);
  const command = target ? acceptCommand(buildCommand(target), log) : null;
  return kind === 'brew' && command && inCellar(command) ? null : command;
}
