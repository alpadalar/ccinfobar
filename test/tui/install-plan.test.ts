import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { runEffect } from '../../src/tui/index.js';
import { initialState, reduce, type State, type TuiInstallPlan } from '../../src/tui/state.js';
import { installQuestion } from '../../src/tui/view.js';

const FOREIGN: TuiInstallPlan = { current: 'npx ccstatusline', proposed: 'ccinfobar', needsConfirm: true };

let dir: string;
let settings: string;
let configFile: string;
let prevConfig: string | undefined;

const fresh = (): State => initialState(defaultConfig(), configFile);
const deps = () => ({ command: () => 'ccinfobar', settingsFile: settings });

function writeForeign(): Buffer {
  fs.writeFileSync(
    settings,
    `${JSON.stringify({ statusLine: { type: 'command', command: 'npx ccstatusline' } }, null, 2)}\n`,
  );
  return fs.readFileSync(settings);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tui-plan-'));
  settings = path.join(dir, 'settings.json');
  configFile = path.join(dir, 'config.json');
  prevConfig = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevConfig;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TUI install reducer', () => {
  it('plans first instead of opening the confirm', () => {
    const s = reduce(fresh(), { type: 'install' });
    expect(s.effect).toEqual({ kind: 'planInstall' });
    expect(s.mode.kind).toBe('normal');
  });

  it('opens the replace question for a foreign plan', () => {
    const s = reduce(reduce(fresh(), { type: 'install' }), { type: 'installPlanned', plan: FOREIGN });
    expect(s.effect).toBeNull();
    expect(s.mode).toEqual({ kind: 'confirm', what: 'install', plan: FOREIGN });
    expect(installQuestion(FOREIGN)).toBe(
      t('tui.replaceQuestion', { current: 'npx ccstatusline', proposed: 'ccinfobar' }),
    );
  });

  it('keeps the plain question when no confirm is needed', () => {
    const plan = { current: null, proposed: 'ccinfobar', needsConfirm: false };
    const s = reduce(fresh(), { type: 'installPlanned', plan });
    expect(s.mode).toEqual({ kind: 'confirm', what: 'install', plan });
    expect(installQuestion(plan)).toBe("Set Claude Code's statusLine to ccinfobar?");
  });

  it('sanitizes the foreign command in the question', () => {
    const q = installQuestion({ ...FOREIGN, current: 'evil\u001b]0;x\u0007‮\ncmd' });
    expect(q).not.toMatch(/[\u0000-\u001f\u007f‮]/);
  });

  it('yes confirms the install, no leaves', () => {
    const asking = reduce(fresh(), { type: 'installPlanned', plan: FOREIGN });
    const yes = reduce(asking, { type: 'confirm', answer: 'yes' });
    expect(yes.effect).toEqual({ kind: 'install', confirmed: true, plan: FOREIGN });
    expect(yes.mode.kind).toBe('normal');
    const no = reduce(asking, { type: 'confirm', answer: 'no' });
    expect(no.effect).toBeNull();
    expect(no.mode.kind).toBe('normal');
    expect(no.config).toBe(asking.config);
  });
});

describe('TUI install effects', () => {
  it('planInstall returns the plan without writing', () => {
    const before = writeForeign();
    const out = runEffect(fresh(), { kind: 'planInstall' }, deps());
    expect(out).toEqual({ type: 'installPlanned', plan: FOREIGN });
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
    expect(fs.existsSync(configFile)).toBe(false);
  });

  it('install writes through applyInstall and reports the backups dir', () => {
    writeForeign();
    const out = runEffect(fresh(), { kind: 'install', confirmed: true, plan: FOREIGN }, deps());
    expect(out).toMatchObject({ type: 'effectDone', ok: true, saved: true });
    expect((out as { message: string }).message).toContain(path.join(dir, 'cfg', 'backups'));
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command).toBe('ccinfobar');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'cfg', 'manifest.json'), 'utf8'));
    expect(m.entries.filter((e: { kind: string }) => e.kind === 'statusLine')).toHaveLength(1);
  });

  it('refuses when the statusLine changed after the plan', () => {
    writeForeign();
    const plan = { current: 'other-tool', proposed: 'ccinfobar', needsConfirm: true };
    const before = fs.readFileSync(settings);
    const out = runEffect(fresh(), { kind: 'install', confirmed: true, plan }, deps());
    expect(out).toMatchObject({ type: 'effectDone', ok: false });
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('unconfirmed install over a foreign statusLine writes nothing', () => {
    const before = writeForeign();
    const out = runEffect(fresh(), { kind: 'install', confirmed: false }, deps());
    expect(out).toMatchObject({ type: 'effectDone', ok: false });
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });
});
