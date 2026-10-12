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
  isWorktree: boolean;
}

export function readGit(_cwd: string): GitInfo | null {
  return null;
}
