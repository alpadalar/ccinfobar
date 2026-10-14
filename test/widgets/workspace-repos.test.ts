import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import type { StatusPayload, WidgetItem } from '../../src/core/types.js';
import type { RepoEntry, WorkspaceRepos } from '../../src/data/repos.js';
import { ctxWith, renderWidget, withoutSideEffects } from '../helpers.js';

const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git'));
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ws-')));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function repo(root: string, name: string, head: string): void {
  fs.mkdirSync(path.join(root, name, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, name, '.git', 'HEAD'), head);
}

function workspace(): string {
  const w = path.join(dir, 'w');
  repo(w, 'api', 'ref: refs/heads/main\n');
  repo(w, 'web', 'ref: refs/heads/dev\n');
  fs.mkdirSync(path.join(w, 'notes'));
  repo(path.join(w, 'node_modules'), 'x', 'ref: refs/heads/main\n');
  return w;
}

function ctxAt(cwd: string, item: Partial<WidgetItem> = {}) {
  const payload: StatusPayload = { workspace: { current_dir: cwd } } as StatusPayload;
  return createContext({
    payload,
    config: { ...defaultConfig(), colorLevel: 0, lines: [[{ id: 'r', type: 'workspace-repos', ...item }]] },
    env,
    preview: false,
  });
}

describe.skipIf(tmpRepo)('workspace-repos on a real folder', () => {
  it('lists child repos with branches', () => {
    const lines = render(ctxAt(workspace())).map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('repos: api (main) · web (dev)');
    expect(lines[0]).not.toContain('notes');
    expect(lines[0]).not.toContain('node_modules');
  });

  it('never spawns', () => {
    const w = workspace();
    expect(() => withoutSideEffects(() => render(ctxAt(w)))).not.toThrow();
  });

  it('is null inside a repo', () => {
    const w = path.join(dir, 'w');
    fs.mkdirSync(path.join(w, '.git'), { recursive: true });
    repo(path.join(w, 'inner'), 'api', 'ref: refs/heads/main\n');
    expect(renderWidget('workspace-repos', ctxAt(path.join(w, 'inner')))).toBeNull();
  });

  it('is null without child repos', () => {
    const e = path.join(dir, 'empty');
    fs.mkdirSync(e);
    expect(renderWidget('workspace-repos', ctxAt(e))).toBeNull();
  });
});

describe.skipIf(tmpRepo)('workspace-repos placeholders', () => {
  const mixed = (cwd: string, options: WidgetItem['options'] = {}) => {
    const ctx = ctxAt(cwd);
    ctx.config.lines = [
      [
        { id: 'b', type: 'git-branch' },
        { id: 'r', type: 'workspace-repos', options },
      ],
    ];
    return render({ ...ctx, data: { ...ctx.data, git: () => null } }).map(stripAnsi);
  };

  it('hides git placeholders in a workspace folder', () => {
    const line = mixed(workspace())[0]!;
    expect(line).toContain('repos: api (main) · web (dev)');
    expect(line).not.toContain('—');
  });

  it('keeps them with hideGitPlaceholders off or without child repos', () => {
    expect(mixed(workspace(), { hideGitPlaceholders: false })[0]).toContain('—');
    const e = path.join(dir, 'empty');
    fs.mkdirSync(e);
    expect(mixed(e)[0]).toContain('—');
  });
});

describe.skipIf(tmpRepo)('workspace-repos real heads', () => {
  it('shows a detached sha and strips escapes from branch names', () => {
    const w = path.join(dir, 'w');
    repo(w, 'api', 'abc1234def5678901234567890abcdef12345678\n');
    repo(w, 'web', 'ref: refs/heads/x\u001b[31my\n');
    expect(renderWidget('workspace-repos', ctxAt(w))).toBe('api (abc1234) · web (xy)');
  });
});

const entry = (name: string, branch: string | null, activity: number, hidden = false): RepoEntry => ({
  name,
  branch,
  detached: false,
  activity,
  hidden,
});
const fixture: WorkspaceRepos = {
  root: '/ws',
  repos: [
    entry('.dot', 'main', 50, true),
    entry('api', 'main', 10),
    entry('infra', 'main', 30),
    entry('web', 'dev', 20),
  ],
  total: 4,
};
const r = (options: WidgetItem['options'] = {}, config = {}) =>
  renderWidget('workspace-repos', ctxWith({ repos: () => fixture, config }), { options });

describe('workspace-repos options', () => {
  it('defaults', () => expect(r()).toBe('api (main) · infra (main) · web (dev)'));
  it('maxRepos overflow', () => expect(r({ maxRepos: 2 })).toBe('api (main) · infra (main) +1'));
  it('showBranch off', () => expect(r({ showBranch: false })).toBe('api · infra · web'));
  it('sort recent', () => expect(r({ sort: 'recent', showBranch: false })).toBe('infra · web · api'));
  it('includeHidden', () => expect(r({ includeHidden: true, maxRepos: 1 })).toBe('.dot (main) +3'));
  it('text charset', () => expect(r({ showBranch: false }, { charset: 'text' })).toBe('api | infra | web'));
  it('null without data or only hidden repos', () => {
    expect(renderWidget('workspace-repos', ctxWith())).toBeNull();
    const only = { ...fixture, repos: [fixture.repos[0]!] };
    expect(renderWidget('workspace-repos', ctxWith({ repos: () => only }))).toBeNull();
  });
});
