import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCommand } from '../../src/commands/command.js';
import { defaultCommand } from '../../src/commands/install.js';

let root: string;
let cellarJs: string;
let brewBin: string;
let optBin: string;
let npmJs: string;

const binCommand = (bin: string, onPath = true) => {
  const built = buildCommand({ kind: 'bin', bin, onPath });
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
  npmJs = path.join(root, 'brew', 'lib', 'node_modules', 'ccinfobar', 'dist', 'ccinfobar.js');
  fs.mkdirSync(path.dirname(npmJs), { recursive: true });
  fs.writeFileSync(npmJs, '');
  brewBin = path.join(root, 'brew', 'bin', 'ccinfobar');
  optBin = path.join(root, 'brew', 'opt', 'ccinfobar', 'bin', 'ccinfobar');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const place = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
};

// symlinks need privileges on Windows, so the links are mapped
const links = (map: Record<string, string>) => (p: string) => map[p] ?? fs.realpathSync(p);

describe('brew install target', () => {
  it('uses the stable bin symlink of the brew prefix', () => {
    place(brewBin);
    const realpath = links({ [brewBin]: cellarJs });
    const got = defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => null, realpath });
    expect(got).toBe(binCommand(brewBin));
    safe(got);
  });

  it('follows a real prefix symlink into the keg', () => {
    fs.mkdirSync(path.dirname(brewBin), { recursive: true });
    try {
      fs.symlinkSync(cellarJs, brewBin);
    } catch {
      return;
    }
    const got = defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => null });
    expect(got).toBe(binCommand(brewBin));
  });

  it('prefers the brew bin over an earlier npm-global copy on PATH', () => {
    place(brewBin);
    const realpath = links({ [brewBin]: cellarJs });
    const got = defaultCommand('brew', undefined, {
      entry: cellarJs,
      globalBinary: () => '/home/u/.npm-global/bin/ccinfobar',
      realpath,
    });
    expect(got).toBe(binCommand(brewBin));
    safe(got);
  });

  it('skips a prefix bin owned by an npm-global copy', () => {
    place(brewBin);
    const realpath = links({ [brewBin]: npmJs });
    const deps = { entry: cellarJs, globalBinary: () => brewBin, realpath };
    expect(defaultCommand('brew', undefined, deps)).toBeNull();
    place(optBin);
    const withOpt = links({ [brewBin]: npmJs, [optBin]: cellarJs });
    const got = defaultCommand('brew', undefined, { ...deps, realpath: withOpt });
    expect(got).toBe(binCommand(optBin, false));
    safe(got);
  });

  it('uses the opt link of an unlinked keg', () => {
    place(optBin);
    const realpath = links({ [optBin]: cellarJs });
    const got = defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => null, realpath });
    expect(got).toBe(binCommand(optBin, false));
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

  it('falls back to a stable PATH hit that links into the keg', () => {
    const hit = path.join(root, 'elsewhere', 'bin', 'ccinfobar');
    place(hit);
    const realpath = links({ [hit]: cellarJs });
    const got = defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => hit, realpath });
    expect(got).toBe(binCommand(hit));
    safe(got);
  });

  it('refuses a PATH hit that is another copy', () => {
    const hit = path.join(root, 'npm-global', 'bin', 'ccinfobar');
    place(hit);
    const realpath = links({ [hit]: npmJs });
    expect(
      defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => hit, realpath }),
    ).toBeNull();
    const gone = '/home/u/.npm-global/bin/ccinfobar';
    expect(defaultCommand('brew', undefined, { entry: cellarJs, globalBinary: () => gone })).toBeNull();
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
