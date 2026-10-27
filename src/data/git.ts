import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deepSanitize } from '../core/sanitize.js';
import { cacheKey, readCache, writeCache } from './cache.js';
import { findUp, gitdirOf, parseHead, readSmall } from './repos.js';
import { binary, whichDeps } from './which.js';

export interface GitInfo {
  root: string;
  branch: string | null;
  detached: boolean;
  sha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  insertions: number | null;
  deletions: number | null;
  stash: number | null;
  operation: string | null;
  remoteUrl: string | null;
  upstreamUrl?: string | null;
  forkUrl?: string | null;
  isWorktree: boolean;
}

// spawning git is slow on Windows
export const GIT_TIMEOUT =
  Number(process.env.CCINFOBAR_GIT_TIMEOUT) || (process.platform === 'win32' ? 1500 : 400);

export const HARDEN = ['-c', 'core.fsmonitor=false', '--no-optional-locks'] as const;

const EMPTY_VAR = 'CCINFOBAR_GIT_EMPTY';

// exit 1 reads as '' when okExit1
function exec(
  cwd: string,
  args: string[],
  timeout: number,
  env: NodeJS.ProcessEnv,
  okExit1 = false,
): string | null {
  const bin = binary('git', whichDeps(env));
  if (bin === null) return null;
  try {
    return execFileSync(bin, args, {
      cwd,
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
  } catch (e) {
    return okExit1 && (e as { status?: number | null }).status === 1 ? '' : null;
  }
}

// the worker runs jobs side by side, so a slow git must not block the others
function execAsync(
  cwd: string,
  args: string[],
  timeout: number,
  env: NodeJS.ProcessEnv,
  okExit1 = false,
): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = binary('git', whichDeps(env));
    if (bin === null) {
      resolve(null);
      return;
    }
    try {
      const child = execFile(
        bin,
        args,
        { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env },
        (e, stdout) => {
          if (!e) resolve(String(stdout));
          else resolve(okExit1 && (e as { code?: unknown }).code === 1 ? '' : null);
        },
      );
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

function git(cwd: string, args: string[], pre: readonly string[] = [], okExit1 = false): string | null {
  return exec(
    cwd,
    [...pre, ...args],
    GIT_TIMEOUT,
    {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      [EMPTY_VAR]: '',
    },
    okExit1,
  );
}

const SCRUB = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
]);

export function scrubGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // env keys are case-insensitive on Windows
  for (const [k, v] of Object.entries(env)) if (!SCRUB.has(k.toUpperCase())) out[k] = v;
  return { ...out, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', [EMPTY_VAR]: '' };
}

function detectOperation(gitDir: string): string | null {
  const has = (n: string) => fs.existsSync(path.join(gitDir, n));
  if (has('rebase-merge') || has('rebase-apply')) return 'REBASING';
  if (has('MERGE_HEAD')) return 'MERGING';
  if (has('CHERRY_PICK_HEAD')) return 'CHERRY-PICKING';
  if (has('REVERT_HEAD')) return 'REVERTING';
  if (has('BISECT_LOG')) return 'BISECTING';
  return null;
}

export function parseStatus(out: string) {
  const r = {
    branch: null as string | null,
    detached: false,
    sha: null as string | null,
    upstream: null as string | null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    stash: 0,
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice(13).trim();
      r.sha = oid === '(initial)' ? null : oid.slice(0, 7);
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim();
      if (head === '(detached)') r.detached = true;
      else r.branch = head;
    } else if (line.startsWith('# branch.upstream ')) {
      r.upstream = line.slice(18).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        r.ahead = Number(m[1]);
        r.behind = Number(m[2]);
      }
    } else if (line.startsWith('# stash ')) {
      r.stash = Number(line.slice(8)) || 0;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') r.staged++;
      if (line[3] !== '.') r.unstaged++;
    } else if (line.startsWith('u ')) {
      r.conflicts++;
    } else if (line.startsWith('? ')) {
      r.untracked++;
    }
  }
  return r;
}

export function parseShortstat(out: string): { insertions: number; deletions: number } {
  const ins = /(\d+) insertion/.exec(out);
  const del = /(\d+) deletion/.exec(out);
  return { insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}

export function finishGit(info: GitInfo): GitInfo {
  return deepSanitize(info);
}

export interface ScopedEntry {
  scope: string;
  key: string;
  value: string;
}

export function parseScopedConfig(out: string): ScopedEntry[] {
  const entries: ScopedEntry[] = [];
  for (const line of out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    const rest = line.slice(tab + 1);
    const sp = rest.indexOf(' ');
    const key = sp < 0 ? rest : rest.slice(0, sp);
    if (!key) continue;
    entries.push({ scope: line.slice(0, tab), key, value: sp < 0 ? '' : rest.slice(sp + 1) });
  }
  return entries;
}

const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/;

export function localFilterOverrides(entries: ScopedEntry[]): string[] {
  const names = new Set<string>();
  for (const e of entries) {
    if (e.scope !== 'local' && e.scope !== 'worktree') continue;
    const m = FILTER_KEY.exec(e.key);
    if (m) names.add(m[1]!);
  }
  const out: string[] = [];
  for (const name of names) {
    for (const kind of ['clean', 'smudge', 'process']) {
      const key = `filter.${name}.${kind}`;
      // -c splits at the first '='
      if (name.includes('=')) out.push(`--config-env=${key}=${EMPTY_VAR}`);
      else out.push('-c', `${key}=`);
    }
  }
  return out;
}

const SCOPED_RE = '^(remote\\.(origin|upstream|fork)\\.url|filter\\..+\\.(clean|smudge|process))$';

export async function hardenedGit(
  cwd: string,
  args: string[],
  opts: { harden: boolean; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const env = scrubGitEnv(opts.env ?? process.env);
  const start = Date.now();
  let pre: string[] = [];
  if (opts.harden) {
    // no overrides known, so no status
    const cfg = await execAsync(
      cwd,
      [...HARDEN, 'config', '--show-scope', '--get-regexp', SCOPED_RE],
      opts.timeout,
      env,
      true,
    );
    if (cfg === null) return null;
    pre = [...HARDEN, ...localFilterOverrides(parseScopedConfig(cfg))];
  }
  const left = opts.timeout - (Date.now() - start);
  if (left <= 0) return null;
  return execAsync(cwd, [...pre, ...args], left, env);
}

const READ_RE =
  '^(remote\\.(origin|upstream|fork)\\.url|filter\\..+\\.(clean|smudge|process)|core\\.(worktree|bare)|extensions\\.worktreeconfig)$';

const INCLUDE_RE = /^\s*\[\s*include(if)?\b/im;

function readGitSpawning(cwd: string, harden: boolean): GitInfo | null {
  const pre: readonly string[] = harden ? HARDEN : [];
  const revs = git(cwd, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], pre);
  if (revs === null) return null;
  const [top, gitDirRaw, commonRaw] = revs.split('\n').map((l) => l.trim());
  if (!top || !gitDirRaw) return null;
  const gitDir = path.resolve(cwd, gitDirRaw);
  const common = commonRaw ? path.resolve(cwd, commonRaw) : gitDir;

  // exits 1 when nothing matches
  const cfgOut = git(cwd, ['config', '--show-scope', '--get-regexp', SCOPED_RE], pre, true);
  if (cfgOut === null && harden) return null;
  const entries = parseScopedConfig(cfgOut ?? '');
  const url = (name: string) => entries.find((e) => e.key === `remote.${name}.url`)?.value.trim() || null;
  const safe: readonly string[] = harden ? [...HARDEN, ...localFilterOverrides(entries)] : [];

  const base = ['status', '--porcelain=v2', '--branch'];
  const withStash = git(cwd, [...base, '--show-stash'], safe);
  const status = withStash ?? git(cwd, base, safe);
  if (status === null) return null;
  const parsed = parseStatus(status);
  const s = { ...parsed, stash: withStash === null ? null : parsed.stash };

  const diffArgs = harden
    ? ['diff', 'HEAD', '--shortstat', '--no-ext-diff', '--no-textconv']
    : ['diff', 'HEAD', '--shortstat'];
  const diff = git(cwd, diffArgs, safe);
  const stat = diff === null ? { insertions: null, deletions: null } : parseShortstat(diff);

  return finishGit({
    root: path.resolve(top),
    ...s,
    ...stat,
    operation: detectOperation(gitDir),
    remoteUrl: url('origin'),
    upstreamUrl: url('upstream'),
    forkUrl: url('fork'),
    isWorktree: gitDir !== common,
  });
}

export function readGit(
  cwd: string,
  opts: {
    harden?: boolean;
    cache?: { now: number; persist: boolean };
    env?: NodeJS.ProcessEnv;
  } = {},
): GitInfo | null {
  const harden = opts.harden !== false;
  const cache = opts.cache;
  if (!cache) return readGitSpawning(cwd, harden);
  const env = opts.env ?? process.env;
  const layout = discoverGit(cwd, env);
  if (!layout) return readGitSpawning(cwd, harden);
  const gitBin = binary('git', whichDeps(env));
  if (gitBin === null) return null;
  const name = gitCacheName(layout.root, layout.gitdir, harden, gitBin);
  const sig = gitSig(layout);
  const hit = readGitCache(name, env);
  if (hit && hit.at <= cache.now && cache.now - hit.at < GIT_TTL && sameSig(hit.sig, sig)) {
    return finishGit({ ...hit.info, operation: detectOperation(layout.gitdir) });
  }

  const pre: readonly string[] = harden ? HARDEN : [];
  const cfgPath = path.join(layout.common, 'config');
  const cfgSig = statSig(cfgPath);
  let out: string;
  let reused = false;
  if (hit?.cfg && sameSig([hit.cfg.sig], [cfgSig])) {
    out = hit.cfg.out;
    reused = true;
  } else {
    const got = git(cwd, ['config', '--show-scope', '--get-regexp', READ_RE], pre, true);
    if (got === null) {
      if (harden) return null;
      out = '';
    } else {
      out = got;
    }
  }
  const entries = parseScopedConfig(out);
  if (
    entries.some((e) => e.key === 'core.worktree' || (e.key === 'core.bare' && e.value.trim() === 'true'))
  ) {
    return readGitSpawning(cwd, harden);
  }
  const cacheable =
    reused ||
    (!INCLUDE_RE.test(readSmall(cfgPath) ?? '') &&
      !entries.some((e) => e.key === 'extensions.worktreeconfig'));
  const url = (n: string) => entries.find((e) => e.key === `remote.${n}.url`)?.value.trim() || null;
  const safe: readonly string[] = harden ? [...HARDEN, ...localFilterOverrides(entries)] : [];

  const base = ['status', '--porcelain=v2', '--branch'];
  const withStash = git(cwd, [...base, '--show-stash'], safe);
  const status = withStash ?? git(cwd, base, safe);
  if (status === null) return null;
  const parsed = parseStatus(status);
  const s = { ...parsed, stash: withStash === null ? null : parsed.stash };

  const diffArgs = harden
    ? ['diff', 'HEAD', '--shortstat', '--no-ext-diff', '--no-textconv']
    : ['diff', 'HEAD', '--shortstat'];
  const diff = git(cwd, diffArgs, safe);
  const stat = diff === null ? { insertions: null, deletions: null } : parseShortstat(diff);

  const info = finishGit({
    root: layout.root,
    ...s,
    ...stat,
    operation: detectOperation(layout.gitdir),
    remoteUrl: url('origin'),
    upstreamUrl: url('upstream'),
    forkUrl: url('fork'),
    isWorktree: layout.gitdir !== layout.common,
  });
  if (cache.persist) {
    const entry: GitCacheEntry = {
      v: GIT_CACHE_VERSION,
      at: cache.now,
      sig: gitSig(layout),
      info: { ...info, operation: null },
      ...(cacheable ? { cfg: { sig: cfgSig, out } } : {}),
    };
    writeCache(name, entry, env);
  }
  return info;
}

export interface GitLayout {
  root: string;
  gitdir: string;
  common: string;
}

const DISCOVERY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
];

// file walk only; null means use the spawning path uncached
export function discoverGit(cwd: string, env: NodeJS.ProcessEnv = process.env): GitLayout | null {
  try {
    const win = process.platform === 'win32';
    for (const k of Object.keys(env)) {
      const key = win ? k.toUpperCase() : k;
      if (DISCOVERY_ENV.includes(key) && env[k] !== undefined) return null;
    }
    const holder = findUp(cwd, '.git', 'any');
    if (!holder) return null;
    const dotgit = path.join(holder, '.git');
    let gitdir: string;
    if (fs.statSync(dotgit).isDirectory()) {
      gitdir = dotgit;
    } else {
      const text = readSmall(dotgit);
      const g = text === null ? null : gitdirOf(text, holder);
      if (!g) return null;
      gitdir = g;
    }
    const head = readSmall(path.join(gitdir, 'HEAD'));
    if (head === null || /^ref:\s*refs\/heads\/\.invalid\s*$/.test(head.trim())) return null;
    const cd = readSmall(path.join(gitdir, 'commondir'));
    const common = cd === null ? gitdir : path.resolve(gitdir, cd.trim());
    let root: string;
    try {
      root = fs.realpathSync.native(holder);
    } catch {
      root = path.resolve(holder);
    }
    return { root, gitdir, common };
  } catch {
    return null;
  }
}

export type GitSig = [string, number, number] | [string, null];

function statSig(f: string): GitSig {
  try {
    const st = fs.statSync(f, { throwIfNoEntry: false });
    if (st) return [f, st.mtimeMs, st.size];
  } catch {}
  return [f, null];
}

export function gitSig(layout: GitLayout): GitSig[] {
  const { gitdir, common } = layout;
  const out: GitSig[] = [
    statSig(path.join(gitdir, 'HEAD')),
    statSig(path.join(gitdir, 'index')),
    statSig(path.join(common, 'packed-refs')),
    statSig(path.join(common, 'config')),
  ];
  const raw = readSmall(path.join(gitdir, 'HEAD'));
  const branch = raw === null ? null : parseHead(raw);
  if (branch && !branch.detached && branch.branch) {
    out.push(statSig(path.join(common, 'refs', 'heads', branch.branch)));
  }
  out.push(statSig(path.join(gitdir, 'logs', 'HEAD')), statSig(path.join(common, 'refs', 'stash')));
  return out;
}

export function sameSig(a: GitSig[], b: GitSig[]): boolean {
  return (
    a.length === b.length && a.every((x, i) => x[0] === b[i]![0] && x[1] === b[i]![1] && x[2] === b[i]![2])
  );
}

export const GIT_TTL = 2000;
const GIT_CACHE_VERSION = 1;

export function gitCacheName(root: string, gitdir: string, harden: boolean, gitBin: string): string {
  return `git-${cacheKey(root, gitdir, harden ? '1' : '0', gitBin)}.json`;
}

export interface GitCacheEntry {
  v: number;
  at: number;
  sig: GitSig[];
  info: GitInfo;
  cfg?: { sig: GitSig; out: string };
}

function isSig(x: unknown): x is GitSig {
  if (!Array.isArray(x) || typeof x[0] !== 'string') return false;
  if (x.length === 2) return x[1] === null;
  return x.length === 3 && typeof x[1] === 'number' && typeof x[2] === 'number';
}

const num = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown): boolean => x === null || num(x);

function isInfo(x: unknown): x is GitInfo {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.root === 'string' &&
    (o.branch === null || typeof o.branch === 'string') &&
    ['ahead', 'behind', 'staged', 'unstaged', 'untracked', 'conflicts'].every((k) => num(o[k])) &&
    ['insertions', 'deletions', 'stash'].every((k) => numOrNull(o[k])) &&
    typeof o.isWorktree === 'boolean'
  );
}

export function readGitCache(name: string, env: NodeJS.ProcessEnv): GitCacheEntry | null {
  const raw = readCache<unknown>(name, env);
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== GIT_CACHE_VERSION || typeof o.at !== 'number') return null;
  if (!Array.isArray(o.sig) || !o.sig.every(isSig) || !isInfo(o.info)) return null;
  const entry: GitCacheEntry = { v: o.v, at: o.at, sig: o.sig as GitSig[], info: deepSanitize(o.info) };
  if (o.cfg !== undefined) {
    const c = o.cfg as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || typeof c.out !== 'string' || !isSig(c.sig)) return null;
    entry.cfg = { sig: c.sig, out: c.out };
  }
  return entry;
}
