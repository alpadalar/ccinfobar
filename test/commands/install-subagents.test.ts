import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyInstall,
  InstallNeedsConfirmError,
  planInstall,
  uninstall,
  uninstallSubagentLine,
} from '../../src/commands/install.js';
import { findSubagentLineEntry, readManifest } from '../../src/commands/manifest.js';
import { hashBytes } from '../../src/commands/settings-file.js';
import { formatJson, type SettingsFixture, settingsFixture } from './fixtures.js';

const CMD = '/bin/ccinfobar';
const SUB = { type: 'command', command: '/bin/ccinfobar subagent-line' };
const foreign = { type: 'command', command: 'other-tool rows' };
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const bytes = (f: string) => fs.readFileSync(f);
const entry = (fx: SettingsFixture) => findSubagentLineEntry(readManifest(fx.env), fx.file);

function install(
  fx: SettingsFixture,
  o: { command?: string; subagents?: boolean; confirmed?: boolean } = {},
) {
  const plan = planInstall({
    file: fx.file,
    command: o.command ?? CMD,
    env: fx.env,
    ...(o.subagents ? { subagents: true } : {}),
  });
  return applyInstall(plan, { confirmed: o.confirmed ?? true, env: fx.env });
}

const full = (fx: SettingsFixture) => uninstall(fx.file, { env: fx.env });

describe('install --subagents', () => {
  it('writes the key with statusLine, records a hash, and restores byte-exact', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    const before = bytes(fx.file);
    const res = install(fx, { subagents: true });
    const data = read(fx.file);
    expect(data.subagentStatusLine).toEqual(SUB);
    expect(data.model).toBe('opus');
    expect(res.subagent).toBe('added');
    expect(res.backup && fs.existsSync(res.backup)).toBe(true);
    expect(entry(fx)?.writtenHash).toBe(hashBytes(bytes(fx.file)));
    const out = full(fx);
    expect(out.subagent).toBe('removed');
    expect(bytes(fx.file).equals(before)).toBe(true);
    expect(entry(fx)).toBeNull();
  });

  it('stays byte-exact when the flag comes in a second write', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    const before = bytes(fx.file);
    install(fx);
    const plan = planInstall({ file: fx.file, command: CMD, env: fx.env, subagents: true });
    expect(plan.subagent?.changes).toBe(true);
    expect(applyInstall(plan, { confirmed: true, env: fx.env }).subagent).toBe('added');
    full(fx);
    expect(bytes(fx.file).equals(before)).toBe(true);
  });

  it('rewrites a stale owned command on a plain reinstall', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    const before = bytes(fx.file);
    install(fx, { command: '/old/ccinfobar', subagents: true });
    const res = install(fx, { command: '/new/ccinfobar' });
    expect(res.subagent).toBe('rewritten');
    const data = read(fx.file);
    expect(data.subagentStatusLine.command).toBe('/new/ccinfobar subagent-line');
    expect(data.statusLine.command).toBe('/new/ccinfobar');
    full(fx);
    expect(bytes(fx.file).equals(before)).toBe(true);
  });

  it('keeps hand-added sub-keys on an owned rewrite and does not write when nothing owned changed', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx, { command: '/old/ccinfobar', subagents: true });
    const data = read(fx.file);
    data.subagentStatusLine.hint = 'mine';
    fs.writeFileSync(fx.file, `${JSON.stringify(data, null, 2)}\n`);
    const same = planInstall({ file: fx.file, command: '/old/ccinfobar', env: fx.env });
    expect(same.subagent?.changes).toBe(false);
    const res = install(fx, { command: '/new/ccinfobar' });
    expect(res.subagent).toBe('rewritten');
    expect(read(fx.file).subagentStatusLine).toEqual({
      type: 'command',
      command: '/new/ccinfobar subagent-line',
      hint: 'mine',
    });
    expect(entry(fx)?.value).toEqual({ type: 'command', command: '/new/ccinfobar subagent-line' });
  });

  it('asks before replacing a foreign entry and restores it on uninstall (D-03)', () => {
    const fx = settingsFixture({ data: { subagentStatusLine: foreign } });
    const before = bytes(fx.file);
    const plan = planInstall({ file: fx.file, command: CMD, env: fx.env, subagents: true });
    expect(plan.needsConfirm).toBe(true);
    expect(plan.subagent?.owner).toBe('foreign');
    expect(() => applyInstall(plan, { confirmed: false, env: fx.env })).toThrow(InstallNeedsConfirmError);
    expect(bytes(fx.file).equals(before)).toBe(true);
    const res = applyInstall(plan, { confirmed: true, env: fx.env });
    expect(res.subagent).toBe('replaced');
    expect(entry(fx)?.previous).toEqual(foreign);
    const out = full(fx);
    expect(out.subagent).toBe('restored');
    expect(read(fx.file).subagentStatusLine).toEqual(foreign);
    expect(read(fx.file).statusLine).toBeUndefined();
  });

  it('leaves a foreign entry alone without the flag', () => {
    const fx = settingsFixture({ data: { subagentStatusLine: foreign } });
    const plan = planInstall({ file: fx.file, command: CMD, env: fx.env });
    expect(plan.subagent).toBeUndefined();
    expect(plan.needsConfirm).toBe(false);
    applyInstall(plan, { confirmed: false, env: fx.env });
    expect(read(fx.file).subagentStatusLine).toEqual(foreign);
  });

  it('keeps a hand-edited entry on uninstall and drops the manifest entry', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx, { subagents: true });
    const data = read(fx.file);
    data.subagentStatusLine.command = 'mine';
    fs.writeFileSync(fx.file, formatJson(data));
    const out = full(fx);
    expect(out.subagent).toBe('kept');
    const after = read(fx.file);
    expect(after.subagentStatusLine.command).toBe('mine');
    expect(after.statusLine).toBeUndefined();
    expect(entry(fx)).toBeNull();
  });

  it('uninstallSubagentLine removes only that key', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx, { subagents: true });
    const res = uninstallSubagentLine(fx.file, fx.env);
    expect(res).toMatchObject({ subagent: 'removed', changed: true });
    const data = read(fx.file);
    expect(data.statusLine).toBeDefined();
    expect(data.subagentStatusLine).toBeUndefined();
    expect(entry(fx)).toBeNull();
    const snap = bytes(fx.file);
    expect(uninstallSubagentLine(fx.file, fx.env)).toEqual({ subagent: null, backup: null, changed: false });
    expect(bytes(fx.file).equals(snap)).toBe(true);
  });

  it('never writes the key into a project file', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    const file = path.join(fx.dir, 'project', '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatJson({ model: 'opus' }));
    const plan = planInstall({ file, command: CMD, env: fx.env, subagents: true });
    applyInstall(plan, { confirmed: true, env: fx.env });
    expect(read(file).subagentStatusLine).toBeUndefined();
    expect(findSubagentLineEntry(readManifest(fx.env), file)).toBeNull();
  });

  it('removes the key when the statusLine is already gone', () => {
    const fx = settingsFixture({ data: { model: 'opus' } });
    install(fx, { subagents: true });
    const data = read(fx.file);
    delete data.statusLine;
    fs.writeFileSync(fx.file, formatJson(data));
    full(fx);
    expect(read(fx.file).subagentStatusLine).toBeUndefined();
    expect(entry(fx)).toBeNull();
  });
});
