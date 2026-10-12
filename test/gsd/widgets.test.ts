import { describe, expect, it } from 'vitest';
import { renderPart } from '../../src/core/renderer.js';
import { sampleGsd, sampleTranscript } from '../../src/core/sample.js';
import type { GsdInfo } from '../../src/data/gsd.js';
import { widgets } from '../../src/widgets/gsd.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const withInfo = (patch: Partial<GsdInfo>) => ctxWith({ gsd: () => ({ ...sampleGsd(), ...patch }) });
const none = ctxWith({ gsd: () => null });
const sample = ctxWith();

describe('gsd widgets', () => {
  it('registers every widget in the gsd category with metadata', () => {
    expect(widgets).toHaveLength(15);
    for (const w of widgets) {
      expect(w.category).toBe('gsd');
      expect(w.type.startsWith('gsd-')).toBe(true);
      expect(w.sample).toBeTruthy();
      expect(w.description).toBeTruthy();
    }
  });

  it('all return null when not a GSD project', () => {
    for (const w of widgets) expect(renderWidget(w.type, none), w.type).toBeNull();
  });

  it('renders sample data', () => {
    expect(renderWidget('gsd-milestone', sample)).toBe('v1.2 Billing');
    expect(renderWidget('gsd-milestone-progress', sample)).toBe('█████░░░░░ 50%');
    expect(renderWidget('gsd-phase', sample)).toBe('4/6 Invoice export');
    expect(renderWidget('gsd-status', sample)).toBe('executing');
    expect(renderWidget('gsd-plans', sample)).toBe('3/5');
    expect(renderWidget('gsd-plan-progress', sample)).toBe('██████░░░░ 60%');
    expect(renderWidget('gsd-next', sample)).toBe('/gsd-execute-phase 4');
    expect(renderWidget('gsd-workstream', sample)).toBeNull();
    expect(renderWidget('gsd-blockers', sample)).toBe('⚠ 1 concern');
    expect(renderWidget('gsd-todos', sample)).toBe('2 todos');
    expect(renderWidget('gsd-requirements', sample)).toBe('14/22');
    expect(renderWidget('gsd-last-command', sample)).toBe('/gsd-execute-phase');
    expect(renderWidget('gsd-update', sample)).toBeNull();
    expect(renderWidget('gsd-task', sample)).toBe('Wiring GSD widgets into renderer');
    expect(renderWidget('gsd-summary', sample)).toBe('v1.2 Billing [█████░░░░░] 50% · Phase 4 executing');
  });

  it('milestone hides name on request or when absent', () => {
    expect(renderWidget('gsd-milestone', sample, { options: { showName: false } })).toBe('v1.2');
    expect(renderWidget('gsd-milestone', withInfo({ milestoneName: null }))).toBe('v1.2');
    expect(renderWidget('gsd-milestone', withInfo({ milestone: null, milestoneName: null }))).toBeNull();
  });

  it('milestone progress options', () => {
    expect(renderWidget('gsd-milestone-progress', sample, { options: { showCounts: true, width: 6 } })).toBe(
      '███░░░ 50% 3/6 phases',
    );
    expect(renderWidget('gsd-milestone-progress', sample, { options: { showPercent: false } })).toBe(
      '█████░░░░░',
    );
    expect(renderWidget('gsd-milestone-progress', withInfo({ percent: null }))).toBeNull();
  });

  it('phase options and truncation', () => {
    expect(renderWidget('gsd-phase', sample, { options: { showName: false } })).toBe('4/6');
    expect(renderWidget('gsd-phase', sample, { options: { showTotal: false } })).toBe('4 Invoice export');
    expect(renderWidget('gsd-phase', sample, { options: { maxNameLength: 7 } })).toBe('4/6 Invoic…');
    expect(renderWidget('gsd-phase', withInfo({ phase: null }))).toBeNull();
  });

  it('phase label applies via the renderer', () => {
    const part = renderPart(sample, { id: 'p', type: 'gsd-phase' });
    expect(part?.text).toBe('Phase 4/6 Invoice export');
    expect(renderPart(sample, { id: 'p', type: 'gsd-phase', raw: true })?.text).toBe('4/6 Invoice export');
  });

  it('status colors by stage', () => {
    const color = (status: string) => {
      const def = widgets.find((w) => w.type === 'gsd-status')!;
      const out = def.render(withInfo({ status }), { id: 's', type: 'gsd-status' });
      return typeof out === 'object' && out ? out.color : undefined;
    };
    expect(color('executing')).toBe('yellow');
    expect(color('planning')).toBe('blue');
    expect(color('discussing')).toBe('cyan');
    expect(color('verifying')).toBe('magenta');
    expect(color('complete')).toBe('green');
    expect(renderWidget('gsd-status', withInfo({ status: 'ready-to-plan' }))).toBe('ready to plan');
    expect(renderWidget('gsd-status', withInfo({ status: null }))).toBeNull();
  });

  it('plans handles empty phases', () => {
    const empty = withInfo({
      phase: { number: '5', name: 'X', dir: null, plans: 0, summaries: 0, complete: false },
    });
    expect(renderWidget('gsd-plans', empty)).toBeNull();
    expect(renderWidget('gsd-plans', empty, { options: { showEmpty: true } })).toBe('none');
    expect(renderWidget('gsd-plan-progress', empty)).toBeNull();
  });

  it('next derives from status and honors prefix', () => {
    const next = (patch: Partial<GsdInfo>, options?: Record<string, string>) =>
      renderWidget('gsd-next', withInfo({ nextAction: null, nextPhases: [], ...patch }), { options });
    expect(next({ status: 'ready-to-plan' })).toBe('/gsd-plan-phase 4');
    expect(next({ status: 'ready-to-execute' })).toBe('/gsd-execute-phase 4');
    expect(next({ status: 'discussing' })).toBe('/gsd-discuss-phase 4');
    expect(next({ status: 'verifying' })).toBe('/gsd-verify-work 4');
    expect(next({ status: 'phase-complete' })).toBe('/gsd-verify-work 4');
    expect(next({ status: 'phase-complete', phasesCompleted: 6 })).toBe('/gsd-complete-milestone');
    expect(next({ status: 'complete' })).toBe('/gsd-new-milestone');
    expect(next({ status: 'executing' }, { slashPrefix: '/gsd:' })).toBe('/gsd:execute-phase 4');
    expect(next({ status: null })).toBeNull();
    expect(next({ nextAction: 'plan-phase', nextPhases: ['4.5', '5'] })).toBe('/gsd-plan-phase 4.5,5');
  });

  it('workstream, blockers, todos, requirements', () => {
    expect(renderWidget('gsd-workstream', withInfo({ workstream: 'billing' }))).toBe('billing');
    expect(renderWidget('gsd-blockers', withInfo({ blockers: [] }))).toBeNull();
    expect(renderWidget('gsd-blockers', withInfo({ blockers: ['a', 'b'] }))).toBe('⚠ 2 concerns');
    expect(renderWidget('gsd-blockers', sample, { options: { showFirst: true, maxLength: 10 } })).toBe(
      '⚠ 1 concern: Stripe sa…',
    );
    expect(renderWidget('gsd-todos', withInfo({ pendingTodos: 0 }))).toBeNull();
    expect(renderWidget('gsd-todos', withInfo({ pendingTodos: 1 }))).toBe('1 todo');
    expect(renderWidget('gsd-requirements', withInfo({ requirementsTotal: 0 }))).toBeNull();
  });

  it('last command keeps the latest GSD command across other commands', () => {
    const t = (lastCommand: string | null, lastGsdCommand: string | null) =>
      ctxWith({ transcript: () => ({ ...sampleTranscript(NOW.getTime()), lastCommand, lastGsdCommand }) });
    expect(renderWidget('gsd-last-command', t('/review', null))).toBeNull();
    expect(renderWidget('gsd-last-command', t('review', 'gsd-plan-phase'))).toBe('/gsd-plan-phase');
    expect(
      renderWidget('gsd-last-command', t('review', 'gsd-plan-phase'), { options: { onlyGsd: false } }),
    ).toBe('/review');
    expect(renderWidget('gsd-last-command', t(null, 'gsd:plan-phase 3'))).toBe('/gsd:plan-phase');
    expect(renderWidget('gsd-last-command', ctxWith({ transcript: () => null }))).toBeNull();
  });

  it('update shows version and stale hooks', () => {
    const upd = (available: boolean, staleHooks: boolean) =>
      withInfo({ update: { available, staleHooks, installed: '1.40.0', latest: '1.41.0' } });
    expect(renderWidget('gsd-update', upd(true, false))).toBe('⬆ GSD 1.41.0');
    expect(renderWidget('gsd-update', upd(false, true))).toBe('⚠ stale hooks');
    expect(renderWidget('gsd-update', upd(true, true))).toBe('⬆ GSD 1.41.0 ⚠ stale hooks');
    expect(renderWidget('gsd-update', withInfo({ update: null }))).toBeNull();
  });

  it('task truncates', () => {
    expect(renderWidget('gsd-task', sample, { options: { maxLength: 10 } })).toBe('Wiring GS…');
    expect(renderWidget('gsd-task', ctxWith({ transcript: () => null }))).toBeNull();
  });

  it('summary variants', () => {
    expect(renderWidget('gsd-summary', withInfo({ status: 'complete' }))).toBe(
      'v1.2 Billing [█████░░░░░] 50% · milestone complete',
    );
    expect(renderWidget('gsd-summary', withInfo({ status: 'ready-to-execute', nextAction: null }))).toBe(
      'v1.2 Billing [█████░░░░░] 50% · next execute-phase 4',
    );
    expect(
      renderWidget(
        'gsd-summary',
        withInfo({ milestone: null, milestoneName: null, percent: null, status: 'planning' }),
      ),
    ).toBe('Phase 4 planning');
  });
});
