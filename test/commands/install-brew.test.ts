import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCommand } from '../../src/commands/command.js';
import { defaultCommand } from '../../src/commands/install.js';

let root: string;
let cellarJs: string;
let brewBin: string;

const binCommand = (bin: string) => {
  const built = buildCommand({ kind: 'bin', bin, onPath: true });
  return built.ok ? built.command : null;
};

const safe = (command: string | null) => {
  if (command === null) return;
  expect(command.replace(/\\/g, '/')).not.toContain('/Cellar/');
  expect(command).not.toContain(process.execPath);
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-install-brew-')));
  const pkg = path.join(root, 'brew', 'Cellar', 'ccinfobar', '9.9.9', 'libexec', 'lib', 'node_modules');
  cellarJs = path.join(pkg, 'ccinfobar', 'dist', 'ccinfobar.js');
  fs.mkdirSync(path.dirname(cellarJs), { recursive: true });
  fs.writeFileSync(cellarJs, '');
  brewBin = path.join(root, 'brew', 'bin', 'ccinfobar');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const withBin = () => {
  fs.mkdirSync(path.dirname(brewBin), { recursive: true });
  fs.writeFileSync(brewBin, '');
};

describe('brew install target', () => {
  it('uses the stable bin symlink of the brew prefix', () => {
    withBin();
    const got = defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => null });
    expect(got).toBe(binCommand(brewBin));
    safe(got);
  });

  it('prefers the brew bin over an earlier npm-global copy on PATH', () => {
    withBin();
    const got = defaultCommand('brew', undefined, {
      entry: cellarJs,
      globalBinary: () => '/home/u/.npm-global/bin/ccinfobar',
    });
    expect(got).toBe(binCommand(brewBin));
    safe(got);
  });

  it('returns null without a brew bin or a PATH hit', () => {
    expect(defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => null })).toBeNull();
  });

  it('refuses a versioned Cellar path from PATH', () => {
    const cellar = '/opt/homebrew/Cellar/ccinfobar/9.9.9/bin/ccinfobar';
    expect(defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => cellar })).toBeNull();
    const win = 'C:\\brew\\Cellar\\ccinfobar\\9.9.9\\bin\\ccinfobar';
    expect(defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => win })).toBeNull();
  });

  it('falls back to a stable PATH hit', () => {
    const hit = '/home/linuxbrew/.linuxbrew/bin/ccinfobar';
    const got = defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => hit });
    expect(got).toBe(binCommand(hit));
    safe(got);
  });

  it('never writes the script target or the node path for brew', () => {
    const exists = () => false;
    const got = defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => null, exists });
    expect(got).toBeNull();
    const all = [
      defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => null, exists: () => true }),
      defaultCommand('brew', undefined, { entry: '/nowhere/ccinfobar.js', globalBinary: () => null }),
    ];
    for (const c of all) safe(c);
  });

  it('keeps the source fallback for other kinds', () => {
    const entry = path.resolve(process.argv[1] ?? '');
    const want = buildCommand({ kind: 'script', script: entry });
    expect(defaultCommand('source', undefined, { globalBinary: () => null })).toBe(
      want.ok ? want.command : null,
    );
    expect(defaultCommand('source', undefined, { entry: cellarJs, globalBinary: () => null })).toBe(
      (() => {
        const w = buildCommand({ kind: 'script', script: cellarJs });
        return w.ok ? w.command : null;
      })(),
    );
  });

  it('keeps the PATH hit first for npm-global even under a brew node', () => {
    const hit = '/opt/homebrew/Cellar/node/22.0.0/bin/ccinfobar';
    expect(defaultCommand('npm-global', undefined, { globalBinary: () => hit })).toBe(binCommand(hit));
  });
});
