import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
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
import { type Manifest, recordHook } from '../../src/commands/manifest.js';
import type { HookEvent } from '../../src/data/hooks.js';

const EMPTY: Manifest = { version: 1, entries: [] };
const FILE = path.join(os.tmpdir(), 'ccib-hooks-plan', 'settings.json');
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
