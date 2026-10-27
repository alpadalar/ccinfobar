import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipDist } from '../dist.js';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const win = process.platform === 'win32';

const SEVEN = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'PermissionDenied',
];
const NEVER = ['PreToolUse', 'PostToolUse', 'PostToolBatch', 'PreModelSwitch', 'SessionEnd'];

type Fake = string | null;

// fake claude first on PATH; the real one is never reachable
function fakeClaude(dir: string, out: Fake): void {
  fs.mkdirSync(dir, { recursive: true });
  if (win) {
    const body = out === null ? '@exit /b 1\r\n' : `@echo ${out}\r\n`;
    fs.writeFileSync(path.join(dir, 'claude.cmd'), body);
    return;
  }
  const body = out === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho '${out}'\n`;
  fs.writeFileSync(path.join(dir, 'claude'), body, { mode: 0o755 });
}

function sandbox(claudeOut: Fake = '2.1.299 (Claude Code)') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-hooks-')));
  const claude = path.join(dir, 'claude');
  const config = path.join(dir, 'config');
  const settings = path.join(claude, 'settings.json');
  const binDir = path.join(dir, 'bin');
  fakeClaude(binDir, claudeOut);
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
  });
  const run = (args: string[], command = 'ccinfobar-test') =>
    spawnSync(process.execPath, [bin, ...args, '--command', command, '--no-import'], {
      cwd: dir,
      encoding: 'utf8',
      env,
      input: '',
    });
  const manifest = path.join(config, 'manifest.json');
  const read = () => JSON.parse(fs.readFileSync(settings, 'utf8').replace(/^\uFEFF/, ''));
  return { dir, claude, config, settings, manifest, run, read };
}

const FOREIGN = { model: 'opus', statusLine: { type: 'command', command: 'npx ccstatusline', padding: 1 } };

const commandsOf = (hooks: Record<string, unknown[]>, event: string) =>
  (hooks[event] as Array<{ hooks: Array<{ command: string }> }>).map((g) => g.hooks[0]?.command);

describe.skipIf(skipDist)('install --hooks with the built CLI', () => {
  it('adds the seven default hooks to user settings and the manifest', () => {
    const s = sandbox();
    const res = s.run(['install', '--hooks', '--yes']);
    expect(res.status).toBe(0);
    const hooks = s.read().hooks as Record<string, unknown[]>;
    expect(Object.keys(hooks).sort()).toEqual([...SEVEN].sort());
    for (const e of SEVEN) expect(commandsOf(hooks, e)).toEqual([`ccinfobar-test hook ${e}`]);
    expect((hooks.Notification?.[0] as { matcher?: string } | undefined)?.matcher).toBe('permission_prompt');
    expect(hooks.PermissionRequest).toBeUndefined();
    for (const e of NEVER) expect(hooks[e]).toBeUndefined();
    expect(res.stdout).toContain('Claude Code 2.1.299');
    expect(res.stdout).toContain(`✓ hooks added: ${SEVEN.join(', ')}`);
    const m = JSON.parse(fs.readFileSync(s.manifest, 'utf8'));
    const entries = m.entries.filter((e: { kind: string }) => e.kind === 'hook');
    expect(entries.map((e: { event: string }) => e.event).sort()).toEqual([...SEVEN].sort());
  });

  it('--dry-run writes nothing and prints one line per hook', () => {
    const s = sandbox();
    const res = s.run(['install', '--hooks', '--dry-run']);
    expect(res.status).toBe(0);
    expect(fs.existsSync(s.settings)).toBe(false);
    expect(fs.existsSync(s.manifest)).toBe(false);
    const adds = res.stdout.split('\n').filter((l) => l.startsWith('  + hook '));
    expect(adds).toHaveLength(7);
    expect(adds).toContain('  + hook Stop: ccinfobar-test hook Stop');
    expect(res.stdout).toContain('Dry run: nothing was written.');
  });

  it('--hooks=permission also adds PermissionRequest', () => {
    const s = sandbox();
    const res = s.run(['install', '--hooks=permission', '--yes']);
    expect(res.status).toBe(0);
    const hooks = s.read().hooks as Record<string, unknown[]>;
    expect(commandsOf(hooks, 'PermissionRequest')).toEqual(['ccinfobar-test hook PermissionRequest']);
    expect(Object.keys(hooks)).toHaveLength(8);
  });

  it('--hooks=bogus exits 1 and writes nothing', () => {
    const s = sandbox();
    const res = s.run(['install', '--hooks=bogus', '--yes']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--hooks takes no value or =permission');
    expect(fs.existsSync(s.settings)).toBe(false);
    expect(fs.existsSync(s.config)).toBe(false);
  });

  it('refuses hooks on an old Claude Code but installs the status line', () => {
    const s = sandbox('2.1.50 (Claude Code)');
    const res = s.run(['install', '--hooks', '--yes']);
    expect(res.status).toBe(0);
    const data = s.read();
    expect(data.statusLine.command).toBe('ccinfobar-test');
    expect(data.hooks).toBeUndefined();
    expect(res.stdout).toContain('Hooks need Claude Code 2.1.101 or newer (found 2.1.50)');
  });

  it('refuses hooks when the version is unknown', () => {
    const s = sandbox(null);
    const res = s.run(['install', '--hooks', '--yes']);
    expect(res.status).toBe(0);
    const data = s.read();
    expect(data.statusLine.command).toBe('ccinfobar-test');
    expect(data.hooks).toBeUndefined();
    expect(res.stdout).toContain('its version could not be detected');
    const dry = s.run(['install', '--hooks', '--dry-run']);
    expect(dry.stdout).toContain('Claude Code version not detected');
  });

  it('a second run keeps the hooks and the bytes', () => {
    const s = sandbox();
    expect(s.run(['install', '--hooks', '--yes']).status).toBe(0);
    const before = fs.readFileSync(s.settings);
    const res = s.run(['install', '--hooks', '--yes']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`hooks already installed: ${SEVEN.join(', ')}`);
    expect(fs.readFileSync(s.settings).equals(before)).toBe(true);
    const dry = s.run(['install', '--hooks', '--dry-run']);
    expect(dry.stdout).toContain('  = hook Stop (already installed)');
  });

  it('a new --command rewrites the owned hooks without --hooks (D-20)', () => {
    const s = sandbox();
    expect(s.run(['install', '--hooks', '--yes']).status).toBe(0);
    const dry = s.run(['install', '--dry-run'], 'ccinfobar-test2');
    expect(dry.stdout).toContain('  ~ hook Stop: ccinfobar-test hook Stop → ccinfobar-test2 hook Stop');
    const res = s.run(['install', '--yes'], 'ccinfobar-test2');
    expect(res.status).toBe(0);
    const hooks = s.read().hooks as Record<string, unknown[]>;
    for (const e of SEVEN) expect(commandsOf(hooks, e)).toEqual([`ccinfobar-test2 hook ${e}`]);
    expect(res.stdout).toContain('✓ hooks updated to the new command:');
  });

  it('reports a same-command hook it does not own as not managed', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    const mine = { hooks: [{ type: 'command', command: 'ccinfobar-test hook Stop' }] };
    fs.writeFileSync(s.settings, JSON.stringify({ hooks: { Stop: [mine] } }, null, 2));
    const dry = s.run(['install', '--hooks', '--dry-run']);
    expect(dry.stdout).toContain('  - hook Stop: already present (not managed)');
    const res = s.run(['install', '--hooks', '--yes']);
    expect(res.stdout).toContain('already present (not managed): Stop');
    expect(s.read().hooks.Stop).toEqual([mine]);
  });

  it('replaces a foreign statusLine without a TTY and adds hooks; dry-run shows both', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    fs.writeFileSync(s.settings, JSON.stringify(FOREIGN, null, 2));
    const dry = s.run(['install', '--hooks', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('current:  npx ccstatusline');
    expect(dry.stdout).toContain('proposed: ccinfobar-test');
    expect(dry.stdout).toContain('  + hook SessionStart: ccinfobar-test hook SessionStart');
    expect(JSON.parse(fs.readFileSync(s.settings, 'utf8'))).toEqual(FOREIGN);
    const res = s.run(['install', '--hooks']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Replaced: npx ccstatusline');
    expect(Object.keys(s.read().hooks)).toHaveLength(7);
  });

  it('--project --hooks warns and writes no hooks to the project file', () => {
    const s = sandbox();
    const res = s.run(['install', '--project', '--hooks', '--yes']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Hooks go to user settings only');
    const local = path.join(s.dir, '.claude', 'settings.local.json');
    const data = JSON.parse(fs.readFileSync(local, 'utf8'));
    expect(data.statusLine.command).toBe('ccinfobar-test');
    expect(data.hooks).toBeUndefined();
    expect(fs.existsSync(s.settings)).toBe(false);
  });
  it('uninstall --hooks keeps the statusLine and removes the hooks key', () => {
    const s = sandbox();
    expect(s.run(['install', '--hooks', '--yes']).status).toBe(0);
    const res = s.run(['uninstall', '--hooks']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`✓ Removed ccinfobar hooks: ${SEVEN.join(', ')}`);
    const data = s.read();
    expect(data.statusLine.command).toBe('ccinfobar-test');
    expect(data.hooks).toBeUndefined();
    const again = s.run(['uninstall', '--hooks']);
    expect(again.stdout).toContain('No ccinfobar hooks in');
  });

  it('uninstall restores the pre-install bytes exactly and reports the hooks', () => {
    const s = sandbox();
    fs.mkdirSync(s.claude, { recursive: true });
    const before = '{\r\n    "model": "opus",\r\n    "hooks": {\r\n        "Stop": []\r\n    }\r\n}\r\n';
    fs.writeFileSync(s.settings, before);
    expect(s.run(['install', '--hooks', '--yes']).status).toBe(0);
    expect(Object.keys(s.read().hooks)).toHaveLength(7);
    const res = s.run(['uninstall']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`✓ Removed ccinfobar hooks: ${SEVEN.join(', ')}`);
    expect(fs.readFileSync(s.settings, 'utf8')).toBe(before);
    const m = JSON.parse(fs.readFileSync(s.manifest, 'utf8'));
    expect(m.entries.filter((e: { kind: string }) => e.kind === 'hook')).toEqual([]);
  });

  it('uninstall --project --hooks warns and leaves user hooks alone', () => {
    const s = sandbox();
    expect(s.run(['install', '--hooks', '--yes']).status).toBe(0);
    const res = s.run(['uninstall', '--project', '--hooks']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Hooks live in user settings only');
    expect(Object.keys(s.read().hooks)).toHaveLength(7);
  });

  it('install --progress adds the sync handlers once; uninstall --progress removes only them', () => {
    const s = sandbox('2.1.300 (Claude Code)');
    fs.mkdirSync(s.claude, { recursive: true });
    fs.writeFileSync(s.settings, JSON.stringify({ model: 'opus' }, null, 2));
    const dry = s.run(['install', '--progress', '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('  + StopFailure (progress): ccinfobar-test --progress hook StopFailure');
    expect(dry.stdout.split('\n').filter((l) => l.includes(' (progress): '))).toHaveLength(3);
    expect(JSON.parse(fs.readFileSync(s.settings, 'utf8'))).toEqual({ model: 'opus' });
    const res = s.run(['install', '--hooks', '--progress', '--yes']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('✓ Added the progress handlers for UserPromptSubmit, Stop, StopFailure');
    expect(res.stdout).toContain('terminalProgressBarEnabled');
    const backups = fs.readdirSync(path.join(s.config, 'backups')).filter((f) => /^settings-\d{8}T/.test(f));
    expect(backups).toHaveLength(1);
    const hooks = s.read().hooks as Record<string, unknown[]>;
    expect(commandsOf(hooks, 'Stop')).toEqual([
      'ccinfobar-test hook Stop',
      'ccinfobar-test --progress hook Stop',
    ]);
    expect(hooks.StopFailure).toEqual([
      { hooks: [{ type: 'command', command: 'ccinfobar-test --progress hook StopFailure', timeout: 5 }] },
    ]);
    expect(s.read().terminalProgressBarEnabled).toBeUndefined();
    const cfg = JSON.parse(fs.readFileSync(path.join(s.config, 'config.json'), 'utf8'));
    expect(cfg.progress.enabled).toBe(true);
    const off = s.run(['uninstall', '--progress']);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain('✓ Removed the progress handlers');
    expect(off.stdout).not.toContain('\u001b]9;4');
    const after = s.read();
    expect(after.model).toBe('opus');
    expect(after.statusLine.command).toBe('ccinfobar-test');
    expect(after.hooks.StopFailure).toBeUndefined();
    for (const e of SEVEN) expect(commandsOf(after.hooks, e)).toEqual([`ccinfobar-test hook ${e}`]);
    expect(JSON.parse(fs.readFileSync(path.join(s.config, 'config.json'), 'utf8')).progress.enabled).toBe(
      false,
    );
  });

  it('install --progress on an old Claude Code refuses and changes nothing', () => {
    const s = sandbox('2.1.100 (Claude Code)');
    expect(s.run(['install', '--yes']).status).toBe(0);
    const settings = fs.readFileSync(s.settings);
    const config = fs.readFileSync(path.join(s.config, 'config.json'));
    const res = s.run(['install', '--progress', '--yes']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Terminal progress needs Claude Code 2.1.141 or newer (found 2.1.100)');
    expect(fs.readFileSync(s.settings).equals(settings)).toBe(true);
    expect(fs.readFileSync(path.join(s.config, 'config.json')).equals(config)).toBe(true);
  });
});
