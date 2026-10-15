import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts', 'homebrew-formula.mjs');
const formulaRel = path.join('packaging', 'homebrew', 'ccinfobar.rb');
const formulaText = fs.readFileSync(path.join(root, formulaRel), 'utf8');
const SHA = 'ab'.repeat(32);

let mod: any;
beforeAll(async () => {
  mod = await import(pathToFileURL(script).href);
});

const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

const tmps: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempCopy(text = formulaText): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-brew-'));
  tmps.push(dir);
  fs.mkdirSync(path.join(dir, 'packaging', 'homebrew'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
  fs.writeFileSync(path.join(dir, formulaRel), text);
  return dir;
}

const readCopy = (dir: string) => fs.readFileSync(path.join(dir, formulaRel), 'utf8');

describe('checkFormula', () => {
  it('accepts the committed formula', () => {
    expect(mod.checkFormula(formulaText)).toEqual([]);
  });

  it('carries the package.json version and a placeholder sha256', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(formulaText).toContain(`/ccinfobar-${version}.tgz"`);
    expect(formulaText).toContain(`  sha256 "${'0'.repeat(64)}"`);
  });

  it('never installs settings from the formula', () => {
    expect(formulaText).not.toContain('post_install');
    expect(formulaText).toContain('ccinfobar install');
    expect(formulaText).toContain('ccinfobar uninstall');
    for (const env of [
      'CCINFOBAR_CONFIG_DIR',
      'CCINFOBAR_CACHE_DIR',
      'CLAUDE_CONFIG_DIR',
      'CCINFOBAR_NO_UPDATE',
    ])
      expect(formulaText).toContain(`ENV["${env}"]`);
  });

  it('reports a post_install, a missing node dependency and a non-registry url', () => {
    const post = formulaText.replace('  def caveats', '  def post_install\n  end\n\n  def caveats');
    const noNode = formulaText.replace('  depends_on "node"\n', '');
    const github = formulaText.replace(
      /https:\/\/registry\.npmjs\.org\/ccinfobar\/-\/ccinfobar-[^"]+\.tgz/,
      'https://github.com/alpadalar/ccinfobar/archive/v1.0.0.tar.gz',
    );
    const selfInstall = formulaText.replace(
      '    bin.install_symlink',
      '    system "#{bin}/ccinfobar", "install"\n    bin.install_symlink',
    );
    for (const bad of [post, noNode, github, selfInstall]) {
      expect(bad).not.toBe(formulaText);
      expect(mod.checkFormula(bad).length).toBeGreaterThan(0);
    }
  });
});

describe('renderFormula', () => {
  it('rewrites only the url and sha256 lines', () => {
    const out: string = mod.renderFormula(formulaText, { version: '1.2.3', sha256: SHA });
    const before = formulaText.split('\n');
    const after = out.split('\n');
    expect(after.length).toBe(before.length);
    const changed = before.flatMap((l, i) => (l === after[i] ? [] : [i]));
    expect(changed.length).toBe(2);
    expect(after[changed[0]!]).toBe('  url "https://registry.npmjs.org/ccinfobar/-/ccinfobar-1.2.3.tgz"');
    expect(after[changed[1]!]).toBe(`  sha256 "${SHA}"`);
    expect(out).toContain('    url :stable\n');
    expect(mod.checkFormula(out)).toEqual([]);
  });

  it('throws when a line is missing or repeated', () => {
    const urlLine = formulaText.split('\n').find((l) => l.startsWith('  url "'))!;
    const shaLine = formulaText.split('\n').find((l) => l.startsWith('  sha256 "'))!;
    const noUrl = formulaText.replace(`${urlLine}\n`, '');
    const twoUrls = formulaText.replace(urlLine, `${urlLine}\n${urlLine}`);
    const noSha = formulaText.replace(`${shaLine}\n`, '');
    for (const bad of [noUrl, twoUrls, noSha])
      expect(() => mod.renderFormula(bad, { version: '1.2.3', sha256: SHA })).toThrow();
  });
});

describe('hashes', () => {
  it('formats sha512 as SRI and sha256 as hex', () => {
    const buf = Buffer.from('ccinfobar tarball bytes');
    expect(mod.sri512(buf)).toBe(`sha512-${createHash('sha512').update(buf).digest('base64')}`);
    expect(mod.sha256Hex(buf)).toBe(createHash('sha256').update(buf).digest('hex'));
  });
});

describe('homebrew-formula.mjs', () => {
  it('fills url and sha256 from a local tarball, then reports no change', () => {
    const dir = tempCopy();
    const tgz = path.join(dir, 'x.tgz');
    const bytes = Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5]);
    fs.writeFileSync(tgz, bytes);
    const first = run(['--root', dir, '--tarball', tgz, '--version', '1.2.3']);
    expect(first.status, first.stderr).toBe(0);
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(first.stdout).toContain(`homebrew-formula: 1.2.3 ${sha}`);
    const text = readCopy(dir);
    expect(text).toContain(`  sha256 "${sha}"`);
    expect(text).toMatch(/^ {2}url "\S+\/ccinfobar-1\.2\.3\.tgz"$/m);
    const second = run(['--root', dir, '--tarball', tgz, '--version', '1.2.3']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already at 1.2.3');
    expect(readCopy(dir)).toBe(text);
  });

  it('rejects a bad version without writing', () => {
    const dir = tempCopy();
    const tgz = path.join(dir, 'x.tgz');
    fs.writeFileSync(tgz, 'x');
    for (const v of ['1.2', '1.2.3;rm']) {
      const r = run(['--root', dir, '--tarball', tgz, '--version', v]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/^homebrew-formula: /);
      expect(readCopy(dir)).toBe(formulaText);
    }
  });

  it('fails on a missing tarball', () => {
    const dir = tempCopy();
    const r = run(['--root', dir, '--tarball', path.join(dir, 'missing.tgz'), '--version', '1.2.3']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^homebrew-formula: /);
    expect(readCopy(dir)).toBe(formulaText);
  });

  it('--check passes on the formula and fails on a broken copy', () => {
    const ok = run(['--check', '--root', tempCopy()]);
    expect(ok.status).toBe(0);
    const broken = run([
      '--check',
      '--root',
      tempCopy(formulaText.replace('strategy :npm', 'strategy :git')),
    ]);
    expect(broken.status).toBe(1);
    expect(broken.stderr).toMatch(/^homebrew-formula: /);
  });
});

describe('registry mode', () => {
  const tgzUrl = 'https://registry.npmjs.org/ccinfobar/-/ccinfobar-1.2.3.tgz';
  const bytes = Buffer.from('registry tarball bytes');

  function stubRegistry(dist: Record<string, unknown>, headers: Record<string, string> = {}) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url === 'https://registry.npmjs.org/ccinfobar/1.2.3') return new Response(JSON.stringify({ dist }));
      if (url === tgzUrl) return new Response(bytes, { headers });
      return new Response('', { status: 404 });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    return urls;
  }

  it('writes the sha256 only after the tarball matches dist.integrity', async () => {
    const dir = tempCopy();
    const urls = stubRegistry({ tarball: tgzUrl, integrity: mod.sri512(bytes) });
    await expect(mod.run(['--root', dir, '--version', '1.2.3'])).resolves.toBe(0);
    expect(urls).toEqual(['https://registry.npmjs.org/ccinfobar/1.2.3', tgzUrl]);
    expect(readCopy(dir)).toContain(`  sha256 "${mod.sha256Hex(bytes)}"`);
  });

  it('refuses an integrity mismatch, a foreign tarball url and an oversized body', async () => {
    const dir = tempCopy();
    stubRegistry({ tarball: tgzUrl, integrity: mod.sri512(Buffer.from('other')) });
    await expect(mod.run(['--root', dir, '--version', '1.2.3'])).rejects.toThrow('integrity mismatch');
    vi.unstubAllGlobals();
    stubRegistry({ tarball: 'https://example.com/ccinfobar-1.2.3.tgz', integrity: mod.sri512(bytes) });
    await expect(mod.run(['--root', dir, '--version', '1.2.3'])).rejects.toThrow('unexpected tarball url');
    vi.unstubAllGlobals();
    stubRegistry(
      { tarball: tgzUrl, integrity: mod.sri512(bytes) },
      { 'content-length': String(60 * 1024 * 1024) },
    );
    await expect(mod.run(['--root', dir, '--version', '1.2.3'])).rejects.toThrow('over 50 MB');
    expect(readCopy(dir)).toBe(formulaText);
  });
});
