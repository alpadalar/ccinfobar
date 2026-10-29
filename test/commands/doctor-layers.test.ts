import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetLanguageCache } from '../../src/cli/lang.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { manifestFile } from '../../src/commands/manifest.js';
import { t } from '../../src/core/i18n/index.js';
import { claudeSettingsPath, configDir, lastPayloadPath, tildify } from '../../src/core/paths.js';

const ROOT = process.env.CCIB_TEST_ROOT as string;
const PROJECT = path.join(ROOT, 'layers-project');
const MANAGED = path.join(ROOT, 'layers-managed', 'managed-settings.json');
const PROJECT_FILE = path.join(PROJECT, '.claude', 'settings.json');
const LOCAL_FILE = path.join(PROJECT, '.claude', 'settings.local.json');
const HOME_DIR = path.join(ROOT, 'layers-home');
const A = path.join(ROOT, 'layers-a');
const A_FILE = path.join(A, '.claude', 'settings.json');
const A_LOCAL = path.join(A, '.claude', 'settings.local.json');

const put = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};

const cfg = (extra: object = {}) => {
  const file = path.join(configDir(), 'doctor-layers.json');
  put(file, { lines: [[{ type: 'model' }]], ...extra });
  return file;
};

const doctorAt = (
  cwd: string,
  projectDir: string | null,
  extra: object = {},
  managedFiles: string[] = [],
): string[] => {
  if (projectDir) put(lastPayloadPath(), { workspace: { project_dir: projectDir } });
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    runDoctor(cfg(extra), { managedFiles });
    return spy.mock.calls.map((c) => c.map(String).join(' '));
  } finally {
    spy.mockRestore();
  }
};

// the repo's own .claude must not leak in
const doctor = (extra: object = {}, managedFiles: string[] = []): string[] =>
  doctorAt(path.join(ROOT, 'layers-cwd'), PROJECT, extra, managedFiles);

const USER_SL = { statusLine: { type: 'command', command: '/bin/ccinfobar' } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetLanguageCache();
  for (const f of [claudeSettingsPath(), manifestFile(), lastPayloadPath(), MANAGED]) {
    fs.rmSync(f, { force: true });
  }
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  fs.rmSync(A, { recursive: true, force: true });
});

const effective = (layer: string, file: string, command: string) =>
  t('doctor.statusLineEffective', { layer, file: tildify(file), command });

describe('doctor effective layer', () => {
  it('names the project statusLine that overrides the user file', () => {
    put(claudeSettingsPath(), USER_SL);
    put(PROJECT_FILE, { statusLine: { type: 'command', command: 'other --x' } });
    const out = doctor();
    expect(out).toContain(effective('project', PROJECT_FILE, 'other --x'));
    expect(out.some((l) => l.includes('overrides it with: other --x'))).toBe(true);
  });

  it('local beats project', () => {
    put(claudeSettingsPath(), USER_SL);
    put(PROJECT_FILE, { statusLine: { command: 'p' } });
    put(LOCAL_FILE, { statusLine: { command: 'l' } });
    expect(doctor()).toContain(effective('local', LOCAL_FILE, 'l'));
  });

  it('managed beats local', () => {
    put(claudeSettingsPath(), USER_SL);
    put(LOCAL_FILE, { statusLine: { command: 'l' } });
    put(MANAGED, { statusLine: { command: 'm' } });
    expect(doctor({}, [MANAGED])).toContain(effective('managed', MANAGED, 'm'));
  });

  it('names a project subagentStatusLine even when the user file has none', () => {
    put(claudeSettingsPath(), USER_SL);
    put(PROJECT_FILE, { subagentStatusLine: { command: 'sub --y' } });
    const out = doctor();
    expect(out).toContain(
      t('doctor.subagentLineEffective', {
        layer: 'project',
        file: tildify(PROJECT_FILE),
        command: 'sub --y',
      }),
    );
  });

  it('an empty overriding statusLine says unset', () => {
    put(claudeSettingsPath(), USER_SL);
    put(PROJECT_FILE, { statusLine: {}, subagentStatusLine: { type: 'command' } });
    const out = doctor();
    expect(out).toContain(effective('project', PROJECT_FILE, t('install.unset')));
    expect(out).toContain(
      t('doctor.subagentLineEffective', {
        layer: 'project',
        file: tildify(PROJECT_FILE),
        command: t('install.unset'),
      }),
    );
    expect(out.some((l) => l.includes(': undefined'))).toBe(false);
  });

  it('an empty overriding statusLine says unset in tr', () => {
    put(claudeSettingsPath(), USER_SL);
    put(PROJECT_FILE, { statusLine: {} });
    const out = doctor({ language: 'tr' });
    expect(out.some((l) => l.includes('ayarlı değil'))).toBe(true);
    expect(out.some((l) => l.includes('undefined'))).toBe(false);
  });

  it('prints no effective line for a user-only setup', () => {
    put(claudeSettingsPath(), { ...USER_SL, subagentStatusLine: { command: '/bin/sub' } });
    const out = doctor();
    expect(out.some((l) => l.includes('Claude Code uses the'))).toBe(false);
  });

  describe('vim warning', () => {
    const vim = { lines: [[{ type: 'vim-mode' }]] };
    const warn = (out: string[]) =>
      out.some((l) => l.includes(t('doctor.vimTwice', { command: '' }).slice(0, 30)));
    it('is silent when the effective statusLine hides the indicator', () => {
      put(claudeSettingsPath(), { ...USER_SL, editorMode: 'vim' });
      put(PROJECT_FILE, { statusLine: { command: 'p', hideVimModeIndicator: true } });
      expect(warn(doctor(vim))).toBe(false);
    });
    it('is loud when only the user file hides it under a project override', () => {
      put(claudeSettingsPath(), {
        statusLine: { command: '/bin/ccinfobar', hideVimModeIndicator: true },
        editorMode: 'vim',
      });
      put(PROJECT_FILE, { statusLine: { command: 'p' } });
      expect(warn(doctor(vim))).toBe(true);
    });
  });

  it('turkish puts the file first', () => {
    put(claudeSettingsPath(), USER_SL);
    put(PROJECT_FILE, { statusLine: { command: 'other' } });
    const out = doctor({ language: 'tr' });
    expect(out).toContain(
      `  Claude Code ${tildify(PROJECT_FILE)} içindeki project statusLine ayarını kullanıyor: other`,
    );
  });
});

describe('doctor run from the home folder', () => {
  it('run from the home folder prints no effective line', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(HOME_DIR, '.claude'));
    put(claudeSettingsPath(), {
      ...USER_SL,
      subagentStatusLine: { type: 'command', command: '/bin/ccinfobar subagent-line' },
    });
    const out = doctorAt(HOME_DIR, HOME_DIR);
    expect(out.some((l) => l.includes('Claude Code uses the'))).toBe(false);
  });

  it('run from the home folder prints a user-file hook warning once', () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(HOME_DIR, '.claude'));
    put(claudeSettingsPath(), { ...USER_SL, disableAllHooks: true });
    const out = doctorAt(HOME_DIR, HOME_DIR);
    expect(out.filter((l) => l.includes('disableAllHooks')).length).toBe(1);
  });
});

describe('doctor chains per project folder', () => {
  const vim = { lines: [[{ type: 'vim-mode' }]] };

  it('keeps the folder doctor runs in and the last session project apart', () => {
    put(claudeSettingsPath(), USER_SL);
    put(A_FILE, { statusLine: { command: 'a-cmd' } });
    put(LOCAL_FILE, { statusLine: { command: 'l' } });
    const out = doctorAt(A, PROJECT);
    expect(out).toContain(effective('project', A_FILE, 'a-cmd'));
    expect(out).toContain(effective('local', LOCAL_FILE, 'l'));
  });

  it('vim warning checks each project chain', () => {
    put(claudeSettingsPath(), { ...USER_SL, editorMode: 'vim' });
    put(A_FILE, { statusLine: { command: 'a', hideVimModeIndicator: true } });
    put(PROJECT_FILE, { statusLine: { command: 'p' } });
    const out = doctorAt(A, PROJECT, vim);
    const hits = out.filter((l) => l.includes(t('doctor.vimTwice', { command: '' }).slice(0, 30)));
    expect(hits.length).toBe(1);
  });

  it('progress-bar warning is per chain and printed once', () => {
    put(claudeSettingsPath(), USER_SL);
    put(A_LOCAL, { terminalProgressBarEnabled: false });
    fs.mkdirSync(PROJECT, { recursive: true });
    const out = doctorAt(A, PROJECT, { progress: { enabled: true } });
    const line = t('doctor.progress.ccBar', { file: tildify(claudeSettingsPath()) });
    expect(out.filter((l) => l === line).length).toBe(1);
  });

  it('a managed hook warning prints once with two chains', () => {
    put(claudeSettingsPath(), USER_SL);
    put(MANAGED, { disableAllHooks: true });
    fs.mkdirSync(PROJECT, { recursive: true });
    const out = doctorAt(A, PROJECT, {}, [MANAGED]);
    expect(out.filter((l) => l.includes('disableAllHooks')).length).toBe(1);
  });
});

describe('doctor terminal-escape safety', () => {
  it.skipIf(process.platform === 'win32')(
    'prints project-derived paths without raw control characters',
    () => {
      const evil = path.join(ROOT, 'layers-evil-\x1b[31m-\x07');
      try {
        put(claudeSettingsPath(), USER_SL);
        put(path.join(evil, '.claude', 'settings.json'), {
          statusLine: { type: 'command', command: 'other --x' },
        });
        const out = doctorAt(evil, null).join('\n');
        expect(out).toContain('other --x');
        expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
      } finally {
        fs.rmSync(evil, { recursive: true, force: true });
      }
    },
  );
});
