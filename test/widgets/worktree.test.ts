import { describe, expect, it } from 'vitest';
import { sampleGit } from '../../src/core/sample.js';
import type { StatusPayload } from '../../src/core/types.js';
import { formatPath } from '../../src/widgets/workspace.js';
import { ctxWith, renderWidget } from '../helpers.js';

const wt = {
  name: 'feat-x',
  path: '/home/dev/.claude/worktrees/feat-x',
  branch: 'feature/x',
  original_cwd: '/home/dev/projects/acme-app',
  original_branch: 'main',
};

const run = (
  options: Record<string, string | number | boolean>,
  payload: StatusPayload = { worktree: wt },
  extra: Parameters<typeof ctxWith>[0] = {},
) => renderWidget('git-worktree', ctxWith({ payload, ...extra }), { options });

const plainGit = () => ({ ...sampleGit(), isWorktree: false });

describe('git-worktree', () => {
  it('defaults to the name', () => {
    expect(run({})).toBe('feat-x');
    expect(run({ show: 'name' })).toBe('feat-x');
  });

  it('shows branch and original branch', () => {
    expect(run({ show: 'branch' })).toBe('feature/x');
    expect(run({ show: 'original-branch' })).toBe('main');
  });

  it('shortens path and original directory', () => {
    const short = run({ show: 'path' });
    expect(short).toBe(formatPath(wt.path, 'short', 2));
    expect(short?.endsWith('feat-x')).toBe(true);
    expect(run({ show: 'path', style: 'basename' })).toBe('feat-x');
    expect(run({ show: 'original-cwd', style: 'tilde' })).toBe(formatPath(wt.original_cwd, 'tilde'));
    expect(run({ show: 'original-cwd', style: 'segments', segments: 1 })).toBe('acme-app');
  });

  it('falls back to the name for hook-based worktrees', () => {
    for (const show of ['branch', 'original-branch', 'path', 'original-cwd']) {
      expect(run({ show }, { worktree: { name: 'feat-x' } })).toBe('feat-x');
    }
  });

  it('falls back to workspace.git_worktree', () => {
    expect(run({ show: 'branch' }, { workspace: { git_worktree: 'w' } })).toBe('w');
  });

  it('falls back to the git probe basename', () => {
    const git = () => ({ ...sampleGit(), isWorktree: true, root: '/tmp/x/wt-1' });
    expect(run({ show: 'path' }, {}, { git })).toBe('wt-1');
  });

  it('appends the origin branch', () => {
    expect(run({ showOrigin: true })).toBe('feat-x ← main');
    expect(run({ showOrigin: true }, { worktree: wt }, { config: { charset: 'text' } })).toBe(
      'feat-x <- main',
    );
    expect(run({ show: 'original-branch', showOrigin: true })).toBe('main');
    expect(run({ showOrigin: true }, { worktree: { name: 'feat-x' } })).toBe('feat-x');
  });

  it('is hidden without worktree data', () => {
    for (const show of ['name', 'branch', 'original-branch', 'path', 'original-cwd']) {
      expect(run({ show }, {}, { git: plainGit })).toBeNull();
    }
  });
});
