import fs from 'node:fs';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { loadForUse } from '../core/load.js';
import type { Config } from '../core/types.js';
import { hardenedGit } from '../data/git.js';
import { DIRTY_VERSION, dirtyFile, insideRepo, pickRepos, type RepoEntry, scanRepos } from '../data/repos.js';
import { writeAtomic } from '../data/store.js';
import { opt } from '../widgets/shared.js';

const MAX_REPOS = 50;
const PER_REPO_MS = 2_000;
const BUDGET_MS = 15_000;
const STATUS = ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=dirty'];

export function computeDirty(
  cwd: string,
  repos: RepoEntry[],
  opts: { harden: boolean; perRepoMs?: number; budgetMs?: number; env?: NodeJS.ProcessEnv },
): Record<string, boolean> {
  const out = Object.create(null) as Record<string, boolean>;
  const per = opts.perRepoMs ?? PER_REPO_MS;
  const end = Date.now() + (opts.budgetMs ?? BUDGET_MS);
  for (const r of repos.slice(0, MAX_REPOS)) {
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

export async function runRepos(args: Args, cfgFile: string): Promise<void> {
  const cwd = args.positional[0];
  if (args.flags.background !== true || !cwd || !path.isAbsolute(cwd)) return;
  const root = path.resolve(cwd);
  try {
    if (!fs.statSync(root).isDirectory()) return;
  } catch {
    return;
  }
  const env = process.env;
  try {
    const { config } = loadForUse(cfgFile);
    const harden = config.gitHardening !== false;
    if (insideRepo(root)) return;
    const repos = dirtyOrder(scanRepos(root, { exact: true }).repos, config);
    const dirty = computeDirty(root, repos, { harden, env });
    writeAtomic(dirtyFile(root, env), JSON.stringify({ v: DIRTY_VERSION, at: Date.now(), dirty }), {
      mode: 0o600,
    });
  } catch {
  } finally {
    try {
      fs.unlinkSync(`${dirtyFile(root, env)}.lock`);
    } catch {}
  }
}
