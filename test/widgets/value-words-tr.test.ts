import { describe, expect, it } from 'vitest';
import { sampleGsd, sampleTranscript } from '../../src/core/sample.js';
import type { StatusPayload } from '../../src/core/types.js';
import type { GsdInfo } from '../../src/data/gsd.js';
import type { JobEnvelope, JobReader } from '../../src/data/jobs/runner.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import {
  formatCurrency,
  formatDuration,
  formatMoney,
  formatPercent,
  formatTokens,
} from '../../src/widgets/shared.js';
import { ctxWith, NOW, renderWidget, withLang, withTz } from '../helpers.js';

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
      'sistem istemi değişti (-40 karakter)',
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

describe('dates, limit words and neutral numbers', () => {
  const resetIn = (ms: number) =>
    ctxWith({ payload: { rate_limits: { five_hour: { resets_at: (NOW.getTime() + ms) / 1000 } } } });
  const clock = (ms: number) =>
    withTz('UTC', () =>
      both(() => renderWidget('five-hour-reset', resetIn(ms), { options: { showClockTime: true } })),
    );

  it('date short uses the active language, iso stays', () => {
    withTz('UTC', () => {
      expect(both(() => renderWidget('date', ctxWith(), { options: { format: 'short' } }))).toEqual([
        'Oct 12',
        '12 Eki',
      ]);
      expect(both(() => renderWidget('date', ctxWith()))).toEqual(['2026-10-12', '2026-10-12']);
    });
  });

  it('limit clock time follows the template and the weekday language', () => {
    expect(clock(90 * 60_000)).toEqual(['at 13:30', 'saat 13:30']);
    expect(clock(2 * 86_400_000 + 2 * 3_600_000)).toEqual(['at Wed 14:00', 'Çar 14:00']);
    expect(clock(86_400_000 + 9 * 3_600_000 + 5 * 60_000)).toEqual(['at Tue 21:05', 'Sal 21:05']);
    expect(withTz('UTC', () => both(() => renderWidget('five-hour-reset', resetIn(90 * 60_000))))).toEqual([
      '1h 30m',
      '1h 30m',
    ]);
  });

  it('usage pace words', () => {
    const pace = (used: number) =>
      ctxWith({
        payload: {
          rate_limits: { five_hour: { used_percentage: used, resets_at: NOW.getTime() / 1000 + 2.5 * 3600 } },
        },
      });
    expect(both(() => renderWidget('usage-pace', pace(50)))).toEqual(['on pace', 'dengeli']);
    expect(both(() => renderWidget('usage-pace', pace(80)))).toEqual(['⇡30%', '⇡30%']);
  });

  it('numbers, percents, currency and units stay neutral in Turkish', () => {
    withLang('tr', () => {
      expect(formatPercent(50)).toBe('50%');
      expect(formatPercent(12.5, 1)).toBe('12.5%');
      expect(formatCurrency(4.1)).toBe('$4.10');
      expect(formatMoney(1234.5, 'EUR')).not.toMatch(/\d,\d{2}$/);
      expect(formatTokens(1200)).toBe('1.2k');
      expect(formatTokens(1_500_000)).toBe('1.5M');
      expect(formatDuration(72 * 60_000)).toBe('1h 12m');
    });
    const numeric = [
      'context-percentage',
      'context-bar',
      'context-length',
      'tokens-input',
      'tokens-total',
      'cache-hit-rate',
      'output-speed',
      'session-cost',
      'cost-rate',
      'session-duration',
      'five-hour-usage',
      'five-hour-reset',
      'weekly-usage',
      'weekly-reset',
      'usage-projection',
      'limit-risk',
      'lines-changed',
    ];
    for (const type of numeric) {
      const [en, tr] = both(() => renderWidget(type, ctxWith()));
      expect(tr, type).toBe(en);
      expect(tr ?? '', type).not.toMatch(/%\d|\d,\d/);
    }
  });
});
