import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { runEffect } from '../../src/tui/index.js';
import { keyToAction } from '../../src/tui/keys.js';
import { initialState, reduce, type State, type TuiInstallPlan } from '../../src/tui/state.js';
import { installQuestion } from '../../src/tui/view.js';

const FOREIGN: TuiInstallPlan = { current: 'npx ccstatusline', proposed: 'ccinfobar', needsConfirm: true };

let dir: string;
let settings: string;
let configFile: string;
let prevConfig: string | undefined;
let prevClaude: string | undefined;

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
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  process.env.CCINFOBAR_CONFIG_DIR = path.join(dir, 'cfg');
});

afterEach(() => {
  if (prevConfig === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prevConfig;
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
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
    expect(s.mode).toEqual({ kind: 'confirm', what: 'install', plan: FOREIGN, subagents: false });
    expect(installQuestion(FOREIGN)).toBe(
      t('tui.replaceQuestion', { current: 'npx ccstatusline', proposed: 'ccinfobar' }),
    );
  });

  it('keeps the plain question when no confirm is needed', () => {
    const plan = { current: null, proposed: 'ccinfobar', needsConfirm: false };
    const s = reduce(fresh(), { type: 'installPlanned', plan });
    expect(s.mode).toEqual({ kind: 'confirm', what: 'install', plan, subagents: false });
    expect(installQuestion(plan)).toBe("Set Claude Code's statusLine to ccinfobar?");
  });

  it('sanitizes the foreign command in the question', () => {
    const q = installQuestion({ ...FOREIGN, current: 'evil\u001b]0;x\u0007‮\ncmd' });
    expect(q).not.toMatch(/[\u0000-\u001f\u007f‮]/);
  });

  it('yes confirms the install, no leaves', () => {
    const asking = reduce(fresh(), { type: 'installPlanned', plan: FOREIGN });
    const yes = reduce(asking, { type: 'confirm', answer: 'yes' });
    expect(yes.effect).toEqual({ kind: 'install', confirmed: true, plan: FOREIGN, subagents: false });
    expect(yes.mode.kind).toBe('normal');
    const no = reduce(asking, { type: 'confirm', answer: 'no' });
    expect(no.effect).toBeNull();
    expect(no.mode.kind).toBe('normal');
    expect(no.config).toBe(asking.config);
  });
});

describe('TUI install subagents toggle', () => {
  const OURS: TuiInstallPlan = {
    current: null,
    proposed: 'ccinfobar',
    needsConfirm: false,
    subagent: { owner: 'us', change: 'x' },
  };
  const FOREIGN_SUB: TuiInstallPlan = {
    current: null,
    proposed: 'ccinfobar',
    needsConfirm: true,
    subagent: { owner: 'other', change: 'Would replace' },
  };

  it('defaults to off, or on when ccinfobar owns the subagent line', () => {
    const off = reduce(fresh(), { type: 'installPlanned', plan: FOREIGN });
    expect(off.mode).toMatchObject({ kind: 'confirm', subagents: false });
    const on = reduce(fresh(), { type: 'installPlanned', plan: OURS });
    expect(on.mode).toMatchObject({ kind: 'confirm', subagents: true });
  });

  it('s flips the flag and re-plans with it', () => {
    const asking = reduce(fresh(), { type: 'installPlanned', plan: FOREIGN });
    const on = reduce(asking, { type: 'confirm', answer: 'subagents' });
    expect(on.mode).toMatchObject({ kind: 'confirm', what: 'install', subagents: true });
    expect(on.effect).toEqual({ kind: 'planInstall', subagents: true });
    const replanned = reduce(on, { type: 'installPlanned', plan: FOREIGN_SUB, subagents: true });
    expect(replanned.mode).toMatchObject({ subagents: true, plan: FOREIGN_SUB });
    const off = reduce(replanned, { type: 'confirm', answer: 'subagents' });
    expect(off.effect).toEqual({ kind: 'planInstall', subagents: false });
    expect(off.mode).toMatchObject({ subagents: false });
  });

  it('a re-plan keeps the toggled value even when the plan owns nothing', () => {
    const s = reduce(fresh(), { type: 'installPlanned', plan: FOREIGN, subagents: true });
    expect(s.mode).toMatchObject({ subagents: true });
  });

  it('y installs with the flag', () => {
    const asking = reduce(fresh(), { type: 'installPlanned', plan: FOREIGN, subagents: true });
    expect(reduce(asking, { type: 'confirm', answer: 'yes' }).effect).toEqual({
      kind: 'install',
      confirmed: true,
      plan: FOREIGN,
      subagents: true,
    });
  });

  it('s is not a confirm answer in other modals', () => {
    const quit = reduce(reduce(fresh(), { type: 'removeChip' }), { type: 'quit' });
    expect(reduce(quit, { type: 'confirm', answer: 'subagents' })).toBe(quit);
  });

  it('keyToAction maps s in the install confirm', () => {
    const asking = reduce(fresh(), { type: 'installPlanned', plan: FOREIGN });
    expect(keyToAction({ name: 's', sequence: 's', ctrl: false, meta: false, shift: false }, asking)).toEqual(
      {
        type: 'confirm',
        answer: 'subagents',
      },
    );
  });
});

describe('TUI install effects', () => {
  it('planInstall with subagents plans the subagent line and reports the flag', () => {
    const before = writeForeign();
    const out = runEffect(fresh(), { kind: 'planInstall', subagents: true }, deps());
    expect(out).toMatchObject({
      type: 'installPlanned',
      subagents: true,
      plan: {
        subagent: { owner: null, change: 'Would set subagentStatusLine to "ccinfobar subagent-line"' },
      },
    });
    expect(fs.readFileSync(settings).equals(before)).toBe(true);
  });

  it('planInstall without subagents leaves the subagent section out', () => {
    writeForeign();
    const out = runEffect(fresh(), { kind: 'planInstall' }, deps()) as { plan: TuiInstallPlan };
    expect(out.plan.subagent).toBeUndefined();
  });

  it('install with subagents writes subagentStatusLine, without it does not', () => {
    writeForeign();
    runEffect(fresh(), { kind: 'install', confirmed: true, plan: FOREIGN, subagents: true }, deps());
    const data = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(data.subagentStatusLine.command).toBe('ccinfobar subagent-line');
    writeForeign();
    runEffect(fresh(), { kind: 'install', confirmed: true, plan: FOREIGN, subagents: false }, deps());
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).subagentStatusLine).toBeUndefined();
  });

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
