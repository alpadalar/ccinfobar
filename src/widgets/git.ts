import path from 'node:path';
import { hyperlink } from '../core/ansi.js';
import { t } from '../core/i18n/index.js';
import type { GhValue } from '../core/job-values.js';
import { safeUrl } from '../core/sanitize.js';
import type { RenderContext, WidgetDef, WidgetItem } from '../core/types.js';
import type { GitInfo } from '../data/git.js';
import { ghKey, ghParam } from '../data/jobs/keys.js';
import { jobValue } from '../data/jobs/runner.js';
import { pickRepos } from '../data/repos.js';
import { hideZeroOption, opt } from './shared.js';
import { formatPath, segmentsOption, styleOption } from './workspace.js';

export function parseRemote(url: string | null | undefined): { host: string; path: string } | null {
  if (!url) return null;
  const raw = url.trim();
  if (!/^[\w.+-]+:\/\/|^[^/\\:]+@[^:]+:|^[\w.-]+:[^\\/]/.test(raw)) return null;
  let host: string;
  let rest: string;
  if (/^[\w.+-]+:\/\//.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      rest = u.pathname;
    } catch {
      return null;
    }
  } else {
    const i = raw.indexOf(':');
    host = raw.slice(0, i).replace(/^.*@/, '').toLowerCase();
    rest = raw.slice(i + 1);
  }
  const p = rest
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return p ? { host, path: p } : null;
}

const tail = (p: string) => p.split('/').slice(-2).join('/');

export function repoSlug(url: string | null | undefined): string | null {
  const p = parseRemote(url)?.path.split('/');
  return p && p.length >= 2 ? tail(p.join('/')) : null;
}

// upstream remote: origin is the fork; fork remote: origin is the parent
export function forkInfo(g: GitInfo | null | undefined): { fork: string; parent: string } | null {
  if (!g) return null;
  const origin = parseRemote(g.remoteUrl);
  const upstream = parseRemote(g.upstreamUrl);
  const [fork, parent] = upstream ? [origin, upstream] : [parseRemote(g.forkUrl), origin];
  if (!fork || !parent) return null;
  const id = (r: { host: string; path: string }) => `${r.host}/${r.path}`.toLowerCase();
  if (id(fork) === id(parent)) return null;
  const label = fork.host === parent.host ? tail(parent.path) : `${parent.host}/${tail(parent.path)}`;
  return { fork: fork.path, parent: label };
}

export const PR_CI_GONE_MS = 3_600_000;

export type PrCiState =
  | { kind: 'off' }
  | { kind: 'mr' }
  | { kind: 'no-repo' }
  | { kind: 'pending'; key: string }
  | { kind: 'error'; key: string; error: string | null }
  | { kind: 'gone'; key: string; error: string | null }
  | { kind: 'ok'; key: string; v: GhValue; error: string | null };

const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;

const isCounts = (v: unknown): v is GhValue => {
  const c = v as GhValue | null;
  return !!c && typeof c === 'object' && count(c.fail) && count(c.pending) && count(c.total);
};

// same strict check as the gh job, so the widget never waits on a job that never runs
export function prCiState(ctx: RenderContext, item: WidgetItem): PrCiState {
  const pr = ctx.payload.pr;
  if (item.options?.ci !== true || !pr || pr.number === undefined) return { kind: 'off' };
  if (pr.kind === 'mr') return { kind: 'mr' };
  const param = ghParam(ctx.payload);
  if (!param) return { kind: 'no-repo' };
  const key = ghKey(param);
  const j = jobValue(ctx.data.jobs?.()?.job<GhValue>(key) ?? null);
  if (!j) return { kind: 'pending', key };
  if (!isCounts(j.value)) return { kind: 'error', key, error: j.error };
  if (j.at === null || ctx.now.getTime() - j.at > PR_CI_GONE_MS) return { kind: 'gone', key, error: j.error };
  return { kind: 'ok', key, v: j.value, error: j.error };
}

function ciText(v: GhValue, ascii: boolean): string {
  if (v.fail > 0) return `${ascii ? 'x' : '✗'} ${v.fail}`;
  if (v.pending > 0) return `${ascii ? '*' : '●'} ${v.pending}`;
  if (v.total > 0) return ascii ? t('widget.pr.ciPassText') : '✓';
  return '';
}

const hideZero = hideZeroOption();

function worktreeName(ctx: RenderContext): string | null {
  const fromPayload = ctx.payload.worktree?.name || ctx.payload.workspace?.git_worktree;
  if (fromPayload) return fromPayload;
  const g = ctx.data.git();
  return g?.isWorktree ? path.basename(g.root) : null;
}

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
    options: [hideZero],
    render(ctx, item) {
      const g = ctx.data.git();
      if (!g || g.insertions === null || g.deletions === null) return null;
      if (!g.insertions && !g.deletions && opt(item, 'hideZero', false)) return null;
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
      if (!g || g.upstream === null) return null;
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
    options: [hideZero],
    render(ctx, item) {
      const n = ctx.data.git()?.conflicts;
      if (n === undefined || (n === 0 && opt(item, 'hideZero', false))) return null;
      return String(n);
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
      return n == null ? null : String(n);
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
    options: [
      { key: 'nameOnly', label: 'Name only', kind: 'boolean', default: false },
      { key: 'ownerOnlyWhenFork', label: 'Owner only in a fork', kind: 'boolean', default: false },
    ],
    render(ctx, item) {
      const r = ctx.payload.workspace?.repo;
      const full = r?.owner && r.name ? `${r.owner}/${r.name}` : repoSlug(ctx.data.git()?.remoteUrl);
      if (!full) return null;
      const slash = full.indexOf('/');
      if (opt(item, 'ownerOnlyWhenFork', false) && forkInfo(ctx.data.git())) return full.slice(0, slash);
      return opt(item, 'nameOnly', false) ? full.slice(slash + 1) : full;
    },
  },
  {
    type: 'git-is-fork',
    name: 'Git is fork',
    category: 'git',
    hideWhenEmpty: true,
    description: 'Marks a repo that is a fork, from the upstream or fork remote',
    icon: { nerd: '', emoji: '🍴' },
    color: 'yellow',
    sample: '⑂',
    options: [
      { key: 'symbol', label: 'Symbol', kind: 'text', default: '', help: 'Empty uses ⑂' },
      { key: 'showParent', label: 'Show parent repo', kind: 'boolean', default: false },
    ],
    render(ctx, item) {
      const f = forkInfo(ctx.data.git());
      if (!f) return null;
      const custom = opt<string>(item, 'symbol', '');
      const symbol = custom || (ctx.config.charset === 'text' ? t('widget.gitIsFork.text') : '⑂');
      return opt(item, 'showParent', false) ? `${symbol} ${f.parent}` : symbol;
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
    options: [
      {
        key: 'show',
        label: 'Show',
        kind: 'select',
        default: 'name',
        choices: [
          { value: 'name', label: 'Name' },
          { value: 'branch', label: 'Branch' },
          { value: 'original-branch', label: 'Original branch' },
          { value: 'path', label: 'Path' },
          { value: 'original-cwd', label: 'Original directory' },
        ],
        help: 'Branch and path fields fall back to the name when Claude Code did not send them',
      },
      { ...styleOption, default: 'short', showWhen: { key: 'show', values: ['path', 'original-cwd'] } },
      { ...segmentsOption, showWhen: { key: 'show', values: ['path', 'original-cwd'] } },
      {
        key: 'showOrigin',
        label: 'Show origin branch',
        kind: 'boolean',
        default: false,
        help: 'Append the branch the worktree was created from',
      },
    ],
    render: (ctx, item) => {
      const show = opt<string>(item, 'show', 'name');
      const w = ctx.payload.worktree;
      const raw =
        show === 'branch'
          ? w?.branch
          : show === 'original-branch'
            ? w?.original_branch
            : show === 'path'
              ? w?.path
              : show === 'original-cwd'
                ? w?.original_cwd
                : undefined;
      const field = typeof raw === 'string' && raw ? raw : null;
      let text: string | null;
      if (field && (show === 'path' || show === 'original-cwd')) {
        text = formatPath(field, opt<string>(item, 'style', 'short'), opt(item, 'segments', 2));
      } else {
        text = field ?? worktreeName(ctx);
      }
      if (text === null) return null;
      const origin = w?.original_branch;
      if (
        opt(item, 'showOrigin', false) &&
        typeof origin === 'string' &&
        origin &&
        show !== 'original-branch'
      ) {
        text += ctx.config.charset === 'text' ? ` <- ${origin}` : ` ← ${origin}`;
      }
      return text;
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
    options: [
      { key: 'link', label: 'Clickable link', kind: 'boolean', default: false },
      {
        key: 'ci',
        label: 'CI checks (needs gh)',
        kind: 'boolean',
        default: false,
        help: 'Shows passing, failing or running checks from gh pr checks, refreshed in the background',
      },
    ],
    render(ctx, item) {
      const pr = ctx.payload.pr;
      if (!pr || pr.number === undefined) return null;
      const text = `#${pr.number}${pr.review_state ? ` ${pr.review_state}` : ''}`;
      const href = pr.url ? safeUrl(pr.url) : null;
      const out = opt(item, 'link', false) && href ? hyperlink(text, href) : text;
      const ci = prCiState(ctx, item);
      const part = ci.kind === 'ok' ? ciText(ci.v, ctx.config.charset === 'text') : '';
      return part ? `${out} ${part}` : out;
    },
  },
  {
    type: 'workspace-repos',
    name: 'Workspace repos',
    category: 'git',
    hideWhenEmpty: true,
    description: 'Child folders that are git repos, when the folder itself is not a repo',
    label: 'repos: ',
    icon: { nerd: '', emoji: '📦' },
    color: 'magenta',
    sample: 'api (main) · web (dev) · infra (main)',
    options: [
      { key: 'maxItems', aliases: ['maxRepos'], label: 'Repos shown', kind: 'number', default: 5 },
      { key: 'showBranch', label: 'Show branch', kind: 'boolean', default: true },
      {
        key: 'sort',
        label: 'Sort',
        kind: 'select',
        default: 'name',
        choices: [
          { value: 'name', label: 'By name' },
          { value: 'recent', label: 'Most recent first' },
        ],
      },
      { key: 'includeHidden', label: 'Include hidden folders', kind: 'boolean', default: false },
      {
        key: 'hideGitPlaceholders',
        label: 'Hide empty git widgets',
        kind: 'boolean',
        help: 'While repos are shown, the other git widgets hide instead of showing —',
        default: true,
      },
      {
        key: 'dirty',
        label: 'Mark repos with uncommitted changes',
        kind: 'boolean',
        help: 'Checked in the background',
        default: false,
      },
    ],
    render(ctx, item) {
      const ws = ctx.data.repos?.();
      if (!ws) return null;
      const list = pickRepos(ws.repos, opt(item, 'includeHidden', false), opt<string>(item, 'sort', 'name'));
      if (!list.length) return null;
      const max = Math.max(1, Math.floor(opt(item, 'maxItems', 5)));
      const branch = opt(item, 'showBranch', true);
      const mark = opt(item, 'dirty', false);
      const parts = list.slice(0, max).map((r) => {
        const star = mark && ws.dirty?.[r.name] === true ? '*' : '';
        return branch && r.branch ? `${r.name} (${r.branch}${star})` : `${r.name}${star}`;
      });
      const text = parts.join(ctx.config.charset === 'text' ? ' | ' : ' · ');
      const more = list.length - parts.length;
      return more > 0 ? `${text} +${more}` : text;
    },
  },
];
