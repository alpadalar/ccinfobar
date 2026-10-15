import { formatMoney } from '../widgets/shared.js';
import { type MessageId, t, withLanguage } from './i18n/index.js';
import type { Report, ReportNote, ReportRow } from './report-types.js';
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
