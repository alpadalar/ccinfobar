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

describe('transcript tool activity', () => {
  const T0 = Date.parse('2026-10-12T10:00:00Z');
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const line = (o: object) => JSON.stringify(o);
  const usage = { input_tokens: 1, output_tokens: 1 };
  const prompt = (s: number, text: string, promptId?: string) =>
    line({ type: 'user', timestamp: at(s), ...(promptId ? { promptId } : {}), message: { content: text } });
  const use = (s: number, id: string, name: string, input: object = {}, extra: object = {}) =>
    line({
      type: 'assistant',
      timestamp: at(s),
      ...extra,
      message: {
        id: `m_${id}`,
        model: 'claude-opus-4',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name, input }],
        usage,
      },
    });
  const result = (s: number, id: string, promptId?: string) =>
    line({
      type: 'user',
      timestamp: at(s),
      ...(promptId ? { promptId } : {}),
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
  const reply = (s: number, stop: string | null) =>
    line({
      type: 'assistant',
      timestamp: at(s),
      message: {
        id: `r${s}`,
        model: 'claude-opus-4',
        stop_reason: stop,
        content: [{ type: 'text', text: 'x' }],
        usage,
      },
    });
  const parse = (lines: string[]) => parseTranscriptText(lines.join('\n'));

  it('tracks running tools and turn counts', () => {
    const t = parse([
      prompt(0, 'go', 'p1'),
      use(1, 't1', 'Read', { file_path: '/a/b/c.ts' }),
      result(2, 't1', 'p1'),
      use(3, 't2', 'Bash', { command: 'npm test' }),
    ]);
    expect(t.runningTools).toEqual([{ id: 't2', name: 'Bash', arg: 'npm test', start: T0 + 3000 }]);
    expect(t.turnToolCounts).toEqual([
      ['Read', 1],
      ['Bash', 1],
    ]);
    expect(t.lastToolResultAt).toBe(T0 + 2000);
    expect(t.toolResultTimes).toEqual([T0 + 2000]);
    expect(t.promptId).toBe('p1');
    expect(t.promptStart).toBe(T0);
    expect(t.turnEnd).toBeNull();
  });

  it('keeps the last tool result times in order, once per timestamp', () => {
    const lines = [prompt(0, 'go', 'p1')];
    for (let i = 1; i <= 70; i++) lines.push(use(i, `t${i}`, 'Read'), result(i, `t${i}`), result(i, `t${i}`));
    const t = parse(lines);
    expect(t.toolResultTimes).toHaveLength(64);
    expect(t.toolResultTimes[0]).toBe(T0 + 7000);
    expect(t.toolResultTimes[63]).toBe(T0 + 70_000);
  });

  it('masks secrets in the running tool argument', () => {
    const arg = (command: string) =>
      parse([prompt(0, 'go', 'p1'), use(1, 't1', 'Bash', { command })]).runningTools[0]?.arg;
    expect(arg('export GITHUB_TOKEN=ghp_abcdef123')).toBe('export GITHUB_TOKEN=…');
    expect(arg('curl -H "auth: Bearer sk-abc123456"')).toBe('curl -H "auth: Bearer …"');
    expect(arg('mysql --password=hunter2 db')).toBe('mysql --password=… db');
    expect(arg('git clone https://me:pw@host/x')).toBe('git clone https://me:…@host/x');
    expect(arg('npm test -- --reporter=dot')).toBe('npm test -- --reporter=dot');
  });

  it('counts a streamed rewrite of the same tool_use once', () => {
    const t = parse([prompt(0, 'go', 'p1'), use(1, 't1', 'Bash'), use(1, 't1', 'Bash')]);
    expect(t.turnToolCounts).toEqual([['Bash', 1]]);
    expect(t.runningTools).toHaveLength(1);
  });

  it('resets turn counts and running tools on a new prompt', () => {
    const t = parse([
      prompt(0, 'go', 'p1'),
      use(1, 't1', 'Read'),
      use(2, 't2', 'Bash'),
      prompt(10, 'next', 'p2'),
      use(11, 't3', 'Edit'),
      result(12, 't3', 'p2'),
    ]);
    expect(t.turnToolCounts).toEqual([['Edit', 1]]);
    expect(t.sessionToolCounts).toEqual([
      ['Read', 1],
      ['Bash', 1],
      ['Edit', 1],
    ]);
    expect(t.runningTools).toEqual([]);
    expect(t.promptStart).toBe(T0 + 10_000);
  });

  it('starts a turn by the pendingPrompt rule without prompt ids', () => {
    const t = parse([
      prompt(0, 'go'),
      use(1, 't1', 'Read'),
      result(2, 't1'),
      prompt(5, 'again'),
      use(6, 't2', 'Bash'),
    ]);
    expect(t.turnToolCounts).toEqual([['Bash', 1]]);
    expect(t.promptStart).toBe(T0 + 5000);
  });

  it('does not reset turn counts on a tool result', () => {
    const t = parse([
      prompt(0, 'go', 'p1'),
      use(1, 't1', 'Read'),
      result(2, 't1', 'p9'),
      use(3, 't2', 'Read'),
    ]);
    expect(t.turnToolCounts).toEqual([['Read', 2]]);
    expect(t.lastToolResultAt).toBe(T0 + 2000);
    expect(t.promptStart).toBe(T0);
  });

  it('ends the turn on an interrupt marker without starting a new one', () => {
    const t = parse([
      prompt(0, 'go', 'p1'),
      use(1, 't1', 'Bash'),
      prompt(4, '[Request interrupted by user for tool use]', 'p1'),
    ]);
    expect(t.runningTools).toEqual([]);
    expect(t.turnEnd).toBe(T0 + 4000);
    expect(t.turnToolCounts).toEqual([['Bash', 1]]);
    expect(t.promptStart).toBe(T0);
    expect(t.turnStart).toBe(T0 + 4000);
  });

  it('ends the turn on turn_duration after the prompt', () => {
    const sys = (s: number) =>
      line({ type: 'system', subtype: 'turn_duration', durationMs: 1, timestamp: at(s) });
    expect(parse([prompt(0, 'go', 'p1'), use(1, 't1', 'Read'), sys(3)]).turnEnd).toBe(T0 + 3000);
    expect(parse([sys(-5), prompt(0, 'go', 'p1'), use(1, 't1', 'Read')]).turnEnd).toBeNull();
  });

  it('ends the turn on a final stop_reason only', () => {
    expect(parse([prompt(0, 'go', 'p1'), reply(2, 'end_turn')]).turnEnd).toBe(T0 + 2000);
    expect(parse([prompt(0, 'go', 'p1'), reply(2, 'max_tokens')]).turnEnd).toBe(T0 + 2000);
    expect(parse([prompt(0, 'go', 'p1'), use(2, 't1', 'Bash')]).turnEnd).toBeNull();
    expect(parse([prompt(0, 'go', 'p1'), reply(2, 'end_turn'), use(3, 't1', 'Bash')]).turnEnd).toBeNull();
    expect(parse([prompt(0, 'go', 'p1'), reply(2, 'end_turn'), prompt(5, 'more', 'p2')]).turnEnd).toBeNull();
  });

  it('ignores sidechain tools', () => {
    const t = parse([prompt(0, 'go', 'p1'), use(1, 's1', 'Grep', {}, { isSidechain: true })]);
    expect(t.turnToolCounts).toEqual([]);
    expect(t.sessionToolCounts).toEqual([]);
    expect(t.runningTools).toEqual([]);
  });

  it('stores a short, safe argument', () => {
    const arg = (input: object) => parse([use(1, 't1', 'X', input)]).runningTools[0]?.arg;
    const long = arg({ command: 'a'.repeat(200) })!;
    expect([...long]).toHaveLength(32);
    expect(long.endsWith('…')).toBe(true);
    expect(arg({ file_path: '/a/b/c.ts' })).toBe('c.ts');
    expect(arg({ path: 'C:\\src\\lib\\' })).toBe('lib');
    expect(arg({ pattern: 'x', command: 'npm  run\n test' })).toBe('npm run test');
    expect(arg({ command: 'echo \u001b[2Jhi' })).not.toContain('\u001b');
    expect(arg({ other: 'x' })).toBe('');
    expect(arg({ command: 5, query: 'q' })).toBe('q');
  });

  it('counts a tool named __proto__ as a plain tuple', () => {
    const t = parse([use(1, 't1', '__proto__'), use(2, 't2', 'constructor')]);
    expect(t.sessionToolCounts).toEqual([
      ['__proto__', 1],
      ['constructor', 1],
    ]);
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('keeps the 50 highest counts and the newest 8 running tools', () => {
    const lines: string[] = [];
    let n = 0;
    for (let i = 10; i < 60; i++) {
      for (let k = 0; k < 2; k++) lines.push(use(n, `c${n++}`, `T${i}`));
    }
    for (let i = 0; i < 10; i++) lines.push(use(n, `c${n++}`, `T0${i}`));
    const t = parse(lines);
    expect(t.sessionToolCounts).toHaveLength(50);
    expect(t.sessionToolCounts.every(([, c]) => c === 2)).toBe(true);
    expect(t.sessionToolCounts.some(([name]) => name.startsWith('T0'))).toBe(false);
    const par = parse(Array.from({ length: 12 }, (_, i) => use(1, `p${i}`, 'Bash')));
    expect(par.runningTools.map((r) => r.id)).toEqual(['p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11']);
  });

  it('refolds a cache from the previous version', () => {
    const file = path.join(dir, 'tools.jsonl');
    fs.writeFileSync(
      file,
      `${[prompt(0, 'go', 'p1'), use(1, 't1', 'Read'), result(2, 't1', 'p1')].join('\n')}\n`,
    );
    expect(readTranscript(file, env)?.turnToolCounts).toEqual([['Read', 1]]);
    const cdir = path.join(dir, 'cache');
    const [name] = fs.readdirSync(cdir);
    const f = path.join(cdir, name!);
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(
      f,
      JSON.stringify({ ...st, v: st.v - 1, sessionTools: [['Fake', 99]], turnTools: undefined }),
    );
    const again = readTranscript(file, env);
    expect(again?.sessionToolCounts).toEqual([['Read', 1]]);
    expect(again?.turnToolCounts).toEqual([['Read', 1]]);
  });
});
