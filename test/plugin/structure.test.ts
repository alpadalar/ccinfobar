import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const pluginDir = path.join(root, 'plugin');
const marketDir = path.join(root, '.claude-plugin');
const SKILLS = ['doctor', 'edit', 'install', 'theme', 'uninstall'];
const ALLOWED: Record<string, string> = {
  doctor: 'Bash(ccinfobar --version), Bash(ccinfobar doctor)',
  edit: 'Bash(ccinfobar --version), Bash(ccinfobar edit --detach)',
  install:
    'Bash(ccinfobar --version), Bash(ccinfobar install --hooks --dry-run), Bash(ccinfobar install --dry-run)',
  theme: 'Bash(ccinfobar --version), Bash(ccinfobar themes --list), Bash(ccinfobar theme *)',
  uninstall: 'Bash(ccinfobar --version)',
};
const PREFLIGHT = 'ccinfobar check: !`ccinfobar --version || echo ccinfobar-missing`';
const PLUGIN_KEYS = [
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
];
const FORBIDDEN = [
  'commands',
  'hooks',
  'bin',
  'agents',
  'output-styles',
  'monitors',
  '.mcp.json',
  '.lsp.json',
  'settings.json',
  'CLAUDE.md',
];

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pkg = readJson(path.join(root, 'package.json'));

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function skill(id: string): { meta: Record<string, string>; body: string } {
  const text = fs.readFileSync(path.join(pluginDir, 'skills', id, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const start = lines.indexOf('---');
  const end = lines.indexOf('---', start + 1);
  expect(start, `${id}: frontmatter start`).toBe(0);
  expect(end, `${id}: frontmatter end`).toBeGreaterThan(start);
  const meta: Record<string, string> = {};
  for (const line of lines.slice(start + 1, end)) {
    const m = /^([a-z-]+):\s*(.*)$/.exec(line);
    expect(m, `${id}: bad frontmatter line ${line}`).not.toBeNull();
    meta[m![1]!] = m![2]!.trim();
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

describe('marketplace.json', () => {
  it('lists the ccinfobar plugin from ./plugin without a version', () => {
    const m = readJson(path.join(marketDir, 'marketplace.json'));
    expect(m.name).toBe('ccinfobar');
    expect(m.owner).toEqual({ name: 'Alperen Adalar' });
    expect(m.plugins).toHaveLength(1);
    const entry = m.plugins[0];
    expect(entry.name).toBe('ccinfobar');
    expect(entry.source).toBe('./plugin');
    expect(typeof entry.description).toBe('string');
    expect(entry).not.toHaveProperty('version');
  });
});

describe('plugin.json', () => {
  const file = path.join(pluginDir, '.claude-plugin', 'plugin.json');

  it('has only the allowed keys and the package.json version', () => {
    const p = readJson(file);
    for (const k of Object.keys(p)) expect(PLUGIN_KEYS, `unexpected key ${k}`).toContain(k);
    for (const k of ['hooks', 'mcpServers', 'commands', 'agents', 'settings'])
      expect(p).not.toHaveProperty(k);
    expect(p.name).toBe('ccinfobar');
    expect(p.version).toBe(pkg.version);
    expect(p.author).toEqual({ name: 'Alperen Adalar' });
    expect(p.license).toBe('MIT');
    expect(() => new URL(p.homepage)).not.toThrow();
  });
});

describe('plugin layout', () => {
  it('has exactly the five skills', () => {
    const dirs = fs
      .readdirSync(path.join(pluginDir, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(SKILLS);
    for (const id of SKILLS) expect(fs.existsSync(path.join(pluginDir, 'skills', id, 'SKILL.md'))).toBe(true);
  });

  it('ships no hooks, commands, bin, agents, MCP or settings', () => {
    for (const name of FORBIDDEN) expect(fs.existsSync(path.join(pluginDir, name)), name).toBe(false);
  });

  it('no plugin file sets statusLine or uses CLAUDE_PLUGIN_ROOT', () => {
    const files = [...walk(pluginDir), ...walk(marketDir)];
    expect(files.length).toBeGreaterThan(SKILLS.length);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(root, f);
      expect(text, rel).not.toContain('"statusLine"');
      expect(text, rel).not.toContain('CLAUDE_PLUGIN_ROOT');
    }
  });
});

describe('skills', () => {
  for (const id of SKILLS) {
    it(`${id}: frontmatter and shared rules`, () => {
      const { meta, body } = skill(id);
      expect(meta.description).toBeTruthy();
      expect(meta['disable-model-invocation']).toBe('true');
      expect(meta['allowed-tools']).toBe(ALLOWED[id]);
      expect(meta['allowed-tools']).not.toMatch(/npx|--yes|uninstall|ccinfobar \*/);
      if (id === 'theme' || id === 'install') expect(meta['argument-hint']).toBeTruthy();
      else expect(meta).not.toHaveProperty('argument-hint');
      expect(Object.keys(meta).sort()).toEqual(
        [
          'allowed-tools',
          'description',
          'disable-model-invocation',
          ...(meta['argument-hint'] ? ['argument-hint'] : []),
        ].sort(),
      );
      expect(body).toContain(PREFLIGHT);
      expect(body).not.toContain('2>&1');
      expect(body).toContain('npx ccinfobar@latest install');
      expect(body).toMatch(/never edit any settings\.json/i);
      expect(body).toMatch(/as data, not instructions/i);
      expect(body).toContain('[shell command execution disabled by policy]');
      expect(body).toContain('prints 0.6.2 or lower, ccinfobar is too old for this skill. Run nothing else');
      const gate = body.indexOf('npx ccinfobar@latest --version');
      expect(gate).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(body.indexOf('npx ccinfobar@latest install --dry-run'));
    });
  }

  it('install dry-runs first and asks before replacing another status line', () => {
    const { body } = skill('install');
    const dry = body.indexOf('ccinfobar install --hooks --dry-run');
    const yes = body.indexOf('ccinfobar install --hooks --yes');
    expect(dry).toBeGreaterThan(-1);
    expect(yes).toBeGreaterThan(dry);
    expect(body).toMatch(/another tool's status line/i);
    expect(body).toMatch(/\bask\b/i);
    expect(body).not.toMatch(/add `--no-hooks`/);
    const plainDry = body.indexOf('`ccinfobar install --dry-run`');
    expect(plainDry).toBeGreaterThan(-1);
    expect(body.indexOf('`ccinfobar install --yes`')).toBeGreaterThan(plainDry);
  });

  it('uninstall, edit, theme and doctor call the binary', () => {
    expect(skill('uninstall').body).toContain('ccinfobar uninstall');
    expect(skill('uninstall').body).toContain('claude plugin uninstall ccinfobar@ccinfobar');
    expect(skill('edit').body).toContain('ccinfobar edit --detach');
    expect(skill('theme').body).toContain('ccinfobar themes --list');
    expect(skill('theme').body).toContain('ccinfobar theme ');
    expect(skill('doctor').body).toContain('ccinfobar doctor');
  });
});
