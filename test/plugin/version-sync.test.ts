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
});

describe('scripts/sync-plugin-version.mjs', () => {
  it('rewrites plugin.json and INSTALL.md on a temp copy, then is a no-op', () => {
    const dir = tempCopy('9.9.9');
    const pluginBefore = fs.readFileSync(path.join(dir, pluginRel), 'utf8');
    const installBefore = fs.readFileSync(path.join(dir, 'INSTALL.md'), 'utf8');

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
    expect(installAfter).not.toContain(version);
    expect(first.stdout).toContain('INSTALL.md');

    const second = run(['--root', dir]);
    expect(second.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, pluginRel), 'utf8')).toBe(pluginAfter);
    expect(fs.readFileSync(path.join(dir, 'INSTALL.md'), 'utf8')).toBe(installAfter);

    expect(run(['--root', dir, '--check']).status).toBe(0);
  });

  it('exits 1 with a message when a file is missing', () => {
    const dir = tempCopy('9.9.9');
    fs.rmSync(path.join(dir, 'INSTALL.md'));
    const r = run(['--root', dir, '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('INSTALL.md');
  });

  it('--check passes on the repo', () => {
    const r = run(['--check']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe('package.json', () => {
  it('runs the sync from the npm version lifecycle and never depends on claude-code', () => {
    expect(pkg.scripts.version).toContain('sync-plugin-version');
    expect(pkgText).not.toContain('@anthropic-ai/claude-code');
  });
});
