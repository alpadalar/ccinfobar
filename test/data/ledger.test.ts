import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StatusPayload } from '../../src/core/types.js';
import {
  credit,
  dayKey,
  emptySummary,
  foldText,
  isoWeekKey,
  ledgerOn,
  ledgerView,
  monthKey,
  projectRoot,
  pruneLedger,
  RENDER_BUDGET,
  readLedger,
  recordLedger,
  type Summary,
} from '../../src/data/ledger.js';
import { accountKey } from '../../src/data/limits.js';

const local = (y: number, m: number, d: number, h = 12, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime();
const T = local(2026, 10, 14, 12);
const A = 'acct1';
const P = '/work/repo';

function line(s: string, c: number, t = T, a = A, p = P): string {
  return `${JSON.stringify({ v: 1, t, a, s, p, tp: '', c })}\n`;
}

function fold(...lines: string[]): Summary {
  const s = emptySummary();
  foldText(s, lines.join(''));
  return s;
}

const close = (n: number | undefined) => Math.round((n ?? Number.NaN) * 1e6) / 1e6;

function chain(values: number[]): number[] {
  let highs: number[] | undefined;
  return values.map((c) => {
    const r = credit(highs, c);
    highs = r.highs;
    return close(r.delta);
  });
}

describe('credit (segmented high-water)', () => {
  it('baselines a first sighting and counts growth', () => {
    expect(chain([0, 1.2])).toEqual([0, 1.2]);
  });

  it('adds nothing on a resume at the same total', () => {
    expect(chain([0, 1.2, 1.2, 2])).toEqual([0, 1.2, 0, 0.8]);
  });

  it('baselines a fork that carries the parent total', () => {
    expect(chain([4.2, 4.5])).toEqual([0, 0.3]);
  });

  it('never double counts two interleaved processes', () => {
    expect(chain([10, 8.1, 10.2, 8.3])).toEqual([0, 0, 0.2, 0.2]);
  });

  it('undercounts two streams that keep crossing on one id', () => {
    const feed = [5, 5];
    for (let i = 1; i <= 10; i++) feed.push(5 + 0.1 * i, 5 + 0.12 * i);
    const credited = chain(feed).reduce((a, b) => a + b, 0);
    expect(close(credited)).toBe(1.5);
    expect(credited).toBeLessThan(2.2);
  });

  it('counts from zero after a /login reset', () => {
    expect(chain([0, 2, 0, 0.4])).toEqual([0, 2, 0, 0.4]);
  });

  it('baselines a crash-restored older total', () => {
    expect(chain([0, 7, 5, 5.5])).toEqual([0, 7, 0, 0.5]);
  });

  it('keeps at most four segments', () => {
    let highs: number[] | undefined;
    for (const c of [9, 8, 7, 6, 5, 4]) highs = credit(highs, c).highs;
    expect(highs).toEqual([4, 5, 6, 7]);
  });

  it('moves an updated segment to the front', () => {
    expect(credit([1, 5, 3], 5.5).highs).toEqual([5.5, 1, 3]);
  });

  it('keeps the main stream through five live segments', () => {
    const feed = [0, 5];
    let main = 5;
    for (const top of [4, 3, 2, 1]) {
      main += 0.1;
      feed.push(0, top, main);
    }
    const credited = chain(feed).reduce((a, b) => a + b, 0);
    expect(close(credited)).toBe(close(5 + 4 + 3 + 2 + 1 + 0.4));
  });
});

describe('day and week keys', () => {
  it('uses local days', () => {
    expect(dayKey(local(2026, 12, 31, 23, 59, 59))).toBe('2026-12-31');
    expect(dayKey(local(2027, 1, 1, 0, 0, 1))).toBe('2027-01-01');
    expect(monthKey(local(2027, 1, 1, 0, 0, 1))).toBe('2027-01');
  });

  it('gives ISO weeks across year ends', () => {
    expect(isoWeekKey(local(2026, 12, 31))).toBe('2026-W53');
    expect(isoWeekKey(local(2027, 1, 1))).toBe('2026-W53');
    expect(isoWeekKey(local(2027, 1, 4))).toBe('2027-W01');
    expect(isoWeekKey(local(2020, 12, 31))).toBe('2020-W53');
    expect(isoWeekKey(local(2025, 1, 1))).toBe('2025-W01');
    expect(isoWeekKey(local(2024, 12, 30))).toBe('2025-W01');
  });

  it('keeps day and week right on DST change days', () => {
    for (const [y, m, d] of [
      [2026, 3, 8],
      [2026, 3, 29],
      [2026, 10, 25],
      [2026, 11, 1],
    ] as const) {
      for (const h of [0, 1, 2, 3, 12, 23]) {
        expect(dayKey(local(y, m, d, h, 30))).toBe(
          `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        );
      }
    }
    expect(isoWeekKey(local(2026, 3, 29, 23, 30))).toBe('2026-W13');
    expect(isoWeekKey(local(2026, 3, 30, 0, 30))).toBe('2026-W14');
    expect(isoWeekKey(local(2026, 10, 25, 23, 30))).toBe('2026-W43');
  });
});

describe('projectRoot', () => {
  const p = (w: StatusPayload['workspace'], cwd?: string) =>
    ({ workspace: w, ...(cwd ? { cwd } : {}) }) as StatusPayload;

  it('prefers project_dir, then current_dir, then cwd', () => {
    expect(projectRoot(p({ project_dir: '/a', current_dir: '/b' }, '/c'), 'linux')).toBe('/a');
    expect(projectRoot(p({ current_dir: '/b' }, '/c'), 'linux')).toBe('/b');
    expect(projectRoot(p(undefined, '/c'), 'linux')).toBe('/c');
  });

  it('drops a trailing separator', () => {
    expect(projectRoot(p({ project_dir: '/a/b/' }), 'linux')).toBe('/a/b');
    expect(projectRoot(p({ project_dir: '/' }), 'linux')).toBe('/');
  });

  it('lowercases on win32 only', () => {
    expect(projectRoot(p({ project_dir: 'C:\\Work\\Repo\\' }), 'win32')).toBe('c:\\work\\repo');
    expect(projectRoot(p({ project_dir: '/Work/Repo' }), 'darwin')).toBe('/Work/Repo');
  });
});

describe('foldText', () => {
  it('folds per account, day and project', () => {
    const s = fold(
      line('s1', 0),
      line('s1', 1.5),
      line('s2', 0, T, A, '/other'),
      line('s2', 0.5, T, A, '/other'),
    );
    expect(close(s.days[A]?.['2026-10-14'])).toBe(2);
    expect(close(s.projects[A]?.[P]?.['2026-10-14'])).toBe(1.5);
    expect(close(s.projects[A]?.['/other']?.['2026-10-14'])).toBe(0.5);
    expect(s.since[A]).toBe(T);
    expect(Object.getPrototypeOf(s.days)).toBeNull();
    expect(Object.getPrototypeOf(s.days[A])).toBeNull();
  });

  it('skips a torn last line until its newline arrives', () => {
    const s = emptySummary();
    const full = line('s1', 0) + line('s1', 1);
    foldText(s, full.slice(0, -5));
    expect(s.days[A]).toBeUndefined();
    foldText(s, line('s1', 2));
    expect(close(s.days[A]?.['2026-10-14'])).toBe(2);
  });

  it('skips garbage and invalid fields but keeps later lines', () => {
    const s = fold(
      line('s1', 0),
      'not json\n',
      '{"v":1,"t":1,"a":"acct1"\n',
      `${JSON.stringify({ v: 1, t: T, a: A, s: 's1', p: P, tp: '', c: 'x' })}\n`,
      line('s1', Number.POSITIVE_INFINITY),
      line('s1', -1),
      line('s1', 2e6),
      line('bad id!', 1),
      line('s1', 1, Number.NaN),
      line('__proto__', 0),
      line('__proto__', 1),
      line('s3', 0, T, '__proto__'),
      line('s3', 1, T, '__proto__'),
      line('s4', 0, T, A, '__proto__'),
      line('s4', 1, T, A, '__proto__'),
      `${JSON.stringify({ v: 2, t: T, a: A, s: 's1', p: P, tp: '', c: 9 })}\n`,
      '\n',
      line('s1', 0.75),
    );
    expect(close(s.days[A]?.['2026-10-14'])).toBe(0.75);
    expect(Object.keys(s.sessions).sort()).toEqual(['s1']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('puts each delta on the day of its observation', () => {
    const late = local(2026, 10, 14, 23, 59, 59);
    const early = local(2026, 10, 15, 0, 0, 1);
    const s = fold(line('s1', 0, late - 60_000), line('s1', 1, late), line('s1', 1.5, early));
    expect(close(s.days[A]?.['2026-10-14'])).toBe(1);
    expect(close(s.days[A]?.['2026-10-15'])).toBe(0.5);
  });
});

describe('ledgerView', () => {
  const week = (d: number) => line('w', d, local(2026, 10, 12 + Math.floor(d), 10));

  it('sums today, ISO week, month and project for one account', () => {
    const s = fold(
      line('old', 0, local(2026, 9, 30)),
      line('old', 3, local(2026, 9, 30)),
      week(0),
      week(1),
      week(2),
      line('t', 0),
      line('t', 0.5, T, A, '/elsewhere'),
      line('x', 0, T, 'acct2'),
      line('x', 100, T, 'acct2'),
    );
    const v = ledgerView(s, A, P, T)!;
    expect(close(v.today)).toBe(0.5 + 1);
    expect(close(v.week)).toBe(2.5);
    expect(close(v.month)).toBe(2.5);
    expect(close(v.project.all)).toBe(5);
    expect(close(v.project.week)).toBe(2);
    expect(v.since).toBe(local(2026, 9, 30));
    expect(close(ledgerView(s, 'acct2', P, T)?.today)).toBe(100);
  });

  it('adds the pending delta of this render', () => {
    const s = fold(line('s1', 0), line('s1', 1));
    const v = ledgerView(s, A, P, T, { session: 's1', c: 1.25 })!;
    expect(close(v.today)).toBe(1.25);
    expect(close(v.week)).toBe(1.25);
    expect(close(v.month)).toBe(1.25);
    expect(close(v.project.today)).toBe(1.25);
    expect(close(v.project.all)).toBe(1.25);
    expect(close(ledgerView(s, A, P, T, { session: 'new', c: 3 })?.today)).toBe(1);
    expect(close(ledgerView(s, A, P, T, { session: 's1', c: 'x' })?.today)).toBe(1);
  });

  it('is null for an account with no rows', () => {
    expect(ledgerView(emptySummary(), A, P, T)).toBeNull();
    expect(ledgerView(emptySummary(), A, P, T, { session: 's1', c: 2 })).toBeNull();
    expect(ledgerView(fold(line('s1', 0)), A, P, T)?.today).toBe(0);
  });
});

describe('ledgerOn', () => {
  it('is on only with a ledger widget', () => {
    const cfg = (type: string) => ({ lines: [[{ id: '1', type }]] }) as never;
    expect(ledgerOn(cfg('cost-today'))).toBe(true);
    expect(ledgerOn(cfg('session-cost'))).toBe(false);
  });
});

describe('ledger files', () => {
  let dir = '';
  let env: NodeJS.ProcessEnv = {};
  const month = () => path.join(dir, 'ledger', `${monthKey(T)}.jsonl`);
  const summary = () => path.join(dir, 'ledger', 'summary.json');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ledger-'));
    env = { CCINFOBAR_CACHE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('folds only the bytes after the stored offset', () => {
    fs.mkdirSync(path.dirname(month()), { recursive: true });
    fs.writeFileSync(month(), line('s1', 0) + line('s1', 1));
    const first = readLedger(env, T, { persist: true });
    expect(first.moved).toBe(true);
    expect(close(first.summary.days[A]?.['2026-10-14'])).toBe(1);
    expect(fs.existsSync(summary())).toBe(true);
    const again = readLedger(env, T);
    expect(again.moved).toBe(false);
    expect(close(again.summary.days[A]?.['2026-10-14'])).toBe(1);
    fs.appendFileSync(month(), line('s1', 1.5) + line('s1', 2).slice(0, 10));
    const next = readLedger(env, T, { persist: true });
    expect(close(next.summary.days[A]?.['2026-10-14'])).toBe(1.5);
    expect(next.summary.files[monthKey(T)]).toBe(fs.statSync(month()).size - 10);
  });

  it('reads the previous month file too', () => {
    const prev = path.join(dir, 'ledger', `${monthKey(local(2026, 9, 30))}.jsonl`);
    fs.mkdirSync(path.dirname(prev), { recursive: true });
    fs.writeFileSync(prev, line('s1', 0, local(2026, 9, 30)) + line('s1', 2, local(2026, 9, 30)));
    const v = ledgerView(readLedger(env, T).summary, A, P, T)!;
    expect(close(v.project.all)).toBe(2);
    expect(v.month).toBe(0);
  });

  it('rebuilds when the file shrank, without double counting', () => {
    fs.mkdirSync(path.dirname(month()), { recursive: true });
    fs.writeFileSync(month(), line('s1', 0) + line('s1', 1) + line('s1', 2));
    readLedger(env, T, { persist: true });
    fs.writeFileSync(month(), line('s1', 0) + line('s1', 1));
    const r = readLedger(env, T);
    expect(r.moved).toBe(true);
    expect(close(r.summary.days[A]?.['2026-10-14'])).toBe(1);
    expect(r.summary.files[monthKey(T)]).toBe(fs.statSync(month()).size);
  });

  it('never writes with persist false', () => {
    fs.mkdirSync(path.dirname(month()), { recursive: true });
    fs.writeFileSync(month(), line('s1', 0) + line('s1', 1));
    expect(readLedger(env, T, { persist: false }).moved).toBe(true);
    expect(fs.existsSync(summary())).toBe(false);
  });

  it('ignores a damaged or foreign summary', () => {
    fs.mkdirSync(path.dirname(summary()), { recursive: true });
    fs.writeFileSync(
      summary(),
      '{"v":1,"days":{"__proto__":{"x":1}},"files":{"../x":5},"sessions":{"s1":{"h":["a"],"seen":1}}}',
    );
    const s = readLedger(env, T).summary;
    expect(Object.keys(s.files)).toEqual([]);
    expect(Object.keys(s.sessions)).toEqual([]);
    fs.writeFileSync(summary(), 'garbage');
    expect(readLedger(env, T).summary.v).toBe(1);
  });

  it('appends only a changed total and writes the summary when moved', () => {
    const payload = (c: number) =>
      ({
        session_id: 's1',
        cost: { total_cost_usd: c },
        workspace: { project_dir: P },
        transcript_path: '/x/t.jsonl',
      }) as StatusPayload;
    recordLedger(env, payload(0), readLedger(env, T), T);
    const lines = () => fs.readFileSync(month(), 'utf8').split('\n').filter(Boolean);
    expect(lines()).toHaveLength(1);
    const first = JSON.parse(lines()[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({ v: 1, t: T, a: accountKey(env), s: 's1', c: 0 });
    expect(first.tp).toMatch(/^[0-9a-f]{12}$/);
    expect(Object.keys(first).sort()).toEqual(['a', 'c', 'p', 's', 't', 'tp', 'v']);
    recordLedger(env, payload(0), readLedger(env, T), T);
    expect(lines()).toHaveLength(1);
    expect(fs.existsSync(summary())).toBe(true);
    recordLedger(env, payload(1), readLedger(env, T), T);
    expect(lines()).toHaveLength(2);
    recordLedger(
      env,
      { session_id: 'bad id', cost: { total_cost_usd: 3 } } as StatusPayload,
      readLedger(env, T),
      T,
    );
    recordLedger(env, { session_id: 's1' } as StatusPayload, readLedger(env, T), T);
    expect(lines()).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')('keeps ledger files private (0600)', () => {
    const payload = { session_id: 's1', cost: { total_cost_usd: 0 } } as StatusPayload;
    recordLedger(env, payload, readLedger(env, T), T);
    recordLedger(env, { ...payload, cost: { total_cost_usd: 1 } }, readLedger(env, T), T);
    expect(fs.statSync(month()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(summary()).mode & 0o777).toBe(0o600);
  });
});

describe('retention', () => {
  let dir = '';
  let env: NodeJS.ProcessEnv = {};
  const DAY = 86_400_000;
  const ledger = () => path.join(dir, 'ledger');
  const file = (name: string) => path.join(ledger(), name);
  const names = () => fs.readdirSync(ledger()).sort();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ledger-'));
    env = { CCINFOBAR_CACHE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
    fs.mkdirSync(ledger(), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('drops month files older than 13 months by name, not mtime', () => {
    for (const n of ['2025-09.jsonl', '2025-10.jsonl', '2026-10.jsonl']) fs.writeFileSync(file(n), '');
    const old = new Date(2020, 0, 1);
    fs.utimesSync(file('2025-10.jsonl'), old, old);
    const s = emptySummary();
    s.files['2025-09'] = 0;
    s.files['2025-10'] = 0;
    pruneLedger(env, s, T);
    expect(names()).toEqual(['2025-10.jsonl', '2026-10.jsonl']);
    expect(Object.keys(s.files)).toEqual(['2025-10']);
  });

  it('never deletes a file that is not YYYY-MM.jsonl', () => {
    const odd = ['notes.txt', '2025-1.jsonl', '2020-01.jsonl.bak', 'x2020-01.jsonl', 'summary.json'];
    for (const n of odd) fs.writeFileSync(file(n), '');
    fs.mkdirSync(file('2019-01.jsonl'));
    pruneLedger(env, emptySummary(), T);
    expect(names()).toEqual([...odd, '2019-01.jsonl'].sort());
  });

  it('keeps 400 days of rows and sessions seen in the last 30 days', () => {
    const s = fold(
      line('old', 0, T - 402 * DAY),
      line('old', 2, T - 401 * DAY),
      line('kept', 0, T - 31 * DAY),
      line('kept', 3, T - 29 * DAY),
    );
    pruneLedger(env, s, T);
    expect(Object.keys(s.days[A]!)).toEqual([dayKey(T - 29 * DAY)]);
    expect(Object.keys(s.projects[A]![P]!)).toEqual([dayKey(T - 29 * DAY)]);
    expect(Object.keys(s.sessions)).toEqual(['kept']);
  });

  it('treats a pruned session seen again as a first sighting', () => {
    const s = fold(line('s1', 0, T - 40 * DAY), line('s1', 5, T - 40 * DAY));
    pruneLedger(env, s, T);
    foldText(s, line('s1', 6));
    expect(s.days[A]?.[dayKey(T)]).toBeUndefined();
    const kept = fold(line('s1', 0, T - 40 * DAY), line('s1', 5, T - 40 * DAY), line('s1', 6));
    expect(close(kept.days[A]?.[dayKey(T)])).toBe(1);
  });

  it('prunes when recordLedger creates a new month file', () => {
    const payload = (c: number) => ({ session_id: 's1', cost: { total_cost_usd: c } }) as StatusPayload;
    fs.writeFileSync(file('2024-01.jsonl'), line('gone', 1, local(2024, 1, 5)));
    fs.writeFileSync(file(`${monthKey(T)}.jsonl`), '');
    recordLedger(env, payload(0), readLedger(env, T), T);
    expect(names()).toContain('2024-01.jsonl');
    fs.rmSync(file(`${monthKey(T)}.jsonl`));
    recordLedger(env, payload(1), readLedger(env, T), T);
    expect(names()).not.toContain('2024-01.jsonl');
    expect(names()).toContain(`${monthKey(T)}.jsonl`);
    const saved = JSON.parse(fs.readFileSync(file('summary.json'), 'utf8')) as Summary;
    expect(saved.sessions.gone).toBeUndefined();
    expect(saved.files['2024-01']).toBeUndefined();
  });
});

describe('cold fold byte budget', () => {
  let dir = '';
  let env: NodeJS.ProcessEnv = {};
  const ledger = () => path.join(dir, 'ledger');
  const months = [local(2026, 8, 10), local(2026, 9, 10), local(2026, 10, 10)];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ledger-'));
    env = { CCINFOBAR_CACHE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
    fs.mkdirSync(ledger(), { recursive: true });
    for (const [m, t] of months.entries()) {
      let text = '';
      for (let i = 0; i < 40; i++) text += line(`m${m}s${i % 4}`, i * 0.25, t + i * 60_000);
      text += line('long', 10 + m, t + 50 * 60_000);
      fs.writeFileSync(path.join(ledger(), `${monthKey(t)}.jsonl`), text);
    }
    fs.writeFileSync(path.join(ledger(), 'notes.jsonl'), line('foreign', 0) + line('foreign', 99));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const size = (t: number) => fs.statSync(path.join(ledger(), `${monthKey(t)}.jsonl`)).size;

  it('folds oldest month first, stops at the budget and finishes over later calls', () => {
    const ref = readLedger(env, T, { persist: false }).summary;
    expect(ledgerView(ref, A, P, T)?.partial).toBe(false);
    expect(ref.sessions.foreign).toBeUndefined();
    const budget = Math.floor(size(months[0]!) * 1.5);
    const first = readLedger(env, T, { persist: true, budget });
    expect(first.moved).toBe(true);
    expect(ledgerView(first.summary, A, P, T)?.partial).toBe(true);
    expect(first.summary.files['2026-08']).toBe(size(months[0]!));
    expect(first.summary.files['2026-09']).toBeGreaterThan(0);
    expect(first.summary.files['2026-09']).toBeLessThan(size(months[1]!));
    expect(first.summary.files['2026-10']).toBeUndefined();
    let calls = 1;
    let last = first;
    while (ledgerView(last.summary, A, P, T)?.partial && calls < 10) {
      last = readLedger(env, T, { persist: true, budget });
      calls++;
    }
    expect(calls).toBeGreaterThan(1);
    expect(ledgerView(last.summary, A, P, T)?.partial).toBe(false);
    expect(last.summary.days).toEqual(ref.days);
    expect(last.summary.projects).toEqual(ref.projects);
    expect(readLedger(env, T, { budget }).moved).toBe(false);
  });

  it('keeps the month-boundary step of a session on a cold rebuild', () => {
    const sep = local(2026, 9, 30, 23);
    const oct = local(2026, 10, 1, 1);
    fs.writeFileSync(path.join(ledger(), '2026-09.jsonl'), line('x', 0, sep) + line('x', 2, sep));
    fs.writeFileSync(path.join(ledger(), '2026-10.jsonl'), line('x', 2.5, oct) + line('x', 3, oct));
    const days = readLedger(env, T).summary.days[A]!;
    expect(close(days['2026-09-30'])).toBe(2);
    expect(close(days['2026-10-01'])).toBe(1);
  });

  it('reads a small budget before stdout and finishes the build after it', () => {
    let text = '';
    for (let i = 0; text.length < RENDER_BUDGET * 1.5; i++)
      text += line(`big${i % 50}`, i * 0.01, months[0]! + i);
    fs.writeFileSync(path.join(ledger(), '2026-08.jsonl'), text);
    const ref = readLedger(env, T, { persist: false }).summary;
    const read = readLedger(env, T, { budget: RENDER_BUDGET });
    expect(read.more).toBe(true);
    expect(ledgerView(read.summary, A, P, T)?.partial).toBe(true);
    expect(fs.existsSync(path.join(ledger(), 'summary.json'))).toBe(false);
    recordLedger(env, { session_id: 'new', cost: { total_cost_usd: 0 } } as StatusPayload, read, T);
    const saved = readLedger(env, T, { budget: 0 });
    expect(saved.summary.built).toBe(true);
    expect(saved.summary.days).toEqual(ref.days);
  });

  it('reads at most the budget per call', () => {
    const reads: number[] = [];
    const orig = fs.readSync;
    const spy = (fd: number, buf: NodeJS.ArrayBufferView, off: number, len: number, pos: number | null) => {
      reads.push(len);
      return orig(fd, buf, off, len, pos);
    };
    const fsMod = fs as unknown as { readSync: typeof spy };
    fsMod.readSync = spy;
    try {
      readLedger(env, T, { persist: false, budget: 1000 });
    } finally {
      fsMod.readSync = orig as unknown as typeof spy;
    }
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });
});
