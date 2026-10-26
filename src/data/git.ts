import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deepSanitize } from '../core/sanitize.js';

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
  insertions: number;
  deletions: number;
  stash: number;
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
  try {
    return execFileSync('git', args, {
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
    try {
      const child = execFile(
        'git',
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

function git(cwd: string, args: string[], pre: readonly string[] = []): string | null {
  return exec(cwd, [...pre, ...args], GIT_TIMEOUT, {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    [EMPTY_VAR]: '',
  });
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

export function readGit(cwd: string, opts: { harden?: boolean } = {}): GitInfo | null {
  const harden = opts.harden !== false;
  const pre: readonly string[] = harden ? HARDEN : [];
  const revs = git(cwd, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], pre);
  if (revs === null) return null;
  const [top, gitDirRaw, commonRaw] = revs.split('\n').map((l) => l.trim());
  if (!top || !gitDirRaw) return null;
  const gitDir = path.resolve(cwd, gitDirRaw);
  const common = commonRaw ? path.resolve(cwd, commonRaw) : gitDir;

  // exits 1 when nothing matches
  const entries = parseScopedConfig(
    git(cwd, ['config', '--show-scope', '--get-regexp', SCOPED_RE], pre) ?? '',
  );
  const url = (name: string) => entries.find((e) => e.key === `remote.${name}.url`)?.value.trim() || null;
  const safe: readonly string[] = harden ? [...HARDEN, ...localFilterOverrides(entries)] : [];

  const base = ['status', '--porcelain=v2', '--branch'];
  const status = git(cwd, [...base, '--show-stash'], safe) ?? git(cwd, base, safe);
  if (status === null) return null;
  const s = parseStatus(status);

  const diffArgs = harden
    ? ['diff', 'HEAD', '--shortstat', '--no-ext-diff', '--no-textconv']
    : ['diff', 'HEAD', '--shortstat'];
  const diff = git(cwd, diffArgs, safe);
  const stat = diff ? parseShortstat(diff) : { insertions: 0, deletions: 0 };

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
