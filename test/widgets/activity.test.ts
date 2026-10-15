import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { t } from '../../src/core/i18n/index.js';
import { emptyReason } from '../../src/core/inspect.js';
import { PRESETS, starterConfig } from '../../src/core/presets.js';
import { sampleLedger } from '../../src/core/sample.js';
import { SCENARIO_NOW, SCENARIOS } from '../../src/core/scenarios.js';
import { ledgerOn, SLOT_MS, slotKey } from '../../src/data/ledger.js';
import { groupSlots } from '../../src/widgets/activity.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget, withoutSideEffects } from '../helpers.js';

const now = NOW.getTime();
const cur = slotKey(now);
const view = (slots: Record<number, number>) => () => ({ ...sampleLedger(now), slots });
const strip = (slots: Record<number, number>, options: Record<string, unknown> = {}, charset?: 'text') =>
  renderWidget(
    'activity-strip',
    ctxWith({ ledger: view(slots), ...(charset ? { config: { charset } } : {}) }),
    { options: { slots: 4, ...options } as never },
  );
const utc = () => 0;

describe('activity-strip', () => {
  it('scales intensity to the busiest slot, idle is a dot', () => {
    const k = cur - 2;
    const out = strip({ [k]: 1, [k + 2]: 4 });
    expect(out).toBe('·▂·█');
    expect([...out!]).toHaveLength(4);
  });

  it('shows presence marks', () => {
    expect(strip({ [cur - 2]: 1, [cur]: 4 }, { mode: 'presence' })).toBe('·▪·▪');
  });

  it('uses the text ramp and a space for idle under charset text', () => {
    expect(strip({ [cur - 2]: 1, [cur]: 4 }, {}, 'text')).toBe(' . #');
    expect(strip({ [cur - 2]: 1, [cur]: 4 }, { mode: 'presence' }, 'text')).toBe('.#.#');
  });

  it('shows an idle strip when nothing happened in view', () => {
    expect(strip({ [cur - 40]: 3 })).toBe('····');
    expect(strip({})).toBe('····');
  });

  it('shows the pending delta in the current slot', () => {
    expect(strip({ [cur]: 0.001 })).toBe('···█');
  });

  it('is empty without a ledger and says no-ledger', () => {
    const ctx = ctxWith({ ledger: () => null, payload: { session_id: 's' } });
    expect(renderWidget('activity-strip', ctx)).toBeNull();
    expect(emptyReason(ctx, { id: 'a', type: 'activity-strip' })).toEqual({
      code: 'no-ledger',
      text: t('explain.reason.no-ledger'),
    });
    const bare = createContext({
      payload: {},
      config: { ...defaultConfig(), colorLevel: 0 },
      env: {},
      now: NOW,
    });
    expect(renderWidget('activity-strip', bare)).toBeNull();
  });

  it('clamps the slot count', () => {
    const len = (slots: unknown) =>
      [...(renderWidget('activity-strip', ctxWith(), { options: { slots } as never }) ?? '')].length;
    expect(len(1)).toBe(4);
    expect(len(1_000_000)).toBe(96);
    expect(len('x')).toBe(36);
    expect(len(12.6)).toBe(12);
  });

  it('grows with fill by the extra cells', () => {
    const ctx = { ...ctxWith(), extra: 5 };
    const out = renderWidget('activity-strip', ctx, { options: { fill: true } });
    expect([...out!]).toHaveLength(41);
    expect([...renderWidget('activity-strip', ctx)!]).toHaveLength(36);
  });

  it('groups by size in local time', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const out = renderWidget(
        'activity-strip',
        ctxWith({ ledger: view({ [cur]: 1, [cur - 4]: 2, [cur - 3]: 2 }) }),
        { options: { slots: 4, size: '60' } },
      );
      expect(out).toBe('··█▂');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('matches the sample on the sample ledger', () => {
    const def = getWidget('activity-strip')!;
    expect(renderWidget('activity-strip', ctxWith())).toBe(def.sample);
    expect([...def.sample!]).toHaveLength(36);
    expect(def.timeBased).toBe(true);
    expect(def.category).toBe('charts');
  });

  it('turns ledger recording on', () => {
    expect(ledgerOn({ lines: [[{ id: '1', type: 'activity-strip' }]] } as never)).toBe(true);
  });

  it('is in no preset and no default layout', () => {
    for (const c of [
      defaultConfig(),
      starterConfig(true),
      starterConfig(false),
      ...PRESETS.map((p) => p.build()),
    ])
      expect(JSON.stringify(c)).not.toContain('activity-strip');
  });

  it('renders under every scenario', () => {
    for (const s of SCENARIOS) {
      const b = s.build(SCENARIO_NOW);
      const ctx = createContext({
        payload: b.payload,
        config: { ...defaultConfig(), colorLevel: 0 },
        env: b.env,
        now: new Date(SCENARIO_NOW),
        data: b.data,
      });
      expect(() => withoutSideEffects(() => renderWidget('activity-strip', ctx)), s.id).not.toThrow();
    }
  });
});

describe('groupSlots', () => {
  it('returns count groups ending with now', () => {
    expect(groupSlots({ [cur]: 2, [cur - 1]: 1 }, now, 3, 15, utc)).toEqual([0, 1, 2]);
    expect(groupSlots({ [cur + 1]: 9 }, now, 2, 15, utc)).toEqual([0, 0]);
  });

  it('ignores bad values', () => {
    const slots = { [cur]: Number.NaN, [cur - 1]: -1, [cur - 2]: Number.POSITIVE_INFINITY } as Record<
      number,
      number
    >;
    expect(groupSlots(slots, now, 3, 15, utc)).toEqual([0, 0, 0]);
  });

  it('groups 15-minute keys on local hour boundaries at UTC+5:45', () => {
    const off = () => 345;
    // 12:00Z is 17:45 local; utc hours would give [4, 5, 1]
    const t0 = Date.UTC(2026, 9, 12, 12, 0);
    const k = slotKey(t0);
    const slots = { [k]: 1, [k - 1]: 2, [k - 4]: 3, [k - 5]: 4 };
    expect(groupSlots(slots, t0, 3, 60, off)).toEqual([0, 7, 3]);
    expect(groupSlots(slots, t0, 2, 30, off)).toEqual([0, 3]);
  });

  it('has no gap when the clock springs forward', () => {
    // offset 60 before 01:00Z, 120 after: local 02:00..02:59 does not exist
    const jump = Date.UTC(2026, 2, 29, 1, 0);
    const off = (ms: number) => (ms < jump ? 60 : 120);
    const t0 = jump + 2 * 3_600_000;
    const slots: Record<number, number> = {};
    for (let k = slotKey(t0 - 6 * 3_600_000); k <= slotKey(t0); k++) slots[k] = 1;
    const out = groupSlots(slots, t0, 6, 60, off);
    expect(out).toHaveLength(6);
    expect(out).toEqual([4, 4, 4, 4, 4, 1]);
  });

  it('has no duplicate hour when the clock falls back', () => {
    // offset 120 before 01:00Z, 60 after: local 02:00..02:59 happens twice
    const back = Date.UTC(2026, 9, 25, 1, 0);
    const off = (ms: number) => (ms < back ? 120 : 60);
    const t0 = back + 2 * 3_600_000;
    const slots: Record<number, number> = {};
    for (let k = slotKey(t0 - 6 * 3_600_000); k <= slotKey(t0); k++) slots[k] = 1;
    const out = groupSlots(slots, t0, 6, 60, off);
    expect(out).toEqual([4, 4, 4, 4, 4, 1]);
    expect(groupSlots(slots, t0, 9, 15, off)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('keeps SLOT_MS at 15 minutes', () => {
    expect(SLOT_MS).toBe(15 * 60_000);
  });
});
