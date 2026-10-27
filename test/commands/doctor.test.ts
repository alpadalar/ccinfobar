import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envLanguage } from '../../src/cli/lang.js';
import {
  commandWarnings,
  configWarnings,
  languageLine,
  printWidgetReport,
  runDoctor,
  usageLine,
} from '../../src/commands/doctor.js';
import { applyInstall, planInstall } from '../../src/commands/install.js';
import { manifestFile, readManifest } from '../../src/commands/manifest.js';
import { backupsDir } from '../../src/commands/settings-file.js';
import { defaultConfig, inspectConfigText } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { VERSION } from '../../src/core/version.js';
import { cacheDir, claudeSettingsPath, configDir, lastPayloadPath, tildify } from '../../src/core/paths.js';
import type { StatusPayload } from '../../src/core/types.js';
import { httpKey } from '../../src/data/jobs/keys.js';
import { failEnvelope, jobsDir, okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import { usageFile, usageKey } from '../../src/data/usage.js';
import { withEnvLang, withLang } from '../helpers.js';

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

describe('configWarnings rules', () => {
  const bad = (id: string, key: string, problem: string) => t('doctor.badRule', { id, key, problem });

  it('names the item id, key and problem of an ignored rule', () => {
    const raw = { lines: [[{ id: 'ctx1', type: 'context-percentage', showWhen: 'context.pct => 70' }]] };
    expect(configWarnings(raw)).toEqual([bad('ctx1', 'showWhen', t('rule.error.bad-operator', { at: 13 }))]);
    expect(configWarnings(raw)[0]).toMatch(/^⚠ Widget ctx1: showWhen is ignored \(bad operator at \d+\)$/);
  });

  it('reports the bad entry of an array rule and falls back to the normalized id', () => {
    const raw = { lines: [[{ type: 'model' }, { type: 'model', hideWhen: ['git', 'contxt.pct > 5'] }]] };
    expect(configWarnings(raw)).toEqual([
      bad('model-1', 'hideWhen', t('rule.error.unknown-metric', { text: 'contxt.pct', at: 1 })),
    ]);
  });

  it('accepts valid rules and sanitizes rule text', () => {
    const ok = { lines: [[{ id: 'a', type: 'model', showWhen: 'context.pct >= 70', hideWhen: ['!git'] }]] };
    expect(configWarnings(ok)).toEqual([]);
    const esc = { lines: [[{ id: 'x\u001b[31m', type: 'model', showWhen: 'co\u001b[2Jst > 1' }]] };
    const out = configWarnings(esc);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toContain('\u001b');
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

describe('runDoctor refresh hint', () => {
  const timed = () => cfgFile('timed.json', JSON.stringify({ lines: [[{ type: 'turn-timer' }]] }));
  const hint = t('doctor.refreshHint', { widgets: 'turn-timer' });

  it('suggests --refresh 5 for time-based widgets without a refreshInterval', () => {
    applyInstall(planInstall({ file: claudeSettingsPath(), command: '/opt/bin/ccinfobar' }), {
      confirmed: true,
    });
    expect(capture(() => runDoctor(timed()))).toContain(hint);
    const plain = cfgFile('plain-r.json', JSON.stringify({ lines: [[{ type: 'model' }]] }));
    expect(capture(() => runDoctor(plain)).some((l) => l.includes('--refresh 5'))).toBe(false);
  });

  it('stays quiet when refreshInterval is set', () => {
    applyInstall(planInstall({ file: claudeSettingsPath(), command: '/opt/bin/ccinfobar', refresh: 5 }), {
      confirmed: true,
    });
    expect(capture(() => runDoctor(timed()))).not.toContain(hint);
  });

  it('names items with time rules', () => {
    const rules = t('doctor.refreshHintRules', { items: 'clk2' });
    expect(rules).toContain('ccinfobar install --refresh 5');
    const file = cfgFile(
      'rules-r.json',
      JSON.stringify({
        lines: [
          [
            { id: 'clk2', type: 'model', showWhen: 'time.hour in 9..18' },
            { id: 'g1', type: 'model', hideWhen: '!git' },
          ],
        ],
      }),
    );
    applyInstall(planInstall({ file: claudeSettingsPath(), command: '/opt/bin/ccinfobar' }), {
      confirmed: true,
    });
    const out = capture(() => runDoctor(file));
    expect(out).toContain(rules);
    expect(out.some((l) => l.includes('Time-based widgets'))).toBe(false);
    applyInstall(planInstall({ file: claudeSettingsPath(), command: '/opt/bin/ccinfobar', refresh: 5 }), {
      confirmed: true,
    });
    expect(capture(() => runDoctor(file))).not.toContain(rules);
  });
});

describe('runDoctor glyph and overflow hints', () => {
  afterEach(() => vi.unstubAllEnvs());
  const doctor = (name: string, cfg: object) => capture(() => runDoctor(cfgFile(name, JSON.stringify(cfg))));

  it('suggests glyphMode jetbrains in a JetBrains terminal', () => {
    vi.stubEnv('TERMINAL_EMULATOR', 'JetBrains-JediTerm');
    expect(doctor('jb.json', {})).toContain(t('doctor.jetbrains'));
    expect(doctor('jb-n.json', { glyphMode: 'normal' })).toContain(t('doctor.jetbrains'));
    expect(doctor('jb-j.json', { glyphMode: 'jetbrains' })).not.toContain(t('doctor.jetbrains'));
    expect(doctor('jb-a.json', { glyphMode: 'auto' })).not.toContain(t('doctor.jetbrains'));
    vi.stubEnv('TERMINAL_EMULATOR', '');
    expect(doctor('jb-off.json', {})).not.toContain(t('doctor.jetbrains'));
  });

  it('notes that priority overflow skips the tui style', () => {
    expect(doctor('tui-p.json', { style: 'tui', overflow: 'priority' })).toContain(t('doctor.priorityTui'));
    expect(doctor('tui.json', { style: 'tui' })).not.toContain(t('doctor.priorityTui'));
    expect(doctor('line-p.json', { overflow: 'priority' })).not.toContain(t('doctor.priorityTui'));
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

describe('runDoctor language', () => {
  const lines = (file: string, lang = 'tr') => withEnvLang(lang, () => capture(() => runDoctor(file)));

  it('follows CCINFOBAR_LANG and says where the language came from', () => {
    const out = lines(cfgFile('lang-auto.json', JSON.stringify({ lines: [[{ type: 'model' }]] })));
    expect(out).toContain('  Dil: Türkçe (tr, kaynak: CCINFOBAR_LANG)');
    expect(out).toContain(withLang('tr', () => t('doctor.backups', { dir: tildify(backupsDir()) })));
  });

  it('reads past CCINFOBAR_LANG=auto to LANG', () => {
    const file = cfgFile('lang-auto-env.json', JSON.stringify({ lines: [] }));
    vi.stubEnv('LC_ALL', '');
    vi.stubEnv('LANG', 'tr_TR.UTF-8');
    try {
      for (const v of ['auto', 'AUTO', '!!']) {
        expect(lines(file, v)).toContain('  Dil: Türkçe (tr, kaynak: LANG)');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets the config language win over the env', () => {
    const out = lines(
      cfgFile('lang-en.json', JSON.stringify({ language: 'en', lines: [[{ type: 'model' }]] })),
    );
    expect(out).toContain('  Language: English (en, from config)');
    expect(out).toContain(t('doctor.backups', { dir: tildify(backupsDir()) }));
  });

  it('names LC_ALL and the system locale', () => {
    const file = cfgFile('lang-c.json', JSON.stringify({ lines: [] }));
    expect(capture(() => runDoctor(file))).toContain('  Language: English (en, from LC_ALL)');
    vi.stubEnv('LANG', '');
    vi.stubEnv('LC_ALL', '');
    try {
      const out = withEnvLang('', () => capture(() => runDoctor(file)));
      // the ICU default decides (Turkish in the tr-locale CI job)
      const sys = envLanguage({});
      expect(['Intl', 'default']).toContain(sys.source);
      expect(out).toContain(withLang(sys.id, () => languageLine(sys)));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports a dropped language value, sanitized', () => {
    const bad = (value: unknown) =>
      lines(cfgFile('lang-bad.json', JSON.stringify({ language: value, lines: [] })), '').filter((l) =>
        l.startsWith('⚠ language'),
      );
    expect(bad('klingon')).toEqual([
      '⚠ language "klingon" is not supported and is ignored (use auto, en, tr)',
    ]);
    const [esc] = bad('x\u001b]0;pwn\u0007y');
    expect(esc).toBeDefined();
    expect(esc).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(bad(5)).toEqual(['⚠ language "5" is not supported and is ignored (use auto, en, tr)']);
    expect(bad('TR')).toEqual([]);
    expect(
      lines(cfgFile('lang-none.json', JSON.stringify({ lines: [] })), '').some((l) =>
        l.startsWith('⚠ language'),
      ),
    ).toBe(false);
  });

  it('prints the dropped value in Turkish under a Turkish env', () => {
    const out = lines(cfgFile('lang-bad-tr.json', JSON.stringify({ language: 'xx', lines: [] })));
    expect(out).toContain('⚠ language "xx" desteklenmiyor ve yok sayılıyor (auto, en, tr kullanın)');
  });
});

describe('runDoctor in Turkish', () => {
  const run = (file: string) => withEnvLang('tr', () => capture(() => runDoctor(file)));

  it('translates the report lines and keeps paths, versions and marks', () => {
    const file = cfgFile('tr.json', JSON.stringify({ lines: [[{ type: 'model' }]] }));
    const settings = claudeSettingsPath();
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'ccinfobar' } }));
    const out = run(file);
    expect(out).toContain(`✓ Node.js ${process.versions.node} (20+ gerekir)`);
    expect(out).toContain(`✓ Yapılandırma ${tildify(file)}`);
    expect(out).toContain(`✓ ${tildify(settings)} içindeki Claude Code statusLine: ccinfobar`);
    expect(out.some((l) => l.endsWith(` Son payload ${tildify(lastPayloadPath())}`))).toBe(true);
    expect(out).toContain(`  Önbellek dizini ${tildify(cacheDir())}`);
    expect(out.some((l) => /^ {2}Algılanan genişlik (bilinmiyor|\d+)$/.test(l))).toBe(true);
    expect(out).toContain('  Güncelleme denetimleri kapalı');
    expect(out).toContain('\nBileşenler');
    expect(out.join('\n')).not.toMatch(/Node\.js \S+ \(needs|Config |Cache dir|Last payload|Detected width/);
  });

  it('names a missing config, an unset statusLine and the install hint', () => {
    const missing = path.join(configDir(), 'missing-tr.json');
    const out = run(missing);
    expect(out).toContain(
      `✗ Yapılandırma ${tildify(missing)} (henüz oluşturulmadı, varsayılanlar kullanılıyor)`,
    );
    expect(out).toContain(`✗ ${tildify(claudeSettingsPath())} içindeki Claude Code statusLine: ayarlı değil`);
    expect(out.at(-1)).toMatch(/^\nClaude Code'da etkinleştirmek için `\S+( \S+)? install` çalıştırın\.$/);
  });

  it('translates the update mode and install kind words', () => {
    vi.stubEnv('CCINFOBAR_NO_UPDATE', '');
    vi.stubEnv('CI', '');
    try {
      const file = cfgFile('tr-notify.json', JSON.stringify({ update: 'notify', lines: [] }));
      const out = run(file);
      expect(out.some((l) => /^✓ Güncel \(güncelleme: yalnızca bildir, kurulum: [^,]+, /.test(l))).toBe(true);
      expect(
        capture(() => runDoctor(file)).some((l) => /^✓ Up to date \(notify mode, \S+ install, /.test(l)),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
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

  it('shows a rolled back and a failed-rollback update in both languages', () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const upd = path.join(cacheDir(), 'update.json');
    const write = (rollback: string) =>
      fs.writeFileSync(
        upd,
        JSON.stringify({
          checkedAt: Date.now(),
          latest: '9.9.9',
          rejected: '9.9.9',
          rollback,
          reason: 'version-mismatch:9.9.8',
        }),
      );
    const params = { version: '9.9.9', current: VERSION, reason: 'version-mismatch:9.9.8' };
    try {
      write('ok');
      const en = capture(() => runDoctor(plain()));
      expect(en).toContain(t('doctor.update.rolledBack', params));
      const tr = withEnvLang('tr', () => capture(() => runDoctor(plain())));
      expect(tr).toContain(withLang('tr', () => t('doctor.update.rolledBack', params)));
      write('failed');
      const bad = capture(() => runDoctor(plain())).find((l) => l.includes('rollback to'));
      expect(bad).toContain('npm install -g ccinfobar@');
    } finally {
      fs.rmSync(upd, { force: true });
    }
  });

  it('shows the last update check in the display language', () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const upd = path.join(cacheDir(), 'update.json');
    const at = new Date(2026, 9, 14, 21, 7);
    fs.writeFileSync(upd, JSON.stringify({ checkedAt: at.getTime(), latest: null }));
    vi.stubEnv('CCINFOBAR_NO_UPDATE', '');
    vi.stubEnv('CI', '');
    try {
      const line = () =>
        capture(() => runDoctor(plain())).find((l) => /^✓ (Up to date|Güncel) /.test(l)) ?? '';
      expect(line()).toMatch(/^✓ Up to date \(auto mode, \S+ install, last checked Oct 14, 2026, 21:07\)$/);
      expect(withEnvLang('tr', line)).toMatch(
        /^✓ Güncel \(güncelleme: otomatik, kurulum: .+, son denetim: 14 Eki 2026 21:07\)$/,
      );
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(upd, { force: true });
    }
  });

  it('says once when Claude Code turned off nonessential traffic', () => {
    const notices = () =>
      capture(() => runDoctor(plain())).filter((l) => l.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'));
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    try {
      expect(notices()).toEqual([t('doctor.jobs.nonessential')]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(notices()).toEqual([]);
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

describe('printWidgetReport', () => {
  const ws = () => fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'doctor-ws-'));

  const save = (extra: StatusPayload = {}): StatusPayload => {
    const dir = ws();
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', timestamp: '2026-10-12T11:59:00Z', message: { content: 'hi' } })}\n`,
    );
    const p: StatusPayload = {
      session_id: 'doctor-test',
      version: '2.1.401',
      cwd: dir,
      workspace: { current_dir: dir },
      model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      transcript_path: transcript,
      ...extra,
    };
    fs.mkdirSync(path.dirname(lastPayloadPath()), { recursive: true });
    fs.writeFileSync(lastPayloadPath(), JSON.stringify(p));
    return p;
  };

  afterEach(() => {
    fs.rmSync(lastPayloadPath(), { force: true });
  });

  const LAYOUT = JSON.stringify({
    lines: [
      [
        { id: 'model', type: 'model' },
        { id: 'branch', type: 'git-branch' },
        { id: 'flex', type: 'flex' },
      ],
      [{ id: 'hid', type: 'session-name', hideEmpty: true }],
    ],
  });

  it('prints compact rows from inspect and ends with the explain pointer', () => {
    save();
    const out = capture(() => printWidgetReport(cfgFile('rows.json', LAYOUT)));
    expect(out[0]).toBe('\nWidgets');
    expect(out).toContain('  ✓ L1 model: Opus 5.5');
    expect(out.find((l) => l.startsWith('  – L1 git-branch (branch): shows —, '))).toBe(
      `  – L1 git-branch (branch): shows —, ${t('explain.reason.no-git')}`,
    );
    expect(out.some((l) => /^ {2}✗ L2 session-name \(hid\): hidden \(hideEmpty\), \S/.test(l))).toBe(true);
    expect(out.some((l) => l.includes('flex'))).toBe(false);
    expect(out.at(-1)).toBe(t('doctor.explainPointer'));
  });

  it('names workspace mode for hidden git rows', () => {
    const p = save();
    fs.mkdirSync(path.join(p.cwd!, 'api', '.git'), { recursive: true });
    fs.writeFileSync(path.join(p.cwd!, 'api', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const layout = JSON.stringify({
      lines: [
        [
          { id: 'branch', type: 'git-branch' },
          { id: 'r', type: 'workspace-repos' },
        ],
        [{ id: 'hid', type: 'session-name', hideEmpty: true }],
      ],
    });
    const out = capture(() => printWidgetReport(cfgFile('ws.json', layout)));
    expect(out).toContain(
      `  ✗ L1 git-branch (branch): ${t('doctor.row.workspaceHidden')}, ${t('explain.reason.workspace-mode')}`,
    );
    expect(out).toContain('  ✓ L1 workspace-repos (r): api (main)');
    expect(out.some((l) => l.startsWith('  ✗ L2 session-name (hid): hidden (hideEmpty), '))).toBe(true);
  });

  it('prints rule-hidden rows with the rule reason', () => {
    save({ context_window: { context_window_size: 200_000, used_percentage: 42 } });
    const layout = JSON.stringify({
      lines: [[{ id: 'hot', type: 'model', hideEmpty: true, showWhen: 'context.pct >= 70' }]],
    });
    const out = capture(() => printWidgetReport(cfgFile('rule.json', layout)));
    const reason = t('explain.reason.hidden-by-rule', {
      key: 'showWhen',
      rule: 'context.pct >= 70',
      metric: 'context.pct',
      value: '42',
    });
    expect(out).toContain(`  ✗ L1 model (hot): ${t('doctor.hiddenByRule')}, ${reason}`);
    expect(out.some((l) => l.includes('hidden (hideEmpty)'))).toBe(false);
  });

  it('points to explain --scenario without a payload', () => {
    const out = capture(() => printWidgetReport(cfgFile('rows.json', LAYOUT)));
    expect(out).toEqual(['\nWidgets', t('doctor.noPayload')]);
    expect(t('doctor.noPayload')).toContain('ccinfobar explain --scenario');
  });

  it('merges the usage cache only when the status line would', () => {
    const prev = process.env.CCINFOBAR_NO_USAGE_API;
    delete process.env.CCINFOBAR_NO_USAGE_API;
    try {
      save({
        rate_limits: {
          five_hour: { used_percentage: 20, resets_at: null },
          seven_day: { used_percentage: 30, resets_at: null },
        },
      });
      fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
      fs.writeFileSync(
        usageFile(),
        JSON.stringify({
          fetchedAt: Date.now(),
          rate_limits: {
            five_hour: { used_percentage: 99, resets_at: null },
            spend_limit: { used_usd: 5, limit_usd: 50, used_percentage: 10 },
          },
        }),
      );
      const cfg = JSON.stringify({
        lines: [
          [
            { id: 'five-hour-usage', type: 'five-hour-usage' },
            { id: 'spend-limit', type: 'spend-limit' },
          ],
        ],
      });
      const out = capture(() => printWidgetReport(cfgFile('usage.json', cfg)));
      expect(out.some((l) => l.startsWith('  ✓ L1 five-hour-usage: ') && l.includes('20'))).toBe(true);
      expect(out.some((l) => l.startsWith('  – L1 spend-limit: shows —, '))).toBe(true);
      expect(out.join('\n')).not.toContain('99');
    } finally {
      if (prev === undefined) delete process.env.CCINFOBAR_NO_USAGE_API;
      else process.env.CCINFOBAR_NO_USAGE_API = prev;
      fs.rmSync(usageFile(), { force: true });
    }
  });

  const noColumns = () => {
    const cols = process.env.COLUMNS;
    delete process.env.COLUMNS;
    return () => {
      if (cols !== undefined) process.env.COLUMNS = cols;
    };
  };

  it('uses the cached width of the last session and warns about a cut line', () => {
    const restore = noColumns();
    const width = path.join(cacheDir(), 'width-doctor-test.json');
    try {
      save();
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(width, JSON.stringify({ width: 12, at: Date.now() - 3_600_000 }));
      const cfg = JSON.stringify({
        autoWrap: false,
        lines: [[{ type: 'model' }, { type: 'session-cost' }, { type: 'model', id: 'm2' }]],
      });
      const out = capture(() => runDoctor(cfgFile('cut.json', cfg)));
      expect(out).toContain('  Detected width 12');
      expect(out.some((l) => l.startsWith('\n  Width: 12 columns detected, '))).toBe(true);
      const cut = out.find((l) => l.startsWith('  ⚠ Line 1 needs '))!;
      expect(cut).toMatch(/^ {2}⚠ Line 1 needs \d+ columns/);
      expect(cut).toBe(t('doctor.lineCut', { line: 1, need: /needs (\d+)/.exec(cut)![1]! }));
      expect(cut).toContain('"overflow": "priority"');
      for (const overflow of ['priority', 'wrap']) {
        const other = JSON.stringify({ ...JSON.parse(cfg), overflow });
        const lines = capture(() => runDoctor(cfgFile(`cut-${overflow}.json`, other)));
        expect(lines.some((l) => l.includes('⚠ Line'))).toBe(false);
      }
    } finally {
      fs.rmSync(width, { force: true });
      restore();
    }
  });

  it('runDoctor writes nothing under the cache dir and runs no ps or stty', () => {
    const restore = noColumns();
    try {
      save();
      const list = () =>
        fs.existsSync(cacheDir()) ? fs.readdirSync(cacheDir(), { recursive: true }).map(String).sort() : [];
      const before = list();
      const exec = vi.spyOn(cp, 'execFileSync');
      module.syncBuiltinESMExports();
      const out = capture(() => runDoctor(cfgFile('ro2.json', LAYOUT)));
      expect(out).toContain('  Detected width unknown');
      expect(list()).toEqual(before);
      expect(exec.mock.calls.filter((c) => c[0] === 'ps' || c[0] === 'stty')).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      module.syncBuiltinESMExports();
      restore();
    }
  });

  it('reports the usage cache even when no limits widget needs it', () => {
    const prev = process.env.CCINFOBAR_NO_USAGE_API;
    delete process.env.CCINFOBAR_NO_USAGE_API;
    try {
      save();
      fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
      fs.writeFileSync(usageFile(), JSON.stringify({ fetchedAt: Date.now(), error: 'rate limited' }));
      const out = capture(() => printWidgetReport(cfgFile('nolimits.json', LAYOUT)));
      expect(out).toContain('  Usage limits: no data from the usage API (last error: rate limited)');
    } finally {
      if (prev === undefined) delete process.env.CCINFOBAR_NO_USAGE_API;
      else process.env.CCINFOBAR_NO_USAGE_API = prev;
      fs.rmSync(usageFile(), { force: true });
    }
  });

  it('writes nothing under the cache dir', () => {
    save();
    const list = () =>
      fs.existsSync(cacheDir()) ? fs.readdirSync(cacheDir(), { recursive: true }).map(String).sort() : [];
    const before = list();
    const cfg = JSON.stringify({
      lines: [[{ type: 'message-count' }, { type: 'subagents' }, { type: 'model' }]],
    });
    capture(() => printWidgetReport(cfgFile('ro.json', cfg)));
    expect(list()).toEqual(before);
  });

  it('prints the report words in Turkish and keeps types, ids and versions', () => {
    save();
    const out = withLang('tr', () => capture(() => printWidgetReport(cfgFile('rows-tr.json', LAYOUT))));
    expect(out[0]).toBe('\nBileşenler');
    expect(out.some((l) => l.startsWith('  Son payload: Claude Code 2.1.401, alanlar: '))).toBe(true);
    expect(out).toContain('  ✓ L1 model: Opus 5.5');
    expect(out.some((l) => l.startsWith('  – L1 git-branch (branch): — gösteriyor, '))).toBe(true);
    expect(out.some((l) => l.startsWith('  ✗ L2 session-name (hid): gizli (hideEmpty), '))).toBe(true);
    expect(out.some((l) => l.startsWith('  Kullanım limitleri: '))).toBe(true);
    expect(out.some((l) => /^\n {2}Genişlik: /.test(l))).toBe(true);
    expect(out.join('\n')).not.toMatch(/Last payload|Usage limits|shows —|hidden|columns detected/);
  });
});

describe('usageLine', () => {
  const cfg = defaultConfig();
  const now = 1_000 * 60_000;
  const both = {
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: null },
      seven_day: { used_percentage: 2, resets_at: null },
    },
  };
  const cases: [string, Parameters<typeof usageLine>, string, string][] = [
    [
      'from Claude Code',
      [cfg, both, null, now],
      'Usage limits: from Claude Code',
      "Kullanım limitleri: Claude Code'dan",
    ],
    [
      'off',
      [{ ...cfg, usageApi: false }, {}, null, now],
      'Usage limits: usage API off (usageApi: false)',
      "Kullanım limitleri: kullanım API'si kapalı (usageApi: false)",
    ],
    [
      'not called',
      [cfg, {}, null, now],
      'Usage limits: usage API not called yet',
      "Kullanım limitleri: kullanım API'si henüz çağrılmadı",
    ],
    [
      'fresh',
      [cfg, {}, { fetchedAt: now - 3 * 60_000, rate_limits: both.rate_limits }, now],
      'Usage limits: from the usage API, 3 min old',
      "Kullanım limitleri: kullanım API'sinden, 3 dk önce",
    ],
    [
      'fresh with an error',
      [cfg, {}, { fetchedAt: now, rate_limits: both.rate_limits, error: 'boom' }, now],
      'Usage limits: from the usage API, 0 min old (last error: boom)',
      "Kullanım limitleri: kullanım API'sinden, 0 dk önce (son hata: boom)",
    ],
    [
      'no data',
      [cfg, {}, { fetchedAt: now }, now],
      'Usage limits: no data from the usage API',
      "Kullanım limitleri: kullanım API'sinden veri yok",
    ],
    [
      'a stored usage error',
      [cfg, {}, { fetchedAt: now, error: 'rate limited by the usage API' }, now],
      'Usage limits: no data from the usage API (last error: rate limited by the usage API)',
      "Kullanım limitleri: kullanım API'sinden veri yok (son hata: kullanım API'si istekleri sınırladı)",
    ],
  ];

  it.each(cases)('%s', (_name, args, english, turkish) => {
    const prev = process.env.CCINFOBAR_NO_USAGE_API;
    delete process.env.CCINFOBAR_NO_USAGE_API;
    try {
      expect(usageLine(...args)).toBe(english);
      expect(withLang('tr', () => usageLine(...args))).toBe(turkish);
    } finally {
      if (prev !== undefined) process.env.CCINFOBAR_NO_USAGE_API = prev;
    }
  });
});

describe('runDoctor background jobs', () => {
  const plain = () => cfgFile('jobs.json', JSON.stringify({ lines: [[{ type: 'model' }]] }));
  const block = (out: string[]) => {
    const i = out.indexOf(t('doctor.jobs.heading'));
    expect(i).toBeGreaterThanOrEqual(0);
    const rest = out.slice(i + 1);
    const end = rest.findIndex((l) => !l.startsWith('  '));
    return end < 0 ? rest : rest.slice(0, end);
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(jobsDir(), { recursive: true, force: true });
  });

  it('lists each job with its age, ok or error and retry time', () => {
    const now = Date.now();
    writeEnvelope(okEnvelope('update', { latest: '0.6.2' }, now - 2 * 60_000));
    writeEnvelope(
      failEnvelope(usageKey(), null, 'rate limited by the usage API', now - 60_000, { blockMs: 5 * 60_000 }),
    );
    const lines = block(capture(() => runDoctor(plain())));
    expect(lines).toContain(t('doctor.jobs.ok', { key: 'update', age: '2m' }));
    const usage = lines.find((l) => l.includes(usageKey())) ?? '';
    expect(usage).toMatch(
      /^ {2}usage-[0-9a-f]{16}: error: rate limited by the usage API, 1m ago, retry in 4m$/,
    );
    expect(lines.indexOf(usage)).toBeGreaterThan(lines.findIndex((l) => l.includes('update')));
  });

  it('says when nonessential traffic turns off the auto jobs', () => {
    writeEnvelope(okEnvelope('update', { latest: '0.6.2' }, Date.now()));
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    const lines = block(capture(() => runDoctor(plain())));
    expect(lines).toContain(t('doctor.jobs.nonessential'));
    expect(t('doctor.jobs.nonessential')).toMatch(/usage, update and status/);
    expect(lines.find((l) => l.includes('update:'))).toContain(t('doctor.jobs.offTraffic'));
    expect(lines).not.toContain(t('doctor.jobs.disabled'));
  });

  it('says when CCINFOBAR_NO_JOBS turns off every job', () => {
    writeEnvelope(okEnvelope('update', { latest: '0.6.2' }, Date.now()));
    vi.stubEnv('CCINFOBAR_NO_JOBS', '1');
    const lines = block(capture(() => runDoctor(plain())));
    expect(lines).toContain(t('doctor.jobs.disabled'));
    expect(lines.find((l) => l.includes('update:'))).toContain(t('doctor.jobs.offAll'));
    expect(lines).not.toContain(t('doctor.jobs.nonessential'));
  });

  it('strips terminal escapes from job errors and never prints env values', () => {
    vi.stubEnv('CCINFOBAR_NO_JOBS', 'secret-value-123');
    const dir = jobsDir();
    fs.mkdirSync(dir, { recursive: true });
    const e = {
      v: 1,
      key: 'status',
      fetchedAt: Date.now(),
      ok: false,
      value: null,
      error: 'bad\u001b[31mred',
    };
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(e));
    const out = capture(() => runDoctor(plain()));
    const lines = block(out);
    expect(lines.find((l) => l.includes('status:'))).toContain('bad');
    expect(lines.join('\n')).not.toContain('\u001b');
    expect(out.join('\n')).not.toContain('secret-value-123');
  });

  it('skips odd file names and non-envelope JSON', () => {
    const dir = jobsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '..x.json'),
      JSON.stringify({ v: 1, key: '..x', fetchedAt: 1, ok: true }),
    );
    fs.writeFileSync(
      path.join(dir, 'Bad.json'),
      JSON.stringify({ v: 1, key: 'Bad', fetchedAt: 1, ok: true }),
    );
    fs.writeFileSync(path.join(dir, 'junk.json'), '[1,2]');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    fs.writeFileSync(
      path.join(dir, 'other.json'),
      JSON.stringify({ v: 1, key: 'nope', fetchedAt: 1, ok: true }),
    );
    fs.mkdirSync(path.join(dir, 'folder.json'));
    fs.writeFileSync(path.join(dir, 'update.lock'), '');
    const lines = block(capture(() => runDoctor(plain())));
    expect(lines).toEqual([t('doctor.jobs.none')]);
  });

  it('says no background data yet without a jobs dir', () => {
    expect(block(capture(() => runDoctor(plain())))).toEqual([t('doctor.jobs.none')]);
    expect(fs.existsSync(jobsDir())).toBe(false);
  });

  it('sweeps stale temp files from the jobs dir', () => {
    const dir = jobsDir();
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'status.json.1.abcd1234.tmp');
    fs.writeFileSync(stale, '{}');
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(stale, old, old);
    const out = capture(() => runDoctor(plain()));
    expect(out).toContain(t('doctor.tmpPruned', { count: 1 }));
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('runDoctor http checks', () => {
  const TOKEN = 'tok-SECRET-abc';
  const URL = 'https://api.x.com/v1?key=${API_KEY}';
  const HEADERS = 'Authorization=Bearer $RELAY_TOKEN';
  const http = (options: Record<string, unknown>) =>
    cfgFile('http.json', JSON.stringify({ lines: [[{ type: 'model' }], [{ type: 'http', options }]] }));
  const all = (options: Record<string, unknown>) => capture(() => runDoctor(http(options)));

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(jobsDir(), { recursive: true, force: true });
  });

  it('names a literal header without its value', () => {
    const out = all({ url: 'https://api.example.com/x', headers: 'Authorization=Bearer lit-SECRET-abc' });
    expect(out).toContain(
      t('doctor.http.badHeader', {
        line: 2,
        error: "header 'Authorization': literal values are not allowed; use Name=$VAR",
      }),
    );
    expect(out.join('\n')).not.toContain('lit-SECRET');
  });

  it('reports bad header entries, urls and paths', () => {
    const out = all({ url: 'https://${H}.x.com', headers: 'X-Key', path: '$.foo-bar' });
    expect(out).toContain(t('doctor.http.badHeader', { line: 2, error: 'header 1: expected Name=$VAR' }));
    expect(out).toContain(
      t('doctor.http.badUrl', { line: 2, error: 'placeholders are only allowed in query values' }),
    );
    expect(out).toContain(
      t('doctor.http.badPath', { line: 2, error: "unexpected '-' at 5; use ['foo-bar']" }),
    );
    expect(all({}).join('\n')).toContain(t('doctor.http.noUrl', { line: 2 }));
  });

  it('warns about plain http unless the host is loopback', () => {
    const plain = all({ url: 'http://api.example.com/x' });
    expect(plain).toContain(t('doctor.http.plain', { line: 2, host: 'api.example.com' }));
    for (const url of [
      'http://localhost:8080/x',
      'http://127.0.0.1/x',
      'http://[::1]:9/x',
      'https://a.b/x',
    ]) {
      expect(
        all({ url }).some((l) => l.includes('plain http')),
        url,
      ).toBe(false);
    }
  });

  it('reports env values over plain http as an error', () => {
    for (const opts of [
      { url: 'http://api.example.com/x', headers: 'Authorization=Bearer $T' },
      { url: 'http://api.example.com/x?key=${K}' },
    ]) {
      const out = all(opts);
      expect(out).toContain(t('doctor.http.badUrl', { line: 2, error: 'secrets need https or localhost' }));
      expect(out.some((l) => l.includes('plain http'))).toBe(false);
    }
  });

  it('reports denied env names', () => {
    const out = all({ url: 'https://attacker.example/x', headers: 'X=$ANTHROPIC_API_KEY' });
    expect(out).toContain(
      t('doctor.http.refusedHeader', {
        line: 2,
        error: 'env ANTHROPIC_API_KEY is not allowed in http items',
      }),
    );
    const query = all({ url: 'https://attacker.example/x?k=${AWS_SECRET_ACCESS_KEY}' });
    expect(query).toContain(
      t('doctor.http.badUrl', { line: 2, error: 'env AWS_SECRET_ACCESS_KEY is not allowed in http items' }),
    );
  });

  it('lists each item with its redacted url and env var names, never values', () => {
    vi.stubEnv('RELAY_TOKEN', TOKEN);
    vi.stubEnv('API_KEY', '');
    const out = all({ url: URL, headers: HEADERS, path: '$.data.balance' });
    expect(out).toContain(
      t('doctor.http.item', {
        line: 2,
        url: 'https://api.x.com/v1?key=\u2026',
        env: 'Authorization=$RELAY_TOKEN (set), $API_KEY (unset)',
      }),
    );
    expect(out.join('\n')).not.toContain(TOKEN);
    const bare = all({ url: 'https://api.x.com/v1' });
    expect(bare).toContain(
      t('doctor.http.item', { line: 2, url: 'https://api.x.com/v1', env: t('doctor.http.noEnv') }),
    );
  });

  it('maps http job keys to their redacted urls', () => {
    vi.stubEnv('RELAY_TOKEN', TOKEN);
    const key = httpKey(URL, HEADERS);
    writeEnvelope(okEnvelope(key, { paths: {} }, Date.now() - 60_000));
    writeEnvelope(failEnvelope('http-0123456789abcdef', null, 'env RELAY_TOKEN not set', Date.now()));
    const out = all({ url: URL, headers: HEADERS });
    const line = out.find((l) => l.includes(key)) ?? '';
    expect(line).toBe(
      t('doctor.jobs.ok', { key, age: '1m' }) +
        t('doctor.jobs.httpUrl', { url: 'https://api.x.com/v1?key=\u2026' }),
    );
    expect(out.find((l) => l.includes('http-0123456789abcdef'))).toContain(t('doctor.jobs.httpUnused'));
    expect(out.join('\n')).not.toContain(TOKEN);
  });

  it('notes the subprocess env scrub', () => {
    expect(all({ url: URL })).not.toContain(t('doctor.jobs.scrub'));
    vi.stubEnv('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', '1');
    expect(all({ url: URL })).toContain(t('doctor.jobs.scrub'));
    expect(t('doctor.jobs.scrub')).toMatch(/secret-looking variables/);
  });

  it('strips terminal escapes from config text', () => {
    const out = all({ url: 'https://a.b/x', path: '$.\u001b[31m' }).join('\n');
    expect(out).not.toContain('\u001b');
  });
});
