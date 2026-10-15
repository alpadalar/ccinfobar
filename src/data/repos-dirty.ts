import path from 'node:path';
import type { Config } from '../core/types.js';
import { opt } from '../widgets/shared.js';
import { hardenedGit } from './git.js';
import { insideRepo, pickRepos, type RepoEntry, scanRepos } from './repos.js';

// the dirty check: the repos job loads it with import()
const MAX_REPOS = 50;
const PER_REPO_MS = 2_000;
const BUDGET_MS = 15_000;
const STATUS = ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty'];

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// yields between repos so the worker's other jobs keep running
export async function computeDirty(
  cwd: string,
  repos: RepoEntry[],
  opts: { harden: boolean; perRepoMs?: number; budgetMs?: number; env?: NodeJS.ProcessEnv },
): Promise<Record<string, boolean>> {
  const out = Object.create(null) as Record<string, boolean>;
  const per = opts.perRepoMs ?? PER_REPO_MS;
  const end = Date.now() + (opts.budgetMs ?? BUDGET_MS);
  for (const r of repos.slice(0, MAX_REPOS)) {
    await tick();
    const left = end - Date.now();
    if (left <= 0) break;
    const status = hardenedGit(path.join(cwd, r.name), STATUS, {
      harden: opts.harden,
      timeout: Math.min(per, left),
      ...(opts.env ? { env: opts.env } : {}),
    });
    if (status !== null) out[r.name] = status.trim() !== '';
  }
  return out;
}

// repos each workspace-repos item shows first, then the rest
export function dirtyOrder(repos: RepoEntry[], config: Config): RepoEntry[] {
  const out = new Set<RepoEntry>();
  for (const it of config.lines.flat()) {
    if (it.type !== 'workspace-repos') continue;
    const max = Math.max(1, Math.floor(opt(it, 'maxRepos', 5)));
    const list = pickRepos(repos, opt(it, 'includeHidden', false), opt<string>(it, 'sort', 'name'));
    for (const r of list.slice(0, max)) out.add(r);
  }
  for (const r of repos) if (!r.hidden) out.add(r);
  for (const r of repos) out.add(r);
  return [...out];
}

export async function checkRepos(
  root: string,
  config: Config,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, boolean>> {
  if (insideRepo(root)) return Object.create(null) as Record<string, boolean>;
  const repos = dirtyOrder(scanRepos(root, { exact: true }).repos, config);
  return computeDirty(root, repos, { harden: config.gitHardening !== false, env });
}
