import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => [] as string[]);

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: ((file: string, ...rest: unknown[]) => {
      files.push(file);
      return (real.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof real.execFileSync,
    execFile: ((file: string, ...rest: unknown[]) => {
      files.push(file);
      return (real.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof real.execFile,
  };
});

const { readGit } = await import('../../src/data/git.js');
const { readJj } = await import('../../src/data/jj.js');
const { binary, resetWhich } = await import('../../src/data/which.js');

// each planted exe is a copy of node.exe (~100 MB), so setup is slow on Windows
describe.runIf(process.platform === 'win32')('planted git.exe and jj.exe in a repository', () => {
  let repo: string;
  let marker: string;
  const prevOptions = process.env.NODE_OPTIONS;

  beforeAll(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-which-win-')));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
    git('init');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@t');
    git('config', 'commit.gpgsign', 'false');
    git('commit', '--allow-empty', '-m', 'init');
    fs.copyFileSync(process.execPath, path.join(repo, 'git.exe'));
    fs.copyFileSync(process.execPath, path.join(repo, 'jj.exe'));
    fs.mkdirSync(path.join(repo, '.jj'));
    marker = path.join(repo, 'marker.cjs');
    fs.writeFileSync(
      marker,
      "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran.txt'), 'x');\n",
    );
    process.env.NODE_OPTIONS = `--require ${marker}`;
  });

  afterAll(() => {
    if (prevOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = prevOptions;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetWhich();
    files.length = 0;
  });

  it('runs git from an absolute PATH entry only', () => {
    const bin = binary('git');
    expect(bin, `PATH=${process.env.PATH}`).toMatch(/^[A-Za-z]:\\/);
    files.length = 0;
    const info = readGit(repo);
    expect(info?.branch).toBeTruthy();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(path.win32.isAbsolute(f)).toBe(true);
      expect(f.toLowerCase().startsWith(repo.toLowerCase())).toBe(false);
    }
    expect(fs.existsSync(path.join(repo, 'ran.txt'))).toBe(false);
  });

  it('never runs the planted jj.exe', () => {
    expect(binary('jj')).toBeNull();
    files.length = 0;
    expect(readJj(repo)!.change()).toBeNull();
    expect(files.some((f) => f.toLowerCase().endsWith('jj.exe'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'ran.txt'))).toBe(false);
  });
});
