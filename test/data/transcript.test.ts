import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTranscriptText, readTranscript } from '../../src/data/transcript.js';

const fixture = path.resolve(__dirname, '../fixtures/transcript.jsonl');
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tr-'));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('transcript parser', () => {
  it('dedupes streamed entries and sums usage', () => {
    const t = parseTranscriptText(fs.readFileSync(fixture, 'utf8'));
    expect(t.inputTokens).toBe(15);
    expect(t.outputTokens).toBe(150);
    expect(t.cacheWriteTokens).toBe(100);
    expect(t.cacheReadTokens).toBe(1000);
    expect(t.totalTokens).toBe(1265);
    expect(t.messageCount).toBe(2);
    expect(t.contextLength).toBe(1005);
  });

  it('reads commands, compactions, title and task', () => {
    const t = parseTranscriptText(fs.readFileSync(fixture, 'utf8'));
    expect(t.lastCommand).toBe('gsd-progress');
    expect(t.compactions).toBe(1);
    expect(t.sessionName).toBe('My session');
    expect(t.currentTask).toBe('Shipping it');
    expect(t.userMessageCount).toBe(3);
    expect(t.firstTimestamp).toBe(Date.parse('2026-10-12T10:00:00.000Z'));
  });

  it('computes output speed from timestamp deltas', () => {
    const t = parseTranscriptText(fs.readFileSync(fixture, 'utf8'));
    expect(t.outputSpeed).toBeGreaterThan(0);
  });

  it('records the newest real assistant message time', () => {
    const t = parseTranscriptText(fs.readFileSync(fixture, 'utf8'));
    expect(t.lastAssistantAt).toBe(Date.parse('2026-10-12T10:00:17.000Z'));
    const line = (o: object) => JSON.stringify(o);
    const usage = { input_tokens: 1, output_tokens: 1 };
    const text = [
      line({
        type: 'assistant',
        timestamp: '2026-10-12T11:00:00.000Z',
        message: { id: 'a', model: 'm', usage },
      }),
      line({
        type: 'assistant',
        timestamp: '2026-10-12T12:00:00.000Z',
        message: { id: 'b', model: '<synthetic>', usage },
      }),
      line({
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-10-12T13:00:00.000Z',
        message: { id: 'c', model: 'm', usage },
      }),
    ].join('\n');
    expect(parseTranscriptText(text).lastAssistantAt).toBe(Date.parse('2026-10-12T11:00:00.000Z'));
    expect(parseTranscriptText('').lastAssistantAt).toBeNull();
  });

  it('re-reads caches written by an older version', () => {
    const file = path.join(dir, 't.jsonl');
    fs.copyFileSync(fixture, file);
    expect(readTranscript(file, env)?.lastAssistantAt).toBe(Date.parse('2026-10-12T10:00:17.000Z'));
    const cdir = path.join(dir, 'cache');
    let old = 0;
    for (const name of fs.readdirSync(cdir)) {
      const f = path.join(cdir, name);
      const st = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!st || typeof st !== 'object' || typeof st.v !== 'number') continue;
      fs.writeFileSync(
        f,
        JSON.stringify({ ...st, v: st.v - 1, messageCount: 99, lastAssistantAt: undefined }),
      );
      old++;
    }
    expect(old).toBe(1);
    const again = readTranscript(file, env);
    expect(again?.messageCount).toBe(2);
    expect(again?.lastAssistantAt).toBe(Date.parse('2026-10-12T10:00:17.000Z'));
  });

  it('returns null for missing files', () => {
    expect(readTranscript(undefined, env)).toBeNull();
    expect(readTranscript(path.join(dir, 'nope.jsonl'), env)).toBeNull();
  });

  it('parses incrementally when the file grows', () => {
    const file = path.join(dir, 't.jsonl');
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    fs.writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`);
    const a = readTranscript(file, env)!;
    expect(a.messageCount).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'cache')).length).toBe(1);
    const half = lines[4]!.slice(0, 40);
    fs.appendFileSync(file, half);
    expect(readTranscript(file, env)!.messageCount).toBe(1);
    fs.appendFileSync(file, `${lines[4]!.slice(40)}\n${lines.slice(5).join('\n')}`);
    const b = readTranscript(file, env)!;
    expect(b).toEqual(parseTranscriptText(fs.readFileSync(fixture, 'utf8')));
  });

  it('reparses when the file shrinks', () => {
    const file = path.join(dir, 't.jsonl');
    fs.copyFileSync(fixture, file);
    expect(readTranscript(file, env)!.messageCount).toBe(2);
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    fs.writeFileSync(file, `${lines.slice(0, 4).join('\n')}\n`);
    expect(readTranscript(file, env)!.messageCount).toBe(1);
  });
});

describe('built-in commands', () => {
  it('tracks local commands and remembers the last GSD command', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-tr-'));
    const file = path.join(dir, 't.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: '<command-name>/gsd-plan-phase</command-name>' } },
      { type: 'system', subtype: 'local_command', content: '<command-name>/compact</command-name>' },
    ];
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const info = readTranscript(file, { ...process.env, CCINFOBAR_CACHE_DIR: dir });
    expect(info?.lastCommand).toBe('compact');
    expect(info?.lastGsdCommand).toBe('gsd-plan-phase');
  });
});

describe('transcript cache misses and response times', () => {
  const seq = path.resolve(__dirname, '../fixtures/cache-sequence.jsonl');
  const at = (t: string) => Date.parse(`2026-10-12T${t}Z`);
  const line = (o: object) => JSON.stringify(o);
  const reply = (ts: string, id: string, usage: object) =>
    line({
      type: 'assistant',
      timestamp: `2026-10-12T${ts}Z`,
      requestId: id,
      message: { id, model: 'm', usage },
    });
  const prompt = (ts: string, content: unknown) =>
    line({ type: 'user', timestamp: `2026-10-12T${ts}Z`, message: { role: 'user', content } });
  const usage = (input: number, read: number, write: number) => ({
    input_tokens: input,
    output_tokens: 5,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  });

  it('counts one miss and treats the request after a compaction as expected', () => {
    const t = parseTranscriptText(fs.readFileSync(seq, 'utf8'));
    expect(t.cacheMisses).toBe(1);
    expect(t.lastMissAt).toBe(at('10:01:02.600'));
    expect(t.messageCount).toBe(6);
  });

  it('times prompts to the first reply and skips wrappers, tool results and slow gaps', () => {
    const t = parseTranscriptText(fs.readFileSync(seq, 'utf8'));
    expect(t.responseCount).toBe(3);
    expect(t.responseMs).toBe(3200);
  });

  it('recomputes the outcome when a streamed line changes its usage', () => {
    const base = [
      reply('10:00:00.000', 'a', usage(50, 0, 20000)),
      reply('10:00:10.000', 'b', usage(100, 20000, 0)),
    ];
    const hitFirst = parseTranscriptText(
      [...base, reply('10:00:20.000', 'c', usage(100, 20000, 0))].join('\n'),
    );
    expect(hitFirst.cacheMisses).toBe(0);
    const updated = parseTranscriptText(
      [
        ...base,
        reply('10:00:20.000', 'c', usage(100, 20000, 0)),
        reply('10:00:21.000', 'c', usage(3200, 16900, 0)),
      ].join('\n'),
    );
    expect(updated.cacheMisses).toBe(1);
    expect(updated.lastMissAt).toBe(at('10:00:20.000'));
    const back = parseTranscriptText(
      [
        ...base,
        reply('10:00:20.000', 'c', usage(3200, 16900, 0)),
        reply('10:00:21.000', 'c', usage(100, 20000, 0)),
      ].join('\n'),
    );
    expect(back.cacheMisses).toBe(0);
    expect(back.lastMissAt).toBeNull();
  });

  it('leaves an older request alone when its key reappears', () => {
    const t = parseTranscriptText(
      [
        reply('10:00:00.000', 'a', usage(50, 0, 20000)),
        reply('10:00:10.000', 'b', usage(100, 20000, 0)),
        reply('10:00:20.000', 'a', usage(9000, 0, 0)),
      ].join('\n'),
    );
    expect(t.cacheMisses).toBe(0);
  });

  it('keeps the last 20 response times and skips zero gaps', () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      const m = String(i).padStart(2, '0');
      lines.push(
        prompt(`10:${m}:00.000`, 'go'),
        reply(`10:${m}:0${i < 5 ? 9 : 2}.000`, `r${i}`, usage(1, 0, 0)),
      );
    }
    lines.push(prompt('11:00:00.000', 'same'), reply('11:00:00.000', 'z', usage(1, 0, 0)));
    const t = parseTranscriptText(lines.join('\n'));
    expect(t.responseCount).toBe(20);
    expect(t.responseMs).toBe(2000);
  });

  it('has no response time without prompts', () => {
    const t = parseTranscriptText(reply('10:00:00.000', 'a', usage(1, 0, 0)));
    expect(t.responseMs).toBeNull();
    expect(t.responseCount).toBe(0);
    expect(t.cacheMisses).toBe(0);
  });

  it('re-reads a cache from the previous version from offset 0', () => {
    const file = path.join(dir, 's.jsonl');
    fs.copyFileSync(seq, file);
    expect(readTranscript(file, env)?.cacheMisses).toBe(1);
    const cdir = path.join(dir, 'cache');
    const [name] = fs.readdirSync(cdir);
    const f = path.join(cdir, name!);
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...st, v: st.v - 1, cacheMisses: undefined, responses: undefined }));
    const again = readTranscript(file, env);
    expect(again?.cacheMisses).toBe(1);
    expect(again?.responseMs).toBe(3200);
  });
});
