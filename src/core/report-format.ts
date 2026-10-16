import { formatCurrency, formatDuration, formatMoney, formatTokens } from '../widgets/shared.js';
import { type Level, style, truncate, visibleWidth } from './ansi.js';
import { type MessageId, t, withLanguage } from './i18n/index.js';
import type { Report, ReportNote, ReportRow, Tokens } from './report-types.js';
import { sanitizeText } from './sanitize.js';

const CSV_HEADER = [
  'period',
  'project',
  'sessions',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
  'cost_usd',
  'cost_source',
  'partial',
  'active_seconds',
].join(',');

// OWASP CSV injection starts, plus full-width ＝＋－＠
const DANGER = /^[=+\-@\t\r\n＝＋－＠]/;

export function csvText(v: string | null): string {
  if (v === null) return '';
  let s = DANGER.test(v) ? `'${v}` : v;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// plain decimals only; String(1e-7) gives exponent form
export function csvNum(n: number | null, digits = 0): string {
  if (n === null || !Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1e21) return BigInt(Math.round(n)).toString();
  const s = digits ? n.toFixed(digits).replace(/\.?0+$/, '') : String(Math.round(n));
  return s === '-0' ? '0' : s;
}

export function formatCsv(report: Report): string {
  const out = [CSV_HEADER];
  for (const r of report.rows) {
    const k = r.tokens;
    out.push(
      [
        csvText(r.period),
        csvText(sanitizeText(r.project)),
        csvNum(r.sessions),
        csvNum(k?.input ?? null),
        csvNum(k?.output ?? null),
        csvNum(k?.cacheRead ?? null),
        csvNum(k?.cacheWrite ?? null),
        csvNum(k?.total ?? null),
        csvNum(r.costUsd, 6),
        csvText(r.costSource),
        r.partial ? 'true' : 'false',
        csvNum(r.activeMs === null ? null : r.activeMs / 1000),
      ].join(','),
    );
  }
  return `${out.join('\r\n')}\r\n`;
}

export function noteText(note: ReportNote): string {
  const p: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(note.params ?? {})) p[k] = typeof v === 'string' ? sanitizeText(v) : v;
  if (note.code === 'non-usd' && typeof p.amount === 'number')
    p.amount = formatMoney(p.amount, String(p.currency ?? ''));
  if (note.code === 'unpriced') p.count = p.requests ?? 0;
  return t(`report.note.${note.code}` as MessageId, p);
}

const usd = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6);

function rowJson(r: ReportRow, full: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (full) {
    out.period = r.period;
    out.project = sanitizeText(r.project);
    out.approx = r.approx;
  }
  out.sessions = r.sessions;
  out.tokens = r.tokens ? { ...r.tokens } : null;
  out.costUsd = usd(r.costUsd);
  out.costSource = r.costSource;
  out.partial = r.partial;
  out.activeMs = r.activeMs === null ? null : Math.round(r.activeMs);
  out.tokensPartial = r.tokensPartial === true;
  if (r.costOther) {
    const other: Record<string, number> = {};
    for (const [c, v] of Object.entries(r.costOther)) other[sanitizeText(c)] = usd(v)!;
    out.costOther = other;
  }
  return out;
}

export function formatJson(
  report: Report,
  meta: { generatedAt: string; timeZone: string; claudeDir: string },
): string {
  const obj = {
    v: 1,
    generatedAt: meta.generatedAt,
    period: report.period,
    since: report.since,
    until: report.until,
    timeZone: meta.timeZone,
    claudeDir: meta.claudeDir,
    ledgerSince: report.ledgerSince,
    pricesUpdated: report.pricesUpdated,
    rows: report.rows.map((r) => rowJson(r, true)),
    totals: report.total ? rowJson(report.total, false) : null,
    unpriced: { models: report.unpriced.models.map(sanitizeText), requests: report.unpriced.requests },
    notes: withLanguage('en', () => report.notes.map((n) => ({ code: n.code, text: noteText(n) }))),
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function displayProjects(projects: string[], home: string, sep: '/' | '\\'): Map<string, string> {
  const fold = (x: string) => (sep === '\\' ? x.toLowerCase() : x);
  const split = sep === '\\' ? /[\\/]+/ : /\/+/;
  const h = fold(home);
  const items = [...new Set(projects)].map((p) => {
    const clean = sanitizeText(p);
    const f = fold(clean);
    const tild = !home
      ? clean
      : f === h
        ? '~'
        : f.startsWith(h + sep)
          ? `~${clean.slice(home.length)}`
          : clean;
    return { p, tild, parts: tild.split(split).filter(Boolean), depth: 1 };
  });
  const name = (i: (typeof items)[number]) =>
    i.depth >= i.parts.length ? i.tild : i.parts.slice(-i.depth).join(sep);
  for (let changed = true; changed; ) {
    changed = false;
    const groups = new Map<string, typeof items>();
    for (const i of items) groups.set(name(i), [...(groups.get(name(i)) ?? []), i]);
    for (const g of groups.values()) {
      if (new Set(g.map((i) => i.tild)).size < 2) continue;
      for (const i of g) {
        if (i.depth >= i.parts.length) continue;
        i.depth++;
        changed = true;
      }
    }
  }
  return new Map(items.map((i) => [i.p, name(i)]));
}

let seg: Intl.Segmenter | undefined;

function midTruncate(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  if (max < 3) return truncate(s, max);
  const tailW = Math.floor((max - 1) / 2);
  const head = truncate(s, max - tailW);
  seg ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  const parts = Array.from(seg.segment(s), (x) => x.segment);
  let tail = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = parts[i]! + tail;
    if (visibleWidth(next) > max - visibleWidth(head)) break;
    tail = next;
  }
  return head + tail;
}

type Col = 'period' | 'project' | 'sessions' | keyof Tokens | 'cost' | 'active';

const COLS: Col[] = [
  'period',
  'project',
  'sessions',
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'total',
  'cost',
  'active',
];
const DROP: Col[] = ['cacheWrite', 'cacheRead', 'input', 'output'];
const PERIOD_COL = { day: 'report.col.day', week: 'report.col.week', month: 'report.col.month' } as const;

const pad = (s: string, w: number, right: boolean) => {
  const fill = ' '.repeat(Math.max(0, w - visibleWidth(s)));
  return right ? fill + s : s + fill;
};

export function formatTable(
  report: Report,
  opts: { width: number | null; level: Level; home: string; sep: '/' | '\\' },
): string[] {
  if (report.rows.length === 0) return [];
  const names = displayProjects(
    report.rows.map((r) => r.project),
    opts.home,
    opts.sep,
  );
  const entries: { row: ReportRow; label: string; sum: boolean }[] = [];
  const subs = new Map(report.subtotals.map((r) => [r.period, r]));
  report.rows.forEach((r, i) => {
    entries.push({ row: r, label: names.get(r.project) ?? '', sum: false });
    const sub = subs.get(r.period);
    if (sub && report.rows[i + 1]?.period !== r.period)
      entries.push({ row: sub, label: t('report.subtotal'), sum: true });
  });
  if (report.total) entries.push({ row: report.total, label: t('report.total'), sum: true });

  const mark = t('report.partialMark');
  const anyPartial = entries.some((e) => e.row.partial);
  const low = t('report.tokensMark');
  const anyLow = entries.some((e) => e.row.tokensPartial);
  const none = '\u2014';
  const lowMark = (r: ReportRow, s: string) =>
    r.tokensPartial ? s + low : anyLow ? s + ' '.repeat(visibleWidth(low)) : s;
  const tok = (r: ReportRow, c: keyof Tokens) => (r.tokens ? lowMark(r, formatTokens(r.tokens[c])) : none);
  const cost = (r: ReportRow) => {
    const s = r.costUsd === null ? none : formatCurrency(r.costUsd);
    return r.partial ? s + mark : anyPartial ? s + ' '.repeat(visibleWidth(mark)) : s;
  };
  const header: Record<Col, string> = {
    period: t(PERIOD_COL[report.period]),
    project: t('report.col.project'),
    sessions: t('report.col.sessions'),
    input: t('report.col.input'),
    output: t('report.col.output'),
    cacheRead: t('report.col.cacheRead'),
    cacheWrite: t('report.col.cacheWrite'),
    total: t('report.col.total'),
    cost: t('report.col.cost'),
    active: t('report.col.active'),
  };
  const body = entries.map(
    ({ row: r, label, sum }): Record<Col, string> => ({
      period: sum ? '' : r.period,
      project: label,
      sessions: String(r.sessions),
      input: tok(r, 'input'),
      output: tok(r, 'output'),
      cacheRead: tok(r, 'cacheRead'),
      cacheWrite: tok(r, 'cacheWrite'),
      total: tok(r, 'total'),
      cost: cost(r),
      active: r.activeMs === null ? none : lowMark(r, formatDuration(r.activeMs)),
    }),
  );

  const all = [header, ...body];
  const full = all.map((x) => x.project);
  const widthOf = (c: Col) => Math.max(...all.map((x) => visibleWidth(x[c])));
  const span = (cs: Col[]) => cs.reduce((n, c) => n + widthOf(c), 0) + 2 * (cs.length - 1);
  const right = (c: Col) => c !== 'period' && c !== 'project';
  const max = opts.width;
  let cols = [...COLS];
  const fits = () => max === null || span(cols) <= max;
  // the project gives way down to floor before the next column goes
  const shrink = (floor: number) => {
    all.forEach((x, i) => {
      x.project = full[i]!;
    });
    const over = max === null ? 0 : span(cols) - max;
    if (over <= 0) return;
    const w = widthOf('project');
    const target = Math.max(Math.min(floor, w), w - over);
    for (const x of all) x.project = midTruncate(x.project, target);
  };
  for (const d of DROP) {
    if (fits()) break;
    cols = cols.filter((c) => c !== d);
  }
  shrink(8);
  for (const d of ['sessions', 'active'] as Col[]) {
    if (fits()) break;
    cols = cols.filter((c) => c !== d);
    shrink(8);
  }
  if (!fits()) shrink(4);
  let table: string[];
  if (fits()) {
    const widths = new Map(cols.map((c) => [c, widthOf(c)]));
    const line = (x: Record<Col, string>) =>
      cols
        .map((c) => pad(x[c], widths.get(c)!, right(c)))
        .join('  ')
        .trimEnd();
    table = [style(line(header), { bold: true }, opts.level), ...body.map(line)];
  } else table = stacked(all, full, header, body, max!, widthOf, span, opts.level);
  const notes = report.notes.map(noteText);
  if (anyPartial && !report.notes.some((n) => n.code === 'partial'))
    notes.push(noteText({ code: 'partial' }));
  if (anyLow && !report.notes.some((n) => n.code === 'tokens-partial'))
    notes.push(noteText({ code: 'tokens-partial' }));
  return [...table, ...(notes.length ? ['', ...notes.map((n) => style(n, { dim: true }, opts.level))] : [])];
}

// period and project on one line, the numbers indented below
function stacked(
  all: Record<Col, string>[],
  full: string[],
  header: Record<Col, string>,
  body: Record<Col, string>[],
  max: number,
  widthOf: (c: Col) => number,
  span: (cs: Col[]) => number,
  level: Level,
): string[] {
  const pw = widthOf('period');
  all.forEach((x, i) => {
    x.project = midTruncate(full[i]!, Math.max(1, max - pw - 2));
  });
  let nums: Col[] = ['sessions', 'total', 'cost', 'active'];
  for (const d of ['sessions', 'active', 'total'] as Col[]) {
    if (2 + span(nums) <= max) break;
    nums = nums.filter((c) => c !== d);
  }
  if (2 + span(nums) > max) {
    // headers give way to the values
    for (const c of nums) {
      const vw = Math.max(1, ...body.map((x) => visibleWidth(x[c])));
      header[c] = truncate(header[c], vw);
    }
  }
  const widths = new Map(nums.map((c) => [c, widthOf(c)]));
  const top = (x: Record<Col, string>) => `${pad(x.period, pw, false)}  ${x.project}`.trimEnd();
  const below = (x: Record<Col, string>) =>
    `  ${nums.map((c) => pad(x[c], widths.get(c)!, true)).join('  ')}`.trimEnd();
  return [
    style(top(header), { bold: true }, level),
    style(below(header), { bold: true }, level),
    ...body.flatMap((x) => [top(x), below(x)]),
  ];
}
