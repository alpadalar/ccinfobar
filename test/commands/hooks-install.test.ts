import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyHooks,
  DEFAULT_EVENTS,
  detectClaudeCode,
  HOOK_FLOOR,
  hookEventsFor,
  hookGroup,
  mutateHooks,
  NEVER_EVENTS,
  OPTIONAL_EVENTS,
  parseClaudeVersion,
  planHookRewrites,
  planHooks,
} from '../../src/commands/hooks-install.js';
import { applyInstall, planInstall, projectSettingsPath } from '../../src/commands/install.js';
import {
  findHookEntries,
  findStatusLineEntry,
  type Manifest,
  readManifest,
  recordHook,
} from '../../src/commands/manifest.js';
import { backupsDir, hashBytes } from '../../src/commands/settings-file.js';
import { claudeSettingsPath } from '../../src/core/paths.js';
import type { HookEvent } from '../../src/data/hooks.js';
import { formatJson, type SettingsFixture, settingsFixture } from './fixtures.js';

const EMPTY: Manifest = { version: 1, entries: [] };
const FILE = path.join(os.tmpdir(), 'ccib-hooks-plan', 'settings.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const handler = (command: string, event: string) => ({
  type: 'command',
  command: `${command} hook ${event}`,
  async: true,
  timeout: 5,
});
const userStop = { hooks: [{ type: 'command', command: 'afplay done.wav' }] };

function plan(over: Partial<Parameters<typeof planHooks>[0]> = {}) {
  return planHooks({
    settings: {},
    manifest: EMPTY,
    file: FILE,
    command: '/bin/ccinfobar',
    claudeCode: '2.1.299',
    events: DEFAULT_EVENTS,
    ...over,
  });
}

function install(
  fx: SettingsFixture,
  command: string,
  hooks?: { events: readonly HookEvent[]; claudeCode: string | null },
  file = fx.file,
) {
  return applyInstall(planInstall({ file, command, env: fx.env }), {
    confirmed: true,
    env: fx.env,
    ...(hooks ? { hooks } : {}),
  });
}

const backups = (fx: SettingsFixture) => {
  try {
    return fs.readdirSync(backupsDir(fx.env)).filter((f) => /^settings-\d{8}T/.test(f));
  } catch {
    return [];
  }
};

describe('hook groups and events', () => {
  it('builds the shell-form handler with a permission_prompt matcher for Notification only', () => {
    expect(hookGroup('Stop', '/bin/ccinfobar', { async: true })).toEqual({
      hooks: [handler('/bin/ccinfobar', 'Stop')],
    });
    const n = hookGroup('Notification', '/bin/ccinfobar', { async: true });
    expect(Object.keys(n)).toEqual(['matcher', 'hooks']);
    expect(n.matcher).toBe('permission_prompt');
    const sync = hookGroup('Stop', 'x', { async: false });
    expect(sync.hooks[0]).toEqual({ type: 'command', command: 'x hook Stop', timeout: 5 });
    for (const e of DEFAULT_EVENTS) {
      const h = hookGroup(e, 'x', { async: true }).hooks[0] as unknown as Record<string, unknown>;
      expect(Object.hasOwn(h, 'args')).toBe(false);
      expect(Object.hasOwn(h, 'onFailure')).toBe(false);
    }
  });

  it('maps the --hooks flag; PermissionRequest is opt-in', () => {
    expect(hookEventsFor(true)).toEqual(DEFAULT_EVENTS);
    expect(hookEventsFor(true)).toHaveLength(6);
    expect(hookEventsFor(true)).not.toContain('PermissionRequest');
    expect(hookEventsFor('permission')).toEqual([...DEFAULT_EVENTS, ...OPTIONAL_EVENTS]);
    expect(hookEventsFor(undefined)).toEqual([]);
    expect(hookEventsFor(false)).toEqual([]);
    expect(hookEventsFor('x')).toBeNull();
    expect(Object.values(HOOK_FLOOR).every((v) => v === '2.1.101')).toBe(true);
  });

  it('parses Claude Code versions', () => {
    expect(parseClaudeVersion('2.1.299 (Claude Code)\n')).toBe('2.1.299');
    expect(parseClaudeVersion('  2.1.101')).toBe('2.1.101');
    expect(parseClaudeVersion('v2.1.1')).toBeNull();
    expect(parseClaudeVersion(2)).toBeNull();
    expect(parseClaudeVersion(undefined)).toBeNull();
  });
});

describe('planHooks', () => {
  it('never plans NEVER_EVENTS, whatever the input', () => {
    const p = plan({ events: ['PreToolUse', 'Stop'] as unknown as HookEvent[] });
    expect(p.items.map((i) => i.event)).toEqual(['Stop']);
    const pool = [...NEVER_EVENTS, ...DEFAULT_EVENTS, ...OPTIONAL_EVENTS, 'Bogus'];
    for (let n = 0; n < 200; n++) {
      const events = pool.filter((_, i) => (n * 2654435761 + i * 40503) % 7 < 3) as HookEvent[];
      const items = plan({ events }).items;
      const draft: Record<string, unknown> = {};
      mutateHooks(draft, items);
      for (const e of NEVER_EVENTS) {
        expect(items.some((i) => (i.event as string) === e)).toBe(false);
        expect(Object.hasOwn((draft.hooks ?? {}) as object, e)).toBe(false);
      }
    }
  });

  it('refuses an unknown or old Claude Code and accepts the floor', () => {
    expect(plan({ claudeCode: null })).toMatchObject({ refused: 'unknown-version', items: [] });
    expect(plan({ claudeCode: '2.1.100' })).toMatchObject({ refused: 'old-version', items: [] });
    const ok = plan({ claudeCode: '2.1.101' });
    expect(ok.refused).toBeNull();
    expect(ok.asyncOmitted).toBe(false);
    expect(ok.items.map((i) => i.action)).toEqual(Array(6).fill('add'));
  });

  it('follows the floor table for async and per-event skips', () => {
    const floor = {
      core: '2.0.0',
      async: '2.1.101',
      notificationMatcher: '2.0.0',
      PermissionRequest: '2.2.0',
    };
    const p = plan({ claudeCode: '2.0.50', floor, events: [...DEFAULT_EVENTS, 'PermissionRequest'] });
    expect(p.asyncOmitted).toBe(true);
    const perm = p.items.find((i) => i.event === 'PermissionRequest');
    expect(perm?.action).toBe('skip-version');
    for (const i of p.items) expect(Object.hasOwn(i.group.hooks[0] as object, 'async')).toBe(false);
  });

  it('skips a handler that is already there without a manifest entry', () => {
    const same = { hooks: [{ type: 'command', command: 'echo hi' }, handler('/bin/ccinfobar', 'Stop')] };
    const edited = { hooks: [{ ...handler('/bin/ccinfobar', 'SessionStart'), timeout: 30 }] };
    const p = plan({ settings: { hooks: { Stop: [same], SessionStart: [edited] } } });
    expect(p.items.find((i) => i.event === 'Stop')?.action).toBe('skip-unmanaged');
    expect(p.items.find((i) => i.event === 'SessionStart')?.action).toBe('skip-unmanaged');
    const draft = structuredClone({ hooks: { Stop: [same], SessionStart: [edited] } });
    mutateHooks(draft, p.items);
    expect(draft.hooks.Stop).toEqual([same]);
    expect(draft.hooks.SessionStart).toEqual([edited]);
  });

  it('leaves non-object hooks and non-array event values alone', () => {
    const items = plan().items;
    const a: Record<string, unknown> = { hooks: 'nope' };
    mutateHooks(a, items);
    expect(a).toEqual({ hooks: 'nope' });
    const b: Record<string, unknown> = { hooks: { Stop: { odd: true } } };
    mutateHooks(b, items);
    expect((b.hooks as Record<string, unknown>).Stop).toEqual({ odd: true });
    expect(Object.keys(b.hooks as object)).toHaveLength(6);
    const c: Record<string, unknown> = { hooks: null };
    mutateHooks(c, items);
    expect(c).toEqual({ hooks: null });
  });

  it('only rewrites recorded groups that are still unchanged', () => {
    const old = hookGroup('Stop', '/old/ccinfobar', { async: true });
    const m = recordHook(EMPTY, {
      file: FILE,
      event: 'Stop',
      value: old,
      claudeCode: '2.1.299',
      writtenHash: null,
    });
    const items = planHookRewrites({ hooks: { Stop: [userStop, old] } }, m, FILE, '/new/ccinfobar');
    expect(items).toEqual([
      {
        event: 'Stop',
        action: 'rewrite',
        group: hookGroup('Stop', '/new/ccinfobar', { async: true }),
        from: old,
      },
    ]);
    const edited = { hooks: [{ ...old.hooks[0], timeout: 9 }] };
    expect(planHookRewrites({ hooks: { Stop: [edited] } }, m, FILE, '/new/ccinfobar')).toEqual([]);
    expect(planHookRewrites({ hooks: { Stop: [old] } }, m, FILE, '/old/ccinfobar')).toEqual([]);
  });
});

describe('detectClaudeCode', () => {
  const payloadEnv = (version?: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cc-'));
    if (version !== undefined)
      fs.writeFileSync(path.join(dir, 'last-payload.json'), JSON.stringify({ version }));
    return { ...process.env, CCINFOBAR_CACHE_DIR: dir };
  };
  const fail = () => {
    throw new Error('ENOENT');
  };

  it('parses claude --version on POSIX', () => {
    const calls: Array<[string, string[]]> = [];
    const exec = (f: string, a: string[]) => {
      calls.push([f, a]);
      return '2.1.299 (Claude Code)\n';
    };
    expect(detectClaudeCode({ exec, platform: 'linux', env: payloadEnv() })).toBe('2.1.299');
    expect(calls).toEqual([['claude', ['--version']]]);
  });

  it('falls back to the last payload version', () => {
    expect(detectClaudeCode({ exec: fail, platform: 'darwin', env: payloadEnv('2.1.250') })).toBe('2.1.250');
  });

  it('tries claude.exe, then cmd.exe on Windows', () => {
    const calls: Array<[string, string[]]> = [];
    const exec = (f: string, a: string[]) => {
      calls.push([f, a]);
      if (f === 'claude.exe') throw new Error('ENOENT');
      return '2.1.300 (Claude Code)\r\n';
    };
    expect(detectClaudeCode({ exec, platform: 'win32', env: payloadEnv() })).toBe('2.1.300');
    expect(calls).toEqual([
      ['claude.exe', ['--version']],
      ['cmd.exe', ['/d', '/s', '/c', 'claude --version']],
    ]);
  });

  it('returns null when nothing works', () => {
    expect(detectClaudeCode({ exec: fail, platform: 'win32', env: payloadEnv() })).toBeNull();
    expect(detectClaudeCode({ exec: () => 'garbage', platform: 'linux', env: payloadEnv(42) })).toBeNull();
  });
});

describe('install with hooks', () => {
  const HOOKS = { events: DEFAULT_EVENTS, claudeCode: '2.1.299' };

  it('writes six own groups in one patch, format-preserved, and owns them in the manifest', () => {
    const data = { model: 'opus', hooks: { Stop: [userStop] } };
    const fmt = { bom: true, eol: '\r\n' as const, indent: '    ' };
    const fx = settingsFixture({ data, ...fmt });
    expect(claudeSettingsPath(fx.env)).toBe(fx.file);
    const res = install(fx, '/bin/ccinfobar', HOOKS);
    expect(res.changed).toBe(true);
    expect(res.hooks?.items.map((i) => i.action)).toEqual(Array(6).fill('add'));
    expect(backups(fx)).toHaveLength(1);

    const expected = structuredClone(data) as Record<string, unknown> & { hooks: Record<string, unknown[]> };
    expected.statusLine = { type: 'command', command: '/bin/ccinfobar', padding: 0 };
    for (const e of DEFAULT_EVENTS) {
      const g = hookGroup(e, '/bin/ccinfobar', { async: true });
      if (e === 'Stop') expected.hooks.Stop?.push(g);
      else expected.hooks[e] = [g];
    }
    const bytes = fs.readFileSync(fx.file);
    expect(bytes.toString('utf8')).toBe(formatJson(expected, fmt));

    const out = read(fx.file);
    expect(out.hooks.Stop[0]).toEqual(userStop);
    expect(out.hooks.Notification[0].matcher).toBe('permission_prompt');
    for (const e of DEFAULT_EVENTS) {
      const groups = out.hooks[e];
      expect(groups[groups.length - 1].hooks).toEqual([handler('/bin/ccinfobar', e)]);
    }

    const m = readManifest(fx.env);
    expect(m.version).toBe(1);
    expect(m.entries.filter((e) => e.kind === 'statusLine')).toHaveLength(1);
    const hooks = findHookEntries(m, fx.file);
    expect(hooks.map((h) => h.event).sort()).toEqual([...DEFAULT_EVENTS].sort());
    const hash = hashBytes(bytes);
    for (const h of hooks) {
      const groups = out.hooks[h.event];
      expect(h.value).toEqual(groups[groups.length - 1]);
      expect(h.claudeCode).toBe('2.1.299');
      expect(h.writtenHash).toBe(hash);
    }
    expect(hooks.find((h) => h.event === 'Notification')?.matcher).toBe('permission_prompt');
    expect(findStatusLineEntry(m, fx.file)?.writtenHash).toBe(hash);
  });

  it('keeps everything on a second identical install', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx, '/bin/ccinfobar', HOOKS);
    const before = fs.readFileSync(fx.file);
    const n = backups(fx).length;
    const res = install(fx, '/bin/ccinfobar', HOOKS);
    expect(res.changed).toBe(false);
    expect(res.backup).toBeNull();
    expect(res.hooks?.items.map((i) => i.action)).toEqual(Array(6).fill('keep'));
    expect(fs.readFileSync(fx.file).equals(before)).toBe(true);
    expect(backups(fx)).toHaveLength(n);
    expect(findHookEntries(readManifest(fx.env), fx.file)).toHaveLength(6);
  });

  it('does not duplicate a handler the user already has', () => {
    const mine = { hooks: [handler('/bin/ccinfobar', 'Stop')] };
    const fx = settingsFixture({ data: { hooks: { Stop: [mine] } } });
    const res = install(fx, '/bin/ccinfobar', HOOKS);
    expect(res.hooks?.items.find((i) => i.event === 'Stop')?.action).toBe('skip-unmanaged');
    expect(read(fx.file).hooks.Stop).toEqual([mine]);
    const events = findHookEntries(readManifest(fx.env), fx.file).map((h) => h.event);
    expect(events).not.toContain('Stop');
    expect(events).toHaveLength(5);
  });

  it('writes PermissionRequest only when asked for', () => {
    const fx = settingsFixture({ data: {} });
    install(fx, '/bin/ccinfobar', HOOKS);
    expect(read(fx.file).hooks.PermissionRequest).toBeUndefined();
    install(fx, '/bin/ccinfobar', { events: hookEventsFor('permission') ?? [], claudeCode: '2.1.299' });
    expect(read(fx.file).hooks.PermissionRequest).toEqual([
      hookGroup('PermissionRequest', '/bin/ccinfobar', { async: true }),
    ]);
  });

  it('refuses hooks without a known version but still installs the status line', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    const res = install(fx, '/bin/ccinfobar', { events: DEFAULT_EVENTS, claudeCode: null });
    expect(res.hooks?.refused).toBe('unknown-version');
    const out = read(fx.file);
    expect(out.statusLine.command).toBe('/bin/ccinfobar');
    expect(out.hooks).toBeUndefined();
    expect(findHookEntries(readManifest(fx.env), fx.file)).toEqual([]);
    const old = install(fx, '/bin/ccinfobar', { events: DEFAULT_EVENTS, claudeCode: '2.1.100' });
    expect(old.hooks?.refused).toBe('old-version');
    expect(read(fx.file).hooks).toBeUndefined();
  });

  it('rewrites owned hooks when the command changes, without --hooks (D-20)', () => {
    const own = { hooks: [{ type: 'command', command: '/bin/ccinfobar hook Stop', timeout: 9 }] };
    const fx = settingsFixture({ data: { hooks: { Stop: [userStop] } } });
    install(fx, '/bin/ccinfobar', HOOKS);
    const raw = read(fx.file);
    raw.hooks.Stop.unshift(own);
    fs.writeFileSync(fx.file, JSON.stringify(raw, null, 2));
    const res = install(fx, '/new/ccinfobar');
    expect(res.hooks?.items.map((i) => i.action)).toEqual(Array(6).fill('rewrite'));
    const out = read(fx.file);
    expect(out.statusLine.command).toBe('/new/ccinfobar');
    expect(out.hooks.Stop).toEqual([own, userStop, hookGroup('Stop', '/new/ccinfobar', { async: true })]);
    for (const e of DEFAULT_EVENTS) {
      expect(out.hooks[e].at(-1)).toEqual(hookGroup(e, '/new/ccinfobar', { async: true }));
    }
    const m = readManifest(fx.env);
    const hash = hashBytes(fs.readFileSync(fx.file));
    for (const h of findHookEntries(m, fx.file)) {
      expect(h.value).toEqual(hookGroup(h.event as HookEvent, '/new/ccinfobar', { async: true }));
      expect(h.writtenHash).toBe(hash);
    }
    expect(findStatusLineEntry(m, fx.file)?.writtenHash).toBe(hash);
  });

  it('rewrites owned hooks even when a new hooks request is refused', () => {
    const fx = settingsFixture({ data: {} });
    install(fx, '/bin/ccinfobar', HOOKS);
    install(fx, '/new/ccinfobar', { events: DEFAULT_EVENTS, claudeCode: null });
    const out = read(fx.file);
    expect(out.hooks.Stop).toEqual([hookGroup('Stop', '/new/ccinfobar', { async: true })]);
  });

  it('never writes hooks to a project file', () => {
    const fx = settingsFixture({ data: {} });
    const file = projectSettingsPath(path.join(fx.dir, 'proj'));
    const res = install(fx, '/bin/ccinfobar', HOOKS, file);
    expect(res.hooks).toBeNull();
    expect(read(file).statusLine.command).toBe('/bin/ccinfobar');
    expect(read(file).hooks).toBeUndefined();
    expect(findHookEntries(readManifest(fx.env), file)).toEqual([]);
  });

  it('applyHooks writes hooks only and refreshes every hash for the file', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx, '/bin/ccinfobar');
    const p = planHooks({
      settings: read(fx.file),
      manifest: readManifest(fx.env),
      file: fx.file,
      command: '/bin/ccinfobar',
      claudeCode: '2.1.299',
      events: DEFAULT_EVENTS,
    });
    const res = applyHooks(fx.file, p, fx.env);
    expect(res.changed).toBe(true);
    expect(res.items.map((i) => i.action)).toEqual(Array(6).fill('add'));
    const hash = hashBytes(fs.readFileSync(fx.file));
    const m = readManifest(fx.env);
    expect(findHookEntries(m, fx.file)).toHaveLength(6);
    expect(findHookEntries(m, fx.file).every((h) => h.writtenHash === hash)).toBe(true);
    expect(findStatusLineEntry(m, fx.file)?.writtenHash).toBe(hash);
    expect(applyHooks(fx.file, p, fx.env).items.map((i) => i.action)).toEqual(Array(6).fill('keep'));
    const other = projectSettingsPath(path.join(fx.dir, 'proj'));
    expect(applyHooks(other, p, fx.env)).toEqual({ changed: false, backup: null, items: [] });
  });
});
