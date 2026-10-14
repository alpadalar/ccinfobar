import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { t } from '../../src/core/i18n/index.js';
import { emptyReason } from '../../src/core/inspect.js';
import { render } from '../../src/core/renderer.js';
import { sampleLedger, samplePayload } from '../../src/core/sample.js';
import type { Config, WidgetItem, WidgetResult } from '../../src/core/types.js';
import { ledgerOn } from '../../src/data/ledger.js';
import { budgetColor, widgets } from '../../src/widgets/cost.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget, withoutSideEffects } from '../helpers.js';

const view = (today: number) => () => ({ ...sampleLedger(NOW.getTime()), today });

function ctx(today: number | null, budget: Config['budget'] = { daily: 10 }) {
  return ctxWith({
    ledger: today === null ? () => null : view(today),
    config: { budget },
  });
}

function raw(c: ReturnType<typeof ctx>, options: WidgetItem['options'] = {}): WidgetResult {
  return getWidget('budget')!.render(c, { id: 'b', type: 'budget', options });
}

const colorOf = (r: WidgetResult) => (r && typeof r === 'object' ? r.color : undefined);

describe('budget', () => {
  it('shows spend against the daily budget', () => {
    expect(raw(ctx(4.1))).toBe('~$4.10/$10');
    expect(renderWidget('budget', ctx(4.1), { options: { display: 'percent' } })).toBe('41%');
    const bar = renderWidget('budget', ctx(4.1), { options: { display: 'bar' } })!;
    expect(bar.endsWith(' 41%')).toBe(true);
    expect(bar.length).toBeGreaterThan(' 41%'.length);
    expect(
      renderWidget('budget', ctx(4.1), { options: { display: 'bar', showPercent: false } }),
    ).not.toContain('%');
  });

  it('formats amounts', () => {
    expect(raw(ctx(4.1, { daily: 12.5 }))).toBe('~$4.10/$12.50');
    expect(renderWidget('budget', ctx(12.5))).toBe('~$12.50/$10');
    expect(renderWidget('budget', ctx(4.1), { options: { decimals: 0 } })).toBe('~$4/$10');
  });

  it('turns yellow at warnAt and red at the budget', () => {
    expect(colorOf(raw(ctx(7.99)))).toBeUndefined();
    expect(typeof raw(ctx(7.99))).toBe('string');
    expect(colorOf(raw(ctx(8)))).toBe('yellow');
    expect(colorOf(raw(ctx(9.99)))).toBe('yellow');
    expect(colorOf(raw(ctx(10)))).toBe('red');
    expect(colorOf(raw(ctx(12.5)))).toBe('red');
    expect(colorOf(raw(ctx(5, { daily: 10, warnAt: 0.5 })))).toBe('yellow');
    expect(colorOf(raw(ctx(9.99, { daily: 10, warnAt: 1 })))).toBeUndefined();
  });

  it('colors the percent and bar displays the same way', () => {
    expect(raw(ctx(8), { display: 'percent' })).toEqual({ text: '80%', color: 'yellow' });
    expect(raw(ctx(12.5), { display: 'percent' })).toEqual({ text: '125%', color: 'red' });
    expect(colorOf(raw(ctx(12.5), { display: 'bar' }))).toBe('red');
  });

  it('budgetColor', () => {
    expect(budgetColor(0.79, 0.8)).toBeNull();
    expect(budgetColor(0.8, 0.8)).toBe('yellow');
    expect(budgetColor(1, 0.8)).toBe('red');
    expect(budgetColor(1, 1)).toBe('red');
  });

  it('reads the session cost for period session', () => {
    const c = ctxWith({ config: { budget: { session: 2 } } });
    expect(samplePayload(NOW.getTime()).cost?.total_cost_usd).toBe(1.87);
    expect(raw(c, { period: 'session' })).toEqual({ text: '~$1.87/$2', color: 'yellow' });
    expect(renderWidget('budget', c, { options: { period: 'session' } })).toBe('~$1.87/$2');
    expect(renderWidget('budget', c)).toBeNull();
    expect(
      renderWidget('budget', ctxWith({ payload: {}, config: { budget: { session: 2 } } }), {
        options: { period: 'session' },
      }),
    ).toBeNull();
  });

  it('is empty without a budget or a ledger and explains why', () => {
    const none = ctxWith({ ledger: view(4.1) });
    expect(raw(none)).toBeNull();
    expect(emptyReason(none, { id: 'b', type: 'budget' })).toEqual({
      code: 'no-budget',
      text: t('explain.reason.no-budget', { period: 'daily' }),
    });
    const daily = ctx(4.1, { daily: 10 });
    expect(raw(daily, { period: 'session' })).toBeNull();
    expect(emptyReason(daily, { id: 'b', type: 'budget', options: { period: 'session' } }).code).toBe(
      'no-budget',
    );
    const noLedger = ctx(null);
    expect(raw(noLedger)).toBeNull();
    expect(emptyReason(noLedger, { id: 'b', type: 'budget' }).code).toBe('no-ledger');
    expect(t('explain.reason.no-budget', { period: 'session' })).toContain('budget.session');
  });

  it('applies a budget change on the next render', () => {
    const config = { ...defaultConfig(), colorLevel: 0 as const, budget: { daily: 10 } };
    const c = ctxWith({ ledger: view(4.1), config });
    expect(raw(c)).toBe('~$4.10/$10');
    c.config.budget = { daily: 5 };
    expect(raw(c)).toEqual({ text: '~$4.10/$5', color: 'yellow' });
  });

  it('renders with its label', () => {
    const lines = [[{ id: 'b', type: 'budget' }]];
    const out = withoutSideEffects(() =>
      render(ctxWith({ ledger: view(4.1), config: { lines, budget: { daily: 10 } } })),
    );
    expect(stripAnsi(out[0] ?? '')).toContain('Budget ~$4.10/$10');
  });

  it('turns on ledger recording only for the daily period', () => {
    const cfg = (options?: WidgetItem['options']) =>
      ({
        ...defaultConfig(),
        lines: [[{ id: 'b', type: 'budget', ...(options ? { options } : {}) }]],
      }) as Config;
    expect(ledgerOn(cfg())).toBe(true);
    expect(ledgerOn(cfg({ period: 'daily' }))).toBe(true);
    expect(ledgerOn(cfg({ period: 'session' }))).toBe(false);
  });

  it('is an opt-in cost widget with a sample', () => {
    const def = widgets.find((w) => w.type === 'budget')!;
    expect(def.category).toBe('cost');
    expect(def.sample).toBe('~$4.10/$10');
    expect(
      defaultConfig()
        .lines.flat()
        .some((i) => i.type === 'budget'),
    ).toBe(false);
  });

  it('leaves spend-limit alone', () => {
    const c = ctxWith({ config: { budget: { daily: 1, session: 1 } } });
    const plain = ctxWith({});
    expect(renderWidget('spend-limit', c)).toBe(renderWidget('spend-limit', plain));
  });
});
