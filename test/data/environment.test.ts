import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { managedDir, managedSettingsFiles, projectSettingsPath } from '../../src/core/paths.js';
import {
  type EnvCounts,
  launchAncestors,
  mcpProjectKey,
  readEnvironment,
} from '../../src/data/environment.js';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
let root: string;
let claude: string;
let proj: string;
let managed: string;
let env: NodeJS.ProcessEnv;

const put = (file: string, text = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const handlers = (n: number) => ({
  hooks: { Stop: [{ hooks: Array.from({ length: n }, () => ({ type: 'command', command: 'true' })) }] },
});
const json = (file: string, v: unknown) => put(file, JSON.stringify(v));

function read(o: Parameters<typeof readEnvironment>[3] = {}, dir = proj, e = env): EnvCounts {
  const r = readEnvironment(dir, dir, e, { managedDir: managed, stopAt: root, now: NOW, ...o });
  expect(r).not.toBeNull();
  return r!;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-env-')));
  claude = path.join(root, 'claude');
  proj = path.join(root, 'work', 'proj');
  managed = path.join(root, 'managed');
  for (const d of [claude, proj, managed]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'));
  env = { CLAUDE_CONFIG_DIR: claude, CCINFOBAR_CACHE_DIR: path.join(root, 'cache') };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('path helpers', () => {
  it('gives the managed dir per OS without touching the disk', () => {
    expect(managedDir('linux', {})).toBe('/etc/claude-code');
    expect(managedDir('darwin', {})).toBe('/Library/Application Support/ClaudeCode');
    expect(managedDir('win32', {})).toBe('C:\\Program Files\\ClaudeCode');
    expect(managedSettingsFiles('linux', {}, () => [])).toEqual(['/etc/claude-code/managed-settings.json']);
    expect(projectSettingsPath('/p')).toBe(path.join('/p', '.claude', 'settings.local.json'));
    expect(projectSettingsPath('/p', false)).toBe(path.join('/p', '.claude', 'settings.json'));
  });
});

describe('readEnvironment', () => {
  it('counts memory files, rules and hooks across every layer', () => {
    put(path.join(claude, 'CLAUDE.md'));
    put(path.join(claude, 'rules', 'a.md'));
    put(path.join(claude, 'rules', 'sub', 'b.md'));
    put(path.join(claude, 'rules', 'notes.txt'));
    json(path.join(claude, 'settings.json'), handlers(2));
    put(path.join(proj, 'CLAUDE.md'));
    put(path.join(proj, '.claude', 'rules', 'c.md'));
    json(path.join(proj, '.claude', 'settings.local.json'), handlers(1));
    json(path.join(managed, 'managed-settings.json'), handlers(2));
    const r = read();
    expect(r).toMatchObject({ claudeMd: 2, agentsMd: 0, rules: 3, hooks: 5, hooksDisabled: false });
    expect(r.files).toContain(path.join(proj, 'CLAUDE.md'));
    expect(r.files).toContain(path.join(claude, 'settings.json'));
  });

  it('counts ancestor and managed CLAUDE.md, not subdirectories', () => {
    put(path.join(root, 'work', 'CLAUDE.local.md'));
    put(path.join(proj, '.claude', 'CLAUDE.md'));
    put(path.join(proj, 'sub', 'CLAUDE.md'));
    put(path.join(managed, 'CLAUDE.md'));
    expect(read().claudeMd).toBe(3);
  });

  it('stops at the stop dir', () => {
    put(path.join(root, 'CLAUDE.md'));
    expect(read().claudeMd).toBe(1);
    expect(read({ stopAt: path.join(root, 'work') }).claudeMd).toBe(0);
  });

  it('counts the user CLAUDE.md once when the walk passes HOME', () => {
    const home = path.join(root, 'home');
    put(path.join(home, '.claude', 'CLAUDE.md'));
    put(path.join(home, '.claude', 'rules', 'r.md'));
    const dir = path.join(home, 'code');
    fs.mkdirSync(dir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const r = read({}, dir, { CCINFOBAR_CACHE_DIR: env.CCINFOBAR_CACHE_DIR });
    expect(r.claudeMd).toBe(1);
    expect(r.rules).toBe(1);
  });

  it('reads the user settings once when launched in the home folder', () => {
    const home = path.join(root, 'home');
    const e = { CCINFOBAR_CACHE_DIR: path.join(root, 'cache') } as NodeJS.ProcessEnv;
    e.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
    json(path.join(home, '.claude', 'settings.json'), handlers(1));
    const renames = vi.spyOn(fs, 'renameSync');
    expect(read({}, home, e).hooks).toBe(1);
    const writes = renames.mock.calls.length;
    expect(read({}, home, e).hooks).toBe(1);
    read({}, home, e);
    expect(renames.mock.calls.length).toBe(writes);
  });

  it('counts AGENTS.md only when no project CLAUDE.md is in effect', () => {
    put(path.join(proj, 'AGENTS.md'));
    put(path.join(claude, 'CLAUDE.md'));
    expect(read()).toMatchObject({ claudeMd: 1, agentsMd: 1 });
    put(path.join(root, 'work', 'CLAUDE.md'));
    expect(read()).toMatchObject({ claudeMd: 2, agentsMd: 0 });
  });

  it('reads the instructionFiles mode from user and managed settings only', () => {
    const mode = (m: string) => ({
      pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: m } } },
    });
    put(path.join(proj, 'CLAUDE.md'));
    put(path.join(proj, '.claude', 'AGENTS.md'));
    json(path.join(proj, '.claude', 'settings.json'), mode('claude-md-and-agents-md'));
    expect(read().agentsMd).toBe(0);
    json(path.join(claude, 'settings.json'), mode('claude-md-and-agents-md'));
    expect(read().agentsMd).toBe(1);
    json(path.join(managed, 'managed-settings.json'), mode('claude-md'));
    expect(read().agentsMd).toBe(0);
  });

  it('managed-only counts only managed CLAUDE.md and no rules', () => {
    put(path.join(managed, 'CLAUDE.md'));
    put(path.join(claude, 'CLAUDE.md'));
    put(path.join(proj, 'CLAUDE.md'));
    put(path.join(claude, 'rules', 'a.md'));
    json(path.join(managed, 'managed-settings.json'), {
      pluginConfigs: { 'cc-plugin-agents-md@builtin': { options: { instructionFiles: 'managed-only' } } },
    });
    expect(read()).toMatchObject({ claudeMd: 1, agentsMd: 0, rules: 0 });
  });

  it('applies disableAllHooks by precedence', () => {
    json(path.join(claude, 'settings.json'), { ...handlers(2), disableAllHooks: true });
    json(path.join(proj, '.claude', 'settings.json'), { ...handlers(1), disableAllHooks: false });
    expect(read()).toMatchObject({ hooks: 3, hooksDisabled: false });
    json(path.join(proj, '.claude', 'settings.local.json'), { disableAllHooks: true });
    expect(read()).toMatchObject({ hooks: 0, hooksDisabled: true });
    json(path.join(managed, 'managed-settings.json'), handlers(2));
    expect(read()).toMatchObject({ hooks: 2, hooksDisabled: false });
    json(path.join(managed, 'managed-settings.json'), { ...handlers(2), disableAllHooks: true });
    expect(read()).toMatchObject({ hooks: 0, hooksDisabled: true });
  });

  it('keeps only managed hooks under allowManagedHooksOnly', () => {
    json(path.join(claude, 'settings.json'), handlers(3));
    json(path.join(managed, 'managed-settings.json'), { ...handlers(1), allowManagedHooksOnly: true });
    json(path.join(managed, 'managed-settings.d', '10-extra.json'), handlers(1));
    expect(read()).toMatchObject({ hooks: 2, hooksDisabled: false });
  });

  it('skips oversized and malformed settings', () => {
    put(path.join(proj, '.claude', 'settings.json'), `{"hooks":{},"pad":"${'x'.repeat(1_100_000)}"}`);
    put(path.join(claude, 'settings.json'), '{not json');
    json(path.join(proj, '.claude', 'settings.local.json'), handlers(1));
    expect(read().hooks).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('skips a FIFO settings file without hanging', () => {
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    try {
      cp.execFileSync('mkfifo', [projectSettingsPath(proj, false)], { stdio: 'ignore' });
    } catch {
      return;
    }
    json(path.join(claude, 'settings.json'), handlers(1));
    expect(read().hooks).toBe(1);
  });

  it('caps the rule scan by depth and file count', () => {
    const rules = path.join(claude, 'rules');
    put(path.join(rules, 'a', 'b', 'c', 'd', 'e', 'deep.md'));
    put(path.join(rules, 'a', 'b', 'c', 'd', 'e', 'f', 'too-deep.md'));
    expect(read().rules).toBe(1);
    for (let i = 0; i < 510; i++) put(path.join(rules, 'many', `r${i}.md`));
    expect(read({ now: NOW + 61_000 }).rules).toBe(500);
  });

  it.skipIf(process.platform === 'win32')('follows a symlink cycle once', () => {
    const rules = path.join(claude, 'rules');
    put(path.join(rules, 'a.md'));
    fs.symlinkSync(rules, path.join(rules, 'loop'));
    expect(read().rules).toBe(1);
  });

  it('reuses cached facts and parses nothing when nothing changed', () => {
    json(path.join(claude, 'settings.json'), handlers(2));
    json(path.join(proj, '.claude', 'settings.json'), handlers(1));
    put(path.join(claude, 'rules', 'a.md'));
    expect(read().hooks).toBe(3);
    const cache = env.CCINFOBAR_CACHE_DIR!;
    expect(fs.readdirSync(cache).filter((n) => n.startsWith('env-'))).toHaveLength(1);
    const open = vi.spyOn(fs, 'openSync');
    const dirs = vi.spyOn(fs, 'readdirSync');
    const opened = () => open.mock.calls.map((c) => String(c[0])).filter((p) => !p.startsWith(cache));
    expect(read({ now: NOW + 1_000 })).toMatchObject({ hooks: 3, rules: 1 });
    expect(opened()).toEqual([]);
    expect(dirs).not.toHaveBeenCalled();
    const file = path.join(claude, 'settings.json');
    json(file, handlers(4));
    fs.utimesSync(file, new Date(NOW + 5_000), new Date(NOW + 5_000));
    expect(read({ now: NOW + 2_000 }).hooks).toBe(5);
    expect(opened()).toEqual([file]);
  });

  it('never writes the cache when persist is false', () => {
    json(path.join(claude, 'settings.json'), handlers(1));
    expect(read({ persist: false }).hooks).toBe(1);
    expect(fs.existsSync(env.CCINFOBAR_CACHE_DIR!)).toBe(false);
  });

  it('rescans rules on a dir mtime change or after 60 s', () => {
    const rules = path.join(claude, 'rules');
    put(path.join(rules, 'a.md'));
    expect(read().rules).toBe(1);
    put(path.join(rules, 'b.md'));
    fs.utimesSync(rules, new Date(NOW + 9_000), new Date(NOW + 9_000));
    expect(read({ now: NOW + 1_000 }).rules).toBe(2);
    const st = fs.statSync(rules);
    put(path.join(rules, 'c.md'));
    fs.utimesSync(rules, st.atime, st.mtime);
    expect(read({ now: NOW + 2_000 }).rules).toBe(2);
    expect(read({ now: NOW + 62_000 }).rules).toBe(3);
  });

  it('recomputes on a tampered cache', () => {
    json(path.join(claude, 'settings.json'), handlers(1));
    read();
    const cache = env.CCINFOBAR_CACHE_DIR!;
    const name = fs.readdirSync(cache).find((n) => n.startsWith('env-'))!;
    const raw = JSON.parse(fs.readFileSync(path.join(cache, name), 'utf8'));
    raw.files = raw.files.map((f: any[]) => [f[0], f[1], f[2], { h: 'many' }]);
    fs.writeFileSync(path.join(cache, name), JSON.stringify(raw));
    expect(read({ now: NOW + 1_000 }).hooks).toBe(1);
    fs.writeFileSync(path.join(cache, name), '[]');
    expect(read({ now: NOW + 2_000 }).hooks).toBe(1);
  });

  it('stops the walk at the drive root, the stop dir or 20 levels', () => {
    expect(launchAncestors('C:\\a\\b', undefined, path.win32)).toEqual(['C:\\a\\b', 'C:\\a', 'C:\\']);
    expect(launchAncestors('/a/b/c', '/a/b', path.posix)).toEqual(['/a/b/c', '/a/b']);
    expect(launchAncestors(`/${'d/'.repeat(30)}x`, undefined, path.posix)).toHaveLength(20);
  });
});

describe('readEnvironment mcp', () => {
  const cj = () => path.join(claude, '.claude.json');
  const servers = (...names: string[]) => ({ mcpServers: Object.fromEntries(names.map((n) => [n, {}])) });

  it('unions user, local and approved project servers by name', () => {
    json(cj(), { ...servers('github', 'linear'), projects: { [proj]: servers('db') } });
    json(path.join(proj, '.mcp.json'), servers('web', 'db'));
    json(path.join(proj, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['web'] });
    const r = read();
    expect(r.mcp).toBe(4);
    expect(r.mcpHealth).toBeUndefined();
    expect(r.files).toContain(cj());
    expect(r.files).toContain(path.join(proj, '.mcp.json'));
  });

  it('counts project servers only when approved and not disabled', () => {
    json(path.join(proj, '.mcp.json'), servers('a', 'b'));
    expect(read().mcp).toBe(0);
    json(path.join(proj, '.claude', 'settings.json'), { enableAllProjectMcpServers: true });
    expect(read().mcp).toBe(2);
    json(path.join(claude, 'settings.json'), { disabledMcpjsonServers: ['b'] });
    expect(read().mcp).toBe(1);
  });

  it('reads legacy approvals from the project entry', () => {
    json(path.join(proj, '.mcp.json'), servers('a', 'b'));
    json(cj(), {
      projects: { [proj]: { enabledMcpjsonServers: ['a', 'b'], disabledMcpjsonServers: ['a'] } },
    });
    expect(read().mcp).toBe(1);
  });

  it('reads .mcp.json from every ancestor, once per name', () => {
    json(path.join(root, 'work', '.mcp.json'), servers('up', 'web'));
    json(path.join(proj, '.mcp.json'), servers('web'));
    json(path.join(claude, 'settings.json'), { enableAllProjectMcpServers: true });
    expect(read().mcp).toBe(2);
  });

  it('managed-mcp.json is exclusive; managedMcpServers adds', () => {
    json(cj(), servers('github', 'linear'));
    json(path.join(managed, 'managed-settings.json'), { managedMcpServers: { extra: {} } });
    expect(read().mcp).toBe(3);
    json(path.join(managed, 'managed-mcp.json'), servers('corp'));
    expect(read().mcp).toBe(2);
    json(path.join(managed, 'managed-settings.json'), {});
    expect(read().mcp).toBe(1);
  });

  it('keys the project entry by the git root', () => {
    const sub = path.join(proj, 'sub');
    fs.mkdirSync(sub);
    json(cj(), { projects: { [proj]: servers('db'), [sub]: servers('x', 'y') } });
    expect(read({}, sub).mcp).toBe(1);
    fs.rmSync(path.join(proj, '.git'), { recursive: true });
    expect(read({}, sub).mcp).toBe(2);
    expect(mcpProjectKey('C:\\a\\b', 'win32')).toBe('C:/a/b');
    expect(mcpProjectKey('/a/b', 'linux')).toBe('/a/b');
  });

  it('skips an oversized or invalid .claude.json', () => {
    json(path.join(proj, '.mcp.json'), servers('web'));
    json(path.join(proj, '.claude', 'settings.local.json'), { enabledMcpjsonServers: ['web'] });
    put(cj(), '{not json');
    expect(read().mcp).toBe(1);
    json(cj(), servers('github'));
    expect(read().mcp).toBe(2);
    fs.truncateSync(cj(), 9 * 1024 * 1024);
    expect(read().mcp).toBe(2);
    expect(read({ persist: false }, proj, { ...env, CCINFOBAR_CACHE_DIR: path.join(root, 'none') }).mcp).toBe(
      1,
    );
  });

  it('keeps the last .claude.json facts while the file changed in the last 30 s', () => {
    json(cj(), servers('github'));
    expect(read().mcp).toBe(1);
    json(cj(), servers('github', 'linear'));
    fs.utimesSync(cj(), new Date(NOW - 10_000), new Date(NOW - 10_000));
    const open = vi.spyOn(fs, 'openSync');
    expect(read().mcp).toBe(1);
    expect(open.mock.calls.map((c) => String(c[0]))).not.toContain(cj());
    expect(read({ now: NOW + 25_000 }).mcp).toBe(2);
    expect(read({ now: NOW + 26_000 }).mcp).toBe(2);
  });

  it('ignores odd shapes and sanitizes names', () => {
    json(cj(), { mcpServers: ['a'], projects: { [proj]: { mcpServers: 'x' } } });
    expect(read().mcp).toBe(0);
    json(cj(), { mcpServers: { 'a\u001b[31m': {}, a: {}, ['__proto__']: {} } });
    expect(read().mcp).toBe(2);
  });

  it('parses .claude.json only when its signature changes', () => {
    json(cj(), servers('github'));
    expect(read().mcp).toBe(1);
    const cache = env.CCINFOBAR_CACHE_DIR!;
    const open = vi.spyOn(fs, 'openSync');
    const opened = () => open.mock.calls.map((c) => String(c[0])).filter((p) => !p.startsWith(cache));
    expect(read({ now: NOW + 1_000 }).mcp).toBe(1);
    expect(opened()).toEqual([]);
    json(cj(), servers('github', 'linear'));
    fs.utimesSync(cj(), new Date(NOW + 5_000), new Date(NOW + 5_000));
    expect(read({ now: NOW + 2_000 }).mcp).toBe(2);
    expect(opened()).toEqual([cj()]);
  });
});
