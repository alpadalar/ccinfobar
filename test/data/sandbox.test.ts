import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeJsonPath } from '../../src/core/paths.js';
import { readSandbox } from '../../src/data/sandbox.js';

let root: string;
let home: string;
let proj: string;
let opts: { platform: NodeJS.Platform; managedDir: string; home: string };
let env: NodeJS.ProcessEnv;

const put = (file: string, data: unknown, raw?: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw ?? JSON.stringify(data));
};
const user = (data: unknown): void => put(path.join(home, '.claude', 'settings.json'), data);
const project = (data: unknown): void => put(path.join(proj, '.claude', 'settings.json'), data);
const local = (data: unknown, dir = proj): void =>
  put(path.join(dir, '.claude', 'settings.local.json'), data);
const managed = (data: unknown): void => put(path.join(root, 'managed', 'managed-settings.json'), data);
const sb = (enabled?: boolean, extra: Record<string, unknown> = {}) => ({
  sandbox: { ...(enabled === undefined ? {} : { enabled }), ...extra },
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), 'sandbox-'));
  home = path.join(root, 'home');
  proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GIT_CEILING_DIRECTORIES: root };
  opts = { platform: 'linux', managedDir: path.join(root, 'managed'), home };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readSandbox', () => {
  it('reads the user layer', () => {
    user(sb(true));
    expect(readSandbox(proj, env, opts)).toEqual({ enabled: true, strict: false });
    user(sb(false));
    expect(readSandbox(proj, env, opts)).toEqual({ enabled: false, strict: false });
  });

  it('an enclosing repository above the test root does not leak in', () => {
    fs.mkdirSync(path.join(root, '.git'));
    local(sb(true), root);
    user(sb(false));
    expect(readSandbox(proj, env, opts)).toEqual({ enabled: false, strict: false });
  });

  it('is null when nothing sets a boolean', () => {
    expect(readSandbox(proj, env, opts)).toBeNull();
    user(sb(undefined, { allowUnsandboxedCommands: false }));
    expect(readSandbox(proj, env, opts)).toBeNull();
    user({ sandbox: { enabled: 'true' } });
    expect(readSandbox(proj, env, opts)).toBeNull();
    user({ sandbox: { enabled: 1 } });
    expect(readSandbox(proj, env, opts)).toBeNull();
  });

  it('resolves per leaf: managed > local > project > user', () => {
    user(sb(true));
    project(sb(false));
    expect(readSandbox(proj, env, opts)?.enabled).toBe(false);
    local(sb(true));
    expect(readSandbox(proj, env, opts)?.enabled).toBe(true);
    managed(sb(false));
    expect(readSandbox(proj, env, opts)?.enabled).toBe(false);
  });

  it('keeps an admin-required sandbox on against a repo false', () => {
    user(sb(true));
    project(sb(false));
    managed({ sandbox: { allowUnsandboxedCommands: false } });
    expect(readSandbox(proj, env, opts)).toEqual({ enabled: true, strict: true });
    managed({ sandbox: { network: { allowManagedDomainsOnly: true } } });
    expect(readSandbox(proj, env, opts)).toEqual({ enabled: true, strict: false });
  });

  it('does not apply the exception without managed or for managed false', () => {
    user(sb(true));
    project(sb(false));
    expect(readSandbox(proj, env, opts)?.enabled).toBe(false);
    managed(sb(false, { allowUnsandboxedCommands: false }));
    expect(readSandbox(proj, env, opts)?.enabled).toBe(false);
  });

  it('reports strict from allowUnsandboxedCommands', () => {
    user(sb(true, { allowUnsandboxedCommands: false }));
    expect(readSandbox(proj, env, opts)?.strict).toBe(true);
    user(sb(true, { allowUnsandboxedCommands: true }));
    expect(readSandbox(proj, env, opts)?.strict).toBe(false);
  });

  it('is null on win32', () => {
    user(sb(true));
    expect(readSandbox(proj, env, { ...opts, platform: 'win32' })).toBeNull();
  });

  it('prefers the repo root local file over the launch dir one', () => {
    const repo = path.join(root, 'repo');
    const sub = path.join(repo, 'sub', 'dir');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(sub, { recursive: true });
    local(sb(true), repo);
    local(sb(false), sub);
    expect(readSandbox(sub, env, opts)?.enabled).toBe(true);
  });

  it('opens the local file once when launch is the root', () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    local(sb(true), repo);
    const spy = vi.spyOn(fs, 'openSync');
    expect(readSandbox(repo, env, opts)?.enabled).toBe(true);
    const f = path.join(repo, '.claude', 'settings.local.json');
    expect(spy.mock.calls.filter((c) => c[0] === f)).toHaveLength(1);
  });

  it('handles a BOM and survives an invalid layer', () => {
    put(path.join(home, '.claude', 'settings.json'), null, `﻿${JSON.stringify(sb(true))}`);
    put(path.join(proj, '.claude', 'settings.json'), null, '{nope');
    expect(readSandbox(proj, env, opts)?.enabled).toBe(true);
  });

  it('rejects a file over 1 MiB', () => {
    put(path.join(home, '.claude', 'settings.json'), null, ' '.repeat(1024 * 1024 + 1));
    expect(readSandbox(proj, env, opts)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('does not hang on a FIFO', () => {
    const f = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    execFileSync('mkfifo', [f]);
    expect(readSandbox(proj, env, opts)).toBeNull();
  });

  it('never opens ~/.claude.json and leaks no voice or e-mail', () => {
    user({ voiceEnabled: true, voice: { lang: 'en' }, ...sb(true) });
    put(claudeJsonPath(env), { oauthAccount: { emailAddress: 'a@b.co' } });
    const spy = vi.spyOn(fs, 'openSync');
    const res = readSandbox(proj, env, opts);
    expect(spy.mock.calls.some((c) => c[0] === claudeJsonPath(env))).toBe(false);
    const s = JSON.stringify(res);
    expect(s).not.toContain('voice');
    expect(s).not.toContain('@');
  });
});
