import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyInstall, planInstall } from '../../src/commands/install.js';
import {
  findStatusLineEntry,
  manifestFile,
  readManifest,
  recordStatusLine,
  updateManifest,
  writeManifest,
} from '../../src/commands/manifest.js';
import { t } from '../../src/core/i18n/index.js';

const tmpEnv = () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-mlock-')));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
  };
  fs.mkdirSync(path.join(dir, 'claude'), { recursive: true });
  return { dir, env };
};
const entryFor = (file: string) => ({
  file,
  value: { type: 'command' as const, command: 'ccinfobar', padding: 0 },
  previous: null,
  fileExisted: true,
  restore: null,
  writtenHash: 'sha256:x',
});
const files = (env: NodeJS.ProcessEnv) =>
  readManifest(env)
    .entries.map((e) => (e as { file?: string }).file)
    .sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('updateManifest lock', () => {
  it('keeps both entries of interleaved writers', () => {
    const { dir, env } = tmpEnv();
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    const stale = readManifest(env);
    updateManifest(env, (cur) => recordStatusLine(cur, entryFor(b)));
    updateManifest(env, (cur) => recordStatusLine(cur, entryFor(a)));
    expect(files(env)).toEqual([a, b]);
    writeManifest(recordStatusLine(stale, entryFor(a)), env);
    expect(files(env)).toEqual([a]);
  });

  it('reports busy for a fresh lock and leaves it alone', () => {
    const { dir, env } = tmpEnv();
    const lock = `${manifestFile(env)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    let clock = Date.now();
    const now = () => {
      clock += 1000;
      return clock;
    };
    expect(() =>
      updateManifest(env, (cur) => recordStatusLine(cur, entryFor(path.join(dir, 'a'))), now),
    ).toThrow(t('install.manifestBusy', { file: manifestFile(env) }));
    expect(fs.existsSync(lock)).toBe(true);
    expect(readManifest(env).entries).toEqual([]);
  });

  it('takes over a stale lock and removes it afterwards', () => {
    const { dir, env } = tmpEnv();
    const lock = `${manifestFile(env)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(lock, old, old);
    updateManifest(env, (cur) => recordStatusLine(cur, entryFor(path.join(dir, 'a'))));
    expect(fs.existsSync(lock)).toBe(false);
    expect(readManifest(env).entries).toHaveLength(1);
  });

  it('removes the lock when mutate throws', () => {
    const { env } = tmpEnv();
    expect(() =>
      updateManifest(env, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(`${manifestFile(env)}.lock`)).toBe(false);
  });

  it('loses no entry when another install lands between a settings patch and the manifest write', () => {
    const { dir, env } = tmpEnv();
    const p1 = path.join(dir, 'p1', 'settings.json');
    const p2 = path.join(dir, 'p2', 'settings.json');
    for (const p of [p1, p2]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '{}\n');
    }
    const real = fs.renameSync;
    let fired = false;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!fired && String(to) === p1) {
        fired = true;
        spy.mockRestore();
        applyInstall(planInstall({ file: p2, command: 'ccinfobar', env }), { confirmed: true, env });
      }
      return real(from, to);
    });
    applyInstall(planInstall({ file: p1, command: 'ccinfobar', env }), { confirmed: true, env });
    expect(fired).toBe(true);
    const m = readManifest(env);
    expect(findStatusLineEntry(m, p1)).toBeTruthy();
    expect(findStatusLineEntry(m, p2)).toBeTruthy();
  });
});
