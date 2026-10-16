import { describe, expect, it } from 'vitest';
import { PRICES_UPDATED } from '../../src/core/prices.js';
import { formatCsv } from '../../src/core/report-format.js';
import { buildReport, decodeProjectDir, parseRange, periodOf } from '../../src/core/report-model.js';
import {
  type Bucket,
  LEDGER_ZERO_USD,
  type LedgerSession,
  type Period,
  type ProjectFilter,
  type ReportRow,
  type ScanNote,
  type ScanResult,
  type SessionData,
} from '../../src/core/report-types.js';
import type { Config } from '../../src/core/types.js';
import { LEDGER_ZERO } from '../../src/data/ledger.js';
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

const SONNET = 'claude-sonnet-4-5';
const M = 1_000_000;

type B = Partial<Bucket> & { day: string; model?: string; fast?: boolean; big?: boolean; usdFlag?: boolean };

function sess(
  sid: string,
  o: { enc?: string; cwd?: string | null; buckets?: B[]; time?: Record<string, number> } = {},
): SessionData {
  const buckets: Record<string, Bucket> = {};
  for (const b of o.buckets ?? []) {
    const key = `${b.day}|${b.model ?? SONNET}|${b.fast ? 1 : 0}|${b.big ? 1 : 0}|${b.usdFlag ? 1 : 0}`;
    buckets[key] = { in: 0, out: 0, cr: 0, w5: 0, w1: 0, n: 1, usd: 0, ...b } as Bucket;
  }
  return {
    sid,
    enc: o.enc ?? '-work-enc',
    cwd: o.cwd === undefined ? '/work/repo' : o.cwd,
    buckets,
    time: o.time ?? {},
    files: 1,
    gone: false,
  };
}

const led = (p: string, first: number, days: Record<string, number>): LedgerSession => ({
  a: 'acct',
  p,
  first,
  firstT: Date.UTC(2026, 9, 1, 12),
  total: Object.values(days).reduce((a, b) => a + b, 0),
  days,
});

function scan(o: {
  sessions?: SessionData[];
  ledger?: Record<string, LedgerSession>;
  ledgerSince?: number | null;
  notes?: ScanNote[];
}): ScanResult {
  return {
    claudeDir: '/home/u/.claude',
    sessions: Object.fromEntries((o.sessions ?? []).map((s) => [s.sid, s])),
    ledger: o.ledger ?? {},
    ledgerSince: o.ledgerSince ?? null,
    notes: o.notes ?? [],
    files: 0,
    bytesRead: 0,
  };
}

function report(
  data: ScanResult,
  o: {
    period?: Period;
    since?: string | null;
    until?: string | null;
    filter?: ProjectFilter | null;
    config?: Pick<Config, 'profiles'>;
  } = {},
) {
  return buildReport(data, {
    period: o.period ?? 'day',
    since: o.since ?? null,
    until: o.until ?? null,
    filter: o.filter ?? null,
    config: o.config ?? {},
  });
}

const rowOf = (rows: ReportRow[], period: string, project = '/work/repo') =>
  rows.find((r) => r.period === period && r.project === project);

describe('buildReport cost source (D-04)', () => {
  it('ledger-complete session takes its cost from the ledger days and tokens from the transcript', () => {
    const r = report(
      scan({
        sessions: [sess('s1', { buckets: [{ day: '2026-10-10', in: 3 * M, n: 2 }] })],
        ledger: { s1: led('/work/repo', 0.001, { '2026-10-10': 1.5, '2026-10-11': 2.5 }) },
      }),
    );
    expect(rowOf(r.rows, '2026-10-10')).toMatchObject({
      sessions: 1,
      costUsd: 1.5,
      costSource: 'ledger',
      partial: false,
      tokens: { input: 3 * M, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 * M },
    });
    expect(rowOf(r.rows, '2026-10-11')).toMatchObject({ costUsd: 2.5, costSource: 'ledger', tokens: null });
    expect(r.total).toMatchObject({ sessions: 1, costUsd: 4, costSource: 'ledger', partial: false });
    expect(r.total!.tokens!.total).toBe(3 * M);
    expect(r.unpriced).toEqual({ models: [], requests: 0 });
  });

  it('ledger-complete session ignores unpriced transcript models', () => {
    const r = report(
      scan({
        sessions: [sess('s1', { buckets: [{ day: '2026-10-10', model: 'mystery-model', in: 1000, n: 3 }] })],
        ledger: { s1: led('/work/repo', LEDGER_ZERO_USD, { '2026-10-10': 1 }) },
      }),
    );
    expect(r.rows[0]).toMatchObject({ costUsd: 1, costSource: 'ledger', partial: false });
    expect(r.unpriced).toEqual({ models: [], requests: 0 });
    expect(r.notes.some((n) => n.code === 'unpriced' || n.code === 'partial')).toBe(false);
  });

  it('partial ledger session with an unpriced model keeps the partial ledger value', () => {
    const r = report(
      scan({
        sessions: [sess('s1', { buckets: [{ day: '2026-10-10', model: 'mystery-model', in: 1000, n: 3 }] })],
        ledger: { s1: led('/work/repo', 5, { '2026-10-10': 1 }) },
      }),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ costUsd: 1, costSource: 'ledger', partial: true });
    expect(r.unpriced).toEqual({ models: ['mystery-model'], requests: 3 });
    expect(r.notes).toContainEqual({ code: 'unpriced', params: { models: 'mystery-model', requests: 3 } });
    expect(r.notes).toContainEqual({ code: 'partial' });
  });

  it('partial ledger session with a fully priced transcript uses the transcript estimate', () => {
    const r = report(
      scan({
        sessions: [sess('s1', { buckets: [{ day: '2026-10-09', in: M }] })],
        ledger: { s1: led('/work/repo', 5, { '2026-10-10': 1 }) },
      }),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      period: '2026-10-09',
      costUsd: 3,
      costSource: 'transcript',
      partial: false,
    });
  });

  it('transcript estimate goes to each request day and costUSD buckets use their usd', () => {
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: [
              { day: '2026-10-10', in: M, out: M, n: 4 },
              { day: '2026-10-11', in: 999 * M, usd: 0.42, usdFlag: true },
            ],
          }),
        ],
      }),
    );
    expect(rowOf(r.rows, '2026-10-10')).toMatchObject({ costUsd: 18, costSource: 'transcript' });
    expect(rowOf(r.rows, '2026-10-11')!.costUsd).toBeCloseTo(0.42, 9);
    expect(r.total!.costUsd).toBeCloseTo(18.42, 9);
  });

  it('prices fast and big buckets through requestCost', () => {
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: [
              { day: '2026-10-10', model: 'claude-opus-5', in: M, fast: true },
              { day: '2026-10-11', model: 'claude-haiku-5-5', in: M, big: true },
            ],
          }),
        ],
      }),
    );
    expect(rowOf(r.rows, '2026-10-10')!.costUsd).toBeCloseTo(10, 9);
    expect(rowOf(r.rows, '2026-10-11')!.costUsd).toBeCloseTo(0.5, 9);
  });

  it('unknown cost when there is no ledger and a model is unpriced; tokens and time still show', () => {
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: [
              { day: '2026-10-10', in: M },
              { day: '2026-10-10', model: 'mystery-model', out: 500, n: 2 },
            ],
            time: { '2026-10-10': 60_000 },
          }),
        ],
      }),
    );
    expect(r.rows[0]).toMatchObject({
      costUsd: null,
      costSource: null,
      partial: true,
      activeMs: 60_000,
      sessions: 1,
    });
    expect(r.rows[0]!.tokens!.total).toBe(M + 500);
    expect(r.unpriced).toEqual({ models: ['mystery-model'], requests: 2 });
  });

  it('keeps non-USD profile costs out of costUsd', () => {
    const config: Pick<Config, 'profiles'> = {
      profiles: { models: [{ match: 'glm-*', input: 1, output: 2, currency: 'CNY' }] },
    };
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: [
              { day: '2026-10-10', model: 'glm-4.7', in: M, out: M },
              { day: '2026-10-10', in: M },
            ],
          }),
          sess('s2', { cwd: '/work/cn', buckets: [{ day: '2026-10-10', model: 'glm-4.6', in: M }] }),
        ],
      }),
      { config },
    );
    expect(rowOf(r.rows, '2026-10-10')).toMatchObject({
      costUsd: 3,
      costSource: 'transcript',
      costOther: { CNY: 3 },
    });
    expect(rowOf(r.rows, '2026-10-10', '/work/cn')).toMatchObject({
      costUsd: null,
      costOther: { CNY: 1 },
      partial: true,
    });
    expect(rowOf(r.rows, '2026-10-10')!.partial).toBe(false);
    expect(formatCsv(r).split('\r\n')[2]).toMatch(/,,transcript,true,\d*$/);
    expect(r.total).toMatchObject({ costUsd: 3, costOther: { CNY: 4 } });
    expect(r.notes).toContainEqual({ code: 'non-usd', params: { currency: 'CNY', amount: 4 } });
    expect(rowOf(r.rows, '2026-10-10')).not.toHaveProperty('costOther.USD');
  });

  it('adds a profile-price note with the vendor for built-in profile prices', () => {
    const r = report(
      scan({ sessions: [sess('s1', { buckets: [{ day: '2026-10-10', model: 'kimi-k3', in: M }] })] }),
    );
    expect(r.rows[0]).toMatchObject({ costUsd: 3, costSource: 'transcript' });
    expect(r.notes).toContainEqual({ code: 'profile-price', params: { vendor: 'moonshot' } });
  });

  it('reports mixed when a row has ledger and transcript sessions', () => {
    const r = report(
      scan({
        sessions: [
          sess('a', { buckets: [{ day: '2026-10-10', in: M }] }),
          sess('b', { buckets: [{ day: '2026-10-10', in: M }] }),
        ],
        ledger: { a: led('/work/repo', 0, { '2026-10-10': 2 }) },
      }),
    );
    expect(r.rows[0]).toMatchObject({ sessions: 2, costUsd: 5, costSource: 'mixed', partial: false });
  });

  it('ledger-only session has null tokens and time and a ledger-only note', () => {
    const r = report(scan({ ledger: { gone: led('/work/old', 0, { '2026-10-10': 2 }) } }));
    expect(r.rows).toEqual([
      {
        period: '2026-10-10',
        project: '/work/old',
        approx: false,
        sessions: 1,
        tokens: null,
        costUsd: 2,
        costSource: 'ledger',
        partial: false,
        activeMs: null,
        tokensPartial: false,
      },
    ]);
    expect(r.notes).toContainEqual({ code: 'ledger-only', params: { count: 1 } });
  });

  it('marks tokens and time of a row with a ledger-only session as partial', () => {
    const r = report(
      scan({
        sessions: [sess('a', { buckets: [{ day: '2026-10-10', in: 5 }], time: { '2026-10-10': 60_000 } })],
        ledger: {
          gone: led('/work/repo', 0, { '2026-10-10': 2 }),
          b: led('/work/other', 0, { '2026-10-10': 1 }),
        },
      }),
    );
    expect(rowOf(r.rows, '2026-10-10')).toMatchObject({ sessions: 2, tokensPartial: true, activeMs: 60_000 });
    expect(rowOf(r.rows, '2026-10-10', '/work/other')).toMatchObject({ tokens: null, tokensPartial: false });
    expect(r.total).toMatchObject({ sessions: 3, tokensPartial: true });
    expect(r.notes).toContainEqual({ code: 'tokens-partial' });
    const clean = report(scan({ sessions: [sess('a', { buckets: [{ day: '2026-10-10', in: 5 }] })] }));
    expect(clean.rows[0]!.tokensPartial).toBe(false);
    expect(clean.notes).not.toContainEqual({ code: 'tokens-partial' });
  });
});

describe('buildReport projects and filters (D-06, D-10)', () => {
  it('takes the ledger project, then the cwd, then the decoded folder', () => {
    const r = report(
      scan({
        sessions: [
          sess('a', { cwd: '/work/cwd-a', buckets: [{ day: '2026-10-10', in: 1 }] }),
          sess('b', { cwd: '/work/cwd-b', buckets: [{ day: '2026-10-10', in: 1 }] }),
          sess('c', { cwd: null, enc: '-work-enc-c', buckets: [{ day: '2026-10-10', in: 1 }] }),
        ],
        ledger: { a: led('/work/ledger-a', 0, { '2026-10-10': 1 }) },
      }),
    );
    expect(r.rows.map((x) => [x.project, x.approx])).toEqual(
      expect.arrayContaining([
        ['/work/ledger-a', false],
        ['/work/cwd-b', false],
        ['/work/enc/c', true],
      ]),
    );
    expect(r.rows).toHaveLength(3);
    expect(r.notes).toContainEqual({ code: 'approx-project', params: { count: 1 } });
  });

  it('filters by ASCII case-insensitive substring', () => {
    const data = scan({
      sessions: [
        sess('a', { cwd: '/work/api-server', buckets: [{ day: '2026-10-10', in: 1 }] }),
        sess('b', { cwd: '/work/web', buckets: [{ day: '2026-10-10', in: 1 }] }),
      ],
    });
    const r = report(data, { filter: { kind: 'substring', text: 'API' } });
    expect(r.rows.map((x) => x.project)).toEqual(['/work/api-server']);
    expect(report(data, { filter: { kind: 'substring', text: 'İ' } }).rows).toEqual([]);
  });

  it('filters --project . to the longest known project that holds cwd', () => {
    const data = scan({
      sessions: ['/work/repo', '/work/repo/pkg', '/work/repo2', '/work'].map((cwd, i) =>
        sess(`s${i}`, { cwd, buckets: [{ day: '2026-10-10', in: 1 }] }),
      ),
    });
    const at = (cwd: string) => report(data, { filter: { kind: 'cwd', cwd } }).rows.map((x) => x.project);
    expect(at('/work/repo')).toEqual(['/work/repo']);
    expect(at('/work/repo/src/deep')).toEqual(['/work/repo']);
    expect(at('/work/repo/pkg/lib')).toEqual(['/work/repo/pkg']);
    expect(at('/work/repo2x')).toEqual(['/work']);
    expect(at('/elsewhere')).toEqual([]);
    const win = scan({
      sessions: ['c:\\work\\repo', 'c:\\work\\repo\\pkg', 'c:\\work\\repo2'].map((cwd, i) =>
        sess(`w${i}`, { cwd, buckets: [{ day: '2026-10-10', in: 1 }] }),
      ),
    });
    const winAt = (cwd: string) => report(win, { filter: { kind: 'cwd', cwd } }).rows.map((x) => x.project);
    expect(winAt('c:\\work\\repo\\src')).toEqual(['c:\\work\\repo']);
    expect(winAt('c:\\work')).toEqual([]);
  });

  it('shows a Windows project in its own letter case, keyed case-blind', () => {
    const data = scan({
      sessions: [
        {
          ...sess('w1', { cwd: 'c:\\users\\alp\\repo', buckets: [{ day: '2026-10-10', in: 1 }] }),
          shown: 'C:\\Users\\Alp\\Repo',
        },
      ],
      ledger: { w2: led('c:\\users\\alp\\repo', 0.001, { '2026-10-10': 2 }) },
    });
    const r = report(data, {});
    expect(r.rows.map((x) => [x.project, x.sessions])).toEqual([['C:\\Users\\Alp\\Repo', 2]]);
    const cwd = report(data, { filter: { kind: 'cwd', cwd: 'c:\\users\\alp\\repo\\src' } });
    expect(cwd.rows.map((x) => x.project)).toEqual(['C:\\Users\\Alp\\Repo']);
  });

  it('shows nothing for --project . in a parent folder that is no project', () => {
    const data = scan({
      sessions: ['/work/a', '/work/b'].map((cwd, i) =>
        sess(`p${i}`, { cwd, buckets: [{ day: '2026-10-10', in: 1 }] }),
      ),
    });
    expect(report(data, { filter: { kind: 'cwd', cwd: '/work' } }).rows).toEqual([]);
  });
});

describe('buildReport rows and totals (D-07, D-08, D-12, D-14)', () => {
  it('splits a session across the Sunday to Monday week edge and counts it once in the total', () => {
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: [
              { day: '2026-10-18', in: M },
              { day: '2026-10-19', in: M },
            ],
            time: { '2026-10-18': 120_000, '2026-10-19': 60_000 },
          }),
        ],
      }),
      { period: 'week' },
    );
    expect(r.rows.map((x) => [x.period, x.sessions, x.costUsd, x.activeMs])).toEqual([
      ['2026-W42', 1, 3, 120_000],
      ['2026-W43', 1, 3, 60_000],
    ]);
    expect(r.subtotals).toEqual([]);
    expect(r.total).toMatchObject({ period: '', project: '', sessions: 1, costUsd: 6, activeMs: 180_000 });
  });

  it('counts a session only where it has a request, time or cost', () => {
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: [{ day: '2026-10-10', in: M }],
            time: { '2026-10-09': 0, '2026-10-11': 5000 },
          }),
        ],
        ledger: {},
      }),
    );
    expect(r.rows.map((x) => [x.period, x.sessions])).toEqual([
      ['2026-10-10', 1],
      ['2026-10-11', 1],
    ]);
    expect(rowOf(r.rows, '2026-10-11')).toMatchObject({ costUsd: null, activeMs: 5000 });
  });

  it('drops days outside since/until', () => {
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: ['2026-10-04', '2026-10-05', '2026-10-07', '2026-10-08'].map((day) => ({ day, in: M })),
          }),
        ],
      }),
      { since: '2026-10-05', until: '2026-10-07' },
    );
    expect(r.rows.map((x) => x.period)).toEqual(['2026-10-05', '2026-10-07']);
    expect(r).toMatchObject({ since: '2026-10-05', until: '2026-10-07', period: 'day' });
  });

  it('sorts by period, cost (null last), tokens and project; subtotals only for periods with several rows', () => {
    const r = report(
      scan({
        sessions: [
          sess('n', { cwd: '/p/null', buckets: [{ day: '2026-10-10', model: 'x-model', in: 9 * M }] }),
          sess('cheap', { cwd: '/p/cheap', buckets: [{ day: '2026-10-10', in: M }] }),
          sess('dear', { cwd: '/p/dear', buckets: [{ day: '2026-10-10', in: 5 * M }] }),
          sess('t1', { cwd: '/p/b', buckets: [{ day: '2026-10-10', model: 'y-model', in: 2 }] }),
          sess('t2', { cwd: '/p/a', buckets: [{ day: '2026-10-10', model: 'y-model', in: 2 }] }),
          sess('old', {
            cwd: '/p/dear',
            buckets: [{ day: '2026-10-09', in: M }],
            time: { '2026-10-09': 1000 },
          }),
        ],
      }),
    );
    expect(r.rows.map((x) => `${x.period} ${x.project}`)).toEqual([
      '2026-10-09 /p/dear',
      '2026-10-10 /p/dear',
      '2026-10-10 /p/cheap',
      '2026-10-10 /p/null',
      '2026-10-10 /p/a',
      '2026-10-10 /p/b',
    ]);
    expect(r.subtotals).toHaveLength(1);
    expect(r.subtotals[0]).toMatchObject({
      period: '2026-10-10',
      project: '',
      sessions: 5,
      costUsd: 18,
      costSource: 'transcript',
      partial: true,
    });
    expect(r.subtotals[0]!.tokens!.input).toBe(15 * M + 4);
    expect(r.total).toMatchObject({ sessions: 6, costUsd: 21, activeMs: 1000, partial: true });
    expect(r.total!.tokens!.input).toBe(16 * M + 4);
    expect(r.unpriced).toEqual({ models: ['x-model', 'y-model'], requests: 3 });
  });

  it('sums cache reads and both cache write classes', () => {
    const r = report(
      scan({
        sessions: [sess('s1', { buckets: [{ day: '2026-10-10', in: 1, out: 2, cr: 3, w5: 4, w1: 5 }] })],
      }),
    );
    expect(r.rows[0]!.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 9, total: 15 });
  });

  it('treats non-finite and negative numbers as zero', () => {
    const r = report(
      scan({
        sessions: [
          sess('s1', {
            buckets: [{ day: '2026-10-10', in: Number.NaN, out: Number.POSITIVE_INFINITY, cr: -5, w5: 10 }],
            time: { '2026-10-10': Number.NaN, '2026-10-11': -1 },
          }),
        ],
        ledger: { s2: led('/work/x', 0, { '2026-10-10': Number.POSITIVE_INFINITY, 'not-a-day': 3 }) },
      }),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 10, total: 10 });
    expect(Number.isFinite(r.total!.costUsd)).toBe(true);
  });

  it('returns no rows and a null total for empty data', () => {
    const r = report(scan({}));
    expect(r.rows).toEqual([]);
    expect(r.subtotals).toEqual([]);
    expect(r.total).toBeNull();
    expect(r.notes).toEqual([{ code: 'estimate' }]);
  });
});

describe('buildReport notes', () => {
  it('always has estimate first, ledger-since with its date and scan notes with counts', () => {
    withTz('UTC', () => {
      const r = report(
        scan({
          sessions: [sess('s1', { buckets: [{ day: '2026-10-10', in: 1 }] })],
          ledgerSince: Date.UTC(2026, 8, 3, 10),
          notes: [
            { code: 'deleted-transcripts', count: 4 },
            { code: 'line-skipped', count: 1 },
          ],
        }),
      );
      expect(r.notes[0]).toEqual({ code: 'estimate' });
      expect(r.ledgerSince).toBe('2026-09-03');
      expect(r.pricesUpdated).toBe(PRICES_UPDATED);
      expect(r.notes).toContainEqual({ code: 'ledger-since', params: { date: '2026-09-03' } });
      expect(r.notes).toContainEqual({ code: 'deleted-transcripts', params: { count: 4 } });
      expect(r.notes).toContainEqual({ code: 'line-skipped', params: { count: 1 } });
      expect(r.notes.some((n) => n.code === 'partial' || n.code === 'unpriced')).toBe(false);
    });
  });

  it('uses the ledger epsilon of the ledger module', () => {
    expect(LEDGER_ZERO_USD).toBe(LEDGER_ZERO);
  });
});
