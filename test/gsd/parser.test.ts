import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeStatus, readGsd } from '../../src/data/gsd.js';

const fixtures = path.resolve(import.meta.dirname, '../fixtures/gsd');
const fx = (name: string) => path.join(fixtures, name);

let tmp: string;
let home: string;
const HOME_VARS = ['HOME', 'USERPROFILE'] as const;
const savedHome: Record<string, string | undefined> = {};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-gsd-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  for (const k of HOME_VARS) {
    savedHome[k] = process.env[k];
    process.env[k] = home;
  }
});

afterAll(() => {
  for (const k of HOME_VARS) {
    if (savedHome[k] === undefined) delete process.env[k];
    else process.env[k] = savedHome[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('readGsd', () => {
  it('returns null outside a GSD project', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'empty-'));
    expect(readGsd(dir, {})).toBeNull();
    expect(readGsd(path.join(dir, 'does', 'not', 'exist'), {})).toBeNull();
  });

  it('parses a project without frontmatter using disk counts', () => {
    const info = readGsd(fx('plain'), {})!;
    expect(info.projectDir).toBe(fx('plain'));
    expect(info.planningDir).toBe(path.join(fx('plain'), '.planning'));
    expect(info.milestone).toBeNull();
    expect(info.status).toBe('executing');
    expect(info.statusText).toBe('In progress');
    expect(info.activePhase).toBe('3');
    expect(info.phase).toMatchObject({
      number: '3',
      name: 'API Hardening',
      dir: '03-api-hardening',
      plans: 2,
      summaries: 1,
      complete: false,
    });
    expect(info.phaseIndex).toBe(3);
    expect(info.phasesTotal).toBe(3);
    expect(info.phasesCompleted).toBe(2);
    expect(info.plansTotal).toBe(5);
    expect(info.plansCompleted).toBe(4);
    expect(info.percent).toBe(67);
    expect(info.blockers).toEqual(['Sandbox keys pending', 'Rate limit unclear']);
    expect(info.pendingTodos).toBe(1);
    expect(info.requirementsDone).toBe(2);
    expect(info.requirementsTotal).toBe(3);
    expect(info.lastActivity).toBe('2026-10-09');
    expect(info.workstream).toBeNull();
  });

  it('resolves the project from a nested cwd', () => {
    const sub = path.join(fx('plain'), 'phases', '01-import-parser');
    expect(readGsd(sub, {})?.projectDir).toBe(fx('plain'));
  });

  it('prefers frontmatter active_phase and block next_phases, disk over stale progress', () => {
    const info = readGsd(fx('frontmatter'), {})!;
    expect(info.milestone).toBe('v1.2');
    expect(info.milestoneName).toBe('Billing');
    expect(info.status).toBe('executing');
    expect(info.activePhase).toBe('4.5');
    expect(info.nextAction).toBe('execute-phase');
    expect(info.nextPhases).toEqual(['4.5', '5']);
    expect(info.phase).toMatchObject({ number: '4.5', name: 'Hotfix', plans: 2, summaries: 1 });
    expect(info.phaseIndex).toBe(2);
    expect(info.phasesTotal).toBe(3);
    expect(info.phasesCompleted).toBe(1);
    expect(info.plansTotal).toBe(3);
    expect(info.plansCompleted).toBe(2);
    expect(info.percent).toBe(33);
    expect(info.blockers).toEqual([]);
    expect(info.pendingTodos).toBe(0);
  });

  it('parses flow-style next_phases, null active_phase and hides literal milestone name', () => {
    const info = readGsd(fx('flow'), {})!;
    expect(info.nextPhases).toEqual(['2', '3']);
    expect(info.milestone).toBe('v2.0');
    expect(info.milestoneName).toBeNull();
    expect(info.status).toBe('planning');
    expect(info.activePhase).toBe('2');
    expect(info.phasesTotal).toBe(3);
    expect(info.phasesCompleted).toBe(1);
    expect(info.plansTotal).toBe(4);
    expect(info.plansCompleted).toBe(2);
    expect(info.percent).toBe(33);
  });

  it('handles a completed milestone', () => {
    const info = readGsd(fx('complete'), {})!;
    expect(info.status).toBe('complete');
    expect(info.statusText).toBe('Milestone complete');
    expect(info.stoppedAt).toMatch(/^Milestone complete/);
    expect(info.percent).toBe(100);
    expect(info.phasesCompleted).toBe(2);
    expect(info.phase?.number).toBe('2');
    expect(info.phase?.complete).toBe(true);
  });

  it('counts roadmap phases inside shipped details blocks when nothing else exists', () => {
    const info = readGsd(fx('shipped'), {})!;
    expect(info.status).toBe('complete');
    expect(info.milestone).toBe('v1.1');
    expect(info.phasesTotal).toBe(2);
    expect(info.phasesCompleted).toBe(2);
    expect(info.phase?.name).toBe('Propagation');
    expect(info.percent).toBe(100);
  });

  it('excludes shipped milestone phases when a current milestone exists', () => {
    const info = readGsd(fx('mixed'), {})!;
    expect(info.phasesTotal).toBe(2);
    expect(info.phasesCompleted).toBe(0);
    expect(info.milestone).toBe('v1.1');
    expect(info.milestoneName).toBe('Second');
    expect(info.status).toBe('ready-to-plan');
    expect(info.phase).toMatchObject({ number: '3', name: 'Search' });
    expect(info.phaseIndex).toBe(1);
  });

  it('counts nested plans/ directory files', () => {
    const info = readGsd(fx('nested'), {})!;
    expect(info.phase).toMatchObject({ plans: 2, summaries: 1, complete: false });
  });

  it('follows the active workstream pointer', () => {
    const info = readGsd(fx('workstream'), {})!;
    expect(info.workstream).toBe('billing');
    expect(info.planningDir).toBe(path.join(fx('workstream'), '.planning', 'workstreams', 'billing'));
    expect(info.activePhase).toBe('2');
    expect(info.phase?.name).toBe('Invoices');
    expect(info.status).toBe('ready-to-execute');
  });

  it('prefers GSD_WORKSTREAM and rejects invalid names', () => {
    expect(readGsd(fx('workstream'), { GSD_WORKSTREAM: '../x' })?.workstream).toBe('billing');
    expect(readGsd(fx('plain'), { GSD_WORKSTREAM: 'nope' })?.workstream).toBeNull();
  });

  it('falls back to the root when the workstream directory is missing', () => {
    const info = readGsd(fx('workstream-missing'), {})!;
    expect(info.workstream).toBeNull();
    expect(info.planningDir).toBe(path.join(fx('workstream-missing'), '.planning'));
  });

  it('never throws on malformed files', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'bad-'));
    const planning = path.join(dir, '.planning');
    fs.mkdirSync(path.join(planning, 'ROADMAP.md'), { recursive: true });
    fs.mkdirSync(path.join(planning, 'phases', 'not-a-phase'), { recursive: true });
    fs.mkdirSync(path.join(planning, 'phases', '01-x'), { recursive: true });
    fs.writeFileSync(
      path.join(planning, 'STATE.md'),
      '---\nmilestone: [unterminated\n  - : :\nstatus\n\u0000\u0001 garbage\n### Blockers/Concerns\n- \n',
    );
    let info: ReturnType<typeof readGsd> = null;
    expect(() => {
      info = readGsd(dir, {});
    }).not.toThrow();
    expect(info).not.toBeNull();
    fs.writeFileSync(path.join(planning, 'STATE.md'), Buffer.from([0xff, 0xfe, 0x00, 0x2d, 0x2d]));
    expect(() => readGsd(dir, {})).not.toThrow();
  });

  it('reads the GSD update cache', () => {
    const cache = path.join(home, '.cache', 'gsd');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      path.join(cache, 'gsd-update-check.json'),
      JSON.stringify({ update_available: true, installed: '1.40.0', latest: '1.41.0', stale_hooks: ['a'] }),
    );
    expect(readGsd(fx('plain'), {})?.update).toEqual({
      available: true,
      staleHooks: true,
      installed: '1.40.0',
      latest: '1.41.0',
    });
    fs.writeFileSync(path.join(cache, 'gsd-update-check.json'), '{not json');
    expect(readGsd(fx('plain'), {})?.update).toBeNull();
    fs.rmSync(cache, { recursive: true });
    expect(readGsd(fx('plain'), {})?.update).toBeNull();
  });
});

describe('normalizeStatus', () => {
  it.each([
    ['milestone_complete', 'complete'],
    ['✅ Complete — ready for next', 'complete'],
    ['Phase complete', 'phase-complete'],
    ['Ready to plan', 'ready-to-plan'],
    ['Ready to execute', 'ready-to-execute'],
    ['Planning', 'planning'],
    ['In progress', 'executing'],
    ['discussing', 'discussing'],
    ['verifying', 'verifying'],
    ['Paused Here', 'paused-here'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeStatus(raw)).toBe(expected);
  });
});

const REAL = [
  '/media/workspace/ex-ray',
  '/media/workspace/deprem-hazirlik',
  '/media/workspace/ailab-super-app',
];

describe.skipIf(!REAL.some((d) => fs.existsSync(d)))('real projects', () => {
  it.each(REAL.filter((d) => fs.existsSync(d)))('%s', (dir) => {
    const info = readGsd(dir, {});
    if (process.env.GSD_DUMP) console.log(dir, JSON.stringify(info, null, 1));
    expect(info).not.toBeNull();
  });
});
