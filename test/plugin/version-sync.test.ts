import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts', 'sync-plugin-version.mjs');
const pluginRel = path.join('plugin', '.claude-plugin', 'plugin.json');
const pkgText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgText);
const version: string = pkg.version;
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

const installPath = path.join(root, 'INSTALL.md');
const readInstall = () => fs.readFileSync(installPath, 'utf8');
const readmePath = path.join(root, 'README.md');
const README_PIN = 'alpadalar/ccinfobar#v';
const FLOOR = '0.6.2';
const GATE = `needs a ccinfobar release newer than ${FLOOR}`;

function pins(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1]!);
}

const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempCopy(pkgVersion: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-sync-'));
  tmps.push(dir);
  fs.mkdirSync(path.join(dir, 'plugin', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    pkgText.replace(`"version": "${version}"`, `"version": "${pkgVersion}"`),
  );
  fs.copyFileSync(path.join(root, pluginRel), path.join(dir, pluginRel));
  fs.copyFileSync(installPath, path.join(dir, 'INSTALL.md'));
  fs.copyFileSync(readmePath, path.join(dir, 'README.md'));
  return dir;
}

describe('INSTALL.md', () => {
  it('pins every ccinfobar@, /blob/v and #v reference to the package.json version', () => {
    const text = readInstall();
    const npm = pins(text, new RegExp(`ccinfobar@(${SEMVER})`, 'g'));
    const blob = pins(text, new RegExp(`/blob/v(${SEMVER})/`, 'g'));
    const tag = pins(text, new RegExp(`#v(${SEMVER})`, 'g'));
    expect(npm.length).toBeGreaterThan(0);
    expect(blob.length).toBeGreaterThan(0);
    for (const v of [...npm, ...blob, ...tag]) expect(v).toBe(version);
    expect(text).not.toMatch(/ccinfobar@latest/);
  });

  it('covers the runbook steps and rules', () => {
    const text = readInstall();
    for (const s of ['node --version', 'install --dry-run', 'install --yes', 'init', 'ccinfobar preview'])
      expect(text).toContain(s);
    expect(text).toContain('install --hooks');
    expect(text).toMatch(/sudo/);
    expect(text).toMatch(/curl/);
  });

  it('gates on the version before the first install command', () => {
    const text = readInstall();
    const gate = text.indexOf(`ccinfobar@${version} --version`);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(text.indexOf('install --dry-run'));
    expect(text).toContain(`${FLOOR} or lower`);
    expect(text).toContain(GATE);
  });
});

describe('README.md', () => {
  it('pins the plugin marketplace tag to the package.json version', () => {
    const tags = pins(fs.readFileSync(readmePath, 'utf8'), new RegExp(`${README_PIN}(${SEMVER})`, 'g'));
    expect(tags.length).toBeGreaterThan(0);
    for (const v of tags) expect(v).toBe(version);
  });
});

describe('scripts/sync-plugin-version.mjs', () => {
  it('rewrites plugin.json and INSTALL.md on a temp copy, then is a no-op', () => {
    const dir = tempCopy('9.9.9');
    const pluginBefore = fs.readFileSync(path.join(dir, pluginRel), 'utf8');
    const installBefore = fs.readFileSync(path.join(dir, 'INSTALL.md'), 'utf8');
    const readmeBefore = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');

    expect(run(['--root', dir, '--check']).status).toBe(1);
    expect(fs.readFileSync(path.join(dir, pluginRel), 'utf8')).toBe(pluginBefore);

    const first = run(['--root', dir]);
    expect(first.status, first.stderr).toBe(0);
    const pluginAfter = fs.readFileSync(path.join(dir, pluginRel), 'utf8');
    const installAfter = fs.readFileSync(path.join(dir, 'INSTALL.md'), 'utf8');
    expect(JSON.parse(pluginAfter).version).toBe('9.9.9');
    expect(pluginAfter).toBe(pluginBefore.replace(`"version": "${version}"`, '"version": "9.9.9"'));
    expect(installAfter).toBe(
      installBefore
        .replaceAll(`ccinfobar@${version}`, 'ccinfobar@9.9.9')
        .replaceAll(`/blob/v${version}/`, '/blob/v9.9.9/')
        .replaceAll(`#v${version}`, '#v9.9.9'),
    );
    expect(installAfter.replaceAll(FLOOR, '')).not.toContain(version);
    expect(installAfter).toContain(GATE);
    const readmeAfter = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    expect(readmeAfter).toBe(readmeBefore.replaceAll(`${README_PIN}${version}`, `${README_PIN}9.9.9`));
    expect(first.stdout).toContain('README.md');
    expect(first.stdout).toContain('INSTALL.md');

    const second = run(['--root', dir]);
    expect(second.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, pluginRel), 'utf8')).toBe(pluginAfter);
    expect(fs.readFileSync(path.join(dir, 'INSTALL.md'), 'utf8')).toBe(installAfter);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe(readmeAfter);

    expect(run(['--root', dir, '--check']).status).toBe(0);
  });

  it('exits 1 with a message when a file is missing', () => {
    const dir = tempCopy('9.9.9');
    fs.rmSync(path.join(dir, 'INSTALL.md'));
    const r = run(['--root', dir, '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('INSTALL.md');
  });

  it('--check on a release tag fails when the tag lacks the pinned files', () => {
    const dir = tempCopy('9.9.9');
    expect(run(['--root', dir]).status).toBe(0);
    const git = (...a: string[]) =>
      spawnSync(
        'git',
        ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a],
        {
          encoding: 'utf8',
        },
      );
    expect(git('init', '-q').status).toBe(0);
    git('add', '.');
    git('commit', '-qm', 'a');
    expect(run(['--root', dir, '--check']).status).toBe(0);
    git('tag', 'v9.9.9');
    const r = run(['--root', dir, '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.claude-plugin/marketplace.json');
    fs.mkdirSync(path.join(dir, '.claude-plugin'));
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), '{}\n');
    git('add', '.');
    git('commit', '-qm', 'b');
    git('tag', '-f', 'v9.9.9');
    const ok = run(['--root', dir, '--check']);
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('--check passes on the repo', () => {
    const r = run(['--check']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe('package.json', () => {
  it('runs the sync from the npm version lifecycle and never depends on claude-code', () => {
    expect(pkg.scripts.version).toContain('sync-plugin-version');
    expect(pkg.scripts.version).toContain('README.md');
    expect(pkgText).not.toContain('@anthropic-ai/claude-code');
  });
});
