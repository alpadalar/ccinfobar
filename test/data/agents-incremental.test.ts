import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_BUDGET, agentsCacheName, readAgents } from '../../src/data/agents.js';
import { cacheFile } from '../../src/data/cache.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function run(name: string, input: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-agents-inc-'));
  dirs.push(dir);
  const transcript = path.join(dir, 'session.jsonl');
  const sub = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(sub, 'a1.meta.json'),
    JSON.stringify({ agentType: 'Bash', description: 'd', toolUseId: 't1' }),
  );
  const jsonl = path.join(sub, 'a1.jsonl');
  const now = Date.now();
  fs.writeFileSync(
    jsonl,
    `${JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now).toISOString(),
      message: {
        id: 'm1',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', name, input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })}\n`,
  );
  const env = { ...process.env, CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
  const rows = readAgents(transcript, null, now, env);
  return { rows, jsonl, env };
}

describe('agents argument masking', () => {
  it('masks secrets in the row and the cache file', () => {
    const { rows, jsonl, env } = run('Bash', {
      command: "curl -H 'Authorization: Bearer sk-abcdef123456' https://u:pw@host/x?token=abc",
    });
    expect(rows).toHaveLength(1);
    const tool = rows[0]!.tool!;
    expect(tool.startsWith('Bash[')).toBe(true);
    for (const bad of ['sk-abcdef', 'pw@', 'token=abc']) expect(tool).not.toContain(bad);
    expect(tool).toContain('Bearer …');
    const file = cacheFile(agentsCacheName(jsonl), env);
    expect(path.basename(file).startsWith('agent3-')).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    for (const bad of ['sk-abcdef', 'pw@', 'token=abc']) expect(text).not.toContain(bad);
  });

  it('shows the basename of file_path', () => {
    const { rows } = run('Read', { file_path: '/home/u/secret/dir/file.ts' });
    expect(rows[0]!.tool).toBe('Read[file.ts]');
  });

  it('hides URL credentials', () => {
    const { rows } = run('WebFetch', { url: 'https://user:secret@example.com/path' });
    expect(rows[0]!.tool).not.toContain('secret@');
  });
});

const NOW = Date.now();

function line(i: number, extra = ''): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date(NOW).toISOString(),
    message: {
      id: `m${i}`,
      model: 'claude-sonnet-5-5',
      content: [],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    note: extra,
  })}\n`;
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-agents-inc-'));
  dirs.push(dir);
  const transcript = path.join(dir, 'session.jsonl');
  const sub = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const add = (id: string, body: string) => {
    fs.writeFileSync(path.join(sub, `${id}.meta.json`), JSON.stringify({ agentType: 'Bash', toolUseId: id }));
    fs.writeFileSync(path.join(sub, `${id}.jsonl`), body);
  };
  const touchDir = (ms: number) => {
    const t = new Date(ms);
    fs.utimesSync(sub, t, t);
  };
  const env = { ...process.env, CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
  const read = () => readAgents(transcript, null, NOW, env);
  return { sub, add, touchDir, read, jsonl: (id: string) => path.join(sub, `${id}.jsonl`) };
}

const opensOf = (spy: { mock: { calls: unknown[][] } }, file: string) =>
  spy.mock.calls.filter((c) => c[0] === file).length;

describe('incremental reads', () => {
  it('reads only the appended bytes', () => {
    const f = fixture();
    f.add('a1', line(1) + line(2));
    expect(f.read()[0]!.total).toBe(30);
    const more = line(3);
    fs.appendFileSync(f.jsonl('a1'), more);
    const rs = vi.spyOn(fs, 'readSync');
    const rf = vi.spyOn(fs, 'readFileSync');
    expect(f.read()[0]!.total).toBe(45);
    const read = rs.mock.results.reduce((a, r) => a + (r.value as number), 0);
    expect(read).toBeLessThanOrEqual(Buffer.byteLength(more) + 256 + 1024);
    expect(rf.mock.calls.some((c) => String(c[0]).endsWith('.jsonl'))).toBe(false);
  });

  it('reads each meta once per directory mtime', () => {
    const f = fixture();
    f.add('a1', line(1));
    f.touchDir(NOW - 60_000);
    f.read();
    const rf = vi.spyOn(fs, 'readFileSync');
    f.read();
    f.read();
    expect(rf.mock.calls.filter((c) => String(c[0]).endsWith('.meta.json'))).toHaveLength(0);
  });

  it('lists a new agent after the directory mtime changes', () => {
    const f = fixture();
    f.add('a1', line(1));
    f.touchDir(NOW - 60_000);
    expect(f.read()).toHaveLength(1);
    f.add('a2', line(2));
    f.touchDir(NOW - 30_000);
    expect(f.read()).toHaveLength(2);
  });

  it('resets on truncation and on a replaced head', () => {
    const f = fixture();
    f.add('a1', line(1) + line(2) + line(3));
    expect(f.read()[0]!.total).toBe(45);
    fs.writeFileSync(f.jsonl('a1'), line(4));
    expect(f.read()[0]!.total).toBe(15);
    const same = line(5, 'x').length;
    fs.writeFileSync(f.jsonl('a1'), line(6, 'y'.repeat(same - line(6, '').length)));
    expect(f.read()[0]!.total).toBe(15);
  });

  it('bounds bytes per render and converges to a no-open hit', () => {
    const f = fixture();
    const pad = 'p'.repeat(1000);
    let body = '';
    let n = 0;
    while (body.length < 3 * 1024 * 1024) body += line(n++, pad);
    f.add('a1', body);
    const rs = vi.spyOn(fs, 'readSync');
    const first = f.read();
    const bytes = rs.mock.results.reduce((a, r) => a + (r.value as number), 0);
    expect(bytes).toBeLessThanOrEqual(AGENT_BUDGET + 1024 * 1024);
    expect(first[0]!.total).toBeLessThan(n * 15);
    for (let i = 0; i < 5; i++) f.read();
    expect(f.read()[0]!.total).toBe(n * 15);
    const open = vi.spyOn(fs, 'openSync');
    f.read();
    expect(opensOf(open, f.jsonl('a1'))).toBe(0);
  });

  it('reaches the no-open hit for a file without a trailing newline', () => {
    const f = fixture();
    f.add('a1', line(1) + line(2).trimEnd());
    expect(f.read()[0]!.total).toBe(30);
    f.read();
    const open = vi.spyOn(fs, 'openSync');
    expect(f.read()[0]!.total).toBe(30);
    expect(opensOf(open, f.jsonl('a1'))).toBe(0);
  });

  it('rebuilds a legacy agent3 summary without v', () => {
    const f = fixture();
    f.add('a1', line(1) + line(2));
    const env = { ...process.env, CCINFOBAR_CACHE_DIR: path.join(path.dirname(f.sub), '..', 'cache') };
    const size = fs.statSync(f.jsonl('a1')).size;
    fs.mkdirSync(path.dirname(cacheFile(agentsCacheName(f.jsonl('a1')), env)), { recursive: true });
    fs.writeFileSync(
      cacheFile(agentsCacheName(f.jsonl('a1')), env),
      JSON.stringify({
        size,
        model: 'x',
        input: 999,
        output: 999,
        total: 9999,
        fresh: 1,
        first: 1,
        last: 1,
        tool: null,
      }),
    );
    expect(f.read()[0]!.total).toBe(30);
    const saved = JSON.parse(fs.readFileSync(cacheFile(agentsCacheName(f.jsonl('a1')), env), 'utf8'));
    expect(saved.v).toBe(1);
  });
});

describe('budget exhaustion', () => {
  it('does not stamp a grown file complete when the render budget ran out', () => {
    const f = fixture();
    const pad = 'p'.repeat(1000);
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    for (const id of ids) f.add(id, line(0, pad));
    for (let i = 0; i < 3; i++) f.read();
    let more = '';
    let n = 1;
    while (more.length < 1.2 * 1024 * 1024) more += line(n++, pad);
    for (const id of ids) fs.appendFileSync(f.jsonl(id), more);
    // five agents want 1 MiB each, the render budget is 4 MiB
    f.read();
    let rows = f.read();
    for (let i = 0; i < 10; i++) rows = f.read();
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.total).toBe(n * 15);
  });
});

describe('long lines', () => {
  it('reads a line far past the remaining budget in a few large chunks', () => {
    const f = fixture();
    const MIB = 1024 * 1024;
    const blob = (bytes: number) => `{"x":"${'x'.repeat(bytes - 9)}"}\n`;
    const lines = (bytes: number) => blob(1000).repeat(Math.ceil(bytes / 1000));
    for (const id of ['a1', 'a2', 'a3']) f.add(id, lines(MIB + 4096));
    // leaves 200 bytes of the render budget for the last agent
    f.add('a4', blob(MIB - 200));
    f.add('a5', blob(2 * MIB));
    const orig = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...a: unknown[]) =>
      (orig as (...x: unknown[]) => string[])(...a).sort()) as typeof fs.readdirSync);
    const rs = vi.spyOn(fs, 'readSync');
    expect(f.read()).toHaveLength(5);
    expect(rs.mock.calls.length).toBeLessThan(200);
  });
});
