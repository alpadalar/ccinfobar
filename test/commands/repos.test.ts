import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { computeDirty, dirtyOrder, runRepos } from '../../src/commands/repos.js';
import { defaultConfig } from '../../src/core/config.js';
import { configDir } from '../../src/core/paths.js';
import type { Config, WidgetItem } from '../../src/core/types.js';
import { JOBS } from '../../src/data/jobs/index.js';
import { envelopeFile, lockFile } from '../../src/data/jobs/runner.js';
import { legacyDirtyFile, type RepoEntry, readDirty, reposKey } from '../../src/data/repos.js';

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

describe('dirtyOrder', () => {
  const repos = Array.from({ length: 60 }, (_, i) => ({
    ...entry(`r${String(i).padStart(2, '0')}`),
    activity: i,
    hidden: i === 59,
  }));
  const cfg = (...items: WidgetItem['options'][]): Config => ({
    ...defaultConfig(),
    lines: [items.map((options, i) => ({ id: `w${i}`, type: 'workspace-repos', options }))],
  });

  it('checks the repos each item shows first', () => {
    const names = (c: Config) => dirtyOrder(repos, c).map((r) => r.name);
    expect(names(cfg({ sort: 'recent', maxRepos: 3 })).slice(0, 3)).toEqual(['r58', 'r57', 'r56']);
    expect(names(cfg({ sort: 'recent', maxRepos: 2, includeHidden: true })).slice(0, 2)).toEqual([
      'r59',
      'r58',
    ]);
    expect(names(cfg({})).slice(0, 2)).toEqual(['r00', 'r01']);
    const all = names(cfg({ sort: 'recent', maxRepos: 3 }));
    expect(all).toHaveLength(60);
    expect(all[all.length - 1]).toBe('r59');
  });
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

  it('reports dirty and clean repos', async () => {
    expect(await computeDirty(ws, [entry('clean'), entry('dirty')], { harden: true, env: gitEnv })).toEqual({
      clean: false,
      dirty: true,
    });
  });

  it('ignores an inherited GIT_DIR and GIT_WORK_TREE', async () => {
    const env = { ...gitEnv, GIT_DIR: path.join(ws, 'dirty', '.git'), GIT_WORK_TREE: path.join(ws, 'dirty') };
    expect(await computeDirty(ws, [entry('clean'), entry('dirty')], { harden: true, env })).toEqual({
      clean: false,
      dirty: true,
    });
  });

  it.skipIf(!posix)('never runs a core.fsmonitor hook when hardened', async () => {
    const d = repo(path.join(base, 'fs'), 'mon', 'a.txt');
    const marker = path.join(base, 'fsmonitor-marker');
    const hook = path.join(base, 'fsmon.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(hook, 0o755);
    run(d, 'config', 'core.fsmonitor', hook);
    fs.writeFileSync(path.join(d, 'a.txt'), 'two\n');
    expect(await computeDirty(path.join(base, 'fs'), [entry('mon')], { harden: true, env: gitEnv })).toEqual({
      mon: true,
    });
    expect(fs.existsSync(marker)).toBe(false);
    await computeDirty(path.join(base, 'fs'), [entry('mon')], { harden: false, env: gitEnv });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('checks at most 50 repos', async () => {
    const names = fs.readdirSync(many).sort();
    const out = await computeDirty(many, names.map(entry), {
      harden: true,
      perRepoMs: 30_000,
      budgetMs: 55_000,
      env: gitEnv,
    });
    expect(Object.keys(out)).toEqual(names.slice(0, 50));
    expect(Object.values(out).every((v) => v === true)).toBe(true);
  }, 60_000);

  it('leaves a timed out repo unknown', async () => {
    const out = await computeDirty(ws, [entry('dirty')], { harden: true, perRepoMs: 1, env: gitEnv });
    expect(out).toEqual({});
  });

  it('leaves a missing repo unknown', async () => {
    expect(await computeDirty(ws, [entry('gone')], { harden: true, env: gitEnv })).toEqual({});
  });

  describe('runRepos', () => {
    let cfg: string;
    beforeAll(() => {
      fs.mkdirSync(configDir(), { recursive: true });
      cfg = path.join(configDir(), 'repos-job.json');
      fs.writeFileSync(
        cfg,
        JSON.stringify({ lines: [[{ id: 'r', type: 'workspace-repos', options: { dirty: true } }]] }),
      );
    });

    it('runs the job, writes the envelope and drops both locks', async () => {
      const lock = lockFile(reposKey(ws));
      const old = `${legacyDirtyFile(ws)}.lock`;
      for (const f of [lock, old]) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '');
      }
      await runRepos(parseArgs(['repos', '--background', ws]), cfg, JOBS);
      const d = readDirty(ws);
      expect({ ...d?.dirty }).toEqual({ clean: false, dirty: true });
      expect(fs.existsSync(envelopeFile(reposKey(ws)))).toBe(true);
      expect(fs.existsSync(legacyDirtyFile(ws))).toBe(false);
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(old)).toBe(false);
      fs.rmSync(envelopeFile(reposKey(ws)));
    });

    it('writes nothing when no item wants the dirty marker', async () => {
      const off = path.join(configDir(), 'repos-off.json');
      fs.writeFileSync(off, JSON.stringify({ lines: [[{ id: 'r', type: 'workspace-repos' }]] }));
      await runRepos(parseArgs(['repos', '--background', ws]), off, JOBS);
      expect(fs.existsSync(envelopeFile(reposKey(ws)))).toBe(false);
      expect(fs.existsSync(lockFile(reposKey(ws)))).toBe(false);
    });

    it.skipIf(!posix)('runs git only in folders whose real name is the shown name', async () => {
      const w = path.join(base, 'bidi');
      repo(w, 'api', 'a.txt');
      const odd = repo(w, 'api\u202e', 'a.txt');
      fs.writeFileSync(path.join(odd, 'u.txt'), 'new\n');
      await runRepos(parseArgs(['repos', '--background', w]), cfg, JOBS);
      expect({ ...readDirty(w)?.dirty }).toEqual({ api: false });
      fs.rmSync(envelopeFile(reposKey(w)));
    });

    it('writes nothing for a relative, missing or foreground path', async () => {
      // across drives on windows path.relative returns an absolute path
      const rel = path.isAbsolute(path.relative(process.cwd(), ws)) ? 'ws' : path.relative(process.cwd(), ws);
      await runRepos(parseArgs(['repos', '--background', rel]), cfg, JOBS);
      await runRepos(parseArgs(['repos', '--background', path.join(base, 'missing')]), cfg, JOBS);
      await runRepos(parseArgs(['repos', ws]), cfg, JOBS);
      for (const p of [ws, path.resolve(rel), path.join(base, 'missing')]) {
        expect(fs.existsSync(envelopeFile(reposKey(p)))).toBe(false);
        expect(fs.existsSync(legacyDirtyFile(p))).toBe(false);
      }
    });
  });
});
