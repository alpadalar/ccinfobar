import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipDist } from '../dist.js';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const win = process.platform === 'win32';

function fakeClaude(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  if (win) fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo 2.1.299 (Claude Code)\r\n');
  else
    fs.writeFileSync(path.join(dir, 'claude'), "#!/bin/sh\necho '2.1.299 (Claude Code)'\n", { mode: 0o755 });
}

function sandbox() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-subagents-')));
  const claude = path.join(dir, 'claude');
  const config = path.join(dir, 'config');
  const settings = path.join(claude, 'settings.json');
  const binDir = path.join(dir, 'bin');
  fakeClaude(binDir);
  const dirs = [binDir, path.dirname(process.execPath)];
  if (win) dirs.push(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') env[k] = v;
  Object.assign(env, {
    PATH: dirs.join(path.delimiter),
    HOME: path.join(dir, 'home'),
    USERPROFILE: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: claude,
    CCINFOBAR_CONFIG_DIR: config,
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    CCINFOBAR_NO_UPDATE: '1',
    CCINFOBAR_NO_USAGE_API: '1',
    CCINFOBAR_NO_JOBS: '1',
    NO_COLOR: '1',
  });
  const run = (args: string[], command = 'ccinfobar-test') => {
    const withCommand = args[0] === 'install' ? [...args, '--command', command, '--no-import'] : args;
    return spawnSync(process.execPath, [bin, ...withCommand], { cwd: dir, encoding: 'utf8', env, input: '' });
  };
  const manifest = path.join(config, 'manifest.json');
  const read = () => JSON.parse(fs.readFileSync(settings, 'utf8').replace(/^\uFEFF/, ''));
  const entries = (): Array<{ kind: string }> => JSON.parse(fs.readFileSync(manifest, 'utf8')).entries;
  return { dir, claude, settings, manifest, run, read, entries };
}

const FOREIGN = { type: 'command', command: 'other-tool run' };

describe.skipIf(skipDist)('install --subagents with the built CLI', () => {
  it('writes the key with a backup and manifest entry, and uninstall restores the bytes', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    const before = '{\r\n    "model": "opus"\r\n}\r\n';
    fs.writeFileSync(s.settings, before);
    const res = s.run(['install', '--subagents', '--yes']);
    expect(res.status).toBe(0);
    expect(s.read().subagentStatusLine).toEqual({ type: 'command', command: 'ccinfobar-test subagent-line' });
    expect(res.stdout).toContain('subagentStatusLine set to');
    expect(res.stdout).toContain('Backup:');
    expect(s.entries().some((e) => e.kind === 'subagentStatusLine')).toBe(true);
    const out = s.run(['uninstall']);
    expect(out.status).toBe(0);
    expect(fs.readFileSync(s.settings, 'utf8')).toBe(before);
    expect(s.entries().some((e) => e.kind === 'subagentStatusLine')).toBe(false);
  });

  it('leaves a foreign value alone without the flag, keeps it without --yes, replaces with --yes', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    const before = `${JSON.stringify({ model: 'opus', subagentStatusLine: FOREIGN }, null, 2)}\n`;
    fs.writeFileSync(s.settings, before);
    expect(s.run(['install', '--yes'], 'x').status).toBe(0);
    expect(s.read().subagentStatusLine).toEqual(FOREIGN);
    const kept = s.run(['install', '--subagents'], 'x');
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain('Kept the current subagentStatusLine.');
    expect(s.read().subagentStatusLine).toEqual(FOREIGN);
    const yes = s.run(['install', '--subagents', '--yes'], 'x');
    expect(yes.status).toBe(0);
    expect(s.read().subagentStatusLine).toEqual({ type: 'command', command: 'x subagent-line' });
    expect(s.run(['uninstall']).status).toBe(0);
    expect(s.read().subagentStatusLine).toEqual(FOREIGN);
    expect(s.read().model).toBe('opus');
  });

  it('doctor shows the owned line', () => {
    const s = sandbox();
    expect(s.run(['install', '--subagents', '--yes']).status).toBe(0);
    const res = s.run(['doctor']);
    expect(res.stdout).toContain('✓ Claude Code subagentStatusLine: ccinfobar-test subagent-line');
    expect(res.stdout).toContain('subagentStatusLine in');
  });
});
