import path from 'node:path';
import { hyperlink } from '../core/ansi.js';
import type { OptionSpec, WidgetDef } from '../core/types.js';
import { opt } from './shared.js';

export function parseRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!/^[\w.+-]+:\/\/|^[^/\\:]+@[^:]+:|^[\w.-]+:[^\\/]/.test(url.trim())) return null;
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const hideZero: OptionSpec = {
  key: 'hideZero',
  label: 'Hide when zero',
  kind: 'boolean',
  default: false,
};

export const widgets: WidgetDef[] = [
  {
    type: 'git-branch',
    name: 'Git branch',
    category: 'git',
    description: 'Current branch, or short sha when detached',
    icon: { nerd: '', emoji: '🌿' },
    color: 'magenta',
    sample: 'feat/statusline',
    options: [{ key: 'showIcon', label: 'Prefix with branch glyph', kind: 'boolean', default: false }],
    render(ctx, item) {
      const g = ctx.data.git();
      if (!g) return null;
      const name = g.detached ? g.sha : g.branch;
      if (!name) return null;
      return opt(item, 'showIcon', false) ? `⎇ ${name}` : name;
    },
  },
  {
    type: 'git-sha',
    name: 'Git commit',
    category: 'git',
    description: 'Short commit hash',
    icon: { nerd: '', emoji: '#️⃣' },
    color: 'brightBlack',
    sample: 'a1b2c3d',
    render: (ctx) => ctx.data.git()?.sha || null,
  },
  {
    type: 'git-changes',
    name: 'Git changes',
    category: 'git',
    description: 'Inserted and deleted lines versus HEAD',
    icon: { nerd: '󰦒', emoji: '✏️' },
    color: 'yellow',
    sample: '+148 -37',
    render(ctx) {
      const g = ctx.data.git();
      if (!g) return null;
      return `+${g.insertions} -${g.deletions}`;
    },
  },
  {
    type: 'git-status',
    name: 'Git status',
    category: 'git',
    description: 'Clean or dirty working tree',
    icon: { nerd: '', emoji: '📋' },
    color: 'yellow',
    sample: '● +3 ~2 ?1',
    options: [{ key: 'counts', label: 'Show counts', kind: 'boolean', default: true }],
    render(ctx, item) {
      const g = ctx.data.git();
      if (!g) return null;
      const parts: string[] = [];
      if (g.staged) parts.push(`+${g.staged}`);
      if (g.unstaged) parts.push(`~${g.unstaged}`);
      if (g.untracked) parts.push(`?${g.untracked}`);
      if (g.conflicts) parts.push(`!${g.conflicts}`);
      if (parts.length === 0) return { text: '✓', color: 'green' };
      const text = opt(item, 'counts', true) ? `● ${parts.join(' ')}` : '●';
      return { text, color: g.conflicts ? 'red' : 'yellow' };
    },
  },
  {
    type: 'git-staged',
    name: 'Git staged',
    category: 'git',
    description: 'Staged files',
    label: 'Staged ',
    icon: { nerd: '', emoji: '✅' },
    color: 'green',
    sample: '3',
    options: [hideZero],
    render(ctx, item) {
      const n = ctx.data.git()?.staged;
      if (n === undefined || (n === 0 && opt(item, 'hideZero', false))) return null;
      return String(n);
    },
  },
  {
    type: 'git-unstaged',
    name: 'Git unstaged',
    category: 'git',
    description: 'Modified files not yet staged',
    label: 'Modified ',
    icon: { nerd: '', emoji: '📝' },
    color: 'yellow',
    sample: '2',
    options: [hideZero],
    render(ctx, item) {
      const n = ctx.data.git()?.unstaged;
      if (n === undefined || (n === 0 && opt(item, 'hideZero', false))) return null;
      return String(n);
    },
  },
  {
    type: 'git-untracked',
    name: 'Git untracked',
    category: 'git',
    description: 'Untracked files',
    label: 'Untracked ',
    icon: { nerd: '', emoji: '❓' },
    color: 'brightBlack',
    sample: '1',
    options: [hideZero],
    render(ctx, item) {
      const n = ctx.data.git()?.untracked;
      if (n === undefined || (n === 0 && opt(item, 'hideZero', false))) return null;
      return String(n);
    },
  },
  {
    type: 'git-ahead-behind',
    name: 'Git ahead/behind',
    category: 'git',
    description: 'Commits ahead of and behind upstream',
    color: 'cyan',
    sample: '↑2 ↓0',
    render(ctx) {
      const g = ctx.data.git();
      if (!g) return null;
      return `↑${g.ahead} ↓${g.behind}`;
    },
  },
  {
    type: 'git-conflicts',
    name: 'Git conflicts',
    category: 'git',
    description: 'Files with merge conflicts',
    label: 'Conflicts ',
    icon: { nerd: '', emoji: '⚠️' },
    color: 'red',
    sample: '2',
    render(ctx) {
      const n = ctx.data.git()?.conflicts;
      return n === undefined ? null : String(n);
    },
  },
  {
    type: 'git-stash',
    name: 'Git stash',
    category: 'git',
    description: 'Number of stash entries',
    label: 'Stash ',
    icon: { nerd: '󰆓', emoji: '📦' },
    color: 'brightBlack',
    sample: '1',
    render(ctx) {
      const n = ctx.data.git()?.stash;
      return n === undefined ? null : String(n);
    },
  },
  {
    type: 'git-operation',
    name: 'Git operation',
    category: 'git',
    description: 'Merge, rebase, cherry-pick, revert or bisect in progress',
    icon: { nerd: '', emoji: '🔀' },
    color: 'red',
    sample: 'MERGING',
    render: (ctx) => ctx.data.git()?.operation || null,
  },
  {
    type: 'git-repo',
    name: 'Git repository',
    category: 'git',
    description: 'Repository owner/name',
    icon: { nerd: '', emoji: '📁' },
    color: 'blue',
    sample: 'acme/acme-app',
    options: [{ key: 'nameOnly', label: 'Name only', kind: 'boolean', default: false }],
    render(ctx, item) {
      const r = ctx.payload.workspace?.repo;
      const full = r?.owner && r.name ? `${r.owner}/${r.name}` : parseRemote(ctx.data.git()?.remoteUrl);
      if (!full) return null;
      return opt(item, 'nameOnly', false) ? full.slice(full.indexOf('/') + 1) : full;
    },
  },
  {
    type: 'git-worktree',
    name: 'Git worktree',
    category: 'git',
    description: 'Linked worktree name',
    label: 'wt ',
    icon: { nerd: '󰙅', emoji: '🌳' },
    color: 'green',
    sample: 'feature-x',
    render: (ctx) => {
      const fromPayload = ctx.payload.worktree?.name || ctx.payload.workspace?.git_worktree;
      if (fromPayload) return fromPayload;
      const g = ctx.data.git();
      return g?.isWorktree ? path.basename(g.root) : null;
    },
  },
  {
    type: 'pr',
    name: 'Pull request',
    category: 'git',
    description: 'Pull request number and review state',
    icon: { nerd: '', emoji: '🔃' },
    color: 'green',
    sample: '#128 pending',
    options: [{ key: 'link', label: 'Clickable link', kind: 'boolean', default: false }],
    render(ctx, item) {
      const pr = ctx.payload.pr;
      if (!pr || pr.number === undefined) return null;
      const text = `#${pr.number}${pr.review_state ? ` ${pr.review_state}` : ''}`;
      return opt(item, 'link', false) && pr.url ? hyperlink(text, pr.url) : text;
    },
  },
];
