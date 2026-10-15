import { describe, expect, it } from 'vitest';
import { sampleGsd, sampleTranscript } from '../../src/core/sample.js';
import type { StatusPayload } from '../../src/core/types.js';
import type { GsdInfo } from '../../src/data/gsd.js';
import type { JobEnvelope, JobReader } from '../../src/data/jobs/runner.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget, withLang } from '../helpers.js';

const gsd = (patch: Partial<GsdInfo>) => ctxWith({ gsd: () => ({ ...sampleGsd(), ...patch }) });
const both = (fn: () => string | null) => [withLang('en', fn), withLang('tr', fn)];

const todos = (n: number, active: number) =>
  ctxWith({
    transcript: () => ({
      ...sampleTranscript(NOW.getTime()),
      todos: Array.from({ length: n }, (_, i) => ({
        content: `step ${i + 1}`,
        status: i < active ? 'completed' : i === active ? 'in_progress' : 'pending',
      })),
    }),
  });

const status = (indicator: string) => {
  const value = { indicator, description: 'Partial outage', incidents: [] };
  const env: JobEnvelope<unknown> = {
    v: 1,
    key: 'status',
    fetchedAt: NOW.getTime() - 30_000,
    ok: true,
    value,
    attempts: 0,
    lastGood: value,
    lastGoodAt: NOW.getTime() - 30_000,
  };
  const jobs: JobReader = {
    job: <V>(key: string) => (key === 'status' ? env : null) as JobEnvelope<V> | null,
  };
  return ctxWith({ jobs: () => jobs });
};

describe('widget value words in Turkish', () => {
  it('gsd counts use plural templates', () => {
    expect(both(() => renderWidget('gsd-blockers', gsd({ blockers: ['a'] })))).toEqual([
      '⚠ 1 concern',
      '⚠ 1 sorun',
    ]);
    expect(both(() => renderWidget('gsd-blockers', gsd({ blockers: ['a', 'b'] })))).toEqual([
      '⚠ 2 concerns',
      '⚠ 2 sorun',
    ]);
    expect(
      both(() =>
        renderWidget('gsd-blockers', gsd({ blockers: ['Stripe keys'] }), { options: { showFirst: true } }),
      ),
    ).toEqual(['⚠ 1 concern: Stripe keys', '⚠ 1 sorun: Stripe keys']);
    expect(both(() => renderWidget('gsd-todos', gsd({ pendingTodos: 1 })))).toEqual([
      '1 todo',
      '1 yapılacak',
    ]);
    expect(both(() => renderWidget('gsd-todos', gsd({ pendingTodos: 3 })))).toEqual([
      '3 todos',
      '3 yapılacak',
    ]);
    expect(
      both(() => renderWidget('gsd-milestone-progress', gsd({}), { options: { showCounts: true } })),
    ).toEqual(['█████░░░░░ 50% 3/6 phases', '█████░░░░░ 50% 3/6 aşama']);
    expect(
      both(() =>
        renderWidget('gsd-plans', gsd({ phase: { ...sampleGsd().phase!, plans: 0 } }), {
          options: { showEmpty: true },
        }),
      ),
    ).toEqual(['none', 'yok']);
  });

  it('known gsd statuses are translated, unknown ones shown raw', () => {
    expect(both(() => renderWidget('gsd-status', gsd({ status: 'ready-to-plan' })))).toEqual([
      'ready to plan',
      'planlamaya hazır',
    ]);
    expect(both(() => renderWidget('gsd-status', gsd({ status: 'executing' })))).toEqual([
      'executing',
      'yürütülüyor',
    ]);
    expect(both(() => renderWidget('gsd-status', gsd({ status: 'custom-thing' })))).toEqual([
      'custom thing',
      'custom thing',
    ]);
    for (const s of ['__proto__', 'constructor', 'toString'])
      expect(withLang('tr', () => renderWidget('gsd-status', gsd({ status: s })))).toBe(s);
  });

  it('gsd summary and update words', () => {
    expect(both(() => renderWidget('gsd-summary', gsd({})))).toEqual([
      'v1.2 Billing [█████░░░░░] 50% · Phase 4 executing',
      'v1.2 Billing [█████░░░░░] 50% · Aşama 4 yürütülüyor',
    ]);
    expect(both(() => renderWidget('gsd-summary', gsd({ status: 'complete' })))).toEqual([
      'v1.2 Billing [█████░░░░░] 50% · milestone complete',
      'v1.2 Billing [█████░░░░░] 50% · kilometre taşı tamamlandı',
    ]);
    expect(both(() => renderWidget('gsd-summary', gsd({ status: 'ready-to-execute' })))).toEqual([
      'v1.2 Billing [█████░░░░░] 50% · next execute-phase 4',
      'v1.2 Billing [█████░░░░░] 50% · sıradaki execute-phase 4',
    ]);
    expect(
      both(() => renderWidget('gsd-summary', gsd({ status: 'custom', nextAction: null, percent: null }))),
    ).toEqual(['v1.2 Billing · Phase 4', 'v1.2 Billing · Aşama 4']);
    const stale = gsd({
      update: { available: true, staleHooks: true, installed: '1.40.0', latest: '1.41.0' },
    });
    expect(both(() => renderWidget('gsd-update', stale))).toEqual([
      '⬆ GSD 1.41.0 ⚠ stale hooks',
      "⬆ GSD 1.41.0 ⚠ hook'lar eski",
    ]);
    expect(withLang('tr', () => renderWidget('gsd-next', gsd({})))).toBe('/gsd-execute-phase 4');
  });

  it('agent counts and todo list', () => {
    expect(both(() => renderWidget('agent-count', ctxWith()))).toEqual([
      '2 running · 1 done',
      '2 çalışıyor · 1 bitti',
    ]);
    const list = (lang: 'en' | 'tr') =>
      withLang(lang, () => renderWidget('todo-list', todos(12, 6), { options: { maxItems: 3 } }))!.split(
        '\n',
      );
    expect(list('en')).toEqual([
      '6/12',
      '  … 5 earlier',
      '  ✓ 6. step 6',
      '  ▸ 7. step 7',
      '  · 8. step 8',
      '  … 4 more',
    ]);
    expect(list('tr')[1]).toBe('  … 5 önceki');
    expect(list('tr')[5]).toBe('  … 4 daha');
    expect(list('tr').slice(2, 5)).toEqual(list('en').slice(2, 5));
  });

  it('session, system, cache and status words', () => {
    const p = (patch: Partial<StatusPayload>) =>
      ctxWith({ payload: { effort: { level: 'high' }, ...patch } });
    expect(
      both(() =>
        renderWidget('effort', p({ thinking: { enabled: true } }), { options: { showThinking: true } }),
      ),
    ).toEqual(['high+think', 'high+düşünme']);
    expect(both(() => renderWidget('thinking', p({ thinking: { enabled: true } })))).toEqual(['on', 'açık']);
    expect(both(() => renderWidget('thinking', p({ thinking: { enabled: false } })))).toEqual([
      'off',
      'kapalı',
    ]);
    expect(both(() => renderWidget('fast-mode', p({ fast_mode: true })))).toEqual(['fast', 'hızlı']);
    expect(
      both(() => renderWidget('fast-mode', p({ fast_mode: false }), { options: { showOff: true } })),
    ).toEqual(['normal', 'normal']);
    expect(both(() => renderWidget('env-counts', ctxWith()))).toEqual([
      'CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5',
      'CLAUDE.md 2 · kural 3 · MCP 4 · hook 5',
    ]);
    const miss = ctxWith({
      payload: {
        prompt_cache: { last_miss_cause: { causes: ['system_prompt_changed'], system_char_delta: -40 } },
      } as unknown as StatusPayload,
    });
    expect(both(() => renderWidget('cache-miss-cause', miss))).toEqual([
      'system prompt changed (-40 chars)',
      'system prompt changed (-40 karakter)',
    ]);
    expect(both(() => renderWidget('service-status', status('major')))).toEqual([
      '⚠ major: Partial outage',
      '⚠ büyük: Partial outage',
    ]);
    expect(both(() => renderWidget('service-status', status('maintenance')))).toEqual([
      '⚠ maintenance: Partial outage',
      '⚠ bakım: Partial outage',
    ]);
    expect(
      both(() => renderWidget('clock', ctxWith(), { options: { h12: true } })?.replace(/\d/g, '0') ?? null),
    ).toEqual([expect.stringMatching(/^00:00 (AM|PM)$/), expect.stringMatching(/^00:00 (ÖÖ|ÖS)$/)]);
  });

  it('widgets with broken data return null and do not throw under tr', () => {
    const broken = ctxWith({
      payload: { rate_limits: 5, effort: 'x', thinking: 'y', prompt_cache: 'z' } as unknown as StatusPayload,
      gsd: () => ({ ...sampleGsd(), status: null, phase: null, blockers: [], pendingTodos: 0, update: null }),
      transcript: () => null,
      agents: () => [],
      environment: () => null,
      jobs: () => ({ job: () => null }),
    });
    withLang('tr', () => {
      for (const type of [
        'gsd-blockers',
        'gsd-todos',
        'gsd-status',
        'gsd-update',
        'agent-count',
        'todo-list',
        'thinking',
        'env-counts',
        'cache-miss-cause',
        'service-status',
      ])
        expect(renderWidget(type, broken), type).toBeNull();
      for (const def of ALL_WIDGETS) expect(() => renderWidget(def.type, broken), def.type).not.toThrow();
    });
  });
});
