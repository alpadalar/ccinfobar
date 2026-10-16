import os from 'node:os';
import path from 'node:path';
import type { Args } from '../cli/args.js';
import { applyLanguage } from '../cli/lang.js';
import { detectLevel, type Level } from '../core/ansi.js';
import { loadConfig } from '../core/config.js';
import { type MessageId, t } from '../core/i18n/index.js';
import { tildify } from '../core/paths.js';
import { formatCsv, formatJson, formatTable } from '../core/report-format.js';
import { buildReport, parseRange, type Range, type RangeError as RangeFail } from '../core/report-model.js';
import type { ProjectFilter, ScanResult } from '../core/report-types.js';
import { sanitizeText } from '../core/sanitize.js';
import { ledgerDir, monthFiles, normalizeRoot, rebuildSummary } from '../data/ledger.js';
import { readReportData, timeZone as zoneOf } from '../data/report-index.js';

export interface ReportIo {
  tty: boolean;
  errTty: boolean;
  columns: number | undefined;
  log(line: string): void;
  error(line: string): void;
  write(text: string): void;
  progress(text: string): void;
  now(): number;
}

export function reportIo(): ReportIo {
  return {
    tty: !!process.stdout.isTTY,
    errTty: !!process.stderr.isTTY,
    columns: process.stdout.columns,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    write: (text) => void process.stdout.write(text),
    progress: (text) => void process.stderr.write(text ? `\r${text}\x1b[K` : '\r\x1b[K'),
    now: () => Date.now(),
  };
}

type Format = 'table' | 'csv' | 'json';

const FORMATS: readonly Format[] = ['table', 'csv', 'json'];
const RANGE_ERRORS: Record<RangeFail['error'], MessageId> = {
  period: 'report.badPeriod',
  since: 'report.badSince',
  until: 'report.badUntil',
  order: 'report.badOrder',
};
const PROGRESS_AFTER = 1000;
const PROGRESS_EVERY = 250;

function fail(io: ReportIo, id: MessageId, params?: Record<string, string>): void {
  io.error(`✗ ${t(id, params)}`);
  process.exitCode = 1;
}

function formatOf(args: Args): Format | { error: MessageId; value?: string } {
  const f = args.flags.format;
  const picked: Format[] = [];
  if (f !== undefined && f !== false) {
    const v = typeof f === 'string' ? f : '';
    if (!FORMATS.includes(v as Format)) return { error: 'report.badFormat', value: v };
    picked.push(v as Format);
  }
  if (args.flags.csv === true) picked.push('csv');
  if (args.flags.json === true) picked.push('json');
  if (new Set(picked).size > 1) return { error: 'report.formatConflict' };
  return picked[0] ?? 'table';
}

function filterOf(args: Args): ProjectFilter | null | undefined {
  const p = args.flags.project;
  if (p === undefined || p === false) return null;
  if (typeof p !== 'string' || !p) return undefined;
  return p === '.' ? { kind: 'root', root: normalizeRoot(process.cwd()) } : { kind: 'substring', text: p };
}

function widthOf(args: Args, io: ReportIo, env: NodeJS.ProcessEnv): number | null {
  const w = typeof args.flags.width === 'string' ? Number(args.flags.width) : Number.NaN;
  if (Number.isFinite(w) && w > 0) return Math.floor(w);
  if (!io.tty) return null;
  const cols = io.columns ?? Number(env.COLUMNS);
  return Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : null;
}

function levelOf(io: ReportIo, env: NodeJS.ProcessEnv, setting: Parameters<typeof detectLevel>[0]): Level {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0';
  if ((!io.tty && !forced) || env.NO_COLOR || env.FORCE_COLOR === '0') return 0;
  return detectLevel(setting, env);
}

// silent until the scan has run for a second
function progressOf(io: ReportIo) {
  const start = io.now();
  let last = Number.NEGATIVE_INFINITY;
  let shown = false;
  return {
    tick(files: number, bytes: number) {
      if (!io.errTty) return;
      const now = io.now();
      if (now - start < PROGRESS_AFTER || now - last < PROGRESS_EVERY) return;
      last = now;
      shown = true;
      io.progress(t('report.progress', { count: files, mb: Math.round(bytes / 1e6) }));
    },
    done() {
      if (shown) io.progress('');
    },
  };
}

interface Plan {
  format: Format;
  filter: ProjectFilter | null;
  range: Range;
}

function planOf(args: Args, io: ReportIo, now: number): Plan | null {
  const format = formatOf(args);
  if (typeof format !== 'string') {
    fail(io, format.error, { value: sanitizeText(format.value ?? '') });
    return null;
  }
  const filter = filterOf(args);
  if (filter === undefined) {
    fail(io, 'report.projectValue');
    return null;
  }
  const { period, since, until } = args.flags;
  const range = parseRange({ period, since, until, all: args.flags.all === true }, now);
  if ('error' in range) {
    fail(io, RANGE_ERRORS[range.error], { value: sanitizeText(range.value) });
    return null;
  }
  return { format, filter, range };
}

function readData(env: NodeJS.ProcessEnv, io: ReportIo, now: number, rebuild: boolean): ScanResult {
  let summary: 'ok' | 'none' | 'failed' = 'none';
  if (rebuild && monthFiles(ledgerDir(env)).length > 0) summary = rebuildSummary(env, now) ? 'ok' : 'failed';
  const progress = progressOf(io);
  let data: ScanResult;
  try {
    data = readReportData(env, { rebuild, now, onProgress: progress.tick });
  } finally {
    progress.done();
  }
  if (rebuild) {
    if (summary === 'failed') fail(io, 'report.rebuildFailed');
    io.error(t(summary === 'ok' ? 'report.rebuilt' : 'report.reread', { count: data.files }));
    const kept = data.notes.find((n) => n.code === 'rebuild-kept');
    if (kept) io.error(t('report.keptDeleted', { count: kept.count }));
  }
  return data;
}

export function runReport(args: Args, cfgFile: string, io: ReportIo = reportIo()): void {
  const env = process.env;
  const loaded = loadConfig(cfgFile);
  if (!loaded.issue) applyLanguage(loaded.config);
  const now = io.now();
  const plan = planOf(args, io, now);
  if (!plan) return;
  const data = readData(env, io, now, args.flags.rebuild === true);
  const report = buildReport(data, { ...plan.range, filter: plan.filter, config: loaded.config });
  if (plan.format === 'csv') io.write(formatCsv(report));
  else if (plan.format === 'json') {
    const timeZone = zoneOf();
    const generatedAt = new Date(now).toISOString();
    io.write(formatJson(report, { generatedAt, timeZone, claudeDir: data.claudeDir }));
  } else {
    const lines = formatTable(report, {
      width: widthOf(args, io, env),
      level: levelOf(io, env, loaded.config.colorLevel),
      home: os.homedir(),
      sep: path.sep === '\\' ? '\\' : '/',
    });
    if (!lines.length) io.log(t('report.empty', { dir: sanitizeText(tildify(data.claudeDir)) }));
    for (const line of lines) io.log(line);
  }
}
