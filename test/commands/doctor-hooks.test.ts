import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/commands/doctor.js';
import { shortAge } from '../../src/commands/explain.js';
import { DEFAULT_EVENTS } from '../../src/commands/hooks-install.js';
import { applyInstall, planInstall } from '../../src/commands/install.js';
import { manifestFile, readManifest, writeManifest } from '../../src/commands/manifest.js';
import { t } from '../../src/core/i18n/index.js';
import { claudeSettingsPath, configDir, lastPayloadPath, tildify } from '../../src/core/paths.js';
import { hooksDir } from '../../src/data/hooks.js';

const ROOT = process.env.CCIB_TEST_ROOT as string;
const MANAGED = path.join(ROOT, 'managed', 'managed-settings.json');
const SID = 'doctor-hooks-sid';
const COMMAND = '/nonexistent/ccinfobar';

const cfg = () => {
  const file = path.join(configDir(), 'doctor-hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ lines: [[{ type: 'model' }]] }));
  return file;
};

const doctor = (managedFiles: string[] = []): string[] => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    runDoctor(cfg(), { managedFiles });
    return spy.mock.calls.map((c) => c.map(String).join(' '));
  } finally {
    spy.mockRestore();
  }
};

const install = () =>
  applyInstall(planInstall({ file: claudeSettingsPath(), command: COMMAND }), {
    confirmed: true,
    hooks: { events: DEFAULT_EVENTS, claudeCode: '2.1.299' },
  });

const readSettings = () => JSON.parse(fs.readFileSync(claudeSettingsPath(), 'utf8'));
const writeSettings = (data: unknown) => {
  fs.mkdirSync(path.dirname(claudeSettingsPath()), { recursive: true });
  fs.writeFileSync(claudeSettingsPath(), JSON.stringify(data, null, 2));
};

const log = path.join(hooksDir(), `${SID}.jsonl`);
const fold = path.join(hooksDir(), `${SID}.fold.json`);

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of [claudeSettingsPath(), manifestFile(), lastPayloadPath(), log, fold, MANAGED]) {
    fs.rmSync(f, { force: true });
  }
});

describe('doctor Hooks block', () => {
  it('lists the hook entries with the recorded Claude Code version and flags a missing binary', () => {
    install();
    const out = doctor();
    expect(out).toContain(t('doctor.hooks.summary', { count: 6, versions: '2.1.299' }));
    for (const e of DEFAULT_EVENTS) {
      expect(out).toContain(t('doctor.hooks.entry', { event: e, claudeCode: '2.1.299' }));
    }
    expect(out).toContain(t('doctor.hooks.missingBinary', { command: COMMAND, count: 6 }));
    expect(out.some((l) => l === t('doctor.hooks.off'))).toBe(false);
  });

  it('warns about a hook group changed outside ccinfobar', () => {
    install();
    const data = readSettings();
    const stop = data.hooks.Stop;
    stop[stop.length - 1].hooks[0].timeout = 30;
    writeSettings(data);
    const out = doctor();
    expect(out).toContain(t('doctor.hooks.edited', { event: 'Stop' }));
    expect(out).not.toContain(t('doctor.hooks.edited', { event: 'SessionStart' }));
  });

  it('warns about a removed hook group', () => {
    install();
    const data = readSettings();
    delete data.hooks.SubagentStop;
    writeSettings(data);
    expect(doctor()).toContain(t('doctor.hooks.edited', { event: 'SubagentStop' }));
  });

  it('warns when disableAllHooks is on in user settings', () => {
    writeSettings({ disableAllHooks: true });
    const out = doctor();
    const line = t('doctor.hooks.disableAll', { layer: 'user', file: tildify(claudeSettingsPath()) });
    expect(out).toContain(line);
    expect(line).toContain('no status line');
    expect(out).toContain(t('doctor.hooks.managedNote'));
  });

  it('ignores disableAllHooks values other than true', () => {
    writeSettings({ disableAllHooks: 'true' });
    expect(doctor().some((l) => l.includes('disableAllHooks'))).toBe(false);
  });

  it('reads managed settings for disableAllHooks and allowManagedHooksOnly', () => {
    fs.mkdirSync(path.dirname(MANAGED), { recursive: true });
    fs.writeFileSync(MANAGED, `﻿${JSON.stringify({ disableAllHooks: true, allowManagedHooksOnly: true })}`);
    const out = doctor([MANAGED]);
    expect(out).toContain(t('doctor.hooks.disableAll', { layer: 'managed', file: tildify(MANAGED) }));
    expect(out).toContain(t('doctor.hooks.managedOnly', { file: tildify(MANAGED) }));
  });

  it('shows the last hook event age without writing the fold cache', () => {
    install();
    fs.mkdirSync(path.dirname(lastPayloadPath()), { recursive: true });
    fs.writeFileSync(lastPayloadPath(), JSON.stringify({ session_id: SID, version: '2.1.299' }));
    fs.mkdirSync(hooksDir(), { recursive: true });
    fs.writeFileSync(log, `${JSON.stringify({ v: 1, t: Date.now() - 120_000, e: 'Stop' })}\n`);
    const out = doctor();
    expect(out).toContain(t('doctor.hooks.lastEvent', { age: shortAge(120_000) }));
    expect(fs.existsSync(fold)).toBe(false);
  });

  it('says when no hook event was logged for the last session', () => {
    install();
    fs.mkdirSync(path.dirname(lastPayloadPath()), { recursive: true });
    fs.writeFileSync(lastPayloadPath(), JSON.stringify({ session_id: SID, version: '2.1.299' }));
    expect(doctor()).toContain(t('doctor.hooks.noEvents'));
  });

  it('says hooks are off and how to turn them on', () => {
    const out = doctor();
    expect(out).toContain(t('doctor.hooks.off'));
    expect(t('doctor.hooks.off')).toContain('ccinfobar install --hooks');
    expect(out.some((l) => l.includes('Hook command not found'))).toBe(false);
  });

  it('strips terminal escapes from recorded hook values', () => {
    install();
    const m = readManifest();
    const entries = m.entries.map((e) =>
      e.kind === 'hook'
        ? {
            ...e,
            event: 'Stop\u001b[2J',
            claudeCode: '2.1.299\u001b]0;x\u0007',
            value: { hooks: [{ type: 'command', command: '/nope/\u001b[31mccinfobar hook Stop' }] },
          }
        : e,
    );
    writeManifest({ ...m, entries });
    const out = doctor();
    expect(out.some((l) => l.includes('Hook command not found'))).toBe(true);
    expect(out.filter((l) => l.includes('\u001b') || l.includes('\u0007'))).toEqual([]);
  });
});
