import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import {
  BREW_UPGRADE,
  brewPrefix,
  effectiveUpdate,
  type InstallKind,
  installKind,
  localPrefix,
  selfCommand,
  updateHint,
  updateNotice,
  writeUpdateState,
} from '../../src/data/update-state.js';
import { useIdleEntry } from '../helpers.js';

const TAIL = 'libexec/lib/node_modules/ccinfobar/dist/ccinfobar.js';
const CELLARS = [
  `/opt/homebrew/Cellar/ccinfobar/0.7.0/${TAIL}`,
  `/usr/local/Cellar/ccinfobar/0.7.0/${TAIL}`,
  `/home/linuxbrew/.linuxbrew/Cellar/ccinfobar/0.7.0/${TAIL}`,
  `/home/u/.linuxbrew/Cellar/ccinfobar/0.7.0/${TAIL}`,
  `/srv/brew/Cellar/ccinfobar/0.7.0/${TAIL}`,
];
const tmp = (name: string) =>
  fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT ?? os.tmpdir(), `ccib-${name}-`));
const envWith = () => ({ CCINFOBAR_CACHE_DIR: tmp('kind') }) as NodeJS.ProcessEnv;
const cfg = (update: Config['update']): Config => ({ ...defaultConfig(), update });

describe('install kind', () => {
  useIdleEntry();

  it('detects a Homebrew Cellar copy for every prefix', () => {
    for (const p of CELLARS) expect(installKind(p)).toBe('brew');
    expect(installKind(`C:\\brew\\Cellar\\ccinfobar\\0.7.0\\${TAIL.replace(/\//g, '\\')}`)).toBe('brew');
  });

  it('keeps the other kinds', () => {
    expect(installKind('/home/u/.npm-global/lib/node_modules/ccinfobar/dist/ccinfobar.js')).toBe(
      'npm-global',
    );
    expect(
      installKind('C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\ccinfobar\\dist\\ccinfobar.js'),
    ).toBe('npm-global');
    expect(installKind('/home/u/.npm/_npx/abc/node_modules/ccinfobar/dist/ccinfobar.js')).toBe('npx');
    const checkout = tmp('source');
    fs.mkdirSync(path.join(checkout, '.git'));
    fs.mkdirSync(path.join(checkout, 'dist'));
    fs.writeFileSync(path.join(checkout, 'dist', 'ccinfobar.js'), '');
    expect(installKind(path.join(checkout, 'dist', 'ccinfobar.js'))).toBe('source');
    expect(installKind(path.join(tmp('nogit'), 'dist', 'ccinfobar.js'))).toBe('unknown');
    expect(installKind(path.join(localPrefix(), 'node_modules', 'ccinfobar', 'dist', 'ccinfobar.js'))).toBe(
      'local',
    );
  });

  it('follows a symlinked bin entry into the Cellar', () => {
    const root = fs.realpathSync(tmp('brew'));
    const brew = path.join(root, 'brew');
    const dist = path.join(
      brew,
      'Cellar',
      'ccinfobar',
      '9.9.9',
      'libexec',
      'lib',
      'node_modules',
      'ccinfobar',
      'dist',
    );
    fs.mkdirSync(dist, { recursive: true });
    const entry = path.join(dist, 'ccinfobar.js');
    fs.writeFileSync(entry, '');
    expect(installKind(entry)).toBe('brew');
    expect(brewPrefix(entry)).toBe(brew);
    const bin = path.join(brew, 'bin');
    fs.mkdirSync(bin);
    const link = path.join(bin, 'ccinfobar');
    try {
      fs.symlinkSync(entry, link);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return;
      throw e;
    }
    expect(installKind(link)).toBe('brew');
    expect(brewPrefix(link)).toBe(brew);
  });

  it('finds the brew prefix', () => {
    expect(brewPrefix(CELLARS[0])).toBe('/opt/homebrew');
    expect(brewPrefix(CELLARS[2])).toBe('/home/linuxbrew/.linuxbrew');
    expect(brewPrefix('/home/u/.npm-global/lib/node_modules/ccinfobar/dist/ccinfobar.js')).toBeNull();
    expect(selfCommand('brew')).toBe('ccinfobar');
  });

  it('maps brew auto and notify to notify', () => {
    expect(effectiveUpdate(cfg('off'), 'brew')).toBe('off');
    expect(effectiveUpdate(cfg('auto'), 'brew')).toBe('notify');
    expect(effectiveUpdate(cfg('notify'), 'brew')).toBe('notify');
    for (const kind of ['npm-global', 'local', 'source', 'unknown'] as const) {
      for (const mode of ['off', 'auto', 'notify'] as const)
        expect(effectiveUpdate(cfg(mode), kind)).toBe(mode);
    }
    expect(updateHint('brew')).toBe(BREW_UPGRADE);
    expect(updateHint('npm-global')).toBe('ccinfobar update');
  });

  it('shows the brew hint in the notice', () => {
    const env = envWith();
    writeUpdateState({ checkedAt: Date.now(), latest: '0.3.0' }, env);
    const as = (kind: InstallKind) => () => kind;
    const brew = '⬆ ccinfobar 0.3.0 · brew upgrade ccinfobar';
    expect(updateNotice(cfg('auto'), '0.2.0', env, as('brew'))).toBe(brew);
    expect(updateNotice(cfg('notify'), '0.2.0', env, as('brew'))).toBe(brew);
    expect(updateNotice(cfg('off'), '0.2.0', env, as('brew'))).toBeNull();
    expect(updateNotice(cfg('notify'), '0.2.0', env, as('npm-global'))).toBe(
      '⬆ ccinfobar 0.3.0 · ccinfobar update',
    );
    expect(updateNotice(cfg('auto'), '0.2.0', env, as('npm-global'))).toBeNull();
    expect(updateNotice(cfg('notify'), '0.2.0', env, as('npx'))).toBeNull();
    expect(updateNotice(cfg('auto'), '0.2.0', { ...env, CCINFOBAR_NO_UPDATE: '1' }, as('brew'))).toBeNull();
  });

  it('resolves the kind only when a newer version is known', () => {
    const env = envWith();
    const kindOf = vi.fn((): InstallKind => 'brew');
    for (const mode of ['auto', 'notify'] as const)
      expect(updateNotice(cfg(mode), '0.2.0', env, kindOf)).toBeNull();
    writeUpdateState({ checkedAt: Date.now(), latest: '0.2.0' }, env);
    for (const mode of ['auto', 'notify'] as const)
      expect(updateNotice(cfg(mode), '0.2.0', env, kindOf)).toBeNull();
    expect(kindOf).not.toHaveBeenCalled();
    writeUpdateState({ checkedAt: Date.now(), latest: '0.3.0' }, env);
    expect(updateNotice(cfg('auto'), '0.2.0', env, kindOf)).toBe(
      '⬆ ccinfobar 0.3.0 · brew upgrade ccinfobar',
    );
    expect(kindOf).toHaveBeenCalledTimes(1);
  });

  it('gives the same notice for every mode and kind', () => {
    const env = envWith();
    const kinds: InstallKind[] = ['npm-global', 'local', 'npx', 'brew', 'source', 'unknown'];
    const want = (mode: Config['update'], kind: InstallKind, latest: string | null) => {
      if (mode === 'off' || !latest) return null;
      if (effectiveUpdate(cfg(mode), kind) !== 'notify' || kind === 'npx') return null;
      return `⬆ ccinfobar ${latest} · ${updateHint(kind)}`;
    };
    for (const latest of [null, '0.1.0', '0.2.0', '0.3.0']) {
      if (latest) writeUpdateState({ checkedAt: Date.now(), latest }, env);
      const newer = latest && latest > '0.2.0' ? latest : null;
      for (const mode of ['auto', 'notify', 'off'] as const)
        for (const kind of kinds)
          expect(
            updateNotice(cfg(mode), '0.2.0', env, () => kind),
            `${latest} ${mode} ${kind}`,
          ).toBe(want(mode, kind, newer));
    }
  });

  it('never resolves the kind when updates are off', () => {
    const env = envWith();
    writeUpdateState({ checkedAt: Date.now(), latest: '0.3.0' }, env);
    const kindOf = vi.fn((): InstallKind => 'brew');
    expect(updateNotice(cfg('off'), '0.2.0', env, kindOf)).toBeNull();
    expect(updateNotice(cfg('notify'), '0.2.0', { ...env, CI: '1' }, kindOf)).toBeNull();
    expect(kindOf).not.toHaveBeenCalled();
  });
});
