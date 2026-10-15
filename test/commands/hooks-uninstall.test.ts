import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyHooks,
  DEFAULT_EVENTS,
  planHooks,
  removeOwnedHooks,
  uninstallHooks,
} from '../../src/commands/hooks-install.js';
import { applyInstall, planInstall, uninstall } from '../../src/commands/install.js';
import {
  dropEntry,
  dropHookEntry,
  findHookEntries,
  findStatusLineEntry,
  readManifest,
  writeManifest,
} from '../../src/commands/manifest.js';
import { hashBytes } from '../../src/commands/settings-file.js';
import { formatJson, type SettingsFixture, settingsFixture } from './fixtures.js';

const SIX = [...DEFAULT_EVENTS];
const CMD = '/bin/ccinfobar';
const HOOKS = { events: DEFAULT_EVENTS, claudeCode: '2.1.299' };
const userStop = { hooks: [{ type: 'command', command: 'afplay done.wav' }] };
const other = { type: 'command', command: '/usr/bin/ccstatusline', padding: 0 };
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const write = (fx: SettingsFixture, data: unknown) => fs.writeFileSync(fx.file, formatJson(data));

function install(fx: SettingsFixture, hooks = true) {
  return applyInstall(planInstall({ file: fx.file, command: CMD, env: fx.env }), {
    confirmed: true,
    env: fx.env,
    ...(hooks ? { hooks: HOOKS } : {}),
  });
}

const full = (fx: SettingsFixture) => uninstall(fx.file, { env: fx.env });
const manifest = (fx: SettingsFixture) => readManifest(fx.env);

function expectClean(fx: SettingsFixture) {
  const m = manifest(fx);
  expect(findStatusLineEntry(m, fx.file)).toBeNull();
  expect(findHookEntries(m, fx.file)).toEqual([]);
}

describe('full uninstall with hooks', () => {
  it('deletes a settings file it created, hooks and all', () => {
    const fx = settingsFixture();
    install(fx);
    expect(Object.keys(read(fx.file).hooks)).toEqual(SIX);
    const res = full(fx);
    expect(res).toMatchObject({ status: 'deleted-file', removed: true });
    expect(res.hooks).toEqual({ removed: SIX, kept: [] });
    expect(fs.existsSync(fx.file)).toBe(false);
    expectClean(fx);
  });

  it('deletes a created file that only holds owned content after a reformat', () => {
    const fx = settingsFixture();
    install(fx);
    fs.writeFileSync(fx.file, formatJson(read(fx.file), { indent: '\t' }));
    const res = full(fx);
    expect(res.status).toBe('deleted-file');
    expect(res.hooks.removed).toEqual(SIX);
    expect(fs.existsSync(fx.file)).toBe(false);
    expectClean(fx);
  });

  it('restores BOM, CRLF and 4-space bytes exactly', () => {
    const fx = settingsFixture({
      data: { model: 'opus', hooks: { Stop: [userStop] } },
      bom: true,
      eol: '\r\n',
      indent: '    ',
    });
    const before = fs.readFileSync(fx.file);
    install(fx);
    expect(read(fx.file).hooks.Stop).toHaveLength(2);
    const res = full(fx);
    expect(res).toMatchObject({ status: 'restored-exact', hooks: { removed: SIX, kept: [] } });
    expect(fs.readFileSync(fx.file).equals(before)).toBe(true);
    expectClean(fx);
  });

  it('still restores exactly after uninstall --hooks and a second hooks write', () => {
    const fx = settingsFixture({ data: { model: 'opus' }, indent: '    ' });
    const before = fs.readFileSync(fx.file);
    install(fx);
    expect(uninstallHooks(fx.file, fx.env).changed).toBe(true);
    const p = planHooks({
      settings: read(fx.file),
      manifest: manifest(fx),
      file: fx.file,
      command: CMD,
      claudeCode: '2.1.299',
      events: DEFAULT_EVENTS,
    });
    expect(applyHooks(fx.file, p, fx.env).changed).toBe(true);
    expect(full(fx).status).toBe('restored-exact');
    expect(fs.readFileSync(fx.file).equals(before)).toBe(true);
    expectClean(fx);
  });

  it('removes only owned keys and groups after a user edit', () => {
    const fx = settingsFixture({ data: { model: 'opus', hooks: { Stop: [userStop] } } });
    install(fx);
    write(fx, { ...read(fx.file), theme: 'x' });
    const res = full(fx);
    expect(res).toMatchObject({ status: 'removed', hooks: { removed: SIX, kept: [] } });
    expect(read(fx.file)).toEqual({ model: 'opus', hooks: { Stop: [userStop] }, theme: 'x' });
    expectClean(fx);
  });

  it('leaves a foreign statusLine and still removes owned hooks', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    write(fx, { ...read(fx.file), statusLine: other });
    const res = full(fx);
    expect(res).toMatchObject({ status: 'foreign', removed: false, current: other });
    expect(res.hooks.removed).toEqual(SIX);
    expect(read(fx.file)).toEqual({ model: 'opus', statusLine: other });
    expectClean(fx);
  });

  it('removes owned hooks when the statusLine is gone', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    const { statusLine: _, ...rest } = read(fx.file);
    write(fx, rest);
    const res = full(fx);
    expect(res).toMatchObject({ status: 'gone-nothing', hooks: { removed: SIX, kept: [] } });
    expect(read(fx.file)).toEqual({ model: 'opus' });
    expectClean(fx);
  });

  it('removes owned hooks when no statusLine entry is recorded', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    writeManifest(dropEntry(manifest(fx), fx.file, 'statusLine'), fx.env);
    const { statusLine: _, ...rest } = read(fx.file);
    write(fx, rest);
    const res = full(fx);
    expect(res).toMatchObject({ status: 'not-installed', hooks: { removed: SIX, kept: [] } });
    expect(read(fx.file)).toEqual({ model: 'opus' });
    expectClean(fx);
  });

  it('keeps an edited owned group, reports it and forgets it', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    const data = read(fx.file);
    data.hooks.Stop[0].hooks[0].timeout = 9;
    write(fx, data);
    const res = full(fx);
    expect(res.status).toBe('removed');
    expect(res.hooks).toEqual({ removed: SIX.filter((e) => e !== 'Stop'), kept: ['Stop'] });
    expect(read(fx.file)).toEqual({ model: 'opus', hooks: { Stop: data.hooks.Stop } });
    expectClean(fx);
  });
});

describe('uninstall --hooks', () => {
  it('keeps the statusLine and the user group and refreshes the hash', () => {
    const fx = settingsFixture({ data: { model: 'opus', hooks: { Stop: [userStop] } } });
    install(fx);
    const sl = read(fx.file).statusLine;
    const res = uninstallHooks(fx.file, fx.env);
    expect(res).toMatchObject({ removed: SIX, kept: [], changed: true });
    expect(read(fx.file)).toEqual({ model: 'opus', hooks: { Stop: [userStop] }, statusLine: sl });
    const m = manifest(fx);
    expect(findHookEntries(m, fx.file)).toEqual([]);
    expect(findStatusLineEntry(m, fx.file)?.writtenHash).toBe(hashBytes(fs.readFileSync(fx.file)));
  });

  it('drops an emptied hooks object', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    uninstallHooks(fx.file, fx.env);
    expect(read(fx.file).hooks).toBeUndefined();
    expect(read(fx.file).statusLine.command).toBe(CMD);
  });

  it('leaves an edited owned group in place and reports it', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    const data = read(fx.file);
    data.hooks.Stop[0].hooks[0].timeout = 9;
    write(fx, data);
    const res = uninstallHooks(fx.file, fx.env);
    expect(res.removed).toEqual(SIX.filter((e) => e !== 'Stop'));
    expect(res.kept).toEqual(['Stop']);
    expect(read(fx.file).hooks).toEqual({ Stop: data.hooks.Stop });
    expect(findHookEntries(manifest(fx), fx.file)).toEqual([]);
  });

  it('writes nothing without hook entries', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx, false);
    const bytes = fs.readFileSync(fx.file);
    const m = fs.readFileSync(`${fx.env.CCINFOBAR_CONFIG_DIR}/manifest.json`);
    expect(uninstallHooks(fx.file, fx.env)).toEqual({ removed: [], kept: [], backup: null, changed: false });
    expect(fs.readFileSync(fx.file).equals(bytes)).toBe(true);
    expect(fs.readFileSync(`${fx.env.CCINFOBAR_CONFIG_DIR}/manifest.json`).equals(m)).toBe(true);
  });

  it('an outside edit before it voids the byte restore', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    write(fx, { ...read(fx.file), theme: 'x' });
    uninstallHooks(fx.file, fx.env);
    expect(findStatusLineEntry(manifest(fx), fx.file)?.restore).toBeNull();
    expect(full(fx).status).toBe('removed');
    expect(read(fx.file)).toEqual({ model: 'opus', theme: 'x' });
  });
});

describe('hook entries and groups', () => {
  it('drops hook entries per event', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    const left = findHookEntries(dropHookEntry(manifest(fx), fx.file, 'Stop'), fx.file);
    expect(left.map((e) => e.event)).toEqual(SIX.filter((e) => e !== 'Stop'));
  });

  it('removeOwnedHooks leaves user arrays, empty ones and odd values alone', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx);
    const entries = findHookEntries(manifest(fx), fx.file);
    const draft = read(fx.file);
    draft.hooks.PreToolUse = [];
    draft.hooks.Stop.unshift(userStop);
    draft.hooks.Notification = 'odd';
    const res = removeOwnedHooks(draft, entries);
    expect(res).toEqual({ removed: SIX.filter((e) => e !== 'Notification'), kept: ['Notification'] });
    expect(draft.hooks).toEqual({ PreToolUse: [], Stop: [userStop], Notification: 'odd' });
  });
});

describe('progress role (D-42)', () => {
  const PROGRESS = ['UserPromptSubmit', 'Stop', 'StopFailure'];
  const both = (fx: SettingsFixture) =>
    applyInstall(planInstall({ file: fx.file, command: CMD, env: fx.env }), {
      confirmed: true,
      env: fx.env,
      hooks: { ...HOOKS, claudeCode: '2.1.300', progress: true },
    });
  const groupsBy = (hooks: Record<string, unknown[]>, progress: boolean) =>
    Object.fromEntries(
      Object.entries(hooks)
        .map(([k, v]) => [k, v.filter((g) => JSON.stringify(g).includes('--progress') === progress)])
        .filter(([, v]) => (v as unknown[]).length),
    );

  it('uninstall progress removes only progress groups; async ones stay byte-identical', () => {
    const fx = settingsFixture({ data: { model: 'opus', hooks: { Stop: [userStop] } } });
    both(fx);
    const before = read(fx.file);
    const res = uninstallHooks(fx.file, fx.env, undefined, 'progress');
    expect(res).toMatchObject({ removed: [], kept: [], progress: { removed: PROGRESS, kept: [] } });
    const after = read(fx.file);
    expect(after.hooks).toEqual(groupsBy(before.hooks, false));
    expect(after.statusLine).toEqual(before.statusLine);
    const entries = findHookEntries(manifest(fx), fx.file);
    expect(entries.some((e) => e.role)).toBe(false);
    expect(entries).toHaveLength(7);
  });

  it('uninstall hooks removes only role-less groups; progress ones stay', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    both(fx);
    const before = read(fx.file);
    const res = uninstallHooks(fx.file, fx.env);
    expect(res.removed).toEqual(SIX);
    expect(res.progress).toBeUndefined();
    expect(read(fx.file).hooks).toEqual(groupsBy(before.hooks, true));
    expect(findHookEntries(manifest(fx), fx.file).map((e) => e.role)).toEqual([
      'progress',
      'progress',
      'progress',
    ]);
  });

  it('a user-edited progress handler is kept and reported', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    both(fx);
    const data = read(fx.file);
    const stop = data.hooks.Stop.find((g: unknown) => JSON.stringify(g).includes('--progress'));
    stop.hooks[0].timeout = 9;
    write(fx, data);
    const res = uninstallHooks(fx.file, fx.env, undefined, 'progress');
    expect(res.progress).toEqual({ removed: ['UserPromptSubmit', 'StopFailure'], kept: ['Stop'] });
    expect(read(fx.file).hooks.Stop).toContainEqual(stop);
    expect(findHookEntries(manifest(fx), fx.file).some((e) => e.role)).toBe(false);
  });

  it('role all and a full uninstall remove both', () => {
    const a = settingsFixture({ data: { model: 'opus' } });
    both(a);
    const res = uninstallHooks(a.file, a.env, undefined, 'all');
    expect(res).toMatchObject({ removed: SIX, progress: { removed: PROGRESS } });
    expect(read(a.file).hooks).toBeUndefined();
    const b = settingsFixture({ data: { model: 'opus' } });
    both(b);
    write(b, { ...read(b.file), theme: 'x' });
    const full2 = full(b);
    expect(full2.status).toBe('removed');
    expect(full2.hooks).toEqual({ removed: SIX, kept: [], progress: { removed: PROGRESS, kept: [] } });
    expect(read(b.file)).toEqual({ model: 'opus', theme: 'x' });
    expectClean(b);
    const c = settingsFixture({ data: { model: 'opus' } });
    both(c);
    const exact = full(c);
    expect(exact.status).toBe('restored-exact');
    expect(exact.hooks.progress?.removed).toEqual(PROGRESS);
    expectClean(c);
  });

  it('removeOwnedHooks with every entry removes both roles', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    both(fx);
    const draft = read(fx.file);
    const res = removeOwnedHooks(draft, findHookEntries(manifest(fx), fx.file));
    expect(res).toEqual({ removed: SIX, kept: [], progress: { removed: PROGRESS, kept: [] } });
    expect(draft.hooks).toBeUndefined();
  });
});
