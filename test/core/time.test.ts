import { describe, expect, it } from 'vitest';
import { addDays, dayKey, mondayOf, monthKey, parseDay, weekKey } from '../../src/core/time.js';
import { withTz } from '../helpers.js';

const ZONES = ['UTC', 'America/New_York', 'Europe/Istanbul', 'Pacific/Auckland'];
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('dayKey and monthKey', () => {
  it('use local dates around midnight and month ends', () => {
    for (const tz of ZONES)
      withTz(tz, () => {
        expect(dayKey(local(2026, 1, 31, 23, 59))).toBe('2026-01-31');
        expect(dayKey(local(2026, 2, 1, 0, 0))).toBe('2026-02-01');
        expect(monthKey(local(2026, 1, 31, 23, 59))).toBe('2026-01');
        expect(monthKey(local(2026, 12, 1, 0, 1))).toBe('2026-12');
      });
  });
});

describe('weekKey', () => {
  it('uses the ISO week-year on year edges in every zone', () => {
    for (const tz of ZONES)
      withTz(tz, () => {
        for (const h of [0, 12, 23]) {
          expect(weekKey(local(2025, 12, 29, h))).toBe('2026-W01');
          expect(weekKey(local(2027, 1, 1, h))).toBe('2026-W53');
          expect(weekKey(local(2027, 1, 4, h))).toBe('2027-W01');
          expect(weekKey(local(2021, 1, 3, h))).toBe('2020-W53');
        }
      });
  });

  it('starts a new week at local Monday midnight', () => {
    for (const tz of ZONES)
      withTz(tz, () => {
        expect(weekKey(local(2026, 10, 18, 23, 30))).toBe('2026-W42');
        expect(weekKey(local(2026, 10, 19, 0, 30))).toBe('2026-W43');
      });
  });
});

describe('parseDay', () => {
  it('accepts real dates only', () => {
    expect(parseDay('2026-13-01')).toBeNull();
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('26-01-01')).toBeNull();
    expect(parseDay('2026-00-10')).toBeNull();
    expect(parseDay('2026-1-01')).toBeNull();
    const t = parseDay('2024-02-29');
    expect(t).toBe(local(2024, 2, 29));
  });
});

describe('addDays and mondayOf', () => {
  it('keep the calendar day across DST changes', () => {
    withTz('Europe/Berlin', () => {
      const t = local(2026, 3, 28, 0, 30);
      expect(dayKey(addDays(t, 1))).toBe('2026-03-29');
      expect(dayKey(addDays(t, 2))).toBe('2026-03-30');
      expect(dayKey(addDays(local(2026, 3, 30, 23, 59), -2))).toBe('2026-03-28');
    });
    withTz('America/New_York', () => {
      const t = local(2026, 10, 31, 23, 30);
      expect(dayKey(addDays(t, 1))).toBe('2026-11-01');
      expect(dayKey(addDays(t, 2))).toBe('2026-11-02');
      expect(dayKey(addDays(t, -31))).toBe('2026-09-30');
    });
  });

  it('finds the Monday of the ISO week', () => {
    for (const tz of ZONES)
      withTz(tz, () => {
        expect(mondayOf(local(2026, 10, 18, 23, 30))).toBe(local(2026, 10, 12));
        expect(mondayOf(local(2026, 10, 19, 0, 30))).toBe(local(2026, 10, 19));
        expect(dayKey(mondayOf(local(2027, 1, 1)))).toBe('2026-12-28');
      });
  });
});
