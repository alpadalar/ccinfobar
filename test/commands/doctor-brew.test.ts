import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/commands/doctor.js';
import { manifestFile } from '../../src/commands/manifest.js';
import { t } from '../../src/core/i18n/index.js';
import { claudeSettingsPath, configDir } from '../../src/core/paths.js';
import { VERSION } from '../../src/core/version.js';
import { envelopeFile } from '../../src/data/jobs/runner.js';
import { legacyUpdateFile } from '../../src/data/jobs/update.js';
import { type InstallKind, writeUpdateState } from '../../src/data/update-state.js';
import { withEnvLang } from '../helpers.js';

const cfgFile = (name: string, text: string) => {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

const capture = (fn: () => void): string[] => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => c.map(String).join(' '));
  } finally {
    spy.mockRestore();
  }
};

const plain = (update?: string) =>
  cfgFile('plain.json', JSON.stringify({ ...(update ? { update } : {}), lines: [[{ type: 'model' }]] }));

const doctor = (kind: InstallKind, update?: string) =>
  capture(() => runDoctor(plain(update), { managedFiles: [], installKind: () => kind }));

const BREW = 'updates via brew upgrade ccinfobar, Homebrew install';

beforeEach(() => {
  vi.stubEnv('CCINFOBAR_NO_UPDATE', '');
  vi.stubEnv('CI', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(envelopeFile('update'), { force: true });
  fs.rmSync(legacyUpdateFile(), { force: true });
  fs.rmSync(claudeSettingsPath(), { force: true });
  fs.rmSync(manifestFile(), { force: true });
});

describe('runDoctor on a Homebrew copy', () => {
  it('names Homebrew and brew upgrade when up to date', () => {
    writeUpdateState({ checkedAt: Date.now(), latest: VERSION });
    const out = doctor('brew');
    expect(
      out.some((l) => l.startsWith(`✓ Up to date (notify mode, auto acts as notify, ${BREW}, last checked `)),
    ).toBe(true);
    expect(out.join('\n')).not.toMatch(/[\u0007\u001b]/);
  });

  it('says not checked yet without update state', () => {
    expect(doctor('brew')).toContain(
      `✓ Up to date (notify mode, auto acts as notify, ${BREW}, not checked yet)`,
    );
  });

  it('shows the configured notify mode', () => {
    writeUpdateState({ checkedAt: Date.now(), latest: VERSION });
    expect(doctor('brew', 'notify').some((l) => l.startsWith(`✓ Up to date (notify mode, ${BREW}, `))).toBe(
      true,
    );
  });

  it('tells brew users to run brew upgrade for a newer version', () => {
    writeUpdateState({ checkedAt: Date.now(), latest: '99.0.0' });
    const out = doctor('brew');
    expect(out).toContain(t('doctor.update.availableBrew', { current: VERSION, latest: '99.0.0' }));
    expect(out).toContain(`✗ Update available: ${VERSION} → 99.0.0 (run \`brew upgrade ccinfobar\`)`);
    expect(out.some((l) => l.includes('run `ccinfobar update`'))).toBe(false);
    expect(out.join('\n')).not.toMatch(/[\u0007\u001b]/);
  });

  it('keeps update checks off unchanged', () => {
    writeUpdateState({ checkedAt: Date.now(), latest: '99.0.0' });
    const out = doctor('brew', 'off');
    expect(out).toContain('  Update checks off');
    expect(out.some((l) => l.includes('brew upgrade'))).toBe(false);
  });

  it('prints Turkish brew lines', () => {
    writeUpdateState({ checkedAt: Date.now(), latest: '99.0.0' });
    const out = withEnvLang('tr', () => doctor('brew'));
    expect(out).toContain(`✗ Güncelleme var: ${VERSION} → 99.0.0 (\`brew upgrade ccinfobar\` çalıştırın)`);
    fs.rmSync(envelopeFile('update'), { force: true });
    expect(withEnvLang('tr', () => doctor('brew'))).toContain(
      '✓ Güncel (güncelleme: yalnızca bildir, otomatik bildir gibi çalışır, brew upgrade ccinfobar ile güncellenir, Homebrew kurulumu, henüz denetlenmedi)',
    );
    expect(withEnvLang('tr', () => doctor('brew', 'notify'))).toContain(
      '✓ Güncel (güncelleme: yalnızca bildir, brew upgrade ccinfobar ile güncellenir, Homebrew kurulumu, henüz denetlenmedi)',
    );
  });
});

describe('runDoctor on other copies', () => {
  it('keeps the npm-global line', () => {
    writeUpdateState({ checkedAt: Date.now(), latest: VERSION });
    expect(
      doctor('npm-global').some((l) => l.startsWith('✓ Up to date (auto mode, npm-global install, ')),
    ).toBe(true);
  });

  it.each<InstallKind>(['npm-global', 'local', 'npx', 'source', 'unknown'])(
    'keeps ccinfobar update for %s',
    (kind) => {
      writeUpdateState({ checkedAt: Date.now(), latest: '99.0.0' });
      const out = doctor(kind);
      expect(out).toContain(`✗ Update available: ${VERSION} → 99.0.0 (run \`ccinfobar update\`)`);
      expect(out.some((l) => l.includes('brew upgrade'))).toBe(false);
    },
  );

  it.each<InstallKind>(['npm-global', 'local', 'npx', 'source', 'unknown'])(
    'keeps the not checked line for %s',
    (kind) => {
      expect(doctor(kind)).toContain(
        `✓ Up to date (auto mode, ${t(`doctor.installKind.${kind}`)} install, not checked yet)`,
      );
    },
  );
});
