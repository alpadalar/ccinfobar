import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeUpdateState } from '../../src/data/update-state.js';

const repo = path.resolve(__dirname, '../..');
const bin = path.join(repo, 'dist/ccinfobar.js');
const payload = fs.readFileSync(path.join(repo, 'test/fixtures/payload.json'), 'utf8');
const version = (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string })
  .version;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '').replace(/ /g, ' ');
const NOTICE = '⬆ ccinfobar 99.0.0 · brew upgrade ccinfobar';

let root = '';

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

// the built cli copied where homebrew puts it, temp dirs only
function layout() {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-brew-')));
  const pkg = path.join(
    root,
    'brew',
    'Cellar',
    'ccinfobar',
    version,
    'libexec',
    'lib',
    'node_modules',
    'ccinfobar',
  );
  fs.cpSync(path.join(repo, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(pkg, 'package.json'));
  const entry = path.join(pkg, 'dist', 'ccinfobar.js');
  const preload = path.join(root, 'no-network.mjs');
  fs.writeFileSync(preload, "globalThis.fetch = async () => { throw new Error('no network in tests'); };\n");
  const cache = path.join(root, 'cache');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    CCINFOBAR_CONFIG_DIR: path.join(root, 'config'),
    CCINFOBAR_CACHE_DIR: cache,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    CI: '',
    CCINFOBAR_NO_UPDATE: '',
    CCINFOBAR_CONFIG: '',
    CCINFOBAR_NO_USAGE_API: '1',
    CCINFOBAR_NO_JOBS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    LANG: 'C.UTF-8',
    LC_ALL: '',
  };
  return { entry, cache, env };
}

function linked(entry: string): string | null {
  const link = path.join(root, 'brew', 'bin', 'ccinfobar');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(entry, link);
  } catch {
    return null;
  }
  return link;
}

function doctor(file: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, [file, 'doctor'], { env, encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, out: strip(r.stdout ?? '') };
}

function render(file: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, [file], {
    input: payload,
    encoding: 'utf8',
    env: { ...env, COLUMNS: '200', NO_COLOR: '1', FORCE_COLOR: '' },
    timeout: 15_000,
  });
  const lines = strip(r.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim());
  return { status: r.status, last: lines.at(-1)?.trimEnd() ?? '' };
}

function expectBrew(file: string, cache: string, env: NodeJS.ProcessEnv) {
  const fresh = doctor(file, env);
  expect(fresh.status).toBe(0);
  expect(fresh.out).toContain(
    '✓ Up to date (auto mode, updates via brew upgrade ccinfobar (Homebrew install), not checked yet)',
  );
  expect(fresh.out).not.toContain('npm-global install');

  writeUpdateState({ checkedAt: Date.now(), latest: '99.0.0' }, { CCINFOBAR_CACHE_DIR: cache });
  const newer = doctor(file, env);
  expect(newer.status).toBe(0);
  expect(newer.out).toContain(`✗ Update available: ${version} → 99.0.0 (run \`brew upgrade ccinfobar\`)`);
  expect(newer.out).not.toContain('npm-global install');
  expect(newer.out).not.toContain('run `ccinfobar update`');

  const line = render(file, env);
  expect(line.status).toBe(0);
  expect(line.last.slice(-NOTICE.length)).toBe(NOTICE);
}

describe.skipIf(!fs.existsSync(bin))('built cli in a Homebrew Cellar layout', () => {
  it('doctor reports Homebrew and render shows the brew notice', () => {
    const { entry, cache, env } = layout();
    expectBrew(entry, cache, env);
  }, 60_000);

  it.skipIf(process.platform === 'win32')(
    'same results through the brew bin symlink',
    () => {
      const { entry, cache, env } = layout();
      const link = linked(entry);
      if (!link) return;
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expectBrew(link, cache, env);
    },
    60_000,
  );

  it('a plain npm layout still reports npm-global and ccinfobar update', () => {
    const { entry, cache, env } = layout();
    const npm = path.join(root, 'npm', 'lib', 'node_modules', 'ccinfobar');
    fs.cpSync(path.dirname(path.dirname(entry)), npm, { recursive: true });
    const file = path.join(npm, 'dist', 'ccinfobar.js');
    writeUpdateState({ checkedAt: Date.now(), latest: '99.0.0' }, { CCINFOBAR_CACHE_DIR: cache });
    const out = doctor(file, env).out;
    expect(out).toContain(`(run \`ccinfobar update\`)`);
    expect(out).not.toContain('brew upgrade');
    const line = render(file, { ...env, CCINFOBAR_CONFIG_DIR: path.join(root, 'npm-config') });
    expect(line.last).not.toContain('brew upgrade');
  }, 60_000);
});
