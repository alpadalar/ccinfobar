import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string;

function sandbox() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-cli-')));
  const claude = path.join(dir, 'claude');
  const config = path.join(dir, 'config');
  const settings = path.join(claude, 'settings.json');
  const env = {
    ...process.env,
    HOME: path.join(dir, 'home'),
    USERPROFILE: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: claude,
    CCINFOBAR_CONFIG_DIR: config,
    CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
    CCINFOBAR_NO_UPDATE: '1',
    CCINFOBAR_NO_USAGE_API: '1',
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [bin, ...args, '--command', 'ccinfobar-test', '--no-import'], {
      cwd: dir,
      encoding: 'utf8',
      env,
      input: '',
    });
  return { dir, claude, config, settings, run };
}

const FOREIGN = { model: 'opus', statusLine: { type: 'command', command: 'npx ccstatusline', padding: 1 } };
const foreignBytes = () =>
  Buffer.from(`﻿${JSON.stringify(FOREIGN, null, 4).replace(/\n/g, '\r\n')}\r\n`, 'utf8');

const stamped = (dir: string) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^settings-\d{8}T\d{6}Z(-\d+)?\.json$/.test(n)) : [];

describe.skipIf(!fs.existsSync(bin))('install and uninstall with the built CLI', () => {
  it('replaces a foreign statusLine without a TTY and says so', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    fs.writeFileSync(s.settings, foreignBytes());
    const res = s.run('install');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`Installing ccinfobar ${version}`);
    expect(res.stdout).toContain('Replaced: npx ccstatusline');
    expect(stamped(path.join(s.config, 'backups'))).toHaveLength(1);
    expect(fs.existsSync(path.join(s.config, 'manifest.json'))).toBe(true);
    const text = fs.readFileSync(s.settings, 'utf8');
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('\r\n    "statusLine"');
    expect(JSON.parse(text.slice(1)).statusLine).toEqual({
      type: 'command',
      command: 'ccinfobar-test',
      padding: 0,
    });
  });

  it('uninstall restores the original bytes exactly', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    const before = foreignBytes();
    fs.writeFileSync(s.settings, before);
    expect(s.run('install').status).toBe(0);
    const res = s.run('uninstall');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('exactly as it was');
    expect(fs.readFileSync(s.settings).equals(before)).toBe(true);
  });

  it('--dry-run writes nothing', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    const before = foreignBytes();
    fs.writeFileSync(s.settings, before);
    const res = s.run('install', '--dry-run');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('current:  npx ccstatusline');
    expect(res.stdout).toContain('proposed: ccinfobar-test');
    expect(res.stdout).toContain('padding: 1 -> 0');
    expect(res.stdout).toContain('Dry run: nothing was written.');
    expect(fs.readFileSync(s.settings).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(s.config, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(s.config, 'manifest.json'))).toBe(false);
  });

  it('--yes replaces without prompting', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    fs.writeFileSync(s.settings, foreignBytes());
    const res = s.run('install', '--yes');
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('Replace?');
    expect(JSON.parse(fs.readFileSync(s.settings, 'utf8').slice(1)).statusLine.command).toBe(
      'ccinfobar-test',
    );
  });

  it('install into a missing settings.json, then uninstall deletes it', () => {
    const s = sandbox();
    const res = s.run('install');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('statusLine set to "ccinfobar-test"');
    expect(fs.existsSync(s.settings)).toBe(true);
    expect(s.run('uninstall').status).toBe(0);
    expect(fs.existsSync(s.settings)).toBe(false);
  });
});
