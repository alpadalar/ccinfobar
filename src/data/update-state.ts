import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheDir, configDir } from '../core/paths.js';
import { sanitizeText } from '../core/sanitize.js';
import type { Config } from '../core/types.js';
import { nonessentialTrafficOff, spawnSelf } from './jobs/runner.js';
import { acquireLock, writeAtomic } from './store.js';

export { nonessentialTrafficOff, spawnSelf, spawnSelfDetached } from './jobs/runner.js';

const DAY = 86_400_000;
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

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const version = (v: unknown): string | null => (typeof v === 'string' && VERSION_RE.test(v) ? v : null);

// a corrupt file reads as missing fields
export function readUpdateState(env: NodeJS.ProcessEnv = process.env): UpdateState | null {
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(fs.readFileSync(updateFile(env), 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const checkedAt = typeof o.checkedAt === 'number' && Number.isFinite(o.checkedAt) ? o.checkedAt : 0;
  const state: UpdateState = { checkedAt, latest: version(o.latest) };
  const installed = version(o.installed);
  if (installed) state.installed = installed;
  if (typeof o.error === 'string') state.error = sanitizeText(o.error);
  if (typeof o.session === 'string') state.session = o.session;
  return state;
}

export function writeUpdateState(state: UpdateState, env: NodeJS.ProcessEnv = process.env): void {
  writeAtomic(updateFile(env), JSON.stringify(state));
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

export function selfCommand(kind: InstallKind = installKind()): string {
  return kind === 'npx' || kind === 'local' ? 'npx ccinfobar@latest' : 'ccinfobar';
}

// on every new Claude Code session, else daily
export function scheduleCheck(config: Config, session?: string, env: NodeJS.ProcessEnv = process.env): void {
  if (updatesDisabled(config, env) || nonessentialTrafficOff(env)) return;
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

// home, else temp: never a cwd that may hold a planted binary
export function safeCwd(): string | undefined {
  for (const d of [os.homedir(), os.tmpdir()]) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {}
  }
  return undefined;
}
