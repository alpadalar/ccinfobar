import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const npm = vi.hoisted(() => ({
  calls: [] as Array<[string, string | undefined]>,
  fail: { global: false, local: false },
  make: (_version: string, _prefix?: string) => {},
}));

vi.mock('../../src/data/update-state.js', async (orig) => ({
  ...(await orig<typeof import('../../src/data/update-state.js')>()),
  installKind: () => 'npx',
}));
vi.mock('../../src/data/self-update.js', async (orig) => ({
  ...(await orig<typeof import('../../src/data/self-update.js')>()),
  installVersion: (version: string, prefix?: string) => {
    npm.calls.push([version, prefix]);
    if (prefix ? npm.fail.local : npm.fail.global) throw new Error('EACCES: permission denied');
    npm.make(version, prefix);
  },
}));

const { binVersion, localBin, setupCommand } = await import('../../src/commands/install.js');
const { localPrefix } = await import('../../src/data/update-state.js');
const { withLang } = await import('../helpers.js');

const win = process.platform === 'win32';
let dir: string;
let prefix: string;
let binDir: string;
let prevPath: string | undefined;

function writePkg(root: string, version: string): string {
  const js = path.join(root, 'ccinfobar', 'dist', 'ccinfobar.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(root, 'ccinfobar', 'package.json'),
    JSON.stringify({ name: 'ccinfobar', version }),
  );
  return js;
}

// npm's global layout: posix symlink, windows .cmd shim
function globalCopy(version: string, at = prefix): string {
  if (win) {
    writePkg(path.join(at, 'node_modules'), version);
    const shim = path.join(at, 'ccinfobar.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');
    return shim;
  }
  const js = writePkg(path.join(at, 'lib', 'node_modules'), version);
  const bins = path.join(at, 'bin');
  const bin = path.join(bins, 'ccinfobar');
  fs.mkdirSync(bins, { recursive: true });
  fs.rmSync(bin, { force: true });
  fs.symlinkSync(path.relative(bins, js), bin);
  return bin;
}

function pinnedCopy(version: string, at: string): void {
  writePkg(path.join(at, 'node_modules'), version);
  fs.mkdirSync(path.dirname(localBin()), { recursive: true });
  fs.writeFileSync(localBin(), '#!/bin/sh\n', { mode: 0o755 });
}

const slash = (p: string) => p.replace(/\\/g, '/');

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-setup-')));
  prefix = path.join(dir, 'prefix');
  binDir = win ? prefix : path.join(prefix, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
  npm.calls = [];
  npm.fail = { global: false, local: false };
  npm.make = (version, at) => (at ? pinnedCopy(version, at) : globalCopy(version));
});

afterEach(() => {
  process.env.PATH = prevPath;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(path.dirname(path.dirname(localBin()))), { recursive: true, force: true });
});

describe('setupCommand under npx', () => {
  it('reads the version of a global copy', () => {
    expect(binVersion(globalCopy('0.6.2'))).toBe('0.6.2');
    expect(binVersion(path.join(dir, 'missing'))).toBeNull();
  });

  it('updates an older global copy instead of pointing Claude Code at it', () => {
    const bin = globalCopy('0.6.2');
    const log: string[] = [];
    const res = setupCommand('9.9.9', { log: (l) => log.push(l) });
    expect(npm.calls).toEqual([['9.9.9', undefined]]);
    expect(binVersion(bin)).toBe('9.9.9');
    expect(slash(res.command ?? '')).toContain(slash(prefix));
    expect(res.onPath).toBe(true);
    expect(log[0]).toBe('Updating the global ccinfobar 0.6.2 to 9.9.9 ...');
  });

  it('points at the new copy when an older one earlier on PATH shadows it', () => {
    globalCopy('0.6.2');
    const npmPrefix = path.join(dir, 'npm-prefix');
    vi.stubEnv('npm_config_prefix', npmPrefix);
    npm.make = (version) => void globalCopy(version, npmPrefix);
    try {
      const res = setupCommand('9.9.9');
      expect(npm.calls).toEqual([['9.9.9', undefined]]);
      expect(slash(res.command ?? '')).toContain(slash(npmPrefix));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps a global copy that is as new or newer', () => {
    globalCopy('9.9.9');
    expect(slash(setupCommand('9.9.9').command ?? '')).toContain(slash(prefix));
    globalCopy('10.0.0');
    expect(slash(setupCommand('9.9.9').command ?? '')).toContain(slash(prefix));
    expect(npm.calls).toEqual([]);
  });

  it('skips an older global copy with --no-global and says how to fix it', () => {
    globalCopy('0.6.2');
    const run = () => {
      const log: string[] = [];
      const res = setupCommand('9.9.9', { global: false, log: (l) => log.push(l) });
      return { res, log };
    };
    const { res, log } = run();
    expect(npm.calls).toEqual([['9.9.9', localPrefix()]]);
    expect(slash(res.command ?? '')).not.toContain(slash(prefix));
    expect(res.onPath).toBe(false);
    expect(log[0]).toBe(
      '⚠ The global ccinfobar 0.6.2 is older than 9.9.9 and is not used; update it with `npm install -g ccinfobar@latest` or remove it with `npm rm -g ccinfobar`',
    );
    expect(withLang('tr', run).log[0]).toBe(
      '⚠ Global ccinfobar 0.6.2, 9.9.9 sürümünden eski ve kullanılmıyor; `npm install -g ccinfobar@latest` ile güncelleyin ya da `npm rm -g ccinfobar` ile kaldırın',
    );
  });

  it('never reuses an older global copy with --no-global', () => {
    globalCopy('0.6.2');
    npm.fail.local = true;
    expect(setupCommand('9.9.9', { global: false }).command).toBeNull();
    expect(npm.calls).toEqual([['9.9.9', localPrefix()]]);
  });

  it('keeps a current global copy with --no-global', () => {
    globalCopy('9.9.9');
    expect(slash(setupCommand('9.9.9', { global: false }).command ?? '')).toContain(slash(prefix));
    expect(npm.calls).toEqual([]);
  });

  it('falls back to a pinned copy when the update fails', () => {
    globalCopy('0.6.2');
    npm.fail.global = true;
    const log: string[] = [];
    const res = setupCommand('9.9.9', { log: (l) => log.push(l) });
    expect(npm.calls.map((c) => c[1] !== undefined)).toEqual([false, true]);
    expect(slash(res.command ?? '')).not.toContain(slash(prefix));
    expect(res.onPath).toBe(false);
    expect(log.join('\n')).toContain('Could not update the global ccinfobar 0.6.2');
  });

  it('uses the older global copy when nothing else installs', () => {
    globalCopy('0.6.2');
    npm.fail = { global: true, local: true };
    const res = setupCommand('9.9.9');
    expect(slash(res.command ?? '')).toContain(slash(prefix));
    expect(res.onPath).toBe(true);
  });

  it('logs the update and the pinned fallback in English and Turkish', () => {
    globalCopy('0.6.2');
    npm.fail.global = true;
    const run = () => {
      const log: string[] = [];
      setupCommand('9.9.9', { log: (l) => log.push(l) });
      return log;
    };
    expect(run()).toEqual([
      'Updating the global ccinfobar 0.6.2 to 9.9.9 ...',
      "⚠ Could not update the global ccinfobar 0.6.2: no permission to write to npm's global folder (EACCES)",
      `Installing a pinned copy of ccinfobar 9.9.9 in ${localPrefix()} ...`,
      `✓ Installed ${localBin()}`,
    ]);
    fs.rmSync(path.dirname(path.dirname(path.dirname(localBin()))), { recursive: true, force: true });
    expect(withLang('tr', run)).toEqual([
      'Global ccinfobar 0.6.2 sürümünden 9.9.9 sürümüne güncelleniyor ...',
      "⚠ Global ccinfobar 0.6.2 güncellenemedi: npm'in global klasörüne yazma izni yok (EACCES)",
      `ccinfobar 9.9.9 sürümünün sabit bir kopyası ${localPrefix()} klasörüne kuruluyor ...`,
      `✓ Kuruldu: ${localBin()}`,
    ]);
  });

  it('logs a fresh global install in English and Turkish', () => {
    // no ccinfobar from the machine on PATH
    if (!win) process.env.PATH = [binDir, '/usr/bin', '/bin'].join(path.delimiter);
    const run = () => {
      const log: string[] = [];
      setupCommand('9.9.9', { log: (l) => log.push(l) });
      fs.rmSync(prefix, { recursive: true, force: true });
      fs.mkdirSync(binDir, { recursive: true });
      return log;
    };
    const bin = path.join(binDir, win ? 'ccinfobar.cmd' : 'ccinfobar');
    expect(run()).toEqual([
      'Installing ccinfobar 9.9.9 globally (skip with --no-global) ...',
      `✓ Installed ${bin}`,
    ]);
    expect(withLang('tr', run)).toEqual([
      'ccinfobar 9.9.9 global olarak kuruluyor (atlamak için --no-global) ...',
      `✓ Kuruldu: ${bin}`,
    ]);
  });
});
