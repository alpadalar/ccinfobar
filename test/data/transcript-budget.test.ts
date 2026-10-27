import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseTranscriptText, readTranscript, TRANSCRIPT_BUDGET } from '../../src/data/transcript.js';

const BASE = Date.parse('2026-01-01T00:00:00Z');
const MIB = 1024 * 1024;

function line(i: number): string {
  const ts = new Date(BASE + i * 1000).toISOString();
  return `{"type":"assistant","timestamp":"${ts}","requestId":"r${i}","message":{"id":"m${i}","model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`;
}

function generate(file: string, bytes: number): { count: number; size: number } {
  const fd = fs.openSync(file, 'w');
  let count = 0;
  let size = 0;
  try {
    while (size < bytes) {
      let block = '';
      for (let k = 0; k < 8192; k++) block += line(count++);
      const buf = Buffer.from(block);
      fs.writeSync(fd, buf);
      size += buf.length;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { count, size };
}

let dir: string;
let big: string;
let bigCount = 0;
let bigSize = 0;
let genMs = 0;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-trb-'));
  big = path.join(dir, 'big.jsonl');
  const t0 = Date.now();
  const r = generate(big, 100 * MIB);
  genMs = Date.now() - t0;
  bigCount = r.count;
  bigSize = r.size;
  console.log(`transcript-budget fixture: ${bigSize} bytes, ${bigCount} lines, ${genMs} ms`);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function readBytes<T>(fn: () => T): { out: T; bytes: number } {
  const spy = vi.spyOn(fs, 'readSync');
  try {
    const out = fn();
    const bytes = spy.mock.calls.reduce((a, c) => a + ((c as unknown as unknown[])[3] as number), 0);
    return { out, bytes };
  } finally {
    spy.mockRestore();
  }
}

describe('transcript budget', () => {
  it('reads at most the budget per render and converges', () => {
    const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache1') };
    const max = Math.ceil(bigSize / TRANSCRIPT_BUDGET) + 1;
    let prev = 0;
    let last = null as ReturnType<typeof readTranscript>;
    let sawPartial = false;
    for (let i = 0; i < max; i++) {
      const { out, bytes } = readBytes(() => readTranscript(big, env));
      expect(bytes).toBeLessThanOrEqual(TRANSCRIPT_BUDGET + MIB);
      expect(out!.outputTokens).toBeGreaterThanOrEqual(prev);
      prev = out!.outputTokens;
      last = out;
      if (out!.partial) sawPartial = true;
      else break;
    }
    expect(sawPartial).toBe(true);
    expect(last!.partial).toBeFalsy();
    expect(last!.outputTokens).toBe(bigCount * 20);
    expect(last!.inputTokens).toBe(bigCount * 10);
  });

  it('persists the partial state', () => {
    const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache2') };
    const first = readTranscript(big, env);
    expect(first!.partial).toBe(true);
    const name = fs.readdirSync(env.CCINFOBAR_CACHE_DIR).find((f) => /^transcript-.*\.json$/.test(f));
    expect(name).toBeTruthy();
    const st = JSON.parse(fs.readFileSync(path.join(env.CCINFOBAR_CACHE_DIR, name!), 'utf8'));
    expect(st.offset).toBeGreaterThan(0);
    expect(st.offset).toBeLessThan(bigSize);
  });

  it('persist: false stays unbounded', () => {
    const small = path.join(dir, 'small.jsonl');
    generate(small, MIB);
    const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache3') };
    const info = readTranscript(small, env, { persist: false });
    const expected = parseTranscriptText(fs.readFileSync(small, 'utf8'));
    expect(info!.partial).toBeFalsy();
    expect(info!.outputTokens).toBe(expected.outputTokens);
    expect(info!.messageCount).toBe(expected.messageCount);
    expect(fs.existsSync(env.CCINFOBAR_CACHE_DIR)).toBe(false);
  });

  it('small budget on a 1 MiB file', () => {
    const small = path.join(dir, 'small2.jsonl');
    const { count, size } = generate(small, MIB);
    const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache4') };
    const budget = 64 * 1024;
    const max = Math.ceil(size / budget) + 1;
    let done = false;
    for (let i = 0; i < max && !done; i++) {
      const { out, bytes } = readBytes(() => readTranscript(small, env, { budget }));
      expect(bytes).toBeLessThanOrEqual(budget + 64 * 1024);
      if (!out!.partial) {
        done = true;
        expect(out!.outputTokens).toBe(count * 20);
      }
    }
    expect(done).toBe(true);
  });

  it('reads a line longer than the budget through to its newline', () => {
    const file = path.join(dir, 'longline.jsonl');
    const budget = 64 * 1024;
    const filler = `{"type":"user","x":"${'x'.repeat(budget * 3)}"}\n`;
    fs.writeFileSync(file, line(1) + filler + line(2) + line(3));
    const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache-long') };
    let out = readTranscript(file, env, { budget });
    for (let i = 0; i < 6 && out?.partial; i++) out = readTranscript(file, env, { budget });
    expect(out!.partial).toBeFalsy();
    expect(out!.outputTokens).toBe(60);
  });
});
