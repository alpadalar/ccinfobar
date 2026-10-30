import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLanguage } from '../../src/core/i18n/index.js';
import { buildReport } from '../../src/core/report-model.js';
import { dayKey } from '../../src/core/time.js';
import { displayRoot, normalizeRoot, projectHash } from '../../src/data/ledger.js';
import { accountKeyFor } from '../../src/data/limits.js';
import { projectNamesOf, readReportData } from '../../src/data/report-index.js';
import {
  assistantLine,
  bornAfter,
  type LedgerOpts,
  ledgerLine,
  scratch,
  userLine,
  writeLedger,
  writeTranscript,
} from '../fixtures/report/build.js';
import { BUILTINS, PRICE_DEPS, REPORT_DEPS } from '../report-deps.js';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const D1 = Date.parse('2026-10-12T10:00:00.000Z');
const D2 = Date.parse('2026-10-13T10:00:00.000Z');

function setup(name: string) {
  const root = scratch(name);
  const cache = path.join(root, 'cache');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: root, CCINFOBAR_CACHE_DIR: cache };
  const other = { ...env, CLAUDE_CONFIG_DIR: path.join(root, 'other') };
  const a = accountKeyFor('apiKey', env);
  const line = (o: Partial<LedgerOpts> & { c: number; t: number }) =>
    ledgerLine({ a, s: 'A', p: '/w/a', ...o });
  const run = (opts: Parameters<typeof readReportData>[2] = {}) =>
    readReportData(env, REPORT_DEPS, { now: NOW, ...opts });
  return { root, cache, env, other, a, line, run };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('report ledger fold', () => {
  it('records the first sighting, the credited total and days', () => {
    const { cache, line, run } = setup('first');
    writeLedger(
      '2026-10',
      [
        line({ c: 0.001, t: D1 }),
        line({ c: 1.0, t: D1 + 60_000 }),
        line({ s: 'B', c: 5.0, t: D1 + 120_000 }),
        line({ c: 2.5, t: D2 }),
        line({ s: 'B', c: 6.0, t: D2 + 60_000 }),
      ],
      cache,
    );
    const r = run();
    const A = r.ledger.A!;
    expect(A).toMatchObject({ p: '/w/a', first: 0.001, firstT: D1 });
    expect(A.total).toBeCloseTo(2.499, 9);
    expect(Object.keys(A.days)).toEqual([dayKey(D1), dayKey(D2)]);
    expect(A.days[dayKey(D1)]).toBeCloseTo(0.999, 9);
    expect(A.days[dayKey(D2)]).toBeCloseTo(1.5, 9);
    expect(r.ledger.B).toMatchObject({ first: 5.0, firstT: D1 + 120_000, total: 1.0 });
    expect(r.ledgerSince).toBe(D1);
  });

  it('keeps lines of this config dir under any provider kind only', () => {
    const { cache, env, other, line, run } = setup('accounts');
    writeLedger(
      '2026-10',
      [
        line({ s: 'K', c: 1, t: D1 }),
        line({ s: 'K', c: 2, t: D2 }),
        line({ s: 'F', a: accountKeyFor('firstParty', env), c: 3, t: D1 }),
        line({ s: 'X', a: accountKeyFor('apiKey', other), c: 4, t: D1 }),
        line({ s: 'X', a: accountKeyFor('apiKey', other), c: 9, t: D2 }),
      ],
      cache,
    );
    const r = run();
    expect(Object.keys(r.ledger).sort()).toEqual(['F', 'K']);
    expect(r.ledger.K).toMatchObject({ a: accountKeyFor('apiKey', env), total: 1 });
    expect(r.ledger.F).toMatchObject({ a: accountKeyFor('firstParty', env), first: 3 });
  });

  it('keeps the highs of a session across month files', () => {
    const { cache, line, run } = setup('months');
    const sep = Date.parse('2026-09-30T23:00:00.000Z');
    writeLedger('2026-09', [line({ c: 1.0, t: sep })], cache);
    writeLedger('2026-10', [line({ c: 3.0, t: D1 })], cache);
    const r = run();
    expect(r.ledger.A).toMatchObject({ first: 1.0, firstT: sep, total: 2.0 });
    expect(r.ledger.A!.days).toEqual({ [dayKey(D1)]: 2.0 });
  });

  it('reads only appended ledger bytes and re-folds a shrunk month', () => {
    const { cache, env, line, run } = setup('incremental');
    const file = writeLedger('2026-10', [line({ c: 0.001, t: D1 }), line({ c: 1, t: D1 + 1000 })], cache);
    run();
    const before = fs.statSync(file).size;
    fs.appendFileSync(file, `${line({ c: 3, t: D2 })}\n`);
    const read = vi.spyOn(fs, 'readSync');
    const second = run();
    const bytes = read.mock.results.reduce((n, r) => n + (r.type === 'return' ? r.value : 0), 0);
    vi.restoreAllMocks();
    expect(second.bytesRead).toBe(fs.statSync(file).size - before);
    expect(bytes).toBe(second.bytesRead);
    expect(second.ledger.A!.total).toBeCloseTo(2.999, 9);
    expect(run().bytesRead).toBe(0);

    fs.writeFileSync(file, `${line({ c: 0.002, t: D1 })}\n${line({ c: 2, t: D2 })}\n`);
    const shrunk = run();
    expect(shrunk.ledger.A).toMatchObject({ first: 0.002, firstT: D1 });
    expect(shrunk.ledger.A!.total).toBeCloseTo(1.998, 9);
    const fresh = path.join(path.dirname(cache), 'cache2');
    writeLedger('2026-10', [fs.readFileSync(file, 'utf8').trimEnd()], fresh);
    const cold = readReportData({ ...env, CCINFOBAR_CACHE_DIR: fresh }, REPORT_DEPS, { now: NOW });
    expect(cold.ledger).toEqual(shrunk.ledger);
  });

  it('gives an empty ledger without a ledger dir', () => {
    const { run } = setup('none');
    const r = run();
    expect(r.ledger).toEqual({});
    expect(r.ledgerSince).toBeNull();
    expect(r.notes).toEqual([]);
  });

  it('drops ledger days older than 13 months', () => {
    const { cache, line, run } = setup('old');
    const old = Date.parse('2025-02-10T10:00:00.000Z');
    writeLedger(
      '2025-02',
      [line({ s: 'O', c: 0.001, t: old }), line({ s: 'O', c: 1, t: old + 1000 })],
      cache,
    );
    writeLedger('2026-10', [line({ c: 0.001, t: D1 }), line({ c: 1, t: D1 + 1000 })], cache);
    const r = run();
    expect(Object.keys(r.ledger)).toEqual(['A']);
    expect(r.ledgerSince).toBe(D1);
  });

  it('rebuild re-reads everything, keeps deleted transcripts and never writes the ledger', () => {
    const { root, cache, line, run } = setup('rebuild');
    const month = writeLedger('2026-10', [line({ c: 0.001, t: D1 }), line({ c: 2, t: D2 })], cache);
    const summary = path.join(cache, 'ledger', 'summary.json');
    fs.writeFileSync(summary, '{"v":1,"marker":true}');
    const t1 = writeTranscript(
      'projects/-w-a/A.jsonl',
      [assistantLine({ id: 'm1', requestId: 'r1', ts: D1, in: 1, out: 2 })],
      root,
    );
    const t2 = writeTranscript(
      'projects/-w-a/B.jsonl',
      [assistantLine({ id: 'm2', requestId: 'r2', ts: D1, in: 1, out: 3 })],
      root,
    );
    const first = run();
    expect(first.files).toBe(2);
    fs.rmSync(t2);
    const snap = [fs.readFileSync(month), fs.readFileSync(summary)];
    const r = run({ rebuild: true });
    expect(r.bytesRead).toBe(fs.statSync(t1).size + fs.statSync(month).size);
    expect(r.files).toBe(1);
    expect(r.claudeDir).toBe(path.resolve(root));
    expect(Object.keys(r.sessions).sort()).toEqual(['A', 'B']);
    expect(r.sessions.B).toMatchObject({ gone: true });
    expect(r.ledger.A!.total).toBeCloseTo(1.999, 9);
    expect(r.notes).toEqual([
      { code: 'deleted-transcripts', count: 1 },
      { code: 'rebuild-kept', count: 1 },
    ]);
    expect([fs.readFileSync(month), fs.readFileSync(summary)]).toEqual(snap);
    expect(fs.readdirSync(path.join(cache, 'ledger')).sort()).toEqual(['2026-10.jsonl', 'summary.json']);
  });

  it('costs a fork once whatever the file times, cold, warm or rebuilt', (ctx) => {
    const { root, cache, line, run } = setup('fork-cost');
    writeLedger(
      '2026-10',
      [line({ s: 'S9', c: 0.001, t: D1 }), line({ s: 'S9', c: 15, t: D1 + 600_000 })],
      cache,
    );
    const reqs = [1, 2, 3].map((i) =>
      assistantLine({ id: `m${i}`, requestId: `r${i}`, ts: D1 + i * 60_000, in: 1, costUSD: 5 }),
    );
    const orig = writeTranscript(
      'projects/-w-a/S9.jsonl',
      [userLine({ ts: D1, cwd: '/w/a' }), ...reqs],
      root,
    );
    const own = assistantLine({ id: 'm4', requestId: 'r4', ts: D1 + 1_200_000, in: 1, costUSD: 5 });
    const copy = bornAfter(
      orig,
      'projects/-w-a/S1.jsonl',
      [userLine({ ts: D1, cwd: '/w/a' }), ...reqs, own],
      root,
    );
    if (!copy) return ctx.skip();
    // after birth: macOS moves birth time back with an older mtime
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(copy, later, later);
    fs.utimesSync(orig, new Date(later.getTime() + 60_000), new Date(later.getTime() + 60_000));
    const cost = (r: ReturnType<typeof run>) =>
      buildReport(r, {
        period: 'day',
        since: null,
        until: null,
        filter: null,
        config: {},
        profiles: BUILTINS,
        prices: PRICE_DEPS,
      }).total!.costUsd;
    const cold = run();
    expect(cost(cold)).toBeCloseTo(19.999, 6);
    expect(cost(run())).toBeCloseTo(19.999, 6);
    const rebuilt = run({ rebuild: true });
    expect(cost(rebuilt)).toBeCloseTo(19.999, 6);
    expect(rebuilt.sessions).toEqual(cold.sessions);
  });
});

describe('report project names for hashed ledger lines', () => {
  const OPTS = {
    period: 'day',
    since: null,
    until: null,
    config: {},
    profiles: BUILTINS,
    prices: PRICE_DEPS,
  } as const;

  it('names a hashed session from its transcript and keeps the cwd filter working', () => {
    const { root, cache, line, run } = setup('hash-named');
    writeLedger(
      '2026-10',
      [
        line({ c: 0.001, t: D1, p: projectHash(normalizeRoot('/w/a')) }),
        line({ c: 2, t: D1 + 60_000, p: projectHash(normalizeRoot('/w/a')) }),
      ],
      cache,
    );
    writeTranscript('projects/-w-a/A.jsonl', [userLine({ ts: D1, cwd: '/w/a' })], root);
    const data = run();
    const all = buildReport(data, { ...OPTS, filter: null });
    expect(all.rows.map((r) => r.project)).toEqual([displayRoot('/w/a')]);
    const here = buildReport(data, { ...OPTS, filter: { kind: 'cwd', cwd: normalizeRoot('/w/a') } });
    expect(here.rows.map((r) => r.project)).toEqual([displayRoot('/w/a')]);
  });

  it('names a hashed project from a session that ran in a subfolder', () => {
    const { root, cache, line, run } = setup('hash-ancestor');
    const p = projectHash(normalizeRoot('/w/a'));
    writeLedger(
      '2026-10',
      [line({ s: 'G', c: 0.001, t: D1, p }), line({ s: 'G', c: 2, t: D1 + 60_000, p })],
      cache,
    );
    writeTranscript('projects/-w-a-sub/B.jsonl', [userLine({ ts: D1, cwd: '/w/a/sub' })], root);
    const rows = buildReport(run(), { ...OPTS, filter: null }).rows.map((r) => r.project);
    expect(rows).toContain(displayRoot('/w/a'));
    expect(rows).not.toContain('unknown project');
  });

  it('keeps a direct name over an ancestor guess', () => {
    const { root, cache, line, run } = setup('hash-direct');
    const p = projectHash(normalizeRoot('/w/a'));
    writeLedger('2026-10', [line({ c: 0.001, t: D1, p }), line({ c: 2, t: D1 + 60_000, p })], cache);
    writeTranscript('projects/-w-a/A.jsonl', [userLine({ ts: D1, cwd: '/w/a' })], root);
    writeTranscript('projects/-w-a-sub/B.jsonl', [userLine({ ts: D1, cwd: '/w/a/sub' })], root);
    expect(run().projectNames?.get(p)).toBe(normalizeRoot('/w/a'));
  });

  it('projectNamesOf walks ancestors per platform and stops before the root', () => {
    expect(projectNamesOf(['c:\\w\\a\\sub'], projectHash, 'win32').get(projectHash('c:\\w\\a'))).toBe(
      'c:\\w\\a',
    );
    const root = projectNamesOf(['/'], projectHash, 'linux');
    expect([...root.values()]).toEqual(['/']);
    expect([...projectNamesOf(['/w/a/sub'], projectHash, 'linux').values()].sort()).toEqual([
      '/w',
      '/w/a',
      '/w/a/sub',
    ]);
  });

  it('keeps a legacy path line under its path without a transcript', () => {
    const { cache, line, run } = setup('legacy-path');
    writeLedger('2026-10', [line({ c: 0.001, t: D1 }), line({ c: 2, t: D1 + 60_000 })], cache);
    const r = buildReport(run(), { ...OPTS, filter: null });
    expect(r.rows.map((x) => x.project)).toEqual(['/w/a']);
  });

  it('buckets a hashed session without a transcript as unknown project, never hex', () => {
    const { cache, line, run } = setup('hash-unknown');
    const p = projectHash('/w/gone');
    writeLedger('2026-10', [line({ c: 0.001, t: D1, p }), line({ c: 2, t: D1 + 60_000, p })], cache);
    const data = run();
    for (const [lang, label] of [
      ['en', 'unknown project'],
      ['tr', 'bilinmeyen proje'],
    ] as const) {
      const r = withLanguage(lang, () => buildReport(data, { ...OPTS, filter: null }));
      expect(r.rows.map((x) => x.project)).toEqual([label]);
      expect(r.notes.map((n) => n.code)).toContain('ledger-only');
      expect(JSON.stringify(r)).not.toContain(p);
    }
    const here = buildReport(data, { ...OPTS, filter: { kind: 'cwd', cwd: '/w/gone' } });
    expect(here.rows).toEqual([]);
  });
});
