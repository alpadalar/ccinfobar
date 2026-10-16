import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { main } from '../../src/cli/main.js';
import { type ReportIo, runReport } from '../../src/commands/report.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { tildify } from '../../src/core/paths.js';
import { normalizeRoot } from '../../src/data/ledger.js';
import { accountKeyFor } from '../../src/data/limits.js';
import {
  assistantLine,
  ledgerLine,
  scratch,
  userLine,
  writeLedger,
  writeTranscript,
} from '../fixtures/report/build.js';
import { REPORT_DEPS } from '../report-deps.js';

let root = '';
let cache = '';
let cfg = '';
let n = 0;

// local time, after TZ is pinned
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const NOW = () => at(5, 12);

function req(ts: number, cwd: string, tokens = 1000) {
  n++;
  return assistantLine({
    id: `m${n}`,
    requestId: `r${n}`,
    ts,
    in: tokens,
    out: tokens / 10,
    cr: 50,
    w5: 20,
    cwd,
  });
}

function session(project: string, sid: string, times: number[], tokens = 1000): string {
  const cwd = `/w/${project}`;
  const lines = times.flatMap((ts) => [userLine({ ts: ts - 60_000, cwd }), req(ts, cwd, tokens)]);
  return writeTranscript(`projects/-w-${project}/${sid}.jsonl`, lines, root);
}

function twoProjects(): void {
  session('api', 'a1', [at(3, 10), at(4, 10)]);
  session('web', 'w1', [at(4, 11), at(5, 9)], 3000);
}

interface Fake extends ReportIo {
  out: string[];
  err: string[];
  written: string[];
  prog: string[];
}

function fakeIo(o: Partial<ReportIo> = {}): Fake {
  const out: string[] = [];
  const err: string[] = [];
  const written: string[] = [];
  const prog: string[] = [];
  return {
    tty: false,
    errTty: false,
    columns: undefined,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    write: (s) => written.push(s),
    progress: (s) => prog.push(s),
    now: NOW,
    ...o,
    out,
    err,
    written,
    prog,
  };
}

function run(argv: string[], o: Partial<ReportIo> = {}): Fake {
  const io = fakeIo(o);
  runReport(parseArgs(['report', ...argv]), cfg, REPORT_DEPS, io);
  return io;
}

const rows = (io: Fake) => io.out.filter((l) => /^\d{4}-/.test(l));

beforeEach(() => {
  vi.stubEnv('TZ', 'America/New_York');
  root = scratch('report');
  cache = path.join(root, 'cache');
  cfg = path.join(root, 'config.json');
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  vi.stubEnv('CCINFOBAR_CACHE_DIR', cache);
  vi.stubEnv('NO_COLOR', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setLanguage('en');
  process.exitCode = undefined;
});

describe('report command', () => {
  it('prints rows per project and day, a subtotal for the shared day and a total', () => {
    twoProjects();
    const io = run([]);
    expect(process.exitCode).toBeUndefined();
    expect(io.err).toEqual([]);
    expect(io.out[0]).toMatch(/^Day +Project +Sessions +Input +Output +Cache read +Cache write +Total +Cost/);
    expect(rows(io).map((l) => l.split(/ +/).slice(0, 2).join(' '))).toEqual([
      '2026-10-03 api',
      '2026-10-04 web',
      '2026-10-04 api',
      '2026-10-05 web',
    ]);
    expect(io.out.filter((l) => /^ +subtotal /.test(l))).toHaveLength(1);
    const total = io.out.find((l) => /^ +total /.test(l));
    expect(total).toMatch(/ 2 +8\.0k +800 +200 +80 +9\.1k +\$/);
    expect(io.out).toContain(
      'Costs are estimates at list prices; on a subscription they are not what you pay.',
    );
  });

  it('splits a session crossing Sunday midnight into two ISO weeks', () => {
    session('api', 'a1', [at(4, 23, 50), at(5, 0, 10)]);
    const io = run(['--period', 'week']);
    expect(rows(io).map((l) => l.split(/ +/).slice(0, 3).join(' '))).toEqual([
      '2026-W40 api 1',
      '2026-W41 api 1',
    ]);
    expect(io.out[0]).toMatch(/^Week /);
  });

  it('filters by a path substring and by the current project', () => {
    twoProjects();
    const api = run(['--project', 'API']);
    expect(rows(api).every((l) => / api /.test(l))).toBe(true);
    expect(rows(api)).toHaveLength(2);
    // windows resolves a drive-less path against cwd, so mock an absolute one
    vi.spyOn(process, 'cwd').mockReturnValue(path.resolve('/w/web'));
    const here = run(['--project', '.']);
    expect(rows(here).every((l) => / web /.test(l))).toBe(true);
    expect(rows(here)).toHaveLength(2);
    vi.spyOn(process, 'cwd').mockReturnValue(path.resolve('/w/web/src/deep'));
    expect(rows(run(['--project', '.']))).toEqual(rows(here));
    vi.spyOn(process, 'cwd').mockReturnValue(path.resolve('/w'));
    expect(rows(run(['--project', '.']))).toEqual([]);
  });

  it('narrows to --since/--until and widens with --all', () => {
    twoProjects();
    session('old', 'o1', [at(5, 10) - 40 * 86_400_000]);
    const one = run(['--since', '2026-10-04', '--until', '2026-10-04']);
    expect(rows(one).map((l) => l.slice(0, 10))).toEqual(['2026-10-04', '2026-10-04']);
    expect(rows(run([])).some((l) => / old /.test(l))).toBe(false);
    const all = run(['--all']);
    expect(rows(all)[0]).toMatch(/^2026-08-26 +old /);
    expect(rows(all)).toHaveLength(5);
  });

  it.each([
    [['--period', 'hour'], 'Unknown period "hour". Use day, week or month.'],
    [['--since', '7x'], 'Bad --since value "7x".'],
    [['--since', '2026-10-05', '--until', '2026-10-01'], 'The start date 2026-10-05 is after the end date.'],
    [['--format', 'xml'], 'Unknown format "xml". Use table, csv or json.'],
    [['--csv', '--json'], 'Pick one output format: --format, --csv or --json.'],
    [['--project'], '--project needs a value'],
  ])('rejects %j with one ✗ line and exit 1', (argv, text) => {
    twoProjects();
    const io = run(argv);
    expect(io.err).toHaveLength(1);
    expect(io.err[0]!.startsWith(`✗ ${text}`)).toBe(true);
    expect(io.out).toEqual([]);
    expect(io.written).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('says where it looked when there is no usage', () => {
    const io = run([]);
    expect(io.out).toEqual([`No usage found in ${tildify(root)}`]);
    expect(io.err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('runs through main and prints errors on stderr', async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s: unknown) => void out.push(String(s)));
    vi.spyOn(console, 'error').mockImplementation((s: unknown) => void err.push(String(s)));
    await main(['report', '--config', cfg]);
    expect(out).toEqual([`No usage found in ${tildify(root)}`]);
    await main(['report', '--csv', '--json', '--config', cfg]);
    expect(err).toEqual(['✗ Pick one output format: --format, --csv or --json.']);
    expect(process.exitCode).toBe(1);
  });

  it('writes CSV with the fixed header, CRLF and one quoted cell for a hostile path', () => {
    const cwd = path.join(root, '=HYPERLINK("x","y")');
    writeTranscript('projects/-evil/e1.jsonl', [userLine({ ts: at(5, 8), cwd }), req(at(5, 9), cwd)], root);
    twoProjects();
    const io = run(['--csv']);
    expect(io.written).toHaveLength(1);
    const csv = io.written[0]!;
    expect(csv.startsWith('period,project,sessions,input_tokens,output_tokens,cache_read_tokens,')).toBe(
      true,
    );
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = csv.split('\r\n').slice(1, -1);
    expect(lines).toHaveLength(5);
    const quoted = `"${normalizeRoot(cwd).replace(/"/g, '""')}"`;
    expect(lines.filter((l) => l.startsWith(`2026-10-05,${quoted},1,`))).toHaveLength(1);
    expect(io.out).toEqual([]);
  });

  it('writes stable English JSON whatever the language', () => {
    twoProjects();
    const en = run(['--json']).written.join('');
    const obj = JSON.parse(en);
    expect(obj.v).toBe(1);
    expect(typeof obj.timeZone).toBe('string');
    expect(obj.timeZone.length).toBeGreaterThan(0);
    expect(obj.claudeDir).toBe(path.resolve(root));
    expect(obj.generatedAt).toBe(new Date(NOW()).toISOString());
    expect(obj.rows).toHaveLength(4);
    expect(obj.totals.sessions).toBe(2);
    fs.writeFileSync(cfg, JSON.stringify({ language: 'tr' }));
    const tr = run(['--json']).written.join('');
    expect(tr).toBe(en);
    expect(run([]).out[0]).toMatch(/^Gün +Proje +Oturum /);
  });

  it('fits a TTY width by dropping columns and keeps every column off a TTY', () => {
    twoProjects();
    const narrow = run([], { tty: true, columns: 50 });
    for (const col of ['Cache write', 'Cache read', 'Input', 'Output']) {
      expect(narrow.out[0]).not.toContain(col);
    }
    expect(narrow.out[0]).toMatch(/Total +Cost \(est\.\) +Active/);
    const plain = run([], { tty: false, columns: 50 });
    for (const col of ['Cache write', 'Cache read', 'Input', 'Output']) expect(plain.out[0]).toContain(col);
    const width = run(['--width', '50']);
    expect(width.out[0]).not.toContain('Cache write');
  });

  it('never touches the ledger without --rebuild and repairs its summary with it', () => {
    const a = accountKeyFor('apiKey', process.env);
    const month = writeLedger(
      '2026-10',
      [
        ledgerLine({ t: at(4, 10), a, s: 'a1', p: '/w/api', c: 0 }),
        ledgerLine({ t: at(4, 11), a, s: 'a1', p: '/w/api', c: 1.5 }),
      ],
      cache,
    );
    const summary = path.join(cache, 'ledger', 'summary.json');
    fs.writeFileSync(summary, '{"stale":true}');
    twoProjects();
    const monthBytes = fs.readFileSync(month);
    run([]);
    expect(fs.readFileSync(month)).toEqual(monthBytes);
    expect(fs.readFileSync(summary, 'utf8')).toBe('{"stale":true}');

    fs.rmSync(path.join(root, 'projects', '-w-web', 'w1.jsonl'));
    const io = run(['--rebuild']);
    expect(io.err).toEqual([
      'Rebuilt the cost ledger summary and re-read 1 transcript',
      'Kept history of 1 deleted transcript',
    ]);
    expect(JSON.parse(fs.readFileSync(summary, 'utf8')).built).toBe(true);
    expect(fs.readFileSync(month)).toEqual(monthBytes);
    expect(rows(io).filter((l) => / web /.test(l))).toHaveLength(2);
    expect(io.out).toContain('The rebuild kept 1 deleted transcript from the old index.');
    expect(process.exitCode).toBeUndefined();
  });

  it('says there is no ledger to rebuild when there is none', () => {
    twoProjects();
    const io = run(['--rebuild']);
    expect(io.err).toEqual(['Re-read 2 transcripts; there is no cost ledger to rebuild yet']);
    expect(fs.existsSync(path.join(cache, 'ledger'))).toBe(false);
  });

  it('shows progress only on a TTY stderr after a second and clears it', () => {
    twoProjects();
    const quiet = run(['--rebuild']);
    expect(quiet.prog).toEqual([]);
    let calls = 0;
    const slow = run(['--rebuild'], { errTty: true, now: () => NOW() + (calls++ > 1 ? 2000 : 0) });
    expect(slow.prog.length).toBeGreaterThanOrEqual(2);
    expect(slow.prog[0]).toMatch(/^Scanning transcripts: 1 file, 0 MB$/);
    expect(slow.prog.at(-1)).toBe('');
    let fast = 0;
    const quick = run(['--rebuild'], { errTty: true, now: () => NOW() + fast++ });
    expect(quick.prog).toEqual([]);
  });
});
