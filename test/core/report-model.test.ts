import { describe, expect, it } from 'vitest';
import { decodeProjectDir, parseRange, periodOf } from '../../src/core/report-model.js';
import { withTz } from '../helpers.js';

const ZONES = ['UTC', 'America/New_York', 'Europe/Istanbul', 'Pacific/Auckland'];
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

const each = (fn: () => void) => {
  for (const tz of ZONES) withTz(tz, fn);
};

describe('parseRange', () => {
  it('uses 7 days, 4 ISO weeks or 3 months including the current one by default', () => {
    each(() => {
      const now = local(2026, 10, 14);
      expect(parseRange({}, now)).toEqual({ period: 'day', since: '2026-10-08', until: '2026-10-14' });
      expect(parseRange({ period: 'day' }, now)).toEqual({
        period: 'day',
        since: '2026-10-08',
        until: '2026-10-14',
      });
      expect(parseRange({ period: 'week' }, now)).toEqual({
        period: 'week',
        since: '2026-09-21',
        until: '2026-10-14',
      });
      expect(parseRange({ period: 'month' }, now)).toEqual({
        period: 'month',
        since: '2026-08-01',
        until: '2026-10-14',
      });
      expect(parseRange({ all: true, period: 'week' }, now)).toEqual({
        period: 'week',
        since: null,
        until: null,
      });
    });
  });

  it('keeps calendar days across DST changes', () => {
    each(() => {
      expect(parseRange({}, local(2026, 11, 2, 0, 30))).toMatchObject({
        since: '2026-10-27',
        until: '2026-11-02',
      });
      expect(parseRange({}, local(2026, 3, 30, 23, 30))).toMatchObject({
        since: '2026-03-24',
        until: '2026-03-30',
      });
      expect(parseRange({ period: 'month' }, local(2026, 1, 15))).toMatchObject({ since: '2025-11-01' });
    });
  });

  it('reads relative and absolute since/until', () => {
    each(() => {
      const now = local(2026, 10, 14);
      expect(parseRange({ since: '2w' }, now)).toMatchObject({ since: '2026-10-05', until: '2026-10-14' });
      expect(parseRange({ since: '1w' }, now)).toMatchObject({ since: '2026-10-12' });
      expect(parseRange({ since: '1m' }, now)).toMatchObject({ since: '2026-10-01' });
      expect(parseRange({ since: '1d' }, now)).toMatchObject({ since: '2026-10-14' });
      expect(parseRange({ since: '30d' }, now)).toMatchObject({ since: '2026-09-15' });
      expect(parseRange({ since: '12m' }, now)).toMatchObject({ since: '2025-11-01' });
      expect(parseRange({ until: '1d' }, now)).toMatchObject({ until: '2026-10-13' });
      expect(parseRange({ until: '0d' }, now)).toMatchObject({ until: '2026-10-14' });
      expect(parseRange({ until: '1w' }, now)).toMatchObject({ until: '2026-10-07' });
      expect(parseRange({ until: '1m' }, local(2026, 3, 31))).toMatchObject({ until: '2026-02-28' });
      expect(parseRange({ since: '2026-10-01', until: '2026-10-05' }, now)).toEqual({
        period: 'day',
        since: '2026-10-01',
        until: '2026-10-05',
      });
      expect(parseRange({ since: '2026-10-05', until: '2026-10-05' }, now)).toMatchObject({
        since: '2026-10-05',
        until: '2026-10-05',
      });
      expect(parseRange({ all: true, since: '2026-01-01' }, now)).toMatchObject({
        since: '2026-01-01',
        until: null,
      });
    });
  });

  it('ends the default window at --until', () => {
    each(() => {
      const now = local(2026, 10, 14);
      expect(parseRange({ until: '2026-09-30' }, now)).toMatchObject({
        since: '2026-09-24',
        until: '2026-09-30',
      });
      expect(parseRange({ until: '2026-09-30', period: 'month' }, now)).toMatchObject({
        since: '2026-07-01',
      });
    });
  });

  it('returns error codes for bad values', () => {
    const now = local(2026, 10, 14);
    expect(parseRange({ period: 'hour' }, now)).toEqual({ error: 'period', value: 'hour' });
    expect(parseRange({ period: true }, now)).toEqual({ error: 'period', value: '' });
    expect(parseRange({ since: '0d' }, now)).toEqual({ error: 'since', value: '0d' });
    expect(parseRange({ since: '7x' }, now)).toEqual({ error: 'since', value: '7x' });
    expect(parseRange({ since: '2026-02-30' }, now)).toEqual({ error: 'since', value: '2026-02-30' });
    expect(parseRange({ since: '12345d' }, now)).toEqual({ error: 'since', value: '12345d' });
    expect(parseRange({ since: true }, now)).toEqual({ error: 'since', value: '' });
    expect(parseRange({ until: 'abc' }, now)).toEqual({ error: 'until', value: 'abc' });
    expect(parseRange({ until: true }, now)).toEqual({ error: 'until', value: '' });
    expect(parseRange({ since: '2026-10-06', until: '2026-10-05' }, now)).toEqual({
      error: 'order',
      value: '2026-10-06',
    });
  });
});

describe('periodOf', () => {
  it('maps a day key to itself, its ISO week or its month', () => {
    each(() => {
      expect(periodOf('2026-10-14', 'day')).toBe('2026-10-14');
      expect(periodOf('2026-12-28', 'week')).toBe('2026-W53');
      expect(periodOf('2027-01-01', 'week')).toBe('2026-W53');
      expect(periodOf('2027-01-03', 'week')).toBe('2026-W53');
      expect(periodOf('2027-01-04', 'week')).toBe('2027-W01');
      expect(periodOf('2026-10-18', 'week')).toBe('2026-W42');
      expect(periodOf('2026-10-19', 'week')).toBe('2026-W43');
      expect(periodOf('2026-10-14', 'month')).toBe('2026-10');
    });
  });
});

describe('decodeProjectDir', () => {
  it('turns the projects folder name back into a path', () => {
    expect(decodeProjectDir('-home-u-work-repo')).toBe('/home/u/work/repo');
    expect(decodeProjectDir('C--Users-u-repo')).toBe('C:/Users/u/repo');
    expect(decodeProjectDir('plain')).toBe('plain');
  });
});
