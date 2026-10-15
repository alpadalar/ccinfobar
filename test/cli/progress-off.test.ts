import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHook } from '../../src/cli/hook.js';
import { syncProgress } from '../../src/cli/progress.js';
import { defaultConfig } from '../../src/core/config.js';
import { setProgress } from '../../src/core/edit.js';
import type { StatusPayload } from '../../src/core/types.js';
import { progressFiles, readWant } from '../../src/data/progress.js';
import { requestClear } from '../../src/data/progress-clear.js';
import { writeSmall } from '../../src/data/store.js';
import { ctxWith } from '../helpers.js';

const SID = 'off-sess';
const CLEAR = '\u001b]9;4;0;\u0007';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'progress-off-'));
  const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'), WT_SESSION: '1' } as NodeJS.ProcessEnv;
  const out: string[] = [];
  const hook = (event = 'UserPromptSubmit', sid = SID) =>
    runHook({
      argv: ['--progress', 'hook', event],
      readStdin: async () => ({
        text: JSON.stringify({ session_id: sid, hook_event_name: event }),
        overflow: false,
      }),
      env,
      now: () => 1000,
      append: () => true,
      debug: () => {},
      writeOut: (s) => out.push(s),
    });
  const seqs = () => out.map((l) => (JSON.parse(l) as { terminalSequence: string }).terminalSequence);
  return { env, hook, seqs };
}

const payload = (sid = SID) =>
  ({
    session_id: sid,
    context_window: { context_window_size: 200_000, used_percentage: 72 },
  }) as StatusPayload;

describe('turning progress off clears the bar (D-36)', () => {
  it('an editor toggle keeps the key, so the next render and hook event clear once', async () => {
    const s = sandbox();
    const on = setProgress(defaultConfig(), { enabled: true });
    syncProgress(ctxWith({ payload: payload(), config: on, env: s.env }), s.env, 'linux');
    await s.hook();
    const off = setProgress(on, { enabled: false });
    expect(off.progress).toEqual({ enabled: false });
    expect(
      syncProgress(ctxWith({ payload: payload(), config: off, env: s.env }), s.env, 'linux').changed,
    ).toBe(true);
    await s.hook('Stop');
    await s.hook('UserPromptSubmit');
    expect(s.seqs()).toEqual(['\u001b]9;4;4;72\u0007', CLEAR]);
  });

  it('requestClear flips every live want and counts hook bars still showing', async () => {
    const s = sandbox();
    const want = (sid: string, o: Record<string, unknown>) =>
      writeSmall(
        progressFiles(sid, s.env)!.want,
        JSON.stringify({ v: 1, state: 4, pct: 60, channel: 'hook', always: false, ...o }),
      );
    want('shown', {});
    await s.hook('Stop', 'shown');
    want('never-sent', {});
    want('tty', { channel: 'tty' });
    want('cleared', { state: 0, pct: 0 });
    expect(requestClear(s.env)).toBe(1);
    for (const sid of ['shown', 'never-sent', 'tty', 'cleared'])
      expect(readWant(progressFiles(sid, s.env)!.want)).toMatchObject({ state: 0, pct: 0 });
    expect(readWant(progressFiles('tty', s.env)!.want)?.channel).toBe('tty');
    expect(requestClear(s.env)).toBe(0);
    await s.hook('Stop', 'shown');
    expect(s.seqs()).toEqual(['\u001b]9;4;4;60\u0007', CLEAR]);
  });

  it('requestClear does nothing without a hooks dir', () => {
    const env = { CCINFOBAR_CACHE_DIR: path.join(process.env.CCIB_TEST_ROOT!, 'no-such-cache') };
    expect(requestClear(env)).toBe(0);
  });
});
