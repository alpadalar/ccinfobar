import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { type HookDeps, readHookStdin, runHook, scanFields } from '../../src/cli/hook.js';
import { HOOK_EVENTS, hookLine, hookLogPath, isHookEvent } from '../../src/data/hooks.js';

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
  it('returns the text when the stream ends', async () => {
    const s = new PassThrough();
    const p = readHookStdin(s, 1024, 1000);
    s.write('{"a":');
    s.end('1}');
    expect(await p).toEqual({ text: '{"a":1}', overflow: false });
  });

  it('resolves at the deadline when the stream never ends', async () => {
    const s = new PassThrough();
    const start = Date.now();
    const p = readHookStdin(s, 1024, 50);
    s.write('par');
    expect(await p).toEqual({ text: 'par', overflow: false });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('caps the kept bytes and keeps draining', async () => {
    const s = new PassThrough();
    const p = readHookStdin(s, 10, 1000);
    s.write('0123456789abc');
    s.write('more');
    expect(s.listenerCount('data')).toBe(1);
    s.end('tail');
    expect(await p).toEqual({ text: '0123456789', overflow: true });
    expect(s.listenerCount('data')).toBe(1);
  });

  it('returns null for a TTY', async () => {
    const s = Object.assign(new PassThrough(), { isTTY: true });
    expect(await readHookStdin(s)).toBeNull();
  });
});
