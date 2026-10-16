import fs from 'node:fs';
import path from 'node:path';
import { BREW_UPGRADE } from '../core/brew.js';
import { configDir } from '../core/paths.js';
import type { Config, StatusPayload } from '../core/types.js';
import {
  jobsDisabled,
  nonessentialTrafficOff,
  readEnvelope,
  scheduleRequests,
  writeEnvelope,
} from './jobs/runner.js';
import {
  fromUpdateState,
  legacyUpdateFile,
  readLegacyUpdate,
  toUpdateState,
  UPDATE_LOCK_MS,
  type UpdateState,
  type UpdateValue,
  updateJob,
  updatesDisabled,
} from './jobs/update.js';

export { nonessentialTrafficOff, safeCwd, spawnSelf, spawnSelfDetached } from './jobs/runner.js';
// the registry takes it from here, so both share a chunk
export { type UpdateState, updateJob, updatesDisabled } from './jobs/update.js';

// legacy path, read only
export function updateFile(env: NodeJS.ProcessEnv = process.env): string {
  return legacyUpdateFile(env);
}

export function readUpdateState(env: NodeJS.ProcessEnv = process.env): UpdateState | null {
  const e = readEnvelope<UpdateValue>('update', env);
  return e ? toUpdateState(e) : readLegacyUpdate(env);
}

export function writeUpdateState(state: UpdateState, env: NodeJS.ProcessEnv = process.env): void {
  writeEnvelope(fromUpdateState(state), env);
}

function parseVersion(v: string): { core: number[]; pre: string[] } {
  const [main = '', ...rest] = v.replace(/^v/, '').split('-');
  const core = main.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pre = rest.join('-').split('+')[0] ?? '';
  return { core, pre: pre ? pre.split('.') : [] };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// semver order, prerelease below its release
export function compareVersions(a: string, b: string): number {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  return comparePre(pa.pre, pb.pre);
}

export function availableUpdate(current: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const s = readUpdateState(env);
  return s?.latest && compareVersions(s.latest, current) > 0 ? s.latest : null;
}

export function updateNotice(
  config: Config,
  current: string,
  env: NodeJS.ProcessEnv = process.env,
  kindOf: () => InstallKind = installKind,
): string | null {
  if (config.update === 'off' || updatesDisabled(config, env)) return null;
  const kind = kindOf();
  if (effectiveUpdate(config, kind) !== 'notify' || kind === 'npx') return null;
  const latest = availableUpdate(current, env);
  return latest ? `⬆ ccinfobar ${latest} · ${updateHint(kind)}` : null;
}

export type InstallKind = 'npm-global' | 'local' | 'npx' | 'brew' | 'source' | 'unknown';

export { BREW_UPGRADE };

// package manager owns brew copies
export function effectiveUpdate(config: Pick<Config, 'update'>, kind: InstallKind): Config['update'] {
  if (config.update === 'off') return 'off';
  return kind === 'brew' ? 'notify' : config.update;
}

export function updateHint(kind: InstallKind): string {
  return kind === 'brew' ? BREW_UPGRADE : 'ccinfobar update';
}

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
  if (p.includes('/Cellar/ccinfobar/')) return 'brew';
  if (/\/node_modules\/ccinfobar\/dist\//.test(p)) return 'npm-global';
  if (fs.existsSync(path.join(path.dirname(path.dirname(real)), '.git'))) return 'source';
  return 'unknown';
}

// part of the realpath before /Cellar/
export function brewPrefix(entry = process.argv[1] ?? ''): string | null {
  let real = entry;
  try {
    real = fs.realpathSync(entry);
  } catch {}
  const i = real.replace(/\\/g, '/').indexOf('/Cellar/ccinfobar/');
  return i > 0 ? real.slice(0, i) : null;
}

export function selfCommand(kind: InstallKind = installKind()): string {
  return kind === 'npx' || kind === 'local' ? 'npx ccinfobar@latest' : 'ccinfobar';
}

// on every new Claude Code session, else daily
export function scheduleCheck(
  config: Config,
  session?: string,
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = [],
): void {
  if (updatesDisabled(config, env) || nonessentialTrafficOff(env) || jobsDisabled(env)) return;
  try {
    const now = Date.now();
    const payload = { session_id: session } as StatusPayload;
    const [req] = updateJob.keys({ config, payload, env, cwd: '', now });
    if (!req || !updateJob.due(updateJob.readPrev!('update', env), now, req)) return;
    scheduleRequests([{ req, lockMs: UPDATE_LOCK_MS }], env, extra, { now });
  } catch {}
}
