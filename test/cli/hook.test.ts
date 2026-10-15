import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  type HookDeps,
  pruneHookLogs,
  readHookStdin,
  readUpdateSetting,
  runHook,
  scanFields,
} from '../../src/cli/hook.js';
import { readStdinStream } from '../../src/cli/hook-stream.js';
import { configPath } from '../../src/core/paths.js';
import { HOOK_EVENTS, hookLine, hookLogPath, hooksDir, isHookEvent } from '../../src/data/hooks.js';
import { appendLine } from '../../src/data/store.js';
import { useIdleEntry } from '../helpers.js';

const env = { CCINFOBAR_CACHE_DIR: path.join('/tmp', 'ccib-hook-unit') } as NodeJS.ProcessEnv;
const SID = 'abc_DEF-1';

function deps(text: string | null, argv = ['hook', 'Stop'], overflow = false) {
  const calls: Array<[string, string]> = [];
  const d: HookDeps = {
    argv,
    readStdin: async () => (text === null ? null : { text, overflow }),
    env,
    now: () => 1000,
    append: (file, line) => {
      calls.push([file, line]);
      return true;
    },
  };
  return { d, calls };
}

const body = (o: Record<string, unknown>) => JSON.stringify({ session_id: SID, ...o });

describe('hookLine', () => {
  it('keeps only the allowed fields per event', () => {
    const noise = {
      prompt: 'SECRET',
      last_assistant_message: 'SECRET',
      tool_input: { command: 'rm' },
      message: 'SECRET',
      extra: 'x',
    };
    const all = {
      ...noise,
      source: 'startup',
      prompt_id: 'p',
      stop_hook_active: true,
      agent_id: 'a1',
      agent_type: 'Explore',
      agent_transcript_path: '/t.jsonl',
      notification_type: 'idle_prompt',
      tool_name: 'Bash',
    };
    const keys = (e: (typeof HOOK_EVENTS)[number]) => Object.keys(hookLine(e, all, 5)).sort();
    expect(keys('SessionStart')).toEqual(['e', 's', 't', 'v']);
    expect(keys('UserPromptSubmit')).toEqual(['e', 'p', 't', 'v']);
    expect(keys('Stop')).toEqual(['e', 'p', 'sa', 't', 'v']);
    expect(keys('SubagentStart')).toEqual(['a', 'at', 'e', 't', 'v']);
    expect(keys('SubagentStop')).toEqual(['a', 'at', 'e', 't', 'tp', 'v']);
    expect(keys('Notification')).toEqual(['e', 'n', 't', 'v']);
    expect(keys('PermissionRequest')).toEqual(['e', 't', 'tn', 'v']);
    for (const e of HOOK_EVENTS) expect(JSON.stringify(hookLine(e, all, 5))).not.toContain('SECRET');
    expect(hookLine('Stop', all, 5)).toEqual({ v: 1, t: 5, e: 'Stop', p: 'p', sa: true });
  });

  it('drops fields of the wrong type', () => {
    expect(hookLine('Stop', { prompt_id: 42, stop_hook_active: 'yes' }, 1)).toEqual({
      v: 1,
      t: 1,
      e: 'Stop',
    });
  });

  it('sanitizes and caps strings', () => {
    const l = hookLine('SubagentStop', { agent_id: 'a\u001b[31mb\u0007c', agent_type: 'x'.repeat(300) }, 1);
    expect(l.a).toBe('abc');
    expect(l.at).toHaveLength(256);
    expect(hookLine('SubagentStop', { agent_transcript_path: 'p'.repeat(2000) }, 1).tp).toHaveLength(1024);
  });

  it('keeps the largest line under 4 KB', () => {
    const big = 'é'.repeat(5000);
    const l = hookLine(
      'SubagentStop',
      { agent_id: big, agent_type: big, agent_transcript_path: big },
      Number.MAX_SAFE_INTEGER,
    );
    expect(Buffer.byteLength(JSON.stringify(l))).toBeLessThan(4096);
  });

  it('knows the allowlist', () => {
    expect(isHookEvent('Stop')).toBe(true);
    expect(isHookEvent('PreToolUse')).toBe(false);
    expect(isHookEvent(1)).toBe(false);
  });
});

describe('hookLogPath', () => {
  it('accepts safe ids only', () => {
    expect(hookLogPath(SID, env)?.endsWith(path.join('hooks', `${SID}.jsonl`))).toBe(true);
    for (const bad of ['../x', '', 'a b', 'é', 'a'.repeat(129)]) expect(hookLogPath(bad, env)).toBeNull();
  });
});

describe('runHook', () => {
  it('prefers the stdin event over argv', async () => {
    const { d, calls } = deps(body({ hook_event_name: 'UserPromptSubmit', prompt_id: 'p1' }), [
      '--config',
      'x',
      'hook',
      'Stop',
    ]);
    await runHook(d);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(hookLogPath(SID, env));
    expect(JSON.parse(calls[0]![1])).toEqual({ v: 1, t: 1000, e: 'UserPromptSubmit', p: 'p1' });
  });

  it('falls back to the argv event', async () => {
    const { d, calls } = deps(body({ prompt_id: 'p1' }), ['hook', 'Stop']);
    await runHook(d);
    expect(JSON.parse(calls[0]![1]).e).toBe('Stop');
  });

  it('ignores unknown events', async () => {
    for (const [text, argv] of [
      [body({ hook_event_name: 'PreToolUse' }), ['hook', 'Stop']],
      [body({}), ['hook', 'Foo']],
      [body({}), ['Stop']],
    ] as const) {
      const { d, calls } = deps(text, [...argv]);
      await runHook(d);
      expect(calls).toHaveLength(0);
    }
  });

  it('ignores invalid session ids', async () => {
    for (const sid of ['../x', 42, 'a'.repeat(129)]) {
      const { d, calls } = deps(JSON.stringify({ session_id: sid, hook_event_name: 'Stop' }));
      await runHook(d);
      expect(calls).toHaveLength(0);
    }
  });

  it('ignores malformed, empty, array and missing input', async () => {
    for (const text of ['{"session_id":', '', '[1,2]', 'null', '"x"', null]) {
      const { d, calls } = deps(text);
      await runHook(d);
      expect(calls).toHaveLength(0);
    }
  });

  it('never throws when the append fails', async () => {
    for (const code of ['ENOSPC', 'EACCES']) {
      const { d } = deps(body({ hook_event_name: 'Stop' }));
      d.append = () => {
        throw Object.assign(new Error(code), { code });
      };
      await expect(runHook(d)).resolves.toBeUndefined();
    }
    const { d } = deps(body({ hook_event_name: 'Stop' }));
    d.append = () => false;
    await expect(runHook(d)).resolves.toBeUndefined();
  });

  it('never throws when the stdin read rejects', async () => {
    const { d, calls } = deps('');
    d.readStdin = () => Promise.reject(new Error('boom'));
    await expect(runHook(d)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('records an oversized input from the bounded scan', async () => {
    const text = `{"session_id":"${SID}","hook_event_name":"UserPromptSubmit","prompt_id":"p9","prompt":"${'x'.repeat(1_200_000)}`;
    const { d, calls } = deps(text, ['hook', 'UserPromptSubmit'], true);
    await runHook(d);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]![1])).toEqual({ v: 1, t: 1000, e: 'UserPromptSubmit', p: 'p9' });
  });

  it('takes prompt_id from the tail when it follows a huge prompt', async () => {
    const head = `{"session_id":"${SID}","hook_event_name":"UserPromptSubmit","prompt":"${'x'.repeat(100)}`;
    const { d, calls } = deps(head, ['hook', 'UserPromptSubmit'], true);
    d.readStdin = async () => ({
      text: head,
      overflow: true,
      tail: `xxxx","prompt_id":"p7","session_id":"tail-loses"}`,
    });
    await runHook(d);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain(SID);
    expect(JSON.parse(calls[0]![1])).toMatchObject({ e: 'UserPromptSubmit', p: 'p7' });
  });
});

describe('scanFields', () => {
  it('never picks escaped keys inside strings', () => {
    const text = `{"prompt":"a \\"session_id\\":\\"evil\\" b","session_id":"real","hook_event_name":"Stop"}`;
    expect(JSON.parse(text).prompt).toContain('"session_id":"evil"');
    expect(scanFields(text)).toEqual({ session_id: 'real', hook_event_name: 'Stop' });
  });

  it('keeps the first match and scans only the head', () => {
    expect(scanFields('{"source":"a","source":"b"}')).toEqual({ source: 'a' });
    expect(scanFields(`{"x":"${'y'.repeat(70_000)}","session_id":"late"}`)).toEqual({});
  });
});

describe('readHookStdin', () => {
  // fake fd reads: each item is one read result
  const reader = (items: Array<string | NodeJS.ErrnoException | null>, calls: number[] = []) => {
    return (buf: Buffer, cb: (err: NodeJS.ErrnoException | null, n: number) => void) => {
      calls.push(1);
      const it = items.shift();
      if (it === undefined) return; // never answers
      setImmediate(() => {
        if (it === null) return cb(null, 0);
        if (typeof it !== 'string') return cb(it, 0);
        const n = buf.write(it);
        cb(null, n);
      });
    };
  };
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('returns the text at EOF', async () => {
    expect(await readHookStdin(1024, 1000, reader(['{"a":', '1}', null]), () => false)).toEqual({
      text: '{"a":1}',
      overflow: false,
    });
  });

  it('treats EPIPE and EOF errors as the end', async () => {
    expect(await readHookStdin(1024, 1000, reader(['x', err('EPIPE')]), () => false)).toEqual({
      text: 'x',
      overflow: false,
    });
  });

  it('retries EAGAIN', async () => {
    expect(await readHookStdin(1024, 1000, reader([err('EAGAIN'), 'ok', null]), () => false)).toEqual({
      text: 'ok',
      overflow: false,
    });
  });

  it('resolves at the deadline when stdin never ends', async () => {
    const start = Date.now();
    expect(await readHookStdin(1024, 50, reader(['par']), () => false)).toEqual({
      text: 'par',
      overflow: false,
    });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('caps the kept bytes and keeps draining', async () => {
    const calls: number[] = [];
    const r = reader(['0123456789abc', 'more', 'tail', null], calls);
    expect(await readHookStdin(10, 1000, r, () => false)).toEqual({
      text: '0123456789',
      overflow: true,
      tail: 'abcmoretail',
    });
    expect(calls).toHaveLength(4);
  });

  it('stops at a complete object without waiting for EOF', async () => {
    const calls: number[] = [];
    const r = reader(['{"session_id":', '"x"}\n'], calls);
    expect(await readHookStdin(1024, 5000, r, () => false)).toEqual({
      text: '{"session_id":"x"}\n',
      overflow: false,
    });
    expect(calls).toHaveLength(2);
  });

  it('returns null for a TTY without reading', async () => {
    const calls: number[] = [];
    expect(await readHookStdin(1024, 1000, reader(['x'], calls), () => true)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('readStdinStream (Windows)', () => {
  it('returns the text when the stream ends', async () => {
    const s = new PassThrough();
    const p = readStdinStream(s, 1024, 1000);
    s.write('{"a":');
    s.end('1}');
    expect(await p).toEqual({ text: '{"a":1}', overflow: false });
  });

  it('resolves at the deadline when the stream never ends', async () => {
    const s = new PassThrough();
    const start = Date.now();
    const p = readStdinStream(s, 1024, 50);
    s.write('par');
    expect(await p).toEqual({ text: 'par', overflow: false });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('caps the kept bytes and keeps draining', async () => {
    const s = new PassThrough();
    const p = readStdinStream(s, 10, 1000);
    s.write('0123456789abc');
    s.write('more');
    expect(s.listenerCount('data')).toBe(1);
    s.end('tail');
    expect(await p).toEqual({ text: '0123456789', overflow: true, tail: 'abcmoretail' });
    expect(s.listenerCount('data')).toBe(1);
  });

  it('returns null for a TTY', async () => {
    const s = Object.assign(new PassThrough(), { isTTY: true });
    expect(await readStdinStream(s)).toBeNull();
  });
});

const DAY = 86_400_000;
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hook-ss-unit-')));
const start = (source?: unknown) => body({ hook_event_name: 'SessionStart', source });

function wired(text: string | null, argv = ['hook', 'SessionStart']) {
  const { d, calls } = deps(text, argv);
  const order: string[] = [];
  const scheduled: Array<[string, string]> = [];
  const pruned: Array<[string, string[], number]> = [];
  const reasons: string[] = [];
  const append = d.append;
  d.append = (f, l) => {
    order.push('append');
    return append(f, l);
  };
  d.schedule = (sid, file) => {
    order.push('schedule');
    scheduled.push([sid, file]);
  };
  d.prune = (dir, keep, now) => {
    order.push('prune');
    pruned.push([dir, keep, now]);
    return 0;
  };
  d.debug = (r) => reasons.push(r);
  return { d, calls, order, scheduled, pruned, reasons };
}

describe('SessionStart trigger', () => {
  it('schedules and prunes only on source startup, after the append', async () => {
    const w = wired(start('startup'));
    await runHook(w.d);
    expect(w.order).toEqual(['append', 'prune', 'schedule']);
    expect(w.scheduled).toEqual([[SID, configPath(env)]]);
    expect(w.pruned).toEqual([[hooksDir(env), [`${SID}.jsonl`, `${SID}.fold.json`], 1000]]);
    expect(w.reasons).toEqual(['scheduled']);
  });

  it('never schedules on other sources or other events', async () => {
    for (const text of [
      start('resume'),
      start('clear'),
      start('compact'),
      start('fork'),
      start(),
      start(1),
      start('startup '),
      body({ hook_event_name: 'Stop', source: 'startup' }),
    ]) {
      const w = wired(text);
      await runHook(w.d);
      expect(w.calls).toHaveLength(1);
      expect(w.scheduled).toEqual([]);
      expect(w.pruned).toEqual([]);
    }
  });

  it('passes the resolved --config flag given before hook', async () => {
    const w = wired(start('startup'), ['--config', 'rel/c.json', 'hook', 'SessionStart']);
    await runHook(w.d);
    expect(w.scheduled[0]![1]).toBe(path.resolve('rel/c.json'));
    const v = wired(start('startup'), ['hook', 'SessionStart', '--config', 'x.json']);
    await runHook(v.d);
    expect(v.scheduled[0]![1]).toBe(configPath(env));
  });

  it('never lets a throwing schedule, prune or debug escape', async () => {
    const w = wired(start('startup'));
    w.d.prune = () => {
      throw new Error('p');
    };
    w.d.schedule = () => Promise.reject(new Error('s'));
    await expect(runHook(w.d)).resolves.toBeUndefined();
    const v = wired(start('startup'));
    v.d.debug = () => {
      throw new Error('d');
    };
    v.d.schedule = () => {
      throw new Error('s');
    };
    await expect(runHook(v.d)).resolves.toBeUndefined();
    expect(v.calls).toHaveLength(1);
  });

  it('reports fixed reasons for early returns', async () => {
    const cases: Array<[string | null, string]> = [
      [null, 'tty'],
      ['', 'no-input'],
      ['{', 'bad-json'],
      [body({ hook_event_name: 'PreToolUse' }), 'unknown-event'],
      [JSON.stringify({ session_id: '../x', hook_event_name: 'Stop' }), 'bad-session'],
    ];
    for (const [text, reason] of cases) {
      const w = wired(text);
      await runHook(w.d);
      expect(w.reasons).toEqual([reason]);
    }
    const w = wired(body({ hook_event_name: 'Stop' }));
    w.d.append = () => false;
    await runHook(w.d);
    expect(w.reasons).toEqual(['append-failed']);
  });
});

describe('debug log', () => {
  const run = async (e: NodeJS.ProcessEnv) => {
    const d: HookDeps = {
      argv: ['hook', 'Stop'],
      readStdin: async () => ({
        text: JSON.stringify({ session_id: '../SECRET', hook_event_name: 'Stop', prompt: 'SECRET' }),
        overflow: false,
      }),
      env: e,
      now: () => Date.UTC(2026, 0, 2),
      append: appendLine,
    };
    await runHook(d);
  };

  it('writes a reason line only under CCINFOBAR_DEBUG', async () => {
    const dir = tmp();
    await run({ CCINFOBAR_CACHE_DIR: dir, CCINFOBAR_DEBUG: '1' });
    const log = path.join(dir, 'hooks', 'debug.log');
    expect(fs.readFileSync(log, 'utf8')).toBe('2026-01-02T00:00:00.000Z bad-session\n');
    const quiet = tmp();
    await run({ CCINFOBAR_CACHE_DIR: quiet });
    expect(fs.existsSync(path.join(quiet, 'hooks', 'debug.log'))).toBe(false);
  });

  it('stops writing once debug.log passes 256 KB', async () => {
    const dir = tmp();
    const log = path.join(dir, 'hooks', 'debug.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, 'x'.repeat(262_145));
    await run({ CCINFOBAR_CACHE_DIR: dir, CCINFOBAR_DEBUG: '1' });
    expect(fs.statSync(log).size).toBe(262_145);
  });
});

describe('readUpdateSetting', () => {
  it('reads only the update key', () => {
    const dir = tmp();
    const file = (name: string, text: string) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, text);
      return f;
    };
    expect(readUpdateSetting(path.join(dir, 'missing.json'))).toBe('auto');
    expect(readUpdateSetting(file('a.json', '{"update":"off"}'))).toBe('off');
    expect(readUpdateSetting(file('b.json', '{"update":"notify"}'))).toBe('notify');
    expect(readUpdateSetting(file('c.json', '\uFEFF{"update":"off"}'))).toBe('off');
    expect(readUpdateSetting(file('d.json', '{"update": 3}'))).toBe('auto');
    expect(readUpdateSetting(file('e.json', '[1]'))).toBe('auto');
    expect(readUpdateSetting(file('f.json', 'not json'))).toBeNull();
    expect(readUpdateSetting(dir)).toBeNull();
  });
});

describe('default schedule', () => {
  useIdleEntry();
  const run = async (extra: NodeJS.ProcessEnv, config?: string) => {
    const dir = tmp();
    const e: NodeJS.ProcessEnv = {
      CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'),
      CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
      ...extra,
    };
    if (config !== undefined) {
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'config', 'config.json'), config);
    }
    await runHook({
      argv: ['hook', 'SessionStart'],
      readStdin: async () => ({ text: start('startup'), overflow: false }),
      env: e,
      now: Date.now,
      append: appendLine,
    });
    return fs.existsSync(path.join(dir, 'cache', 'jobs', 'update.lock'));
  };

  it('takes the update lock on startup', async () => {
    expect(await run({})).toBe(true);
  });

  it('honours the traffic and update opt-outs (D-03)', async () => {
    expect(await run({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })).toBe(false);
    expect(await run({ CI: '1' })).toBe(false);
    expect(await run({ CCINFOBAR_NO_UPDATE: '1' })).toBe(false);
    expect(await run({}, '{"update":"off"}')).toBe(false);
    expect(await run({}, '{"update":')).toBe(false);
  });
});

describe('pruneHookLogs', () => {
  const now = Date.UTC(2026, 5, 1);
  const make = (dir: string, name: string, days: number) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '{}\n');
    const t = (now - days * DAY) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };

  it('removes only old session logs and fold caches', () => {
    const dir = tmp();
    const old = make(dir, 'a.jsonl', 8);
    const oldFold = make(dir, 'a.fold.json', 8);
    const fresh = make(dir, 'b.jsonl', 6);
    const kept = make(dir, 'me.jsonl', 30);
    const keptFold = make(dir, 'me.fold.json', 30);
    const debug = make(dir, 'debug.log', 30);
    const other = make(dir, 'notes.json', 30);
    fs.mkdirSync(path.join(dir, 'd.jsonl'));
    expect(pruneHookLogs(dir, ['me.jsonl', 'me.fold.json'], now, 7 * DAY, 200, 10_000)).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldFold)).toBe(false);
    for (const f of [fresh, kept, keptFold, debug, other, path.join(dir, 'd.jsonl')]) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it('stops after maxRemove deletions and tolerates a missing dir', () => {
    const dir = tmp();
    for (let i = 0; i < 10; i++) make(dir, `s${i}.jsonl`, 9);
    expect(pruneHookLogs(dir, [], now, 7 * DAY, 4, 10_000)).toBe(4);
    expect(fs.readdirSync(dir)).toHaveLength(6);
    expect(pruneHookLogs(path.join(dir, 'missing'), [], now)).toBe(0);
  });

  it('reaches old files behind many fresh ones', () => {
    const dir = tmp();
    for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(dir, `f${i}.jsonl`), '');
    const old = make(dir, 'zz-old.jsonl', 9);
    expect(pruneHookLogs(dir, [], Date.now(), 7 * DAY, 200, 10_000)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('stops at the time budget', () => {
    const dir = tmp();
    for (let i = 0; i < 10; i++) make(dir, `s${i}.jsonl`, 9);
    let c = 0;
    expect(pruneHookLogs(dir, [], now, 7 * DAY, 200, 15, () => (c += 10))).toBe(1);
  });
});
