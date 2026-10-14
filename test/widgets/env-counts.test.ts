import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { sampleEnvironment } from '../../src/core/sample.js';
import type { RenderContext } from '../../src/core/types.js';
import { ctxWith, NOW, renderWidget, withoutSideEffects } from '../helpers.js';

const fx = vi.hoisted(() => ({ managedDir: '', stopAt: '' }));

vi.mock('../../src/data/environment.js', async (orig) => {
  const m = await orig<typeof import('../../src/data/environment.js')>();
  return {
    ...m,
    readEnvironment: (...a: Parameters<typeof m.readEnvironment>) =>
      m.readEnvironment(a[0], a[1], a[2], { ...a[3], managedDir: fx.managedDir, stopAt: fx.stopAt }),
  };
});

let root: string;
const put = (file: string, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const handlers = (n: number) =>
  JSON.stringify({ hooks: { Stop: [{ hooks: Array.from({ length: n }, () => ({ type: 'command' })) }] } });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-envw-')));
  fx.managedDir = path.join(root, 'managed');
  fx.stopAt = root;
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('env-counts end to end', () => {
  it('reads the launch dir from workspace.project_dir', () => {
    const c = path.join(root, 'claude');
    const p = path.join(root, 'proj');
    put(path.join(c, 'CLAUDE.md'));
    put(path.join(c, 'rules', 'a.md'));
    put(path.join(c, 'rules', 'sub', 'b.md'));
    put(path.join(c, 'settings.json'), handlers(2));
    fs.mkdirSync(path.join(p, '.git'), { recursive: true });
    put(path.join(p, 'CLAUDE.md'));
    put(path.join(p, '.claude', 'rules', 'c.md'));
    put(path.join(p, '.claude', 'settings.local.json'), handlers(1));
    put(path.join(fx.managedDir, 'managed-settings.json'), handlers(2));
    const sub = path.join(p, 'src');
    put(path.join(sub, 'CLAUDE.md'));
    const servers = (...n: string[]) => ({ mcpServers: Object.fromEntries(n.map((k) => [k, {}])) });
    put(
      path.join(c, '.claude.json'),
      JSON.stringify({ ...servers('github', 'linear'), projects: { [p]: servers('db') } }),
    );
    put(path.join(p, '.mcp.json'), JSON.stringify(servers('web', 'db')));
    put(
      path.join(p, '.claude', 'settings.local.json'),
      JSON.stringify({ ...JSON.parse(handlers(1)), enabledMcpjsonServers: ['web'] }),
    );
    const env = { CLAUDE_CONFIG_DIR: c, CCINFOBAR_CACHE_DIR: path.join(root, 'cache') };
    const ctx = createContext({
      payload: { cwd: sub, workspace: { current_dir: sub, project_dir: p } },
      config: { ...defaultConfig(), colorLevel: 0 },
      env,
      now: NOW,
    });
    expect(withoutSideEffects(() => renderWidget('env-counts', ctx))).toBe(
      'CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5',
    );
    const preview = createContext({
      payload: { cwd: p },
      config: { ...defaultConfig(), colorLevel: 0 },
      env: { ...env, CCINFOBAR_CACHE_DIR: path.join(root, 'cache2') },
      now: NOW,
      preview: true,
    });
    expect(renderWidget('env-counts', preview)).toBe('CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5');
    expect(fs.existsSync(path.join(root, 'cache2'))).toBe(false);
  });
});

describe('env-counts widget', () => {
  const env = (o: Partial<ReturnType<typeof sampleEnvironment>> = {}): RenderContext =>
    ctxWith({ environment: () => ({ ...sampleEnvironment(), ...o }) });

  it('renders the sample', () => {
    expect(renderWidget('env-counts', ctxWith())).toBe('CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5');
  });

  it('shows AGENTS.md after CLAUDE.md and hooks off', () => {
    expect(renderWidget('env-counts', env({ agentsMd: 1, hooks: 0, hooksDisabled: true }))).toBe(
      'CLAUDE.md 2 · AGENTS.md 1 · rules 3 · MCP 4 · hooks off',
    );
  });

  it('hides zero parts unless hideZero is off', () => {
    const z = env({ claudeMd: 0, rules: 0, mcp: 0 });
    expect(renderWidget('env-counts', z)).toBe('hooks 5');
    expect(renderWidget('env-counts', z, { options: { hideZero: false } })).toBe(
      'CLAUDE.md 0 · rules 0 · MCP 0 · hooks 5',
    );
  });

  it('drops parts that are switched off and returns null when nothing is left', () => {
    expect(renderWidget('env-counts', env(), { options: { showRules: false } })).toBe(
      'CLAUDE.md 2 · MCP 4 · hooks 5',
    );
    expect(renderWidget('env-counts', env(), { options: { showMcp: false } })).toBe(
      'CLAUDE.md 2 · rules 3 · hooks 5',
    );
    expect(renderWidget('env-counts', env({ claudeMd: 0, rules: 0, mcp: 0, hooks: 0 }))).toBeNull();
    expect(renderWidget('env-counts', ctxWith({ environment: () => null }))).toBeNull();
  });

  it('uses the text separator for the text charset', () => {
    const ctx = ctxWith({ config: { charset: 'text' } });
    expect(renderWidget('env-counts', ctx)).toBe('CLAUDE.md 2 | rules 3 | MCP 4 | hooks 5');
  });

  it('keeps the plain count with mcpHealth on until Claude Code exposes health', () => {
    const on = { options: { mcpHealth: true } };
    expect(renderWidget('env-counts', env(), on)).toBe('CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5');
    const health = env({ mcpHealth: { ok: 3, total: 4 } });
    expect(renderWidget('env-counts', health, on)).toBe('CLAUDE.md 2 · rules 3 · MCP 3/4 · hooks 5');
    expect(renderWidget('env-counts', health)).toBe('CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5');
  });
});
