import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fail = vi.hoisted(() => ({ on: false }));

vi.mock('../../src/commands/manifest.js', async (orig) => {
  const real = await orig<typeof import('../../src/commands/manifest.js')>();
  return {
    ...real,
    updateManifest: (...args: Parameters<typeof real.updateManifest>) => {
      if (fail.on) throw new Error('disk full');
      return real.updateManifest(...args);
    },
  };
});

const { applyInstall, planInstall } = await import('../../src/commands/install.js');

function tmpEnv() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-rollback-')));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
  };
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  return { dir, env, file: path.join(dir, 'claude', 'settings.json') };
}

afterEach(() => {
  fail.on = false;
});

describe('install rollback when the manifest cannot be written', () => {
  it('restores the previous settings bytes', () => {
    const fx = tmpEnv();
    const before = '{\n  "model": "opus",\n  "statusLine": { "type": "command", "command": "other" }\n}\n';
    fs.writeFileSync(fx.file, before);
    const plan = planInstall({ file: fx.file, command: 'ccinfobar', env: fx.env });
    fail.on = true;
    expect(() => applyInstall(plan, { confirmed: true, env: fx.env })).toThrow(/disk full/);
    expect(fs.readFileSync(fx.file, 'utf8')).toBe(before);
  });

  it('removes a settings file it created', () => {
    const fx = tmpEnv();
    const plan = planInstall({ file: fx.file, command: 'ccinfobar', env: fx.env });
    fail.on = true;
    expect(() => applyInstall(plan, { confirmed: true, env: fx.env })).toThrow(/disk full/);
    expect(fs.existsSync(fx.file)).toBe(false);
  });
});
