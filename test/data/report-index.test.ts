import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Bucket, SessionData } from '../../src/core/report-types.js';
import { dayKey } from '../../src/core/time.js';
import { normalizeRoot } from '../../src/data/ledger.js';
import { keyHash, scanTree, sessionsOf, walkTranscripts } from '../../src/data/report-index.js';
import {
  appendTranscript,
  assistantLine,
  bornAfter,
  metaLine,
  scratch,
  userLine,
  writeTranscript,
} from '../fixtures/report/build.js';

const one = [assistantLine({ id: 'm1', requestId: 'r1', ts: '2026-10-12T10:00:00.000Z', in: 1, out: 1 })];

describe('walkTranscripts', () => {
  it('lists main, aside and agent files and nothing else', () => {
    const root = scratch('walk');
    for (const rel of [
      'projects/-w-a/S1.jsonl',
      'projects/-w-a/S1/subagents/agent-x.jsonl',
      'projects/-w-a/S1/subagents/workflows/wf_1/agent-y.jsonl',
      'projects/-w-a/S1/subagents/workflows/wf_1/journal.jsonl',
      'projects/-w-a/S1/subagents/agent-x.meta.json',
      'projects/-w-a/S1/tool-results/t.jsonl',
      'projects/-w-a/S1/workflows/w.jsonl',
      'projects/-w-a/S2.orphaned-123-abc.jsonl',
      'projects/-w-a/S3.jsonl.superseded-456',
      'projects/-w-a/memory/m.jsonl',
      'projects/-w-a/sessions-index.json',
      'projects/-w-a/bad name.jsonl',
      'projects/loose.jsonl',
    ]) {
      writeTranscript(rel, one, root);
    }
    const { files, capped } = walkTranscripts(root);
    expect(capped).toBe(false);
    const got = files.map((f) => [f.rel, f.kind, f.sid, f.enc]).sort();
    expect(got).toEqual(
      [
        ['projects/-w-a/S1.jsonl', 'main', 'S1', '-w-a'],
        ['projects/-w-a/S1/subagents/agent-x.jsonl', 'agent', 'S1', '-w-a'],
        ['projects/-w-a/S1/subagents/workflows/wf_1/agent-y.jsonl', 'agent', 'S1', '-w-a'],
        ['projects/-w-a/S2.orphaned-123-abc.jsonl', 'aside', 'S2', '-w-a'],
        ['projects/-w-a/S3.jsonl.superseded-456', 'aside', 'S3', '-w-a'],
      ].sort(),
    );
    for (const f of files) {
      expect(f.rel).not.toContain('\\');
      expect(f.abs).toBe(path.join(root, ...f.rel.split('/')));
    }
  });

  it('skips symlinked project dirs and files', (ctx) => {
    const root = scratch('walk-link');
    const real = writeTranscript('elsewhere/T1.jsonl', one, root);
    writeTranscript('projects/-w-a/S1.jsonl', one, root);
    try {
      fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'projects', '-w-link'), 'dir');
      fs.symlinkSync(real, path.join(root, 'projects', '-w-a', 'S5.jsonl'), 'file');
    } catch {
      ctx.skip();
    }
    expect(walkTranscripts(root).files.map((f) => f.rel)).toEqual(['projects/-w-a/S1.jsonl']);
  });

  it('stops at depth 4 below subagents', () => {
    const root = scratch('walk-depth');
    writeTranscript('projects/-w-a/S1/subagents/a/b/c/agent-4.jsonl', one, root);
    writeTranscript('projects/-w-a/S1/subagents/a/b/c/d/agent-5.jsonl', one, root);
    expect(walkTranscripts(root).files.map((f) => f.rel)).toEqual([
      'projects/-w-a/S1/subagents/a/b/c/agent-4.jsonl',
    ]);
  });

  it('caps the file count', () => {
    const root = scratch('walk-cap');
    for (const s of ['S1', 'S2', 'S3']) writeTranscript(`projects/-w-a/${s}.jsonl`, one, root);
    const { files, capped } = walkTranscripts(root, 2);
    expect(files).toHaveLength(2);
    expect(capped).toBe(true);
    expect(walkTranscripts(root, 3).capped).toBe(false);
  });

  it('returns nothing without a projects dir', () => {
    const root = scratch('walk-none');
    expect(walkTranscripts(root)).toEqual({ files: [], capped: false });
    expect(walkTranscripts(path.join(root, 'missing'))).toEqual({ files: [], capped: false });
  });
});

const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const min = (n: number) => T0 + n * 60_000;

function total(s: SessionData | undefined): Bucket {
  const t: Bucket = { in: 0, out: 0, cr: 0, w5: 0, w1: 0, n: 0, usd: 0 };
  for (const b of Object.values(s?.buckets ?? {})) {
    for (const k of Object.keys(t) as (keyof Bucket)[]) t[k] += b[k];
  }
  return t;
}

const scan = (root: string, opts?: Parameters<typeof scanTree>[2]) =>
  sessionsOf(scanTree(root, null, opts).state);

function age(file: string, ms: number): void {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

describe('scanTree requests', () => {
  it('keeps the last line of a key', () => {
    const root = scratch('last');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), in: 5, out: 10 }),
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), in: 6, out: 40 }),
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), in: 7, out: 90 }),
      ],
      root,
    );
    expect(total(scan(root).S1)).toMatchObject({ n: 1, in: 7, out: 90 });
  });

  it('moves a replaced request between buckets', () => {
    const root = scratch('move');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), in: 5, out: 10 }),
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), in: 5, out: 20, speed: 'fast' }),
      ],
      root,
    );
    const keys = Object.keys(scan(root).S1!.buckets);
    expect(keys).toEqual([`${dayKey(min(0))}|claude-opus-4-5|1|0|0`]);
  });

  it('counts a subagent request and its sidechain copy once', () => {
    const root = scratch('side');
    const copy = { id: 'm2', requestId: 'r2', ts: min(1), in: 1, out: 100 };
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), in: 1, out: 1 }),
        assistantLine({ ...copy, sidechain: true }),
      ],
      root,
    );
    writeTranscript('projects/-w-a/S1/subagents/agent-x.jsonl', [assistantLine(copy)], root);
    const s = scan(root);
    expect(Object.keys(s)).toEqual(['S1']);
    expect(total(s.S1)).toMatchObject({ n: 2, out: 101 });
    expect(s.S1!.files).toBe(2);
  });

  it('counts copied fork requests for the older file only', () => {
    const root = scratch('fork');
    const reqs = [1, 2, 3].map((i) => ({ id: `m${i}`, requestId: `r${i}`, ts: min(i), in: 1, out: 10 }));
    age(writeTranscript('projects/-w-a/S1.jsonl', reqs.map(assistantLine), root), T0);
    const fork = [...reqs, { id: 'm4', requestId: 'r4', ts: min(20), in: 1, out: 10 }];
    age(writeTranscript('projects/-w-a/S9.jsonl', fork.map(assistantLine), root), T0 + 60_000);
    const s = scan(root);
    expect(total(s.S1).n).toBe(3);
    expect(total(s.S9).n).toBe(1);
  });

  it('counts copied fork requests for the original after it was resumed', (ctx) => {
    const root = scratch('fork-resumed');
    const reqs = [1, 2, 3].map((i) => ({ id: `m${i}`, requestId: `r${i}`, ts: min(i), in: 1, out: 10 }));
    const orig = writeTranscript('projects/-w-a/S9.jsonl', reqs.map(assistantLine), root);
    const fork = [...reqs, { id: 'm4', requestId: 'r4', ts: min(20), in: 1, out: 10 }];
    const copy = bornAfter(orig, 'projects/-w-a/S1.jsonl', fork.map(assistantLine), root);
    if (!copy) return ctx.skip();
    age(copy, T0 + 60_000);
    age(orig, T0 + 120_000);
    const s = scan(root);
    expect(total(s.S9).n).toBe(3);
    expect(total(s.S1).n).toBe(1);
  });

  it('gives copied requests to the file whose entries start first', () => {
    const root = scratch('fork-first');
    const reqs = [1, 2, 3].map((i) => ({ id: `m${i}`, requestId: `r${i}`, ts: min(i), in: 1, out: 10 }));
    const orig = writeTranscript(
      'projects/-w-a/S9.jsonl',
      [userLine({ ts: min(0) }), ...reqs.map(assistantLine)],
      root,
    );
    const fork = [...reqs.slice(1), { id: 'm4', requestId: 'r4', ts: min(20), in: 1, out: 10 }];
    const copy = writeTranscript('projects/-w-a/S1.jsonl', fork.map(assistantLine), root);
    age(copy, T0);
    age(orig, T0 + 60_000);
    const s = scan(root);
    expect(total(s.S9).n).toBe(3);
    expect(total(s.S1).n).toBe(1);
  });

  it('moves copied requests to an older original that shows up later', () => {
    const root = scratch('fork-late');
    const reqs = [1, 2, 3].map((i) => ({ id: `m${i}`, requestId: `r${i}`, ts: min(i), in: 1, out: 10 }));
    const fork = [...reqs, { id: 'm4', requestId: 'r4', ts: min(20), in: 1, out: 10 }];
    writeTranscript('projects/-w-a/S1.jsonl', fork.map(assistantLine), root);
    const first = scanTree(root, null);
    expect(total(sessionsOf(first.state).S1).n).toBe(4);
    writeTranscript('projects/-w-a/S9.jsonl', [userLine({ ts: min(0) }), ...reqs.map(assistantLine)], root);
    const s = sessionsOf(scanTree(root, first.state).state);
    expect(total(s.S9)).toMatchObject({ n: 3, out: 30 });
    expect(total(s.S1)).toMatchObject({ n: 1, out: 10 });
  });

  it('ignores tool result usage and synthetic messages', () => {
    const root = scratch('skip');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        userLine({ ts: min(0), toolUseResultUsage: { input_tokens: 500, output_tokens: 500 } }),
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(1), model: '<synthetic>', in: 9, out: 9 }),
      ],
      root,
    );
    expect(total(scan(root).S1).n).toBe(0);
  });

  it('counts every line without ids', () => {
    const root = scratch('keyless');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [assistantLine({ ts: min(0), out: 3 }), assistantLine({ ts: min(1), out: 3 })],
      root,
    );
    expect(total(scan(root).S1)).toMatchObject({ n: 2, out: 6 });
  });

  it('splits cache writes into 5m and 1h', () => {
    const root = scratch('cache');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), cw: 200, w5: 100, w1: 50 }),
        assistantLine({ id: 'm2', requestId: 'r2', ts: min(1), cw: 70 }),
      ],
      root,
    );
    expect(total(scan(root).S1)).toMatchObject({ w5: 220, w1: 50 });
  });

  it('flags fast, big and costUSD buckets', () => {
    const root = scratch('flags');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), in: 1, speed: 'fast' }),
        assistantLine({ id: 'm2', requestId: 'r2', ts: min(1), in: 50_000, cr: 40_000, cw: 10_001 }),
        assistantLine({ id: 'm3', requestId: 'r3', ts: min(2), in: 50_000, cr: 40_000, cw: 10_000 }),
        assistantLine({ id: 'm4', requestId: 'r4', ts: min(3), in: 1, costUSD: 0.25 }),
        assistantLine({ id: 'm5', requestId: 'r5', ts: min(4), in: 1, costUSD: 0.5 }),
      ],
      root,
    );
    const d = dayKey(min(0));
    const b = scan(root).S1!.buckets;
    expect(Object.keys(b).sort()).toEqual(
      [
        `${d}|claude-opus-4-5|1|0|0`,
        `${d}|claude-opus-4-5|0|1|0`,
        `${d}|claude-opus-4-5|0|0|0`,
        `${d}|claude-opus-4-5|0|0|1`,
      ].sort(),
    );
    expect(b[`${d}|claude-opus-4-5|0|0|1`]).toMatchObject({ n: 2, usd: 0.75 });
    expect(b[`${d}|claude-opus-4-5|0|0|0`]!.n).toBe(1);
  });

  it('puts each request on the day of its own timestamp', () => {
    const root = scratch('days');
    const late = new Date(2026, 9, 12, 23, 59, 30).getTime();
    const early = new Date(2026, 9, 13, 0, 0, 30).getTime();
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        assistantLine({ id: 'm1', requestId: 'r1', ts: late, out: 1 }),
        assistantLine({ id: 'm2', requestId: 'r2', ts: early, out: 1 }),
      ],
      root,
    );
    const days = Object.keys(scan(root).S1!.buckets).map((k) => k.split('|')[0]);
    expect(days.sort()).toEqual(['2026-10-12', '2026-10-13']);
  });

  it('waits for the newline of a torn last line', () => {
    const root = scratch('torn');
    const full = assistantLine({ id: 'm2', requestId: 'r2', ts: min(1), out: 7 });
    const file = writeTranscript(
      'projects/-w-a/S1.jsonl',
      [assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), out: 1 })],
      root,
    );
    fs.appendFileSync(file, full.slice(0, 40));
    const first = scanTree(root, null);
    expect(total(sessionsOf(first.state).S1)).toMatchObject({ n: 1, out: 1 });
    const offset = first.state.files['projects/-w-a/S1.jsonl']!.offset;
    expect(offset).toBe(fs.statSync(file).size - 40);
    fs.appendFileSync(file, `${full.slice(40)}\n`);
    const second = scanTree(root, first.state);
    expect(second.bytesRead).toBe(fs.statSync(file).size - offset);
    expect(total(sessionsOf(second.state).S1)).toMatchObject({ n: 2, out: 8 });
    expect(scanTree(root, second.state).bytesRead).toBe(0);
  });

  it('skips lines over the size cap and counts them', () => {
    const root = scratch('cap');
    const huge = assistantLine({ id: 'm1', requestId: 'r1', ts: min(0), out: 1000, model: 'x'.repeat(1000) });
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [huge, assistantLine({ id: 'm2', requestId: 'r2', ts: min(1), out: 2 })],
      root,
    );
    const r = scanTree(root, null, { maxLine: 600 });
    expect(r.notes).toEqual([{ code: 'line-skipped', count: 1 }]);
    expect(total(sessionsOf(r.state).S1)).toMatchObject({ n: 1, out: 2 });
  });

  it('drops an oversized line that spans chunks once its newline arrives', () => {
    const root = scratch('cap-torn');
    const file = writeTranscript('projects/-w-a/S1.jsonl', [], root);
    fs.appendFileSync(file, 'x'.repeat(1500));
    const first = scanTree(root, null, { maxLine: 600 });
    expect(first.notes).toEqual([]);
    appendTranscript(
      'projects/-w-a/S1.jsonl',
      ['y'.repeat(100), assistantLine({ id: 'm', requestId: 'r', ts: min(0), out: 4 })],
      root,
    );
    const second = scanTree(root, first.state, { maxLine: 600 });
    expect(second.notes).toEqual([{ code: 'line-skipped', count: 1 }]);
    expect(total(sessionsOf(second.state).S1)).toMatchObject({ n: 1, out: 4 });
  });

  it('keeps the first cwd of the main file and no message text', () => {
    const root = scratch('cwd');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        userLine({ ts: min(0), cwd: '/w/a/' }),
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(1), out: 1, cwd: '/w/other' }),
      ],
      root,
    );
    writeTranscript(
      'projects/-w-a/S1/subagents/agent-x.jsonl',
      [assistantLine({ id: 'm2', requestId: 'r2', ts: min(1), out: 1, cwd: '/w/sub' })],
      root,
    );
    const { state } = scanTree(root, null);
    expect(sessionsOf(state).S1!.cwd).toBe(normalizeRoot('/w/a/'));
    expect(JSON.stringify(state)).not.toContain('PROMPT_MARKER');
    expect(JSON.stringify(sessionsOf(state))).not.toContain('PROMPT_MARKER');
  });

  it('reports the file cap and progress', () => {
    const root = scratch('progress');
    for (const s of ['S1', 'S2', 'S3']) {
      writeTranscript(`projects/-w-a/${s}.jsonl`, [assistantLine({ id: s, requestId: s, ts: min(0) })], root);
    }
    const seen: number[] = [];
    const r = scanTree(root, null, { maxFiles: 2, onProgress: (files) => seen.push(files) });
    expect(r.notes).toEqual([{ code: 'file-cap', count: 2 }]);
    expect(seen).toEqual([1, 2]);
    expect(r.bytesRead).toBeGreaterThan(0);
  });

  it('hashes keys to 53-bit integers', () => {
    const a = keyHash('msg_1:req_1');
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(a).toBe(keyHash('msg_1:req_1'));
    expect(a).not.toBe(keyHash('msg_1:req_2'));
  });
});

const minutes = (s: SessionData | undefined) =>
  Object.values(s?.time ?? {}).reduce((a, b) => a + b, 0) / 60_000;

describe('scanTree active time', () => {
  it('sums gaps capped at five minutes', () => {
    const root = scratch('time');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        userLine({ ts: min(0) }),
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(2) }),
        metaLine(min(20)),
        userLine({ ts: min(21) }),
      ],
      root,
    );
    expect(minutes(scan(root).S1)).toBe(8);
  });

  it('credits a gap across midnight to the later day', () => {
    const root = scratch('midnight');
    const a = new Date(2026, 9, 12, 23, 58).getTime();
    const b = new Date(2026, 9, 13, 0, 1).getTime();
    writeTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: a }), metaLine(b)], root);
    expect(scan(root).S1!.time).toEqual({ '2026-10-13': 180_000 });
  });

  it('adds no time for sidechain lines, agent files and aside files', () => {
    const root = scratch('no-time');
    writeTranscript(
      'projects/-w-a/S1.jsonl',
      [
        userLine({ ts: min(0) }),
        userLine({ ts: min(4), sidechain: true }),
        assistantLine({ id: 'm1', requestId: 'r1', ts: min(8), sidechain: true }),
        metaLine(min(9)),
      ],
      root,
    );
    writeTranscript(
      'projects/-w-a/S1/subagents/agent-x.jsonl',
      [userLine({ ts: min(10) }), metaLine(min(12))],
      root,
    );
    writeTranscript(
      'projects/-w-a/S2.orphaned-1-x.jsonl',
      [userLine({ ts: min(0) }), metaLine(min(3))],
      root,
    );
    const s = scan(root);
    expect(minutes(s.S1)).toBe(5);
    expect(s.S2!.time).toEqual({});
  });

  it('skips the copied history of a fork', () => {
    const root = scratch('fork-time');
    const history: string[] = [];
    for (let i = 0; i <= 10; i++) {
      if (i > 0) history.push(userLine({ ts: min(3 * i - 2) }));
      history.push(assistantLine({ id: `m${i}`, requestId: `r${i}`, ts: min(3 * i), in: 1, out: 1 }));
    }
    age(writeTranscript('projects/-w-a/S1.jsonl', history, root), T0);
    const fresh: string[] = [];
    for (let i = 0; i <= 5; i++) {
      fresh.push(userLine({ ts: min(40 + 2 * i) }));
      fresh.push(assistantLine({ id: `n${i}`, requestId: `q${i}`, ts: min(40 + 2 * i), out: 1 }));
    }
    age(writeTranscript('projects/-w-a/S9.jsonl', [...history, ...fresh], root), T0 + 60_000);
    const s = scan(root);
    expect(minutes(s.S1)).toBe(30);
    expect(minutes(s.S9)).toBe(15);
    expect(total(s.S1).n).toBe(11);
    expect(total(s.S9).n).toBe(6);
  });

  it('skips the copied history of a fork that was older on disk', (ctx) => {
    const root = scratch('fork-time-resumed');
    const history: string[] = [];
    for (let i = 0; i <= 10; i++) {
      if (i > 0) history.push(userLine({ ts: min(3 * i - 2) }));
      history.push(assistantLine({ id: `m${i}`, requestId: `r${i}`, ts: min(3 * i), in: 1, out: 1 }));
    }
    const orig = writeTranscript('projects/-w-a/S9.jsonl', history, root);
    const fresh: string[] = [];
    for (let i = 0; i <= 5; i++) {
      fresh.push(userLine({ ts: min(40 + 2 * i) }));
      fresh.push(assistantLine({ id: `n${i}`, requestId: `q${i}`, ts: min(40 + 2 * i), out: 1 }));
    }
    const copy = bornAfter(orig, 'projects/-w-a/S1.jsonl', [...history, ...fresh], root);
    if (!copy) return ctx.skip();
    age(copy, T0 + 60_000);
    age(orig, T0 + 120_000);
    const s = scan(root);
    expect(minutes(s.S9)).toBe(30);
    expect(minutes(s.S1)).toBe(15);
    expect(total(s.S9).n).toBe(11);
    expect(total(s.S1).n).toBe(6);
  });

  it('keeps the time of a main file that copies its own set-aside transcript', () => {
    const root = scratch('aside-time');
    const reqs = [0, 1, 2, 3].map((i) => assistantLine({ id: `m${i}`, requestId: `r${i}`, ts: min(3 * i) }));
    age(writeTranscript('projects/-w-a/S1.orphaned-1-x.jsonl', reqs, root), T0);
    const main = [...reqs, assistantLine({ id: 'm4', requestId: 'r4', ts: min(12) })];
    age(writeTranscript('projects/-w-a/S1.jsonl', main, root), T0 + 60_000);
    const s = scan(root).S1!;
    expect(minutes(s)).toBe(12);
    expect(total(s).n).toBe(5);
  });

  it('carries the last timestamp across scans', () => {
    const root = scratch('grow');
    writeTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: min(0) }), metaLine(min(2))], root);
    const first = scanTree(root, null);
    expect(minutes(sessionsOf(first.state).S1)).toBe(2);
    appendTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: min(5) })], root);
    expect(minutes(sessionsOf(scanTree(root, first.state).state).S1)).toBe(5);
  });

  it('reads the top-level timestamp of an unparsed line', () => {
    const root = scratch('last-ts');
    const odd = JSON.stringify({
      type: 'user',
      toolUseResult: { timestamp: new Date(min(-60)).toISOString() },
      message: { role: 'user', content: 'PROMPT_MARKER_x' },
      timestamp: new Date(min(4)).toISOString(),
    });
    writeTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: min(0), cwd: '/w/a' }), odd], root);
    expect(minutes(scan(root).S1)).toBe(4);
  });
});
