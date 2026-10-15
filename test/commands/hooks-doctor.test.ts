import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandResolves,
  entryCommand,
  hookEntryState,
  hookGateWarnings,
  managedSettingsFiles,
  progressWarnings,
  readSettingsLayer,
  type SettingsLayer,
} from '../../src/commands/hooks-doctor.js';
import type { HookEntry } from '../../src/commands/manifest.js';

const none = () => [];

describe('managedSettingsFiles', () => {
  it('uses /etc/claude-code on Linux with sorted drop-ins', () => {
    const seen: string[] = [];
    const files = managedSettingsFiles('linux', {}, (dir) => {
      seen.push(dir);
      return ['b.json', 'a.json', 'notes.txt'];
    });
    expect(files).toEqual([
      '/etc/claude-code/managed-settings.json',
      '/etc/claude-code/managed-settings.d/a.json',
      '/etc/claude-code/managed-settings.d/b.json',
    ]);
    expect(seen).toEqual(['/etc/claude-code/managed-settings.d']);
  });

  it('uses Application Support on macOS', () => {
    expect(managedSettingsFiles('darwin', {}, none)).toEqual([
      '/Library/Application Support/ClaudeCode/managed-settings.json',
    ]);
  });

  it('lists Program Files and a different %ProgramFiles% on Windows, never ProgramData', () => {
    const files = managedSettingsFiles('win32', { ProgramFiles: 'D:\\PF' }, none);
    expect(files).toEqual([
      'C:\\Program Files\\ClaudeCode\\managed-settings.json',
      'D:\\PF\\ClaudeCode\\managed-settings.json',
    ]);
    expect(files.some((f) => /ProgramData/i.test(f))).toBe(false);
  });

  it('does not repeat Program Files when %ProgramFiles% is the default', () => {
    expect(managedSettingsFiles('win32', { PROGRAMFILES: 'c:\\program files' }, none)).toEqual([
      'C:\\Program Files\\ClaudeCode\\managed-settings.json',
    ]);
  });
});

describe('hookGateWarnings', () => {
  const layer = (name: SettingsLayer['name'], data: Record<string, unknown> | null): SettingsLayer => ({
    name,
    file: `/x/${name}.json`,
    data,
  });

  it('flags disableAllHooks only when exactly true, per layer', () => {
    const out = hookGateWarnings([
      layer('user', { disableAllHooks: true }),
      layer('project', { disableAllHooks: 'true' }),
      layer('local', { disableAllHooks: 1 }),
      layer('managed', { disableAllHooks: true }),
      layer('managed', null),
    ]);
    expect(out).toEqual([
      { key: 'doctor.hooks.disableAll', params: { layer: 'user', file: '/x/user.json' } },
      { key: 'doctor.hooks.disableAll', params: { layer: 'managed', file: '/x/managed.json' } },
    ]);
  });

  it('flags allowManagedHooksOnly only in managed layers', () => {
    const out = hookGateWarnings([
      layer('user', { allowManagedHooksOnly: true }),
      layer('local', { allowManagedHooksOnly: true }),
      layer('managed', { allowManagedHooksOnly: true }),
    ]);
    expect(out).toEqual([{ key: 'doctor.hooks.managedOnly', params: { file: '/x/managed.json' } }]);
  });
});

describe('readSettingsLayer', () => {
  it('reads JSON with a BOM and returns null data for damaged or missing files', () => {
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT as string, 'layer-'));
    const good = path.join(dir, 'good.json');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(good, '\uFEFF{"disableAllHooks":true}');
    fs.writeFileSync(bad, '{');
    expect(readSettingsLayer('user', good).data).toEqual({ disableAllHooks: true });
    expect(readSettingsLayer('user', bad).data).toBeNull();
    expect(readSettingsLayer('user', path.join(dir, 'none.json')).data).toBeNull();
    fs.writeFileSync(good, '[1]');
    expect(readSettingsLayer('user', good).data).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('commandResolves', () => {
  const only =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it('checks an absolute path', () => {
    expect(commandResolves('/usr/bin/x hook Stop', { platform: 'linux', exists: () => false })).toBe(false);
    expect(commandResolves('/usr/bin/x', { platform: 'linux', exists: only('/usr/bin/x') })).toBe(true);
  });

  it('looks a bare name up on PATH', () => {
    const env = { PATH: '/a:/b' };
    expect(commandResolves('ccinfobar', { env, platform: 'linux', exists: only('/b/ccinfobar') })).toBe(true);
    expect(commandResolves('ccinfobar', { env, platform: 'linux', exists: () => false })).toBe(false);
    expect(commandResolves('ccinfobar', { env: {}, platform: 'linux', exists: () => true })).toBe(false);
  });

  it('handles a quoted first token', () => {
    const exists = only('/p q/ccinfobar');
    expect(commandResolves("'/p q/ccinfobar'", { platform: 'linux', exists })).toBe(true);
    expect(commandResolves('"/p q/ccinfobar" --x', { platform: 'linux', exists })).toBe(true);
    expect(commandResolves("'/p r/ccinfobar'", { platform: 'linux', exists })).toBe(false);
  });

  it('checks the script of a node command', () => {
    const env = { Path: 'C:\\node', PATHEXT: '.COM;.EXE' };
    const node = 'C:\\node\\node.EXE';
    expect(
      commandResolves('node "C:/x/ccinfobar.js"', {
        env,
        platform: 'win32',
        exists: only(node, 'C:/x/ccinfobar.js'),
      }),
    ).toBe(true);
    expect(commandResolves('node "C:/x/ccinfobar.js"', { env, platform: 'win32', exists: only(node) })).toBe(
      false,
    );
    expect(
      commandResolves('/usr/bin/node /gone/ccinfobar.js', {
        platform: 'linux',
        exists: only('/usr/bin/node'),
      }),
    ).toBe(false);
  });

  it('finds node.exe and PATHEXT names on Windows', () => {
    const env = { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' };
    expect(commandResolves('node.exe', { env, platform: 'win32', exists: only('C:\\bin\\node.exe') })).toBe(
      true,
    );
    expect(
      commandResolves('ccinfobar', { env, platform: 'win32', exists: only('C:\\bin\\ccinfobar.CMD') }),
    ).toBe(true);
  });

  it('does not judge relative paths and rejects an empty command', () => {
    expect(commandResolves('./bin/x', { platform: 'linux', exists: () => false })).toBe(true);
    expect(commandResolves('   ', { platform: 'linux', exists: () => true })).toBe(false);
  });
});

describe('hookEntryState and entryCommand', () => {
  const group = {
    hooks: [{ type: 'command', command: '/bin/ccinfobar hook Stop', async: true, timeout: 5 }],
  };
  const entry = {
    kind: 'hook',
    file: '/x/settings.json',
    event: 'Stop',
    value: group,
    claudeCode: '2.1.299',
    writtenHash: null,
    version: '1',
    at: '',
  } as HookEntry;

  it('is ok when an identical group is present and edited otherwise', () => {
    expect(hookEntryState(entry, { hooks: { Stop: [{ hooks: [] }, structuredClone(group)] } })).toBe('ok');
    const changed = structuredClone(group);
    (changed.hooks[0] as { timeout: number }).timeout = 30;
    expect(hookEntryState(entry, { hooks: { Stop: [changed] } })).toBe('edited');
    expect(hookEntryState(entry, { hooks: {} })).toBe('edited');
    expect(hookEntryState(entry, { hooks: { Stop: 'x' } })).toBe('edited');
    expect(hookEntryState(entry, {})).toBe('edited');
  });

  it('drops the trailing hook event from the command', () => {
    expect(entryCommand(entry)).toBe('/bin/ccinfobar');
    expect(entryCommand({ ...entry, value: { hooks: [] } })).toBeNull();
    expect(entryCommand({ ...entry, value: 'x' })).toBeNull();
  });

  it('drops the --progress hook form too', () => {
    const value = { hooks: [{ type: 'command', command: '/bin/ccinfobar --progress hook StopFailure' }] };
    expect(entryCommand({ ...entry, value, role: 'progress' })).toBe('/bin/ccinfobar');
  });
});

describe('progressWarnings', () => {
  const layer = (name: SettingsLayer['name'], data: Record<string, unknown> | null): SettingsLayer => ({
    name,
    file: `/x/${name}.json`,
    data,
  });
  const USER = [layer('user', { terminalProgressBarEnabled: false })];
  const WT = { WT_SESSION: 'abc' };
  const HANDLERS = [{ event: 'UserPromptSubmit' }, { event: 'Stop' }, { event: 'StopFailure' }];
  const keys = (o: Partial<Parameters<typeof progressWarnings>[0]> = {}) =>
    progressWarnings({
      layers: USER,
      progress: { enabled: true },
      entries: HANDLERS,
      env: WT,
      platform: 'linux',
      claudeCode: '2.1.200',
      ...o,
    }).map((w) => w.key);

  it('is quiet when progress is off and nothing is installed', () => {
    expect(keys({ progress: undefined, entries: [], layers: [] })).toEqual([]);
    expect(keys({ progress: { enabled: false }, entries: [], layers: [] })).toEqual([]);
  });

  it('is quiet when everything is in place', () => {
    expect(keys()).toEqual([]);
  });

  it('warns about Claude Code bar by the effective layer, default on', () => {
    const run = (layers: SettingsLayer[]) =>
      progressWarnings({
        layers,
        progress: { enabled: true },
        entries: HANDLERS,
        env: WT,
        platform: 'linux',
        claudeCode: null,
      });
    expect(run([layer('user', {}), layer('project', null)])).toEqual([
      { key: 'doctor.progress.ccBar', params: { file: '/x/user.json' } },
    ]);
    expect(run([layer('user', { terminalProgressBarEnabled: false })])).toEqual([]);
    expect(
      run([
        layer('user', { terminalProgressBarEnabled: false }),
        layer('local', { terminalProgressBarEnabled: true }),
      ]),
    ).toEqual([{ key: 'doctor.progress.ccBar', params: { file: '/x/local.json' } }]);
    expect(
      run([
        layer('user', { terminalProgressBarEnabled: true }),
        layer('project', { terminalProgressBarEnabled: false }),
      ]),
    ).toEqual([]);
    expect(
      run([
        layer('local', { terminalProgressBarEnabled: false }),
        layer('managed', { terminalProgressBarEnabled: true }),
      ]),
    ).toEqual([{ key: 'doctor.progress.ccBar', params: { file: '/x/managed.json' } }]);
    expect(run([layer('user', { terminalProgressBarEnabled: 'false' })])).toEqual([
      { key: 'doctor.progress.ccBar', params: { file: '/x/user.json' } },
    ]);
  });

  it('reports missing and stray handlers', () => {
    expect(keys({ entries: [] })).toEqual(['doctor.progress.noHandlers']);
    expect(keys({ entries: [], progress: { enabled: true, channel: 'hook' } })).toEqual([
      'doctor.progress.noHandlers',
    ]);
    expect(keys({ entries: [], progress: { enabled: true, channel: 'tty' } })).toEqual([]);
    expect(keys({ progress: { enabled: true, channel: 'tty' } })).toEqual(['doctor.progress.ttyHandlers']);
    expect(keys({ progress: { enabled: true, channel: 'tty' }, platform: 'win32' })).not.toContain(
      'doctor.progress.ttyHandlers',
    );
    expect(keys({ progress: { enabled: false } })).toEqual(['doctor.progress.strayHandlers']);
    expect(keys({ progress: undefined })).toEqual(['doctor.progress.strayHandlers']);
  });

  it('checks the terminal allowlist unless terminals is always', () => {
    expect(keys({ env: { TERM_PROGRAM: 'xterm' } })).toEqual(['doctor.progress.terminal']);
    expect(keys({ env: { WT_SESSION: '1' } })).toEqual([]);
    expect(keys({ env: {}, progress: { enabled: true, terminals: 'always' } })).toEqual([]);
  });

  it('flags an old Claude Code on the hook channel', () => {
    const out = progressWarnings({
      layers: USER,
      progress: { enabled: true },
      entries: HANDLERS,
      env: WT,
      platform: 'linux',
      claudeCode: '2.1.100',
    });
    expect(out).toEqual([{ key: 'doctor.progress.oldClaude', params: { version: '2.1.100' } }]);
    expect(keys({ claudeCode: '2.1.141' })).toEqual([]);
    expect(keys({ claudeCode: null })).toEqual([]);
    expect(keys({ claudeCode: '2.1.100', entries: [], progress: { enabled: true, channel: 'tty' } })).toEqual(
      [],
    );
  });

  it('flags the tty channel on Windows and in tmux without passthrough', () => {
    expect(keys({ progress: { enabled: true, channel: 'tty' }, platform: 'win32' })).toEqual([
      'doctor.progress.ttyWindows',
    ]);
    const tmux = { ...WT, TMUX: '/tmp/tmux-1/default,1,0' };
    expect(keys({ progress: { enabled: true, channel: 'tty' }, env: tmux, entries: [] })).toEqual([
      'doctor.progress.tmux',
    ]);
    expect(
      keys({ progress: { enabled: true, channel: 'tty', tmuxPassthrough: true }, env: tmux, entries: [] }),
    ).toEqual([]);
    expect(keys({ env: tmux })).toEqual([]);
  });
});
