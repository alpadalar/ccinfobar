import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HARDEN, scrubGitEnv } from '../../src/data/git.js';
import { installKind, localPrefix } from '../../src/data/update-state.js';

const root = path.resolve(__dirname, '../..');
const gitSrc = fs.readFileSync(path.join(root, 'src', 'data', 'git.ts'), 'utf8');

let probe: any;
beforeAll(async () => {
  probe = await import(pathToFileURL(path.join(root, 'scripts', 'startup-probe.mjs')).href);
});

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const touch = (file: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
};

describe('startup-probe copies of src', () => {
  it('uses the git hardening flags and config regexp of git.ts', () => {
    expect(probe.HARDEN).toEqual([...HARDEN]);
    const scoped = /const SCOPED_RE = ('[^']+');/.exec(gitSrc)?.[1];
    expect(scoped).toBeDefined();
    expect(`'${probe.SCOPED_RE.replace(/\\/g, '\\\\')}'`).toBe(scoped);
  });

  it('times the git argv the render runs', () => {
    for (const [name, args] of Object.entries(probe.GIT_CMDS as Record<string, string[]>)) {
      if (name === 'git --version') continue;
      expect(args.slice(0, HARDEN.length), name).toEqual([...HARDEN]);
      const rest = args.slice(HARDEN.length).filter((a) => a !== probe.SCOPED_RE);
      const lead = rest
        .slice(0, 3)
        .map((a) => `'${a}'`)
        .join(', ');
      expect(gitSrc, name).toContain(lead);
      for (const a of rest) expect(gitSrc, `${name} ${a}`).toContain(`'${a}'`);
    }
  });

  it('scrubs the git env like scrubGitEnv', () => {
    const env = {
      PATH: '/bin',
      GIT_DIR: '/x/.git',
      git_work_tree: '/x',
      GIT_INDEX_FILE: 'i',
      GIT_OBJECT_DIRECTORY: 'o',
      GIT_COMMON_DIR: 'c',
      GIT_NAMESPACE: 'n',
      GIT_AUTHOR_NAME: 'kept',
    };
    expect(probe.scrubGitEnvLike(env)).toEqual(scrubGitEnv(env));
  });

  it('classifies install kinds like installKind', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-probe-kind-')));
    tmps.push(dir);
    const tail = path.join('node_modules', 'ccinfobar', 'dist', 'ccinfobar.js');
    const checkout = path.join(dir, 'src-copy');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    const entries = [
      touch(path.join(dir, 'brew', 'Cellar', 'ccinfobar', '1.0.0', 'libexec', 'lib', tail)),
      touch(path.join(dir, 'npm', 'lib', tail)),
      touch(path.join(dir, '_npx', 'abc', tail)),
      touch(path.join(checkout, 'dist', 'ccinfobar.js')),
      touch(path.join(dir, 'other', 'dist', 'ccinfobar.js')),
      path.join(localPrefix(), tail),
      path.join(dir, 'missing.js'),
    ];
    const kinds = entries.map((e) => installKind(e));
    expect(new Set(kinds).size).toBeGreaterThanOrEqual(5);
    for (const e of entries) expect(probe.installKindLike(e, localPrefix()), e).toBe(installKind(e));
  });
});
