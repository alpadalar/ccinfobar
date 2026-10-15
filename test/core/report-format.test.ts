import { describe, expect, it } from 'vitest';
import { reportMessages as en } from '../../src/core/i18n/en/report.js';
import { reportMessages as tr } from '../../src/core/i18n/tr/report.js';
import { csvNum, csvText, formatCsv, formatJson } from '../../src/core/report-format.js';
import type { NoteCode, Report, ReportRow } from '../../src/core/report-types.js';

const HEADER =
  'period,project,sessions,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,cost_source,partial,active_seconds';

function row(over: Partial<ReportRow> = {}): ReportRow {
  return {
    period: '2026-10-14',
    project: '/home/u/work/api',
    approx: false,
    sessions: 1,
    tokens: { input: 3000, output: 9000, cacheRead: 800_000, cacheWrite: 60_000, total: 872_000 },
    costUsd: 0.94,
    costSource: 'transcript',
    partial: false,
    activeMs: 1_320_000,
    ...over,
  };
}

function report(rows: ReportRow[], over: Partial<Report> = {}): Report {
  return {
    period: 'day',
    since: '2026-10-08',
    until: '2026-10-14',
    rows,
    subtotals: [],
    total: rows.length ? row({ period: '', project: '', sessions: rows.length }) : null,
    unpriced: { models: [], requests: 0 },
    ledgerSince: null,
    pricesUpdated: '2026-10-15',
    notes: [{ code: 'estimate' }],
    ...over,
  };
}

const lines = (csv: string) => csv.split('\r\n').slice(0, -1);
const projectCell = (p: string) => lines(formatCsv(report([row({ project: p })])))[1]!.split(',')[1];

describe('csvText', () => {
  it('quotes commas, quotes, CR and LF', () => {
    expect(csvText('/w/a,b')).toBe('"/w/a,b"');
    expect(csvText('/w/say "hi"')).toBe('"/w/say ""hi"""');
    expect(csvText('/w/a\nb')).toBe('"/w/a\nb"');
    expect(csvText('/w/a\rb')).toBe('"/w/a\rb"');
    expect(csvText('/w/plain')).toBe('/w/plain');
    expect(csvText(null)).toBe('');
  });

  it('guards formula starts, including LF and full-width forms', () => {
    for (const v of ['=1', '+1', '-cmd', '@sum', '\tx', '\rx', '\nx', '＝1', '＋1', '－x', '＠x']) {
      const out = csvText(v);
      expect(out.replace(/^"/, ''), JSON.stringify(v)).toMatch(/^'/);
    }
    expect(csvText('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvText('\nx')).toBe('"\'\nx"');
    expect(csvText('a=1')).toBe('a=1');
  });
});

describe('csvNum', () => {
  it('writes plain decimals', () => {
    expect(csvNum(0.1234567, 6)).toBe('0.123457');
    expect(csvNum(1e-7, 6)).toBe('0');
    expect(csvNum(12.5, 6)).toBe('12.5');
    expect(csvNum(100, 6)).toBe('100');
    expect(csvNum(1234.4)).toBe('1234');
    expect(csvNum(1e21)).toBe('1000000000000000000000');
    expect(csvNum(-0, 6)).toBe('0');
    expect(csvNum(null)).toBe('');
    expect(csvNum(Number.NaN)).toBe('');
    expect(csvNum(Number.POSITIVE_INFINITY, 6)).toBe('');
  });
});

describe('formatCsv', () => {
  it('writes the fixed header, CRLF and no BOM', () => {
    const csv = formatCsv(report([row(), row({ project: '/home/u/ccinfobar', costUsd: 14.2 })]));
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const ls = lines(csv);
    expect(ls[0]).toBe(HEADER);
    expect(ls).toHaveLength(3);
    expect(ls[1]).toBe(
      '2026-10-14,/home/u/work/api,1,3000,9000,800000,60000,872000,0.94,transcript,false,1320',
    );
  });

  it('has no subtotal or total lines', () => {
    const r = report([row(), row({ project: '/b' })], {
      subtotals: [row({ project: '', sessions: 2 })],
    });
    expect(lines(formatCsv(r))).toHaveLength(3);
  });

  it('writes empty cells for null and raw numbers', () => {
    const ls = lines(
      formatCsv(
        report([
          row({ tokens: null, costUsd: null, costSource: null, activeMs: null, partial: true }),
          row({ costUsd: 0.1234567, activeMs: 1499 }),
          row({ costUsd: 1e-7, activeMs: 1500 }),
        ]),
      ),
    );
    expect(ls[1]).toBe('2026-10-14,/home/u/work/api,1,,,,,,,,true,');
    expect(ls[2]!.split(',').slice(8)).toEqual(['0.123457', 'transcript', 'false', '1']);
    expect(ls[3]!.split(',').slice(8)).toEqual(['0', 'transcript', 'false', '2']);
    expect(ls.join('')).not.toMatch(/e-/);
  });

  it('keeps the full sanitized path and guards formulas', () => {
    expect(projectCell('/home/u/work/api')).toBe('/home/u/work/api');
    expect(lines(formatCsv(report([row({ project: '=HYPERLINK("http://x","y")' })])))[1]).toContain(
      ',"\'=HYPERLINK(""http://x"",""y"")",',
    );
    for (const p of ['-cmd', '+1', '@sum', '＝1', '－x', '＠x']) expect(projectCell(p)).toBe(`'${p}`);
    expect(projectCell('/w/\x1b[31mred\x1b[0m')).toBe('/w/red');
    expect(lines(formatCsv(report([row({ project: '/w/a,b' })])))[1]).toContain(',"/w/a,b",');
  });

  it('writes only the header for no rows', () => {
    expect(formatCsv(report([]))).toBe(`${HEADER}\r\n`);
  });
});

const META = {
  generatedAt: '2026-10-15T09:00:00.000Z',
  timeZone: 'Europe/Istanbul',
  claudeDir: '/home/u/.claude',
};

describe('formatJson', () => {
  it('writes one stable English object', () => {
    const r = report(
      [
        row({ project: '/home/u/ccinfobar', costUsd: 14.2 + 0.0000001, sessions: 3, costSource: 'mixed' }),
        row({
          costUsd: null,
          costSource: null,
          partial: true,
          tokens: null,
          activeMs: null,
          costOther: { CNY: 2.5 },
        }),
      ],
      {
        ledgerSince: '2026-09-01',
        unpriced: { models: ['mystery-1'], requests: 4 },
        notes: [
          { code: 'estimate' },
          { code: 'ledger-since', params: { date: '2026-09-01' } },
          { code: 'unpriced', params: { models: 'mystery-1', requests: 4 } },
          { code: 'non-usd', params: { currency: 'CNY', amount: 2.5 } },
          { code: 'partial' },
        ],
      },
    );
    const text = formatJson(r, META);
    expect(text.endsWith('}\n')).toBe(true);
    const obj = JSON.parse(text);
    expect(Object.keys(obj)).toEqual([
      'v',
      'generatedAt',
      'period',
      'since',
      'until',
      'timeZone',
      'claudeDir',
      'ledgerSince',
      'pricesUpdated',
      'rows',
      'totals',
      'unpriced',
      'notes',
    ]);
    expect(text).toBe(`${JSON.stringify(obj, null, 2)}\n`);
    const tokens = { input: 3000, output: 9000, cacheRead: 800000, cacheWrite: 60000, total: 872000 };
    expect(obj).toEqual({
      v: 1,
      generatedAt: '2026-10-15T09:00:00.000Z',
      period: 'day',
      since: '2026-10-08',
      until: '2026-10-14',
      timeZone: 'Europe/Istanbul',
      claudeDir: '/home/u/.claude',
      ledgerSince: '2026-09-01',
      pricesUpdated: '2026-10-15',
      rows: [
        {
          period: '2026-10-14',
          project: '/home/u/ccinfobar',
          approx: false,
          sessions: 3,
          tokens,
          costUsd: 14.2,
          costSource: 'mixed',
          partial: false,
          activeMs: 1320000,
        },
        {
          period: '2026-10-14',
          project: '/home/u/work/api',
          approx: false,
          sessions: 1,
          tokens: null,
          costUsd: null,
          costSource: null,
          partial: true,
          activeMs: null,
          costOther: { CNY: 2.5 },
        },
      ],
      totals: {
        sessions: 2,
        tokens,
        costUsd: 0.94,
        costSource: 'transcript',
        partial: false,
        activeMs: 1320000,
      },
      unpriced: { models: ['mystery-1'], requests: 4 },
      notes: [
        {
          code: 'estimate',
          text: 'Costs are estimates at list prices; on a subscription they are not what you pay.',
        },
        {
          code: 'ledger-since',
          text: 'The cost ledger starts on 2026-09-01; earlier costs are estimated from transcripts.',
        },
        { code: 'unpriced', text: 'No price for mystery-1 (4 requests); their cost is not counted.' },
        { code: 'non-usd', text: 'Costs in CNY are not in the USD totals: ¥2.50.' },
        { code: 'partial', text: '* Partial cost: the ledger joined late or some requests have no price.' },
      ],
    });
    expect(Object.keys(obj.rows[1])).toEqual([
      'period',
      'project',
      'approx',
      'sessions',
      'tokens',
      'costUsd',
      'costSource',
      'partial',
      'activeMs',
      'costOther',
    ]);
  });

  it('never translates notes', async () => {
    const { withLanguage } = await import('../../src/core/i18n/index.js');
    const r = report([row()], { notes: [{ code: 'estimate' }, { code: 'partial' }] });
    const a = formatJson(r, META);
    expect(withLanguage('tr', () => formatJson(r, META))).toBe(a);
    expect(JSON.parse(a).notes).toEqual([
      { code: 'estimate', text: en['report.note.estimate'] },
      { code: 'partial', text: en['report.note.partial'] },
    ]);
  });

  it('sanitizes projects and models and gives null totals for an empty report', () => {
    const r = report([row({ project: '/w/\x1b]0;x\x07a' })], {
      unpriced: { models: ['m\x1b[31m1'], requests: 1 },
    });
    const obj = JSON.parse(formatJson(r, META));
    expect(obj.rows[0].project).toBe('/w/a');
    expect(obj.unpriced.models).toEqual(['m1']);
    expect(JSON.parse(formatJson(report([]), META)).totals).toBeNull();
  });
});

describe('report messages', () => {
  const codes: NoteCode[] = [
    'estimate',
    'ledger-since',
    'unpriced',
    'non-usd',
    'partial',
    'profile-price',
    'approx-project',
    'ledger-only',
    'file-cap',
    'line-skipped',
    'deleted-transcripts',
    'rebuild-kept',
  ];

  it('has an English and a Turkish text for every note code', () => {
    for (const c of codes) {
      const id = `report.note.${c}` as keyof typeof en;
      expect(en[id], c).toBeDefined();
      expect(tr[id], c).toBeDefined();
    }
    expect(Object.keys(en).filter((k) => k.startsWith('report.note.'))).toHaveLength(codes.length);
  });
});
