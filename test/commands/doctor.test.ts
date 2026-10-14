import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandWarnings, configWarnings, runDoctor } from '../../src/commands/doctor.js';
import { applyInstall, planInstall } from '../../src/commands/install.js';
import { manifestFile, readManifest } from '../../src/commands/manifest.js';
import { backupsDir } from '../../src/commands/settings-file.js';
import { inspectConfigText } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { cacheDir, claudeSettingsPath, configDir, tildify } from '../../src/core/paths.js';

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

const reset = () => {
  fs.rmSync(claudeSettingsPath(), { force: true });
  fs.rmSync(manifestFile(), { force: true });
};

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

describe('configWarnings', () => {
  it('lists unknown widget types and unsupported option values', () => {
    const raw = {
      lines: [[{ type: 'no-such' }], [{ type: 'context-percentage', options: { mode: 'bogus' } }]],
    };
    expect(configWarnings(raw)).toEqual([
      t('doctor.unknownWidget', { type: 'no-such', line: 1 }),
      t('doctor.badOption', { type: 'context-percentage', key: 'mode' }),
    ]);
  });

  it('checks number and boolean options', () => {
    const raw = {
      lines: [
        [
          { type: 'session-cost', options: { decimals: 'x' } },
          { type: 'context-percentage', options: { thresholdColors: 'maybe' } },
        ],
      ],
    };
    expect(configWarnings(raw)).toEqual([
      t('doctor.badOption', { type: 'session-cost', key: 'decimals' }),
      t('doctor.badOption', { type: 'context-percentage', key: 'thresholdColors' }),
    ]);
  });

  it('accepts a valid config and odd shapes', () => {
    const raw = {
      lines: [
        [
          { type: 'context-percentage', options: { mode: 'remaining', thresholdColors: 'true' } },
          { type: 'session-cost', options: { decimals: 3, unknownKey: 1 } },
          { type: 'flex' },
        ],
      ],
    };
    expect(configWarnings(raw)).toEqual([]);
    for (const v of [null, 1, 'x', {}, { lines: 'x' }, { lines: [null, [1, null]] }]) {
      expect(configWarnings(v)).toEqual([]);
    }
  });
});

describe('runDoctor config report', () => {
  it('prints the exact location of a broken config', () => {
    const text = '{\n  "lines": [,]\n}';
    const file = cfgFile('broken.json', text);
    const issue = inspectConfigText(text).issue;
    expect(issue?.line).toBe(2);
    const out = capture(() => runDoctor(file));
    expect(out.some((l) => l.startsWith('✗ Config'))).toBe(true);
    expect(out).toContain(t('doctor.configIssue', { ...issue! }));
    expect(out).toContain(t('doctor.columnNote'));
  });

  it('warns about an unknown widget and still loads the config', () => {
    const file = cfgFile('unknown.json', JSON.stringify({ lines: [[{ type: 'no-such' }]] }));
    const out = capture(() => runDoctor(file));
    expect(out.some((l) => l.startsWith('✓ Config'))).toBe(true);
    expect(out).toContain(t('doctor.unknownWidget', { type: 'no-such', line: 1 }));
  });

  it('reads a config with a BOM', () => {
    const file = cfgFile('bom.json', `\uFEFF${JSON.stringify({ lines: [[{ type: 'no-such' }]] })}`);
    const out = capture(() => runDoctor(file));
    expect(out).toContain(t('doctor.unknownWidget', { type: 'no-such', line: 1 }));
  });
});

describe('commandWarnings', () => {
  it('warns on win32 about backslashes and a quoted first token', () => {
    expect(commandWarnings('C:\\Users\\a\\npm\\ccinfobar.cmd', 'win32')).toEqual([t('doctor.winCommand')]);
    expect(commandWarnings('"C:/x y/ccinfobar"', 'win32')).toEqual([t('doctor.winCommand')]);
    expect(commandWarnings("  'C:/x y/ccinfobar'", 'win32')).toEqual([t('doctor.winCommand')]);
    expect(commandWarnings('ccinfobar', 'win32')).toEqual([]);
    expect(commandWarnings('C:\\x', 'linux')).toEqual([]);
  });
});

describe('runDoctor install report', () => {
  const plain = () => cfgFile('plain.json', JSON.stringify({ lines: [[{ type: 'model' }]] }));

  it('prints git hardening off', () => {
    const file = cfgFile('hard.json', JSON.stringify({ gitHardening: false, lines: [] }));
    expect(capture(() => runDoctor(file))).toContain(t('doctor.gitHardeningOff'));
    expect(capture(() => runDoctor(plain()))).not.toContain(t('doctor.gitHardeningOff'));
  });

  it('reports the manifest, backups and manifest ownership', () => {
    applyInstall(planInstall({ file: claudeSettingsPath(), command: '/opt/bin/ccinfobar' }), {
      confirmed: true,
    });
    const m = readManifest();
    expect(m.entries).toHaveLength(1);
    const out = capture(() => runDoctor(plain()));
    expect(out).toContain(t('doctor.manifest', { file: tildify(manifestFile()), count: 1 }));
    const entry = m.entries[0]!;
    expect(out).toContain(t('doctor.manifestEntry', { kind: entry.kind, file: tildify(String(entry.file)) }));
    expect(out).toContain(t('doctor.backups', { dir: tildify(backupsDir()) }));
    expect(
      out.some((l) => l.startsWith('✓ Claude Code statusLine') && l.includes('/opt/bin/ccinfobar')),
    ).toBe(true);
  });

  it('does not claim a foreign statusLine that mentions ccinfobar', () => {
    const file = claudeSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ statusLine: { type: 'command', command: 'bash -c "ccinfobar | x"' } }),
    );
    const out = capture(() => runDoctor(plain()));
    expect(out.some((l) => l.startsWith('✗ Claude Code statusLine'))).toBe(true);
    expect(out.some((l) => l.startsWith('✓ Claude Code statusLine'))).toBe(false);
  });

  it('still treats a legacy ccinfobar command as ours', () => {
    const file = claudeSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'ccinfobar' } }));
    const out = capture(() => runDoctor(plain()));
    expect(out.some((l) => l.startsWith('✓ Claude Code statusLine'))).toBe(true);
  });

  it('strips terminal escapes from external text', () => {
    const file = claudeSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const evil = 'evil\u001b]0;pwned\u0007\u001b[2Jcmd';
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: evil } }));
    fs.mkdirSync(cacheDir(), { recursive: true });
    const upd = path.join(cacheDir(), 'update.json');
    fs.writeFileSync(
      upd,
      JSON.stringify({ checkedAt: Date.now(), latest: null, error: `bad\u001b]52;c;eA==\u0007` }),
    );
    try {
      const out = capture(() => runDoctor(plain()));
      expect(out.join('\n')).not.toMatch(/[\u0007\u001b]/);
      expect(out.some((l) => l.endsWith(': evilcmd'))).toBe(true);
      expect(out).toContain('  Last update check failed: bad');
    } finally {
      fs.rmSync(upd, { force: true });
    }
  });

  it('sweeps stale temp files from the cache dir', () => {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'x.json.1.abcd1234.tmp');
    const fresh = path.join(dir, 'y.json.1.abcd1234.tmp');
    const other = path.join(dir, 'keep.json');
    for (const f of [stale, fresh, other]) fs.writeFileSync(f, '{}');
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(other, old, old);
    const out = capture(() => runDoctor(plain()));
    expect(out).toContain(t('doctor.tmpPruned', { count: 1 }));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    fs.rmSync(fresh);
    expect(capture(() => runDoctor(plain())).some((l) => l.includes('stale temp'))).toBe(false);
  });
});
