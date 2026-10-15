import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { readAgents } from '../../src/data/agents.js';
import type { HookAgent, HookState } from '../../src/data/hooks.js';
import { parseTranscriptText, type TranscriptInfo } from '../../src/data/transcript.js';
import { renderWidget } from '../helpers.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const line = (o: object) => JSON.stringify(o);
const iso = (ms: number) => new Date(ms).toISOString();
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-agents-hooks-'));
  dirs.push(dir);
  const transcript = path.join(dir, 'session.jsonl');
  const sub = path.join(dir, 'session', 'subagents');
  const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
  const add = (
    id: string,
    o: { type?: string; toolUseId?: string; first: number; last: number; mtime?: number },
  ) => {
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, `agent-${id}.meta.json`),
      line({ agentType: o.type ?? 'Explore', description: `do ${id}`, toolUseId: o.toolUseId }),
    );
    const jsonl = path.join(sub, `agent-${id}.jsonl`);
    fs.writeFileSync(
      jsonl,
      [
        line({ type: 'user', timestamp: iso(o.first), message: { content: 'go' } }),
        line({
          type: 'assistant',
          timestamp: iso(o.last),
          message: {
            id: `m-${id}`,
            model: 'claude-sonnet-5-5',
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      ].join('\n'),
    );
    const m = (o.mtime ?? o.last) / 1000;
    fs.utimesSync(jsonl, m, m);
  };
  return { dir, transcript, sub, env, add };
}

function info(over: Partial<TranscriptInfo> = {}): TranscriptInfo {
  return { ...parseTranscriptText(''), ...over };
}

function hooks(agents: Record<string, Partial<HookAgent>> = {}, turnStart: number | null = null): HookState {
  const map: Record<string, HookAgent> = Object.create(null);
  for (const [k, a] of Object.entries(agents))
    map[k] = { type: null, start: null, end: null, transcript: null, ...a };
  return {
    lastEventAt: null,
    lastSource: null,
    turn: turnStart === null ? null : { promptId: null, start: turnStart, end: null, durationMs: null },
    pendingPermission: null,
    lastPermission: null,
    agents: map,
  };
}

describe('readAgents without hooks (D-13)', () => {
  it('D-13: gives the same rows with no hooks, null and undefined', () => {
    const f = setup();
    f.add('a1', { toolUseId: 'toolu_1', first: NOW - 300_000, last: NOW - 120_000 });
    f.add('a2', { type: 'Plan', first: NOW - 100_000, last: NOW - 20_000 });
    f.add('a3', { type: 'general', first: NOW - 25 * 60_000, last: NOW - 20 * 60_000 });
    const i = info({
      agentCalls: [{ id: 'toolu_1', start: NOW - 300_000, done: null }],
      turnStart: NOW - 30 * 60_000,
    });
    const base = readAgents(f.transcript, i, NOW, f.env, { persist: false });
    expect(readAgents(f.transcript, i, NOW, f.env, { persist: false, hooks: null })).toEqual(base);
    expect(readAgents(f.transcript, i, NOW, f.env, { persist: false, hooks: undefined })).toEqual(base);
    expect(JSON.stringify(base)).toBe(
      `[${[
        `{"id":"a1","type":"Explore","description":"do a1","model":"claude-sonnet-5-5","input":10,"output":5,` +
          `"total":15,"fresh":15,"start":1792065300000,"last":1792065600000,"tool":"Read[a.ts]","running":true}`,
        `{"id":"a2","type":"Plan","description":"do a2","model":"claude-sonnet-5-5","input":10,"output":5,` +
          `"total":15,"fresh":15,"start":1792065500000,"last":1792065600000,"tool":"Read[a.ts]","running":true}`,
        `{"id":"a3","type":"general","description":"do a3","model":"claude-sonnet-5-5","input":10,"output":5,` +
          `"total":15,"fresh":15,"start":1792064100000,"last":1792064400000,"tool":"Read[a.ts]","running":false}`,
      ].join(',')}]`,
    );
  });

  it('D-13: a missing subagents dir is still empty', () => {
    const f = setup();
    expect(readAgents(f.transcript, info(), NOW, f.env, { hooks: null })).toEqual([]);
  });
});

describe('readAgents with hooks (D-12)', () => {
  const quiet = { first: NOW - 12 * 60_000, last: NOW - 11 * 60_000 };

  it('matches by id: start without end is running even when the file is quiet', () => {
    const f = setup();
    f.add('a1', quiet);
    const h = hooks({ a1: { type: 'Explore', start: NOW - 60_000 } });
    const [a, ...rest] = readAgents(f.transcript, info(), NOW, f.env, { hooks: h });
    expect(rest).toEqual([]);
    expect(a).toMatchObject({
      id: 'a1',
      type: 'Explore',
      running: true,
      start: NOW - 60_000,
      last: NOW,
      output: 5,
      tool: 'Read[a.ts]',
      description: 'do a1',
    });
  });

  it('matches by id: an end means done at the end time', () => {
    const f = setup();
    f.add('a1', quiet);
    const h = hooks({ a1: { type: 'Explore', start: NOW - 60_000, end: NOW - 5_000 } });
    const [a] = readAgents(f.transcript, info(), NOW, f.env, { hooks: h });
    expect(a).toMatchObject({ id: 'a1', running: false, start: NOW - 60_000, last: NOW - 5_000 });
  });

  it('matches by transcript basename and never opens the hook path', () => {
    const f = setup();
    f.add('a1', quiet);
    const read = vi.spyOn(fs, 'readFileSync');
    const stat = vi.spyOn(fs, 'statSync');
    const h = hooks({ zz: { type: 'Other', start: NOW - 60_000, transcript: '/x/y/agent-a1.jsonl' } });
    const rows = readAgents(f.transcript, info(), NOW, f.env, { hooks: h });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a1', type: 'Other', running: true });
    const touched = [...read.mock.calls, ...stat.mock.calls].map((c) => String(c[0]));
    expect(touched.some((p) => p.startsWith('/x/y'))).toBe(false);
  });

  it('matches by type and start within 5 s', () => {
    const f = setup();
    f.add('a1', { ...quiet, type: 'Explore' });
    const h = hooks({ q9: { type: 'Explore', start: quiet.first + 4_000 } });
    const rows = readAgents(f.transcript, info(), NOW, f.env, { hooks: h });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a1', running: true, start: quiet.first + 4_000 });
  });

  it('does not match by type 6 s apart', () => {
    const f = setup();
    f.add('a1', { type: 'Explore', first: NOW - 50_000, last: NOW - 10_000 });
    const h = hooks({ q9: { type: 'Explore', start: NOW - 44_000 } });
    const rows = readAgents(f.transcript, info(), NOW, f.env, { hooks: h });
    expect(rows).toHaveLength(2);
    const meta = rows.find((r) => r.id === 'a1')!;
    expect(meta).toMatchObject({ running: true, start: NOW - 50_000 });
    expect(rows.find((r) => r.id === 'q9')).toMatchObject({ running: true, total: 0, description: '' });
  });

  it('shows a started agent without a meta file as running with no tokens', () => {
    const f = setup();
    const h = hooks({ b2: { type: 'Plan', start: NOW - 2_000 } });
    expect(readAgents(f.transcript, info(), NOW, f.env, { hooks: h })).toEqual([
      {
        id: 'b2',
        type: 'Plan',
        description: '',
        model: null,
        input: 0,
        output: 0,
        total: 0,
        fresh: 0,
        start: NOW - 2_000,
        last: NOW,
        tool: null,
        running: true,
      },
    ]);
  });

  it('treats a running hook agent older than 2 h as done', () => {
    const f = setup();
    f.add('a1', { first: NOW - 3 * 3_600_000, last: NOW - 3 * 3_600_000 + 60_000 });
    const h = hooks({
      a1: { type: 'Explore', start: NOW - 3 * 3_600_000 },
      b2: { type: 'Plan', start: NOW - 3 * 3_600_000 },
    });
    const rows = readAgents(f.transcript, info({ turnStart: NOW - 4 * 3_600_000 }), NOW, f.env, {
      hooks: h,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a1', running: false });
  });

  it('keeps the heuristics for unmatched meta agents', () => {
    const f = setup();
    f.add('a1', { first: NOW - 100_000, last: NOW - 10_000 });
    f.add('a2', { toolUseId: 'toolu_2', ...quiet });
    f.add('a3', { first: NOW - 100_000, last: NOW - 60_000 });
    const i = info({
      agentCalls: [{ id: 'toolu_2', start: quiet.first, done: null }],
      turnStart: NOW - 30 * 60_000,
    });
    const h = hooks({ other: { type: 'Nope', start: NOW - 1_000_000, end: NOW - 900_000 } });
    const rows = readAgents(f.transcript, i, NOW, f.env, { hooks: h });
    const by = Object.fromEntries(rows.map((r) => [r.id, r.running]));
    expect(by).toEqual({ a1: true, a2: true, a3: false });
  });

  it('scopes done agents to opts.turnStart', () => {
    const f = setup();
    f.add('a1', { first: NOW - 400_000, last: NOW - 300_000 });
    f.add('a2', { first: NOW - 400_000, last: NOW - 300_000 });
    f.add('a3', { first: NOW - 50_000, last: NOW - 40_000 });
    const i = info({ turnStart: NOW - 30 * 60_000 });
    const h = hooks({ a2: { type: 'Explore', start: NOW - 400_000, end: NOW - 290_000 } });
    const all = readAgents(f.transcript, i, NOW, f.env, { hooks: h });
    expect(all.map((r) => r.id).sort()).toEqual(['a1', 'a2', 'a3']);
    const scoped = readAgents(f.transcript, i, NOW, f.env, { hooks: h, turnStart: NOW - 60_000 });
    expect(scoped.map((r) => r.id)).toEqual(['a3']);
  });

  it('trusts a finished transcript call over a hook agent without SubagentStop', () => {
    const f = setup();
    f.add('a1', { toolUseId: 'toolu_1', ...quiet });
    const h = hooks({ a1: { type: 'Explore', start: NOW - 60_000 } });
    const i = (done: number | null) => info({ agentCalls: [{ id: 'toolu_1', start: NOW - 60_000, done }] });
    expect(readAgents(f.transcript, i(null), NOW, f.env, { hooks: h })[0]?.running).toBe(true);
    expect(readAgents(f.transcript, i(NOW - 30_000), NOW, f.env, { hooks: h })[0]?.running).toBe(false);
  });

  it('drops an unmatched hook agent from an earlier turn', () => {
    const f = setup();
    const h = hooks({
      old: { type: 'Plan', start: NOW - 600_000 },
      cur: { type: 'Plan', start: NOW - 5_000 },
    });
    const rows = readAgents(f.transcript, info(), NOW, f.env, { hooks: h, turnStart: NOW - 60_000 });
    expect(rows.map((r) => r.id)).toEqual(['cur']);
    expect(
      readAgents(f.transcript, info(), NOW, f.env, { hooks: h })
        .map((r) => r.id)
        .sort(),
    ).toEqual(['cur', 'old']);
  });

  it('sanitizes hook agent types', () => {
    const f = setup();
    f.add('a1', quiet);
    const h = hooks({
      a1: { type: '\u001b[31mExplore', start: NOW - 1_000 },
      b2: { type: '\u001b[31mPlan\u0007', start: NOW - 1_000 },
    });
    const rows = readAgents(f.transcript, info(), NOW, f.env, { hooks: h });
    expect(rows.map((r) => r.type).sort()).toEqual(['Explore', 'Plan']);
  });
});

describe('createContext agents with hooks', () => {
  it('renders agent-count from the hook-backed list', () => {
    const f = setup();
    f.add('a1', { first: NOW - 100_000, last: NOW - 60_000 });
    const h = hooks(
      {
        a1: { type: 'Explore', start: NOW - 100_000, end: NOW - 50_000 },
        b2: { type: 'Plan', start: NOW - 3_000 },
      },
      NOW - 120_000,
    );
    const ctx = createContext({
      payload: { session_id: 's1', transcript_path: f.transcript, cwd: f.dir },
      config: defaultConfig(),
      env: f.env,
      now: new Date(NOW),
      data: { hooks: () => h, transcript: () => info({ turnStart: NOW - 30_000 }) },
    });
    expect(renderWidget('agent-count', ctx)).toBe('1 running · 1 done');
  });

  it('keeps the transcript turn without hooks', () => {
    const f = setup();
    f.add('a1', { first: NOW - 100_000, last: NOW - 60_000 });
    const ctx = createContext({
      payload: { session_id: 's1', transcript_path: f.transcript, cwd: f.dir },
      config: defaultConfig(),
      env: f.env,
      now: new Date(NOW),
      data: { hooks: () => null, transcript: () => info({ turnStart: NOW - 30_000 }) },
    });
    expect(renderWidget('agent-count', ctx)).toBeNull();
  });
});
