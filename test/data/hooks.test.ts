import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foldHookLog, readHookState } from '../../src/data/hooks.js';

type L = Record<string, unknown>;
const j = (o: L) => JSON.stringify({ v: 1, ...o });
const ups = (t: number, p?: string) => j({ t, e: 'UserPromptSubmit', ...(p ? { p } : {}) });
const stop = (t: number, p?: string, sa?: boolean) =>
  j({ t, e: 'Stop', ...(p ? { p } : {}), ...(sa === undefined ? {} : { sa }) });
const sStart = (t: number, a: string, at?: string) => j({ t, e: 'SubagentStart', a, ...(at ? { at } : {}) });
const sStop = (t: number, a: string, tp?: string) => j({ t, e: 'SubagentStop', a, ...(tp ? { tp } : {}) });

let dir: string;
let env: NodeJS.ProcessEnv;
const SID = 'sess-1';
const log = () => path.join(dir, 'cache', 'hooks', `${SID}.jsonl`);
const foldFile = () => path.join(dir, 'cache', 'hooks', `${SID}.fold.json`);
function writeLog(text: string) {
  fs.mkdirSync(path.dirname(log()), { recursive: true });
  fs.writeFileSync(log(), text);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hk-'));
  env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache') };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('foldHookLog turns', () => {
  it('pairs a prompt with its Stop', () => {
    const s = foldHookLog([ups(1000, 'p1'), stop(4000, 'p1')]);
    expect(s.turn).toEqual({ promptId: 'p1', start: 1000, end: 4000, durationMs: 3000 });
  });

  it('pairs by prompt id when Stop is written first', () => {
    const s = foldHookLog([stop(4000, 'p1'), ups(1000, 'p1')]);
    expect(s.turn).toEqual({ promptId: 'p1', start: 1000, end: 4000, durationMs: 3000 });
  });

  it('ignores a duplicate Stop within 2 s', () => {
    const s = foldHookLog([ups(1000, 'p1'), stop(4000, 'p1'), stop(4500, 'p1')]);
    expect(s.turn).toEqual({ promptId: 'p1', start: 1000, end: 4000, durationMs: 3000 });
  });

  it('extends the turn on a continuation Stop', () => {
    const s = foldHookLog([ups(1000, 'p1'), stop(4000, 'p1'), stop(9000, 'p1', true)]);
    expect(s.turn).toEqual({ promptId: 'p1', start: 1000, end: 9000, durationMs: 8000 });
  });

  it('reports the running turn', () => {
    const s = foldHookLog([ups(1000, 'p1'), stop(4000, 'p1'), ups(10000, 'p2')]);
    expect(s.turn).toEqual({ promptId: 'p2', start: 10000, end: null, durationMs: null });
  });

  it('pairs by order without prompt ids', () => {
    const s = foldHookLog([ups(1000), stop(3000)]);
    expect(s.turn).toEqual({ promptId: null, start: 1000, end: 3000, durationMs: 2000 });
  });

  it('has no turn for an empty log', () => {
    const s = foldHookLog([]);
    expect(s.turn).toBeNull();
    expect(s.lastEventAt).toBeNull();
    expect(s.pendingPermission).toBeNull();
    expect(Object.keys(s.agents)).toEqual([]);
  });
});

describe('foldHookLog agents', () => {
  it('ignores a duplicate SubagentStart and marks the stop', () => {
    const s = foldHookLog([
      sStart(1000, 'a1', 'Explore'),
      sStart(1500, 'a1', 'Explore'),
      sStop(5000, 'a1', '/t/a1.jsonl'),
    ]);
    expect(Object.keys(s.agents)).toEqual(['a1']);
    expect(s.agents.a1).toEqual({ type: 'Explore', start: 1000, end: 5000, transcript: '/t/a1.jsonl' });
  });

  it('records a SubagentStop with no start', () => {
    const s = foldHookLog([sStop(5000, 'a2')]);
    expect(s.agents.a2).toEqual({ type: null, start: null, end: 5000, transcript: null });
  });

  it('keeps the newest 100 agents', () => {
    const lines = Array.from({ length: 130 }, (_, i) => sStart(1000 + i * 3000, `a${i}`));
    const s = foldHookLog(lines);
    const ids = Object.keys(s.agents);
    expect(ids).toHaveLength(100);
    expect(s.agents.a29).toBeUndefined();
    expect(s.agents.a30).toBeDefined();
    expect(s.agents.a129).toBeDefined();
  });
});

describe('foldHookLog permission and session', () => {
  it('sets pending permission and fills the tool', () => {
    const a = foldHookLog([ups(1000, 'p1'), j({ t: 2000, e: 'Notification', n: 'permission_prompt' })]);
    expect(a.pendingPermission).toEqual({ since: 2000, tool: null });
    const b = foldHookLog([
      ups(1000, 'p1'),
      j({ t: 2000, e: 'Notification', n: 'permission_prompt' }),
      j({ t: 2100, e: 'PermissionRequest', tn: 'Bash' }),
    ]);
    expect(b.pendingPermission).toEqual({ since: 2000, tool: 'Bash' });
  });

  it('clears pending permission on Stop', () => {
    const s = foldHookLog([
      ups(1000, 'p1'),
      j({ t: 2100, e: 'PermissionRequest', tn: 'Bash' }),
      stop(6000, 'p1'),
    ]);
    expect(s.pendingPermission).toBeNull();
  });

  it('clears pending permission on UserPromptSubmit and SessionStart', () => {
    const perm = j({ t: 2000, e: 'Notification', n: 'permission_prompt' });
    expect(foldHookLog([perm, ups(5000, 'p2')]).pendingPermission).toBeNull();
    expect(foldHookLog([perm, j({ t: 5000, e: 'SessionStart', s: 'clear' })]).pendingPermission).toBeNull();
  });

  it('does not set pending permission on idle_prompt', () => {
    const s = foldHookLog([j({ t: 2000, e: 'Notification', n: 'idle_prompt' })]);
    expect(s.pendingPermission).toBeNull();
  });

  it('records the last SessionStart source and event time', () => {
    const s = foldHookLog([
      j({ t: 1000, e: 'SessionStart', s: 'startup' }),
      ups(8000, 'p1'),
      j({ t: 5000, e: 'SessionStart', s: 'resume' }),
    ]);
    expect(s.lastSource).toBe('resume');
    expect(s.lastEventAt).toBe(8000);
  });
});

describe('foldHookLog hostile input', () => {
  it('skips malformed lines without throwing', () => {
    const lines = [
      'not json',
      '{"v":1,"t":',
      '[1,2,3]',
      'null',
      '42',
      j({ t: 1000, e: 'PreToolUse' }),
      '{"v":1,"t":"1000","e":"Stop","p":"p1"}',
      '{"v":1,"t":1e999,"e":"Stop","p":"p1"}',
      j({ t: 1000, e: 'UserPromptSubmit', p: 42 }),
      ups(1000, 'p1'),
    ];
    const s = foldHookLog(lines);
    expect(s.turn).toEqual({ promptId: 'p1', start: 1000, end: null, durationMs: null });
    expect(s.lastEventAt).toBe(1000);
  });

  it('ignores __proto__ keys and ids', () => {
    const s = foldHookLog([
      '{"__proto__":{"polluted":1},"v":1,"t":1000,"e":"SubagentStart","a":"__proto__"}',
      sStart(1000, 'constructor'),
      sStop(2000, '__proto__'),
      sStart(3000, 'ok'),
    ]);
    expect(Object.getPrototypeOf(s.agents)).toBeNull();
    expect(Object.keys(s.agents)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('strips control characters from stored strings', () => {
    const s = foldHookLog([sStart(1000, 'a1', 'Ex\u001b[31mplore\u0007')]);
    expect(s.agents.a1?.type).toBe('Explore');
  });
});

describe('readHookState', () => {
  it('returns null for an invalid session id or a missing log', () => {
    expect(readHookState('../etc', env)).toBeNull();
    expect(readHookState('', env)).toBeNull();
    expect(readHookState(SID, env)).toBeNull();
  });

  it('folds only complete lines and picks up the rest later', () => {
    const tail = stop(4000, 'p1');
    writeLog(`${ups(1000, 'p1')}\n${tail.slice(0, 10)}`);
    const a = readHookState(SID, env);
    expect(a?.turn).toEqual({ promptId: 'p1', start: 1000, end: null, durationMs: null });
    fs.appendFileSync(log(), `${tail.slice(10)}\n`);
    const b = readHookState(SID, env);
    expect(b?.turn).toEqual({ promptId: 'p1', start: 1000, end: 4000, durationMs: 3000 });
  });

  it('reads nothing when no bytes were added', () => {
    writeLog(`${j({ t: 1000, e: 'SessionStart', s: 'startup' })}\n`);
    expect(readHookState(SID, env)?.lastSource).toBe('startup');
    const cache = JSON.parse(fs.readFileSync(foldFile(), 'utf8'));
    expect(cache.offset).toBe(fs.statSync(log()).size);
    cache.state.lastSource = 'cached';
    fs.writeFileSync(foldFile(), JSON.stringify(cache));
    expect(readHookState(SID, env)?.lastSource).toBe('cached');
    expect(JSON.parse(fs.readFileSync(foldFile(), 'utf8')).offset).toBe(cache.offset);
  });

  it('refolds from 0 when the log was truncated', () => {
    writeLog(`${ups(1000, 'p1')}\n${stop(4000, 'p1')}\n${ups(10000, 'p2')}\n`);
    expect(readHookState(SID, env)?.turn?.promptId).toBe('p2');
    writeLog(`${ups(20000, 'p9')}\n`);
    expect(readHookState(SID, env)?.turn).toEqual({
      promptId: 'p9',
      start: 20000,
      end: null,
      durationMs: null,
    });
  });

  it('refolds when the cache is damaged or from another version', () => {
    writeLog(`${ups(1000, 'p1')}\n${stop(4000, 'p1')}\n`);
    expect(readHookState(SID, env)?.turn?.durationMs).toBe(3000);
    fs.writeFileSync(foldFile(), '{"v":');
    expect(readHookState(SID, env)?.turn?.durationMs).toBe(3000);
    const cache = JSON.parse(fs.readFileSync(foldFile(), 'utf8'));
    fs.writeFileSync(foldFile(), JSON.stringify({ ...cache, v: -1, state: { turns: 'x' } }));
    expect(readHookState(SID, env)?.turn?.durationMs).toBe(3000);
    fs.writeFileSync(
      foldFile(),
      JSON.stringify({ ...cache, state: { turns: [['p1', 'x', {}]], agents: 5 } }),
    );
    expect(() => readHookState(SID, env)).not.toThrow();
  });

  it('never writes the fold cache with persist false', () => {
    writeLog(`${ups(1000, 'p1')}\n`);
    expect(readHookState(SID, env, { persist: false })?.turn?.promptId).toBe('p1');
    expect(fs.existsSync(foldFile())).toBe(false);
  });

  it('writes the fold cache with mode 0600', () => {
    writeLog(`${ups(1000, 'p1')}\n`);
    readHookState(SID, env);
    if (process.platform !== 'win32') expect(fs.statSync(foldFile()).mode & 0o777).toBe(0o600);
  });

  it('dedupes across reads', () => {
    writeLog(`${sStart(1000, 'a1')}\n`);
    readHookState(SID, env);
    fs.appendFileSync(log(), `${sStart(1200, 'a1')}\n${ups(1300, 'p1')}\n${stop(4000, 'p1')}\n`);
    fs.appendFileSync(log(), `${stop(4100, 'p1')}\n`);
    const s = readHookState(SID, env);
    expect(Object.keys(s?.agents ?? {})).toEqual(['a1']);
    expect(s?.agents.a1?.start).toBe(1000);
    expect(s?.turn?.end).toBe(4000);
  });

  it('keeps the newest 50 keyed turns in the fold cache', () => {
    const lines: string[] = [];
    for (let i = 0; i < 70; i++) lines.push(ups(1000 + i * 10000, `p${i}`), stop(5000 + i * 10000, `p${i}`));
    writeLog(`${lines.join('\n')}\n`);
    const s = readHookState(SID, env);
    expect(s?.turn?.promptId).toBe('p69');
    const turns: unknown[][] = JSON.parse(fs.readFileSync(foldFile(), 'utf8')).state.turns;
    expect(turns).toHaveLength(50);
    const ids = turns.map((x) => x[0]);
    expect(ids).toContain('p69');
    expect(ids).toContain('p20');
    expect(ids).not.toContain('p19');
  });

  it('never throws on a directory in place of the log', () => {
    fs.mkdirSync(log(), { recursive: true });
    expect(readHookState(SID, env)).toBeNull();
  });
});
