import cp from 'node:child_process';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sampleGit, samplePayload } from '../../src/core/sample.js';
import type { Config, StatusPayload } from '../../src/core/types.js';
import { ALL_WIDGETS, CATEGORIES, getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const r = (type: string, opts: Record<string, string | number | boolean> = {}, payload?: StatusPayload) =>
  renderWidget(type, ctxWith(payload ? { payload } : {}), { options: opts });

const empty = (): StatusPayload => ({});
const noData = (config?: Partial<Config>) =>
  ctxWith({
    payload: empty(),
    git: () => null,
    transcript: () => null,
    history: () => [],
    agents: () => [],
    ledger: () => null,
    repos: () => null,
    hooks: () => null,
    environment: () => null,
    sandbox: () => null,
    jj: () => null,
    config,
  });

describe('sample rendering', () => {
  const expected: Record<string, string> = {
    effort: 'high',
    thinking: 'on',
    'session-name': 'statusline refactor',
    'session-id': '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f',
    'claude-version': 'v2.1.300',
    'vim-mode': 'INSERT',
    'context-percentage': '34%',
    'context-bar': '███░░░░░░░ 34%',
    'context-length': '340k',
    'context-window-size': '1M',
    compactions: '1x',
    'tokens-input': '412k',
    'tokens-output': '38.4k',
    'tokens-total': '450k',
    'cache-hit-rate': '94%',
    'cache-timer': '41m',
    'cache-miss-cause': 'tools changed (+2/-0)',
    'output-speed': '72 t/s',
    'session-cost': '$1.87',
    'cost-rate': '$2.47/h',
    'session-duration': '45m',
    'api-duration': '13m',
    'lines-changed': '+214 -63',
    'message-count': '86',
    'five-hour-usage': '42%',
    'five-hour-reset': '2h 14m',
    'weekly-usage': '61%',
    'weekly-reset': '1d 5h',
    'weekly-model-usage': 'Fable 23%',
    'weekly-model-reset': '1d 5h',
    'usage-pace': '⇣13%',
    'git-branch': 'feat/statusline',
    'git-sha': 'a1b2c3d',
    'git-changes': '+148 -37',
    'git-status': '● +3 ~2 ?1',
    'git-staged': '3',
    'git-unstaged': '2',
    'git-untracked': '1',
    'git-ahead-behind': '↑2 ↓0',
    'git-stash': '1',
    'git-repo': 'acme/acme-app',
    pr: '#128 pending',
    cwd: 'acme-app',
    'project-dir': 'acme-app',
    'terminal-width': '140',
  };
  for (const [type, out] of Object.entries(expected)) {
    it(type, () => expect(renderWidget(type, ctxWith({ width: 140 }))).toBe(out));
  }

  it('hides default-valued widgets', () => {
    for (const t of ['output-style', 'fast-mode', 'git-operation', 'git-worktree', 'agent-name']) {
      expect(r(t)).toBeNull();
    }
  });
});

describe('weekly model limits', () => {
  it('picks a model by name and ignores models without a limit', () => {
    const c = ctxWith();
    expect(renderWidget('weekly-model-usage', c, { options: { model: 'fable' } })).toBe('Fable 23%');
    expect(renderWidget('weekly-model-usage', c, { options: { model: 'sonnet' } })).toBeNull();
    expect(renderWidget('weekly-sonnet-usage', c)).toBeNull();
  });

  it('still reads the older sonnet and opus fields', () => {
    const p = samplePayload(NOW.getTime());
    p.rate_limits = { seven_day_opus: { used_percentage: 48, resets_at: null } };
    const c = ctxWith({ payload: p });
    expect(renderWidget('weekly-opus-usage', c)).toBe('48%');
    expect(renderWidget('weekly-model-usage', c)).toBe('Opus 48%');
  });

  it('keeps legacy widgets out of the palette', () => {
    const hidden = ALL_WIDGETS.filter((w) => w.hidden).map((w) => w.type);
    expect(hidden).toEqual(['weekly-sonnet-usage', 'weekly-opus-usage']);
  });
});

describe('missing data', () => {
  const skip = new Set([
    'text',
    'separator',
    'flex',
    'clock',
    'date',
    'hostname',
    'username',
    'memory',
    'load-average',
    'platform',
    'link',
    'cwd',
  ]);
  for (const def of ALL_WIDGETS.filter((w) => !skip.has(w.type) && w.category !== 'gsd')) {
    it(`${def.type} hides without data`, () => {
      // loading placeholder off; test/widgets/loading.test.ts covers it
      expect(renderWidget(def.type, noData({ loadingText: '' }))).toBeNull();
    });
  }
});

describe('options', () => {
  it('effort showThinking', () => expect(r('effort', { showThinking: true })).toBe('high+think'));
  it('session-id short', () => expect(r('session-id', { short: true })).toBe('3f2a9c1e'));
  it('output-style non default', () => {
    const p = { ...samplePayload(NOW.getTime()), output_style: { name: 'Explanatory' } };
    expect(r('output-style', {}, p)).toBe('Explanatory');
    expect(r('output-style', { showDefault: true })).toBe('default');
  });
  it('fast-mode', () => {
    const p = { ...samplePayload(NOW.getTime()), fast_mode: true };
    expect(r('fast-mode', {}, p)).toBe('fast');
  });
  it('session-name falls back to transcript', () => {
    const p = { ...samplePayload(NOW.getTime()), session_name: undefined };
    expect(r('session-name', {}, p)).toBe('statusline refactor');
  });
  it('context remaining and usable', () => {
    expect(r('context-percentage', { mode: 'remaining' })).toBe('66%');
    expect(r('context-percentage', { usable: true })).toBe('35%');
    const ctx = ctxWith();
    ctx.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '500000';
    expect(renderWidget('context-percentage', ctx, { options: { usable: true } })).toBe('73%');
  });
  it('context-length showMax', () => expect(r('context-length', { showMax: true })).toBe('340k/1M'));
  it('context falls back to transcript', () => {
    const p: StatusPayload = { transcript_path: 'x' };
    expect(r('context-length', {}, p)).toBe('340k');
  });
  it('threshold colors', () => {
    const def = ALL_WIDGETS.find((w) => w.type === 'context-percentage')!;
    const p = { ...samplePayload(NOW.getTime()) };
    p.context_window = { ...p.context_window, used_percentage: 90 };
    const out = def.render(ctxWith({ payload: p }), { id: 'x', type: def.type });
    expect(out).toEqual({ text: '90%', color: 'red' });
  });
  it('session-cost decimals', () => expect(r('session-cost', { decimals: 0 })).toBe('$2'));
  it('session-duration clock', () => expect(r('session-duration', { format: 'clock' })).toBe('00:45:30'));
  it('cache-timer cold', () => {
    const p = samplePayload(NOW.getTime());
    p.prompt_cache = { warm: false };
    expect(r('cache-timer', {}, p)).toBe('cold');
  });
  it('cache-timer expired', () => {
    const p = samplePayload(NOW.getTime());
    p.prompt_cache = { warm: true, expires_at: NOW.getTime() / 1000 - 5 };
    expect(r('cache-timer', {}, p)).toBe('cold');
  });
  it('five-hour bar and iso resets_at', () => {
    expect(r('five-hour-usage', { display: 'bar', width: 5 })).toBe('██░░░ 42%');
    const p = samplePayload(NOW.getTime());
    p.rate_limits = { five_hour: { resets_at: new Date(NOW.getTime() + 90 * 60_000).toISOString() } };
    expect(r('five-hour-reset', {}, p)).toBe('1h 30m');
    expect(r('five-hour-reset', { showClockTime: true }, p)).toMatch(/^at \d\d:\d\d$/);
  });
  it('usage-pace ahead', () => {
    const p = samplePayload(NOW.getTime());
    p.rate_limits = {
      five_hour: { used_percentage: 80, resets_at: NOW.getTime() / 1000 + 2.5 * 3600 },
    };
    expect(r('usage-pace', {}, p)).toBe('⇡30%');
  });
  it('spend-limit', () => {
    const p = samplePayload(NOW.getTime());
    p.rate_limits = { spend_limit: { used_usd: 12, limit_usd: 50 } };
    expect(r('spend-limit', {}, p)).toBe('$12/$50');
  });
  it('lines-changed with zero', () => {
    const p: StatusPayload = { cost: { total_lines_added: 0, total_lines_removed: 0 } };
    expect(r('lines-changed', {}, p)).toBe('+0 -0');
    expect(r('lines-changed', { hideZero: true }, p)).toBeNull();
  });
});

describe('git widgets', () => {
  const g = (over: object) => ctxWith({ git: () => ({ ...gitBase, ...over }) });
  const gitBase = {
    root: '/r',
    branch: 'main',
    detached: false,
    sha: 'abc1234',
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    insertions: 0,
    deletions: 0,
    stash: 0,
    operation: null,
    remoteUrl: 'https://github.com/foo/bar.git',
    isWorktree: false,
  };
  it('detached shows sha', () => {
    expect(renderWidget('git-branch', g({ detached: true, branch: null }))).toBe('abc1234');
    expect(renderWidget('git-branch', g({}), { options: { showIcon: true } })).toBe('⎇ main');
  });
  it('clean and conflicted status', () => {
    expect(renderWidget('git-status', g({}))).toBe('✓');
    expect(renderWidget('git-status', g({ conflicts: 1 }))).toBe('● !1');
    expect(renderWidget('git-status', g({ staged: 1 }), { options: { counts: false } })).toBe('●');
  });
  it('shows zeros inside a repository', () => {
    expect(renderWidget('git-staged', g({}))).toBe('0');
    expect(renderWidget('git-stash', g({}))).toBe('0');
    expect(renderWidget('git-conflicts', g({}))).toBe('0');
    expect(renderWidget('git-changes', g({}))).toBe('+0 -0');
    expect(renderWidget('git-ahead-behind', g({ upstream: 'origin/main' }))).toBe('↑0 ↓0');
    expect(renderWidget('git-staged', g({}), { options: { hideZero: true } })).toBeNull();
  });
  it('hides misleading or missing data', () => {
    expect(renderWidget('git-ahead-behind', g({}))).toBeNull();
    expect(renderWidget('git-changes', g({ insertions: null, deletions: null }))).toBeNull();
    expect(renderWidget('git-changes', g({}), { options: { hideZero: true } })).toBeNull();
    expect(
      renderWidget('git-changes', g({ insertions: 3, deletions: 1 }), { options: { hideZero: true } }),
    ).toBe('+3 -1');
    expect(renderWidget('git-conflicts', g({}), { options: { hideZero: true } })).toBeNull();
    expect(renderWidget('git-stash', g({ stash: null }))).toBeNull();
    expect(renderWidget('git-stash', g({ stash: 0 }))).toBe('0');
  });
  it('model showId treats "false" as off', () => {
    const ctx = ctxWith({ payload: { model: { id: 'claude-x', display_name: 'X' } } });
    expect(renderWidget('model', ctx, { options: { showId: 'false' } })).toBe('X');
    expect(renderWidget('model', ctx, { options: { showId: true } })).toBe('claude-x');
  });
  it('operation', () => expect(renderWidget('git-operation', g({ operation: 'MERGING' }))).toBe('MERGING'));
  it('repo falls back to remote url', () => {
    const ctx = ctxWith({ payload: {}, git: () => ({ ...gitBase }) });
    expect(renderWidget('git-repo', ctx)).toBe('foo/bar');
    ctx.data.git = () => ({ ...gitBase, remoteUrl: 'git@host.com:team/proj.git' });
    expect(renderWidget('git-repo', ctx)).toBe('team/proj');
  });
  it('worktree', () => {
    const p: StatusPayload = { worktree: { name: 'feat-x' } };
    expect(r('git-worktree', {}, p)).toBe('feat-x');
    expect(r('git-worktree', {}, { workspace: { git_worktree: 'w' } })).toBe('w');
  });
  it('pr link', () => {
    const out = r('pr', { link: true })!;
    expect(out).toContain('\x1b]8;;https://github.com/acme/acme-app/pull/128');
    expect(out).toContain('#128 pending');
  });
});

describe('workspace', () => {
  const at = (dir: string) => ({ workspace: { current_dir: dir } });
  it('styles', () => {
    const home = os.homedir();
    const p = at(`${home}/projects/acme-app`);
    expect(r('cwd', { style: 'tilde' }, p)).toBe('~/projects/acme-app');
    expect(r('cwd', { style: 'short' }, p)).toBe('~/p/acme-app');
    expect(r('cwd', { style: 'full' }, p)).toBe(`${home}/projects/acme-app`);
    expect(r('cwd', { style: 'segments', segments: 2 }, at('/a/b/c/d'))).toBe('c/d');
    expect(r('cwd', { style: 'short' }, at('/usr/local/lib'))).toBe('/u/l/lib');
    expect(r('cwd', { style: 'segments', segments: 9 }, at('/a/b'))).toBe('/a/b');
  });
  it('windows paths', () => {
    expect(r('cwd', {}, at('C:\\Users\\dev\\app'))).toBe('app');
    expect(r('cwd', { style: 'segments' }, at('C:\\Users\\dev\\app'))).toBe('dev/app');
  });
  it('project-dir', () => {
    expect(r('project-dir', {}, { workspace: { project_dir: path.join('/x', 'proj') } })).toBe('proj');
  });
});

describe('system', () => {
  it('clock and date', () => {
    const c = ctxWith();
    expect(renderWidget('clock', c)).toMatch(/^\d\d:\d\d$/);
    expect(renderWidget('clock', c, { options: { seconds: true } })).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(renderWidget('clock', c, { options: { h12: true } })).toMatch(/^\d\d:\d\d (AM|PM)$/);
    expect(renderWidget('date', c)).toMatch(/^2026-10-1[123]$/);
    expect(renderWidget('date', c, { options: { format: 'short' } })).toMatch(/^Oct 1\d$/);
  }, 30_000);
  it('machine info', () => {
    const c = ctxWith();
    expect(renderWidget('hostname', c)).toBeTruthy();
    expect(renderWidget('platform', c)).toBeTruthy();
    expect(renderWidget('memory', c)).toMatch(/^\d+\.\d\/\d+\.\d GB$/);
    expect(renderWidget('memory', c, { options: { format: 'percent' } })).toMatch(/^\d+%$/);
    if (process.platform !== 'win32') {
      expect(renderWidget('load-average', c)).toMatch(/^\d+\.\d\d \d+\.\d\d \d+\.\d\d$/);
    }
  });
});

describe('custom', () => {
  it('command runs with payload on stdin and strips ansi', () => {
    const script = `node -e "process.stdin.on('data',d=>{const p=JSON.parse(d);console.log('\\x1b[31m'+p.model.display_name)})"`;
    const ctx = ctxWith();
    ctx.cwd = process.cwd();
    ctx.env = { ...process.env };
    expect(renderWidget('command', ctx, { options: { command: script, timeout: 5000 } })).toBe('Opus 5.5');
    expect(
      renderWidget('command', ctx, { options: { command: script, timeout: 5000, preserveColors: true } }),
    ).toContain('\x1b[31m');
  });
  it('command hides on failure, empty or timeout', () => {
    const ctx = ctxWith();
    ctx.cwd = process.cwd();
    ctx.env = { ...process.env };
    expect(renderWidget('command', ctx, { options: { command: 'exit 3' } })).toBeNull();
    expect(renderWidget('command', ctx, { options: {} })).toBeNull();
    expect(
      renderWidget('command', ctx, {
        options: { command: 'node -e "setTimeout(()=>{},3000)"', timeout: 100 },
      }),
    ).toBeNull();
  });
  it('command keeps the output of a command that did not read stdin', () => {
    const ctx = ctxWith();
    ctx.cwd = process.cwd();
    const epipe = (status: number) =>
      Object.assign(new Error('spawnSync /bin/sh EPIPE'), { code: 'EPIPE', status, stdout: 'out\n' });
    const spy = vi.spyOn(cp, 'execSync');
    module.syncBuiltinESMExports();
    try {
      spy.mockImplementationOnce(() => {
        throw epipe(0);
      });
      expect(renderWidget('command', ctx, { options: { command: 'echo out' } })).toBe('out');
      spy.mockImplementationOnce(() => {
        throw epipe(1);
      });
      expect(renderWidget('command', ctx, { options: { command: 'echo out' } })).toBeNull();
    } finally {
      spy.mockRestore();
      module.syncBuiltinESMExports();
    }
  });
  it('link and env', () => {
    expect(r('link', { text: 'docs', url: 'https://x.dev' })).toBe(
      '\x1b]8;;https://x.dev/\x1b\\docs\x1b]8;;\x1b\\',
    );
    const ctx = ctxWith();
    ctx.env = { FOO: 'bar' };
    expect(renderWidget('env', ctx, { options: { name: 'FOO' } })).toBe('bar');
    expect(renderWidget('env', ctx, { options: { name: 'NOPE' } })).toBeNull();
  });
});

describe('parseRemote and forkInfo', () => {
  it.each([
    ['ssh://git@host:2222/a/b.git', { host: 'host', path: 'a/b' }],
    ['git@github.com:acme/app.git', { host: 'github.com', path: 'acme/app' }],
    ['https://user:tok@gitlab.com/a/b/c.git/', { host: 'gitlab.com', path: 'a/b/c' }],
    ['HTTPS://GitHub.com/Me/X', { host: 'github.com', path: 'Me/X' }],
    ['file:///a/b', { host: '', path: 'a/b' }],
    ['/srv/git/x.git', null],
    ['C:\\repos\\app.git', null],
  ])('parses %s', async (url, want) => {
    const { parseRemote } = await import('../../src/widgets/git.js');
    expect(parseRemote(url)).toEqual(want);
  });

  it.each([
    ['https://github.com/me/x', 'https://gitlab.com/me/x', true],
    ['https://GitHub.com/Me/Demo', 'https://github.com/me/demo', false],
    ['https://gitlab.com/grp/sub/demo', 'https://gitlab.com/acme/sub/demo', true],
  ])('fork of %s vs %s', async (origin, upstream, fork) => {
    const { forkInfo } = await import('../../src/widgets/git.js');
    const f = forkInfo({ ...sampleGit(), remoteUrl: origin, upstreamUrl: upstream });
    expect(f !== null).toBe(fork);
    if (origin.includes('grp')) expect(f).toEqual({ fork: 'grp/sub/demo', parent: 'sub/demo' });
  });
});

describe('git-is-fork parent depth', () => {
  it('matches git-repo for a nested group', async () => {
    const { forkInfo, repoSlug } = await import('../../src/widgets/git.js');
    const up = 'https://gitlab.com/acme/sub/demo.git';
    const g = { ...sampleGit(), remoteUrl: 'git@gitlab.com:me/demo.git', upstreamUrl: up };
    expect(forkInfo(g)).toEqual({ fork: 'me/demo', parent: 'sub/demo' });
    expect(forkInfo(g)?.parent).toBe(repoSlug(up));
  });
});

describe('git-is-fork cross-host parent', () => {
  it('keeps the host in the parent label when hosts differ', async () => {
    const { forkInfo } = await import('../../src/widgets/git.js');
    const g = {
      ...sampleGit(),
      remoteUrl: 'https://github.com/me/x',
      upstreamUrl: 'https://gitlab.com/me/x',
    };
    expect(forkInfo(g)).toEqual({ fork: 'me/x', parent: 'gitlab.com/me/x' });
    const deep = { ...g, upstreamUrl: 'https://gitlab.com/acme/sub/demo' };
    expect(forkInfo(deep)?.parent).toBe('gitlab.com/sub/demo');
    const ctx = ctxWith({ payload: {}, git: () => g });
    expect(renderWidget('git-is-fork', ctx, { options: { showParent: true } })).toContain('gitlab.com/me/x');
  });
});

describe('git real world fixes', () => {
  it('ignores local path remotes and falls back to git for worktrees', async () => {
    const ctx = ctxWith({
      payload: {},
      git: () => ({ ...sampleGit(), isWorktree: true, root: '/x/feature-wt' }),
    });
    expect(renderWidget('git-worktree', ctx)).toBe('feature-wt');
    expect(renderWidget('git-worktree', ctxWith({ payload: {} }))).toBeNull();
  });
});

describe('timeBased flag', () => {
  it('marks exactly the widgets that change with time alone', () => {
    expect(
      ALL_WIDGETS.filter((w) => w.timeBased)
        .map((w) => w.type)
        .sort(),
    ).toEqual([
      'activity-strip',
      'cache-timer',
      'clock',
      'http',
      'kaomoji',
      'limit-eta',
      'limit-risk',
      'permission-wait',
      'pet',
      'service-status',
      'tool-activity',
      'turn-timer',
      'usage-projection',
    ]);
  });
});

describe('category order', () => {
  it('lists fun last without changing the category set', () => {
    expect(CATEGORIES.at(-1)?.id).toBe('fun');
    expect(CATEGORIES.at(-2)?.id).toBe('layout');
    expect(CATEGORIES.map((c) => c.id).sort()).toEqual(
      [
        'agents',
        'charts',
        'context',
        'cost',
        'custom',
        'fun',
        'git',
        'gsd',
        'layout',
        'limits',
        'session',
        'system',
        'tokens',
        'workspace',
      ].sort(),
    );
  });

  it('registers the fun widgets after the layout widgets', () => {
    const cats = ALL_WIDGETS.map((w) => w.category);
    expect(cats.indexOf('fun')).toBeGreaterThan(cats.lastIndexOf('layout'));
    expect(ALL_WIDGETS.length).toBeGreaterThanOrEqual(117);
    for (const t of ['pet', 'quip', 'kaomoji']) expect(getWidget(t)).toBeDefined();
  });
});
