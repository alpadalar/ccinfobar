import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cacheDir, claudeDir, claudeSettingsPath, configDir, configPath } from '../../src/core/paths.js';
import { render } from '../../src/core/renderer.js';
import { ctxWith, withoutSideEffects, withoutSideEffectsAsync } from '../helpers.js';

const root = process.env.CCIB_TEST_ROOT ?? '';
const tmp = () => path.join(os.tmpdir(), `ccib-ok-${process.pid}-${Math.random().toString(36).slice(2)}`);

describe('test isolation', () => {
  it('creates the temp root inside the run dir', () => {
    expect(root).not.toBe('');
    expect(fs.existsSync(root)).toBe(true);
    if (process.env.CCIB_TEST_PARENT) expect(root.startsWith(process.env.CCIB_TEST_PARENT)).toBe(true);
  });

  it('resolves every path helper under the temp root', () => {
    for (const p of [
      configDir(),
      cacheDir(),
      claudeDir(),
      claudeSettingsPath(),
      configPath(),
      os.homedir(),
    ]) {
      expect(p.startsWith(root)).toBe(true);
    }
  });

  it('resolves path helpers under the temp root with an empty env', () => {
    for (const p of [configDir({}), cacheDir({}), claudeDir({}), claudeSettingsPath({}), configPath({})]) {
      expect(p.startsWith(root)).toBe(true);
    }
  });

  it('turns off background update and usage checks', () => {
    expect(process.env.CCINFOBAR_NO_UPDATE).toBe('1');
    expect(process.env.CCINFOBAR_NO_USAGE_API).toBe('1');
    expect(process.env.CCINFOBAR_CONFIG).toBeUndefined();
  });

  it('throws on writes outside temp dirs', () => {
    const probe = path.join(process.cwd(), 'ccib-guard-probe.tmp');
    expect(() => fs.writeFileSync(probe, 'x')).toThrow(/write outside temp dirs/);
    expect(() => fs.mkdirSync(path.join(process.cwd(), 'ccib-guard-dir'))).toThrow(/write outside temp dirs/);
    expect(() => fs.openSync(probe, 'w')).toThrow(/write outside temp dirs/);
    expect(fs.existsSync(probe)).toBe(false);
  });

  // node 26 spawns with the real environ once process.env is replaced
  it('never replaces the process.env object in tests', () => {
    const testDir = path.resolve(__dirname, '..');
    const files = (fs.readdirSync(testDir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(100);
    const bad = files.filter((f) =>
      /\bprocess\.env\s*=(?!=)/.test(fs.readFileSync(path.join(testDir, f), 'utf8')),
    );
    expect(bad).toEqual([]);
  });

  it('allows writes in the os temp dir', () => {
    const file = `${tmp()}.tmp`;
    fs.writeFileSync(file, 'x');
    expect(fs.readFileSync(file, 'utf8')).toBe('x');
    fs.rmSync(file);
  });
});

describe('withoutSideEffects', () => {
  it('throws on spawn', () => {
    expect(() => withoutSideEffects(() => execFileSync('git', ['--version']))).toThrow(/spawn during render/);
  });

  it('throws on fetch', () => {
    expect(() => withoutSideEffects(() => fetch('http://127.0.0.1:1'))).toThrow(/fetch during render/);
  });

  it('throws on config.json writes', () => {
    const dir = tmp();
    fs.mkdirSync(dir);
    expect(() => withoutSideEffects(() => fs.writeFileSync(path.join(dir, 'config.json'), '{}'))).toThrow(
      /config save during render/,
    );
    fs.rmSync(dir, { recursive: true });
  });

  it('clears the flag after return and after throw', async () => {
    expect(withoutSideEffects(() => 1)).toBe(1);
    expect(globalThis.__ccibRenderGuard).toBeFalsy();
    expect(() =>
      withoutSideEffects(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(globalThis.__ccibRenderGuard).toBeFalsy();
    await expect(withoutSideEffectsAsync(async () => execFileSync('git', ['--version']))).rejects.toThrow(
      /spawn during render/,
    );
    expect(globalThis.__ccibRenderGuard).toBeFalsy();
    expect(execFileSync('git', ['--version'], { encoding: 'utf8' })).toMatch(/git version/);
  });

  it('renders injected data without side effects', () => {
    const lines = withoutSideEffects(() => render(ctxWith({})));
    expect(lines.length).toBeGreaterThan(0);
  });

  it('renders every new widget without spawn, fetch or config save', () => {
    const types = [
      'usage-projection',
      'limit-eta',
      'limit-risk',
      'cost-today',
      'cost-week',
      'cost-project',
      'budget',
      'performance',
    ];
    const ctx = ctxWith({
      config: { budget: { daily: 3 }, lines: [types.map((type) => ({ id: type, type }))] },
      width: 400,
    });
    const lines = withoutSideEffects(() => render(ctx));
    expect(lines.join('')).toContain('~$4.12/$3');
  });

  it('passes an env override to the context', () => {
    expect(ctxWith({ env: { FOO: '1' } }).env.FOO).toBe('1');
    expect(ctxWith({}).env).toEqual({});
  });
});
