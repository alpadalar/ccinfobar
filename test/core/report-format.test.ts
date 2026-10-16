import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../../src/core/ansi.js';
import { reportMessages as en } from '../../src/core/i18n/en/report.js';
import { withLanguage } from '../../src/core/i18n/index.js';
import { reportMessages as tr } from '../../src/core/i18n/tr/report.js';
import {
  csvNum,
  csvText,
  displayProjects,
  formatCsv,
  formatJson,
  formatTable,
} from '../../src/core/report-format.js';
import type { NoteCode, Report, ReportRow } from '../../src/core/report-types.js';
import { withTz } from '../helpers.js';

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

  it('never translates notes', () => {
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
    'keys-lost',
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

const BIG = {
  input: 41_000,
  output: 120_000,
  cacheRead: 18_200_000,
  cacheWrite: 1_100_000,
  total: 19_461_000,
};

function dayReport(over: Partial<Report> = {}): Report {
  return report(
    [
      row({ project: '/home/u/ccinfobar', sessions: 3, costUsd: 14.2, activeMs: 11_520_000, tokens: BIG }),
      row({ partial: true }),
      row({ period: '2026-10-15', project: '/home/u/old/api', costUsd: null, tokens: null, activeMs: null }),
    ],
    {
      subtotals: [row({ project: '', sessions: 4, costUsd: 15.14, partial: true })],
      total: row({ period: '', project: '', sessions: 5, costUsd: 15.14, partial: true }),
      ledgerSince: '2026-09-01',
      notes: [
        { code: 'estimate' },
        { code: 'ledger-since', params: { date: '2026-09-01' } },
        { code: 'partial' },
      ],
      ...over,
    },
  );
}

const OPTS = { width: null, level: 0, home: '/home/u', sep: '/' } as const;
const table = (r: Report, over: Partial<Parameters<typeof formatTable>[1]> = {}) =>
  formatTable(r, { ...OPTS, ...over });
const body = (ls: string[]) => ls.slice(0, ls.indexOf(''));

describe('formatTable', () => {
  it('prints rows, a subtotal, the total and footnotes', () => {
    expect(table(dayReport())).toEqual([
      'Day         Project    Sessions  Input  Output  Cache read  Cache write  Total  Cost (est.)  Active',
      '2026-10-14  ccinfobar         3  41.0k    120k         18M         1.1M    19M      $14.20   3h 12m',
      '2026-10-14  work/api          1   3.0k    9.0k        800k        60.0k   872k       $0.94*     22m',
      '            subtotal          4   3.0k    9.0k        800k        60.0k   872k      $15.14*     22m',
      '2026-10-15  old/api           1      \u2014       \u2014           \u2014            \u2014      \u2014           \u2014        \u2014',
      '            total             5   3.0k    9.0k        800k        60.0k   872k      $15.14*     22m',
      '',
      en['report.note.estimate'],
      'The cost ledger starts on 2026-09-01; earlier costs are estimated from transcripts.',
      en['report.note.partial'],
    ]);
  });

  it('labels the first column by period and gives nothing for no rows', () => {
    expect(table(dayReport({ period: 'week' }))[0]).toMatch(/^Week {8}Project/);
    expect(table(dayReport({ period: 'month' }))[0]).toMatch(/^Month {7}Project/);
    expect(table(report([]))).toEqual([]);
  });

  it('aligns wide text by display width', () => {
    const ls = body(table(report([row({ project: '/home/u/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8' }), row()])));
    const widths = ls.map(visibleWidth);
    expect(new Set(widths).size).toBe(1);
    expect(ls[1]!.length).toBeLessThan(widths[0]!);
  });

  it('drops columns in order, then middle-truncates the project', () => {
    const headers = (w: number | null) => table(dayReport(), { width: w })[0]!;
    expect(headers(200)).toContain('Cache write');
    expect(headers(99)).toContain('Cache write');
    expect(headers(90)).not.toContain('Cache write');
    expect(headers(90)).toContain('Cache read');
    expect(headers(80)).not.toContain('Cache read');
    expect(headers(80)).toContain('Input');
    expect(headers(70)).not.toContain('Input');
    expect(headers(70)).toContain('Output');
    expect(headers(60)).not.toContain('Output');
    expect(table(dayReport(), { width: 60 })[1]).toContain('ccinfobar');
    const narrow = table(dayReport(), { width: 55 });
    expect(narrow[1]).toContain('ccin\u2026bar');
    expect(narrow[2]).toContain('work/api');
    for (const w of [99, 90, 80, 70, 60]) {
      for (const l of body(table(dayReport(), { width: w })))
        expect(visibleWidth(l), String(w)).toBeLessThanOrEqual(w);
    }
    const tiny = table(dayReport(), { width: 10 })[0]!;
    for (const h of ['Day', 'Project', 'Sessions', 'Total', 'Cost (est.)', 'Active'])
      expect(tiny).toContain(h);
    expect(table(dayReport(), { width: 10 })[1]).toContain('ccin\u2026bar');
  });

  it('keeps everything without a width', () => {
    const name = 'x'.repeat(300);
    const ls = table(report([row({ project: `/home/u/${name}` })]));
    expect(ls[0]).toContain('Cache write');
    expect(ls[1]).toContain(name);
  });

  it('marks partial cost, null cost and ledger-only rows', () => {
    const ls = table(
      report(
        [row({ partial: true }), row({ project: '/a/b', costUsd: null, tokens: null, activeMs: null })],
        {
          notes: [{ code: 'estimate' }],
          total: null,
        },
      ),
    );
    expect(ls[1]).toMatch(/\$0\.94\*\s+22m$/);
    expect(ls[2]).toMatch(/1(?:\s+\u2014){7}$/);
    expect(ls.at(-1)).toBe(en['report.note.partial']);
  });

  it('styles only the header and footnotes', () => {
    expect(table(dayReport()).join('\n')).not.toContain('\x1b');
    const ls = table(dayReport(), { level: 1 });
    expect(ls[0]).toMatch(/^\x1b\[1mDay .*\x1b\[0m$/);
    for (const l of body(ls).slice(1)) expect(l).not.toContain('\x1b');
    for (const l of ls.slice(ls.indexOf('') + 1)) expect(l).toMatch(/^\x1b\[2m.*\x1b\[0m$/);
  });

  it('writes every footnote with sanitized params', () => {
    const ls = table(
      report([row()], {
        notes: [
          { code: 'estimate' },
          { code: 'ledger-since', params: { date: '2026-09-01' } },
          { code: 'unpriced', params: { models: 'm1, m\x1b[31m2', requests: 3 } },
          { code: 'non-usd', params: { currency: 'CNY', amount: 2.5 } },
          { code: 'profile-price', params: { vendor: 'zai' } },
          { code: 'approx-project', params: { count: 1 } },
          { code: 'ledger-only', params: { count: 2 } },
          { code: 'deleted-transcripts', params: { count: 2 } },
          { code: 'line-skipped', params: { count: 1 } },
          { code: 'file-cap', params: { count: 100000 } },
          { code: 'rebuild-kept', params: { count: 1 } },
        ],
      }),
    );
    expect(ls.slice(ls.indexOf('') + 1)).toEqual([
      en['report.note.estimate'],
      'The cost ledger starts on 2026-09-01; earlier costs are estimated from transcripts.',
      'No price for m1, m2 (3 requests); their cost is not counted.',
      'Costs in CNY are not in the USD totals: \u00a52.50.',
      'Prices for zai models come from the built-in zai profile.',
      '1 session has its project guessed from a folder name.',
      '2 sessions have a cost but no transcript left, so tokens and time show \u2014.',
      '2 deleted transcripts are still counted from the report index.',
      '1 oversized transcript line was skipped.',
      'Stopped after 100000 transcript files; some usage may be missing.',
      'The rebuild kept 1 deleted transcript from the old index.',
    ]);
  });

  it('prints the Turkish header', () => {
    const ls = withTz('Europe/Istanbul', () => withLanguage('tr', () => table(dayReport())));
    expect(ls[0]).toBe(
      'G\u00fcn         Proje       Oturum  Girdi  \u00c7\u0131kt\u0131  \u00d6nbellek okuma  \u00d6nbellek yazma  Toplam  Maliyet (tah.)   Aktif',
    );
    expect(ls[3]).toMatch(/^ {12}ara toplam /);
    expect(ls[5]).toMatch(/^ {12}toplam /);
    expect(ls.at(-1)).toBe(tr['report.note.partial']);
  });
});

describe('displayProjects', () => {
  const show = (ps: string[], home = '/home/u', sep: '/' | '\\' = '/') => [
    ...displayProjects(ps, home, sep).values(),
  ];

  it('shows the basename, widened on a shared basename', () => {
    expect(show(['/home/u/work/api', '/home/u/old/api', '/home/u/ccinfobar'])).toEqual([
      'work/api',
      'old/api',
      'ccinfobar',
    ]);
    expect(show(['/a/x/api', '/b/x/api'])).toEqual(['/a/x/api', '/b/x/api']);
  });

  it('tildifies with the given home and keeps outside paths absolute', () => {
    expect(show(['/home/u/api', '/opt/api'])).toEqual(['~/api', '/opt/api']);
    expect(show(['/home/u', '/home/user/x'])).toEqual(['~', 'x']);
    expect(show(['/home/u/api', '/opt/api'], '')).toEqual(['u/api', '/opt/api']);
  });

  it('handles Windows separators and case', () => {
    expect(show(['c:\\users\\u\\work\\api', 'c:\\users\\u\\old\\api'], 'C:\\Users\\u', '\\')).toEqual([
      'work\\api',
      'old\\api',
    ]);
    expect(show(['c:\\users\\u\\api', 'd:\\api'], 'C:\\Users\\u', '\\')).toEqual(['~\\api', 'd:\\api']);
  });

  it('removes escape sequences', () => {
    expect(show(['/home/u/\x1b[31mred\x1b[0m', '/home/u/\x1b]8;;http://x\x07link'])).toEqual(['red', 'link']);
  });
});
