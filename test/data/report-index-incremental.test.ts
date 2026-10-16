import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bucket, ScanResult, SessionData } from '../../src/core/report-types.js';
import { dayKey } from '../../src/core/time.js';
import { indexDir, loadIndex, readReportData } from '../../src/data/report-index.js';
import {
  appendTranscript,
  assistantLine,
  scratch,
  userLine,
  writeTranscript,
} from '../fixtures/report/build.js';

const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const min = (n: number) => T0 + n * 60_000;
const req = (i: number, out = i, ts = min(i)) =>
  assistantLine({ id: `m${i}`, requestId: `r${i}`, ts, in: 1, out });

function setup(name: string) {
  const root = scratch(name);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: root, CCINFOBAR_CACHE_DIR: path.join(root, 'cache') };
  const run = (opts: Parameters<typeof readReportData>[1] = {}) => readReportData(env, { now: NOW, ...opts });
  return { root, env, run, dir: indexDir(env) };
}

function total(s: SessionData | undefined): Bucket {
  const t: Bucket = { in: 0, out: 0, cr: 0, w5: 0, w1: 0, n: 0, usd: 0 };
  for (const b of Object.values(s?.buckets ?? {})) {
    for (const k of Object.keys(t) as (keyof Bucket)[]) t[k] += b[k];
  }
  return t;
}

const minutes = (s: SessionData | undefined) =>
  Object.values(s?.time ?? {}).reduce((a, b) => a + b, 0) / 60_000;

const age = (file: string, ms: number) => fs.utimesSync(file, new Date(ms), new Date(ms));

function spies() {
  const open = vi.spyOn(fs, 'openSync');
  const read = vi.spyOn(fs, 'readSync');
  const file = vi.spyOn(fs, 'readFileSync');
  const opened = () => open.mock.calls.map((c) => String(c[0]));
  // bytes read from transcript fds only; fds are reused after close
  const bytes = () => {
    const ev = [
      ...open.mock.calls.map((c, i) => ({
        at: open.mock.invocationCallOrder[i]!,
        fd: open.mock.results[i]?.value as number,
        path: String(c[0]),
      })),
      ...read.mock.calls.map((c, i) => ({
        at: read.mock.invocationCallOrder[i]!,
        fd: c[0],
        n: read.mock.results[i]?.value as number,
      })),
    ].sort((a, b) => a.at - b.at);
    const live = new Map<number, string>();
    let n = 0;
    for (const e of ev) {
      if ('path' in e) live.set(e.fd, e.path);
      else if (live.get(e.fd)?.includes(`${path.sep}projects${path.sep}`)) n += e.n;
    }
    return n;
  };
  const keyReads = () => file.mock.calls.filter((c) => KEY_FILE.test(path.basename(String(c[0])))).length;
  return { opened, bytes, keyReads };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function tree(root: string): string[] {
  const files = [
    writeTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: min(0), cwd: '/w/a' }), req(1), req(2)], root),
    writeTranscript('projects/-w-a/S2.jsonl', [userLine({ ts: min(10), cwd: '/w/a' }), req(11)], root),
    writeTranscript('projects/-w-b/S3.jsonl', [userLine({ ts: min(20), cwd: '/w/b' }), req(21)], root),
  ];
  for (const [i, f] of files.entries()) age(f, T0 + i * 1000);
  return files;
}

const strip = (r: ScanResult) => ({ ...r, bytesRead: 0 });

const KEY_FILE = /^keys-[0-9a-f]{8}\.bin$/;
const keyFiles = (dir: string) => fs.readdirSync(dir).filter((n) => KEY_FILE.test(n));

function keyFile(dir: string): string {
  const [name, ...more] = keyFiles(dir);
  expect(more).toEqual([]);
  return path.join(dir, name!);
}

describe('report index persistence', () => {
  it('writes index.json and the key file with private modes', () => {
    const { root, run, dir } = setup('persist');
    tree(root);
    const r = run();
    expect(r.files).toBe(3);
    expect(Object.keys(r.sessions).sort()).toEqual(['S1', 'S2', 'S3']);
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);
    const keys = keyFile(dir);
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).keys.stamp;
    expect(path.basename(keys)).toBe(`keys-${stamp.toString(16).padStart(8, '0')}.bin`);
    expect(path.dirname(dir)).toBe(path.join(root, 'cache', 'report'));
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, 'index.json')).mode & 0o777).toBe(0o600);
      expect(fs.statSync(keys).mode & 0o777).toBe(0o600);
    }
  });

  it('opens no transcript and no key set when nothing changed', () => {
    const { root, run, dir } = setup('warm');
    tree(root);
    const first = run();
    const index = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    const s = spies();
    const second = run();
    expect(s.opened().filter((p) => p.includes(`${path.sep}projects${path.sep}`))).toEqual([]);
    expect(s.bytes()).toBe(0);
    expect(s.keyReads()).toBe(0);
    expect(second.bytesRead).toBe(0);
    expect(strip(second)).toEqual(strip(first));
    expect(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).toBe(index);
  });

  it('reads only the appended bytes of a grown file and loads the key set once', () => {
    const { root, run } = setup('grow');
    const [file] = tree(root);
    run();
    const before = fs.statSync(file!).size;
    appendTranscript('projects/-w-a/S1.jsonl', [req(3), userLine({ ts: min(4) })], root);
    const added = fs.statSync(file!).size - before;
    const s = spies();
    const r = run();
    expect(r.bytesRead).toBe(added);
    // plus the tail fingerprint check before the stored offset
    expect(s.bytes()).toBe(added + 256);
    expect(s.keyReads()).toBe(1);
    expect(total(r.sessions.S1)).toMatchObject({ n: 3, out: 6 });
    expect(minutes(r.sessions.S1)).toBe(4);
    expect(total(r.sessions.S2).n).toBe(1);
  });

  it('fingerprints a file shorter than the tail window', () => {
    const { root, run } = setup('short');
    const file = writeTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: min(0), text: 'hi' })], root);
    run();
    expect(fs.statSync(file).size).toBeLessThan(256);
    const before = fs.statSync(file).size;
    appendTranscript('projects/-w-a/S1.jsonl', [req(1)], root);
    const r = run();
    expect(r.bytesRead).toBe(fs.statSync(file).size - before);
    expect(total(r.sessions.S1)).toMatchObject({ n: 1, out: 1 });
  });

  it('keeps last-wins inside a file across runs', () => {
    const { root, run } = setup('grow-last');
    tree(root);
    run();
    appendTranscript('projects/-w-a/S1.jsonl', [req(2, 50)], root);
    expect(total(run().sessions.S1)).toMatchObject({ n: 2, out: 51 });
  });

  it('re-reads a file rewritten in place with a larger size', () => {
    const { root, run } = setup('rewrite');
    const [file] = tree(root);
    run();
    const ino = fs.statSync(file!).ino;
    const before = fs.statSync(file!).size;
    fs.writeFileSync(
      file!,
      `${[userLine({ ts: min(0), cwd: '/w/a', text: 'x'.repeat(300) }), req(1, 10), req(5), req(6)].join('\n')}\n`,
    );
    expect(fs.statSync(file!).ino).toBe(ino);
    expect(fs.statSync(file!).size).toBeGreaterThan(before);
    const r = run();
    expect(r.bytesRead).toBe(fs.statSync(file!).size);
    expect(total(r.sessions.S1)).toMatchObject({ n: 3, out: 21 });
  });

  it('re-reads a truncated file from 0', () => {
    const { root, run } = setup('shrink');
    const [file] = tree(root);
    run();
    fs.writeFileSync(file!, `${req(7)}\n`);
    const r = run();
    expect(r.bytesRead).toBe(fs.statSync(file!).size);
    expect(total(r.sessions.S1)).toMatchObject({ n: 1, out: 7 });
  });

  it('keeps a deleted transcript and still dedups its fork copy', () => {
    const { root, run } = setup('gone');
    const a = writeTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: min(0) }), req(1), req(2)], root);
    const b = writeTranscript('projects/-w-a/S2.jsonl', [req(1), req(2), req(3, 3, min(30))], root);
    age(a, T0);
    age(b, T0 + 1000);
    const first = run();
    expect(total(first.sessions.S2).n).toBe(1);
    fs.rmSync(a);
    const second = run();
    expect(second.sessions.S1).toMatchObject({ gone: true });
    expect(total(second.sessions.S1)).toMatchObject({ n: 2, out: 3 });
    expect(minutes(second.sessions.S1)).toBe(2);
    expect(second.notes).toContainEqual({ code: 'deleted-transcripts', count: 1 });
    appendTranscript('projects/-w-a/S2.jsonl', [req(1), req(4, 4, min(31))], root);
    const third = run();
    expect(total(third.sessions.S1)).toMatchObject({ n: 2, out: 3 });
    expect(total(third.sessions.S2)).toMatchObject({ n: 2, out: 7 });
  });

  it('drops gone aggregates older than 13 months', () => {
    const { root, run } = setup('retain');
    const old = Date.parse('2025-01-10T10:00:00.000Z');
    const a = writeTranscript('projects/-w-a/S1.jsonl', [req(1, 1, old), req(2, 2, min(0))], root);
    const b = writeTranscript('projects/-w-a/S2.jsonl', [req(3, 3, old)], root);
    run();
    fs.rmSync(a);
    fs.rmSync(b);
    const r = run();
    expect(Object.keys(r.sessions.S1!.buckets).map((k) => k.slice(0, 10))).toEqual([dayKey(min(0))]);
    expect(r.sessions.S2).toBeUndefined();
    expect(r.notes).toContainEqual({ code: 'deleted-transcripts', count: 1 });
  });

  it.each([
    ['a newer version', (dir: string) => edit(dir, (j) => ({ ...j, v: 2 }))],
    ['a truncated index', (dir: string) => fs.writeFileSync(path.join(dir, 'index.json'), '{"v":1,"files"')],
    [
      'a bad file entry',
      (dir: string) => edit(dir, (j) => ({ ...j, files: { 'projects/x': { kind: 'x' } } })),
    ],
    ['a bad key set header', (dir: string) => fs.writeFileSync(keyFile(dir), 'XXXX0000')],
    ['a missing key set', (dir: string) => fs.rmSync(keyFile(dir))],
    [
      'a key set from another index',
      (dir: string) => edit(dir, (j) => ({ ...j, keys: { ...j.keys, stamp: 1 } })),
    ],
  ])('scans cold after %s', (_, spoil) => {
    const { root, run, dir } = setup('cold');
    const [file] = tree(root);
    run();
    spoil(dir);
    appendTranscript('projects/-w-a/S1.jsonl', [req(3)], root);
    const r = run();
    expect(total(r.sessions.S1)).toMatchObject({ n: 3, out: 6 });
    expect(total(r.sessions.S2)).toMatchObject({ n: 1, out: 11 });
    expect(r.bytesRead).toBeGreaterThanOrEqual(fs.statSync(file!).size);
    expect(run().bytesRead).toBe(0);
  });

  it.each([
    ['a missing key set', (dir: string) => fs.rmSync(keyFile(dir))],
    ['a bad key set header', (dir: string) => fs.writeFileSync(keyFile(dir), 'XXXX0000')],
    [
      'a key set from another index',
      (dir: string) => edit(dir, (j) => ({ ...j, keys: { ...j.keys, stamp: 1 } })),
    ],
    ['a bad key list', (dir: string) => edit(dir, (j) => ({ ...j, order: 7 }))],
  ])('keeps deleted transcripts after %s', (_, spoil) => {
    const { root, run, dir } = setup('lost');
    const [s1] = tree(root);
    run();
    fs.rmSync(s1!);
    expect(total(run().sessions.S1)).toMatchObject({ n: 2, out: 3 });
    spoil(dir);
    appendTranscript('projects/-w-a/S2.jsonl', [req(12)], root);
    const r = run();
    expect(r.sessions.S1).toMatchObject({ gone: true });
    expect(total(r.sessions.S1)).toMatchObject({ n: 2, out: 3 });
    expect(minutes(r.sessions.S1)).toBe(2);
    expect(total(r.sessions.S2)).toMatchObject({ n: 2, out: 23 });
    expect(total(r.sessions.S3)).toMatchObject({ n: 1, out: 21 });
    expect(r.notes).toContainEqual({ code: 'keys-lost', count: 1 });
    expect(run().notes).toContainEqual({ code: 'keys-lost', count: 1 });
  });

  it('still dedups the recent keys of a deleted transcript after the key set is lost', () => {
    const { root, run, dir } = setup('lost-fork');
    const a = writeTranscript('projects/-w-a/S1.jsonl', [userLine({ ts: min(0) }), req(1), req(2)], root);
    run();
    fs.rmSync(a);
    run();
    fs.rmSync(keyFile(dir));
    writeTranscript('projects/-w-a/S2.jsonl', [req(1), req(2), req(3, 3, min(30))], root);
    const r = run();
    expect(total(r.sessions.S1)).toMatchObject({ n: 2, out: 3 });
    expect(total(r.sessions.S2)).toMatchObject({ n: 1, out: 3 });
  });

  it('drops only a bad file entry', () => {
    const { root, run, dir } = setup('bad-entry');
    const [file] = tree(root);
    run();
    edit(dir, (j) => ({ ...j, files: { ...j.files, 'projects/-w-a/S2.jsonl': { kind: 'x' } } }));
    const before = fs.statSync(file!).size;
    appendTranscript('projects/-w-a/S1.jsonl', [req(3)], root);
    const r = run();
    expect(r.bytesRead).toBe(
      fs.statSync(file!).size - before + fs.statSync(path.join(root, 'projects', '-w-a', 'S2.jsonl')).size,
    );
    expect(total(r.sessions.S1)).toMatchObject({ n: 3, out: 6 });
    expect(total(r.sessions.S2)).toMatchObject({ n: 1, out: 11 });
    expect(r.notes).toEqual([]);
  });

  it('keeps the last pair when a run stops between the key file and index.json', () => {
    const { root, run, dir } = setup('crash');
    const [file] = tree(root);
    run();
    const keys = keyFile(dir);
    appendTranscript('projects/-w-a/S1.jsonl', [req(3)], root);
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('index.json')) throw Object.assign(new Error('killed'), { code: 'EIO' });
      rename(from, to);
    });
    run();
    spy.mockRestore();
    expect(fs.existsSync(keys)).toBe(true);
    const orphan = keyFiles(dir).filter((n) => n !== path.basename(keys));
    expect(orphan).toHaveLength(1);
    const old = (Date.now() - 11 * 60_000) / 1000;
    fs.utimesSync(path.join(dir, orphan[0]!), old, old);
    appendTranscript('projects/-w-a/S1.jsonl', [req(4)], root);
    const r = run();
    expect(r.notes).toEqual([]);
    expect(total(r.sessions.S1)).toMatchObject({ n: 4, out: 10 });
    expect(r.bytesRead).toBeLessThan(fs.statSync(file!).size - 40);
    expect(fs.existsSync(keys)).toBe(false);
    expect(keyFiles(dir)).toHaveLength(1);
  });

  it('accepts its own index under another letter case on Windows', () => {
    const { root, run, dir } = setup('case');
    tree(root);
    run();
    const upper = path.resolve(root).toUpperCase();
    expect(loadIndex(dir, upper, 'win32')).not.toBeNull();
    expect(loadIndex(dir, path.resolve(root).normalize('NFD'), 'linux')).not.toBeNull();
    if (upper !== path.resolve(root)) expect(loadIndex(dir, upper, 'linux')).toBeNull();
    expect(loadIndex(dir, path.join(root, 'other'), 'win32')).toBeNull();
  });

  it('keeps profiles apart', () => {
    const a = setup('profile-a');
    const b = setup('profile-b');
    expect(a.dir).not.toBe(b.dir);
    expect(path.dirname(a.dir)).toBe(path.join(a.root, 'cache', 'report'));
    expect(path.basename(a.dir)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stores no message text', () => {
    const { root, run, dir } = setup('privacy');
    tree(root);
    run();
    const text = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    expect(text).not.toContain('PROMPT_MARKER');
    expect(text).not.toContain('"content"');
  });

  it('rebuild re-reads existing files and keeps deleted ones', () => {
    const { root, run } = setup('rebuild');
    const files = tree(root);
    run();
    fs.rmSync(files[2]!);
    const r = run({ rebuild: true });
    const size = fs.statSync(files[0]!).size + fs.statSync(files[1]!).size;
    expect(r.bytesRead).toBe(size);
    expect(total(r.sessions.S1)).toMatchObject({ n: 2, out: 3 });
    expect(total(r.sessions.S3)).toMatchObject({ n: 1, out: 21 });
    expect(r.notes).toContainEqual({ code: 'rebuild-kept', count: 1 });
    expect(run().notes).not.toContainEqual(expect.objectContaining({ code: 'rebuild-kept' }));
  });
});

function edit(dir: string, fn: (j: any) => unknown): void {
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(file, JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8')))));
}
