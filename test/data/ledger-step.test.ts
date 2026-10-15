import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Credited,
  emptySummary,
  foldText,
  LEDGER_ZERO,
  ledgerDir,
  monthFiles,
  normalizeRoot,
  projectRoot,
  readLedger,
  rebuildSummary,
  type SessionRow,
  stepLine,
  stepText,
} from '../../src/data/ledger.js';

const local = (y: number, m: number, d: number, h = 12, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).getTime();
const T = local(2026, 10, 14, 12);
const A = 'acct1';
const P = '/work/repo';

function line(s: string, c: number, t = T, a = A, p = P): string {
  return `${JSON.stringify({ v: 1, t, a, s, p, tp: '', c })}\n`;
}

const close = (n: number | undefined) => Math.round((n ?? Number.NaN) * 1e6) / 1e6;
const sessions = () => Object.create(null) as Record<string, SessionRow>;

function steps(text: string): Credited[] {
  const out: Credited[] = [];
  stepText(sessions(), text, (c) => out.push(c));
  return out;
}

function folded(text: string): number {
  const s = emptySummary();
  foldText(s, text);
  return Object.values(s.days[A] ?? {}).reduce((a, b) => a + b, 0);
}

const credited = (text: string) => steps(text).reduce((a, c) => a + c.delta, 0);

describe('stepLine', () => {
  it('baselines a first sighting and stores the session highs', () => {
    const m = sessions();
    const r = stepLine(m, line('s1', 0.001).trimEnd());
    expect(r).toEqual({ t: T, a: A, s: 's1', p: P, c: 0.001, delta: 0, first: true });
    expect(m.s1).toEqual({ h: [0.001], seen: T });
  });

  it('credits a session chain like the summary fold', () => {
    const text = line('s1', 0.001) + line('s1', 1.5, T + 1000) + line('s1', 2.25, T + 2000);
    const r = steps(text);
    expect(r.map((c) => close(c.delta))).toEqual([0, 1.499, 0.75]);
    expect(r.map((c) => c.first)).toEqual([true, false, false]);
    expect(close(folded(text))).toBe(2.249);
  });

  it.each([
    ['broken JSON', '{"v":1,"t":1'],
    ['bad version', JSON.stringify({ v: 2, t: T, a: A, s: 's1', p: P, tp: '', c: 1 })],
    ['negative cost', line('s1', -1).trimEnd()],
    ['prototype session', line('__proto__', 1).trimEnd()],
    ['prototype account', line('s1', 1, T, '__proto__').trimEnd()],
    ['oversized project', line('s1', 1, T, A, `/${'x'.repeat(1024)}`).trimEnd()],
    ['bad time', line('s1', 1, Number.NaN).trimEnd()],
    ['null', 'null'],
  ])('rejects %s and leaves the sessions alone', (_name, text) => {
    const m = sessions();
    stepLine(m, line('s1', 0.5).trimEnd());
    const before = JSON.stringify(m);
    expect(stepLine(m, text)).toBeNull();
    expect(JSON.stringify(m)).toBe(before);
    expect(({} as Record<string, unknown>).h).toBeUndefined();
  });
});

describe('stepText', () => {
  it('calls back once per complete valid line in order and skips a torn tail', () => {
    const text = `${line('s1', 0)}not json\n${line('s2', 1)}${line('s1', 2)}${line('s1', 3).slice(0, -6)}`;
    const r = steps(text);
    expect(r.map((c) => [c.s, c.c])).toEqual([
      ['s1', 0],
      ['s2', 1],
      ['s1', 2],
    ]);
  });

  it('gives the summary fold totals for a /login reset and two terminals', () => {
    const login = [0, 2, 0, 0.4].map((c, i) => line('s1', c, T + i * 1000)).join('');
    const terminals = [10, 8.1, 10.2, 8.3].map((c, i) => line('s1', c, T + i * 1000)).join('');
    expect(close(credited(login))).toBe(2.4);
    expect(close(credited(login))).toBe(close(folded(login)));
    expect(close(credited(terminals))).toBe(0.4);
    expect(close(credited(terminals))).toBe(close(folded(terminals)));
  });

  it('keeps the dust threshold of the fold', () => {
    expect(LEDGER_ZERO).toBe(0.005);
  });
});

describe('normalizeRoot', () => {
  it('strips trailing separators and lowercases on win32 only', () => {
    expect(normalizeRoot('/work/repo/', 'linux')).toBe('/work/repo');
    expect(normalizeRoot('/', 'linux')).toBe('/');
    expect(normalizeRoot('/Work/Repo', 'darwin')).toBe('/Work/Repo');
    expect(normalizeRoot('C:\\Work\\Repo\\', 'win32')).toBe('c:\\work\\repo');
    expect(normalizeRoot('C:\\', 'win32')).toBe('c:\\');
    expect(normalizeRoot(`/${'x'.repeat(2000)}`, 'linux')).toHaveLength(1024);
  });

  it('is what projectRoot uses', () => {
    expect(projectRoot({ workspace: { project_dir: '/work/repo/' } }, 'linux')).toBe('/work/repo');
    expect(projectRoot({ cwd: 'C:\\Work\\Repo\\' }, 'win32')).toBe('c:\\work\\repo');
  });
});

describe('rebuildSummary', () => {
  let dir = '';
  let env: NodeJS.ProcessEnv = {};
  const summaryFile = () => path.join(dir, 'ledger', 'summary.json');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-ledger-step-'));
    env = { CCINFOBAR_CACHE_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeMonths(): void {
    const sep = local(2026, 9, 30, 23);
    const oct = local(2026, 10, 1, 1);
    fs.mkdirSync(ledgerDir(env), { recursive: true });
    fs.writeFileSync(
      path.join(ledgerDir(env), '2026-09.jsonl'),
      line('x', 0, sep) +
        line('x', 2, sep + 1000) +
        line('y', 0, sep, A, '/other') +
        line('y', 1, sep + 2000),
    );
    fs.writeFileSync(
      path.join(ledgerDir(env), '2026-10.jsonl'),
      line('x', 2.5, oct) + line('x', 3, oct + 1000) + line('z', 0, T) + line('z', 0.25, T + 1000),
    );
  }

  it('returns null and writes nothing without month files', () => {
    expect(rebuildSummary(env, T)).toBeNull();
    expect(fs.existsSync(ledgerDir(env))).toBe(false);
    fs.mkdirSync(ledgerDir(env), { recursive: true });
    fs.writeFileSync(path.join(ledgerDir(env), 'notes.jsonl'), line('x', 1));
    expect(rebuildSummary(env, T)).toBeNull();
    expect(fs.existsSync(summaryFile())).toBe(false);
  });

  it('refolds every month from zero and writes the summary atomically', () => {
    writeMonths();
    const before = new Map(
      monthFiles(ledgerDir(env)).map((k) => [
        k,
        fs.readFileSync(path.join(ledgerDir(env), `${k}.jsonl`), 'utf8'),
      ]),
    );
    const ref = readLedger(env, T, { persist: false, budget: Number.MAX_SAFE_INTEGER }).summary;
    fs.writeFileSync(
      summaryFile(),
      JSON.stringify({ ...emptySummary(), built: true, files: { '2026-09': 1e6, '2026-10': 1e6 } }),
    );
    const s = rebuildSummary(env, T);
    expect(s?.built).toBe(true);
    expect(s?.days).toEqual(ref.days);
    expect(s?.projects).toEqual(ref.projects);
    expect(close(s?.days[A]?.['2026-09-30'])).toBe(3);
    expect(close(s?.days[A]?.['2026-10-01'])).toBe(1);
    const stored = JSON.parse(fs.readFileSync(summaryFile(), 'utf8'));
    expect(stored.built).toBe(true);
    expect(stored.days).toEqual(JSON.parse(JSON.stringify(ref.days)));
    if (process.platform !== 'win32') expect(fs.statSync(summaryFile()).mode & 0o777).toBe(0o600);
    for (const [k, text] of before)
      expect(fs.readFileSync(path.join(ledgerDir(env), `${k}.jsonl`), 'utf8')).toBe(text);
    expect(fs.readdirSync(ledgerDir(env)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
