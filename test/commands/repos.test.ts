import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { computeDirty, runRepos } from '../../src/commands/repos.js';
import { configDir } from '../../src/core/paths.js';
import { dirtyFile, type RepoEntry, readDirty } from '../../src/data/repos.js';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const available = hasGit();
const posix = process.platform !== 'win32';
const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git'));

let base: string;
let home: string;
let gitEnv: NodeJS.ProcessEnv;
const saved: Record<string, string | undefined> = {};

function run(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: gitEnv,
  });
}

function repo(root: string, name: string, file: string, commit = true): string {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  run(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, file), 'one\n');
  if (commit) {
    run(d, 'add', '.');
    run(d, 'commit', '-q', '-m', 'init');
  }
  return d;
}

const entry = (name: string): RepoEntry => ({
  name,
  branch: 'main',
  detached: false,
  activity: null,
  hidden: false,
});

describe.skipIf(!available || tmpRepo)('repos dirty job', () => {
  let ws: string;
  let many: string;

  beforeAll(() => {
    base = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), 'ccib-dirty-')),
    );
    home = path.join(base, 'home');
    fs.mkdirSync(home);
    gitEnv = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    };
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) saved[k] = process.env[k];
    process.env.GIT_CONFIG_GLOBAL = gitEnv.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    ws = path.join(base, 'ws');
    const d = repo(ws, 'dirty', 'a.txt');
    fs.writeFileSync(path.join(d, 'u.txt'), 'new\n');
    repo(ws, 'clean', 'b.txt');
    many = path.join(base, 'many');
    for (let i = 0; i < 60; i++) repo(many, `r${String(i).padStart(2, '0')}`, 'x.txt', false);
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reports dirty and clean repos', () => {
    expect(computeDirty(ws, [entry('clean'), entry('dirty')], { harden: true, env: gitEnv })).toEqual({
      clean: false,
      dirty: true,
    });
  });

  it('ignores an inherited GIT_DIR and GIT_WORK_TREE', () => {
    const env = { ...gitEnv, GIT_DIR: path.join(ws, 'dirty', '.git'), GIT_WORK_TREE: path.join(ws, 'dirty') };
    expect(computeDirty(ws, [entry('clean'), entry('dirty')], { harden: true, env })).toEqual({
      clean: false,
      dirty: true,
    });
  });

  it.skipIf(!posix)('never runs a core.fsmonitor hook when hardened', () => {
    const d = repo(path.join(base, 'fs'), 'mon', 'a.txt');
    const marker = path.join(base, 'fsmonitor-marker');
    const hook = path.join(base, 'fsmon.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(hook, 0o755);
    run(d, 'config', 'core.fsmonitor', hook);
    fs.writeFileSync(path.join(d, 'a.txt'), 'two\n');
    expect(computeDirty(path.join(base, 'fs'), [entry('mon')], { harden: true, env: gitEnv })).toEqual({
      mon: true,
    });
    expect(fs.existsSync(marker)).toBe(false);
    computeDirty(path.join(base, 'fs'), [entry('mon')], { harden: false, env: gitEnv });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('checks at most 50 repos', () => {
    const names = fs.readdirSync(many).sort();
    const out = computeDirty(many, names.map(entry), { harden: true, env: gitEnv });
    expect(Object.keys(out)).toEqual(names.slice(0, 50));
    expect(Object.values(out).every((v) => v === true)).toBe(true);
  }, 60_000);

  it('leaves a timed out repo unknown', () => {
    const out = computeDirty(ws, [entry('dirty')], { harden: true, perRepoMs: 1, env: gitEnv });
    expect(out).toEqual({});
  });

  it('leaves a missing repo unknown', () => {
    expect(computeDirty(ws, [entry('gone')], { harden: true, env: gitEnv })).toEqual({});
  });

  describe('runRepos', () => {
    let cfg: string;
    beforeAll(() => {
      fs.mkdirSync(configDir(), { recursive: true });
      cfg = path.join(configDir(), 'repos-job.json');
      fs.writeFileSync(cfg, JSON.stringify({ lines: [[{ id: 'r', type: 'workspace-repos' }]] }));
    });

    it('writes the dirty cache and drops the lock', async () => {
      const lock = `${dirtyFile(ws)}.lock`;
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, '');
      await runRepos(parseArgs(['repos', '--background', ws]), cfg);
      const d = readDirty(ws);
      expect({ ...d?.dirty }).toEqual({ clean: false, dirty: true });
      expect(fs.existsSync(lock)).toBe(false);
      fs.rmSync(dirtyFile(ws));
    });

    it.skipIf(!posix)('runs git only in folders whose real name is the shown name', async () => {
      const w = path.join(base, 'bidi');
      repo(w, 'api', 'a.txt');
      const odd = repo(w, 'api\u202e', 'a.txt');
      fs.writeFileSync(path.join(odd, 'u.txt'), 'new\n');
      await runRepos(parseArgs(['repos', '--background', w]), cfg);
      expect({ ...readDirty(w)?.dirty }).toEqual({ api: false });
      fs.rmSync(dirtyFile(w));
    });

    it('writes nothing for a relative, missing or foreground path', async () => {
      // across drives on windows path.relative returns an absolute path
      const rel = path.isAbsolute(path.relative(process.cwd(), ws)) ? 'ws' : path.relative(process.cwd(), ws);
      await runRepos(parseArgs(['repos', '--background', rel]), cfg);
      await runRepos(parseArgs(['repos', '--background', path.join(base, 'missing')]), cfg);
      await runRepos(parseArgs(['repos', ws]), cfg);
      expect(fs.existsSync(dirtyFile(ws))).toBe(false);
      expect(fs.existsSync(dirtyFile(rel))).toBe(false);
      expect(fs.existsSync(dirtyFile(path.join(base, 'missing')))).toBe(false);
    });
  });
});
