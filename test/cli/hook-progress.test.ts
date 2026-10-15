import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type HookDeps, pruneHookLogs, runHook } from '../../src/cli/hook.js';
import { progressFiles, readSent, SEQ_BODY_RE } from '../../src/data/progress.js';
import { writeSmall } from '../../src/data/store.js';

const SID = 'prog_SID-1';
const ARGV = ['--progress', 'hook', 'UserPromptSubmit'];

function sandbox(extra: NodeJS.ProcessEnv = { WT_SESSION: '1' }) {
  const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'hook-progress-'));
  const env = { CCINFOBAR_CACHE_DIR: path.join(dir, 'cache'), ...extra } as NodeJS.ProcessEnv;
  const files = progressFiles(SID, env)!;
  const want = (o: Record<string, unknown> = {}) =>
    writeSmall(files.want, JSON.stringify({ v: 1, state: 4, pct: 72, channel: 'hook', always: false, ...o }));
  const out: string[] = [];
  const appended: string[] = [];
  const reasons: string[] = [];
  let scheduled = 0;
  const run = (text: string | null, argv = ARGV, over: Partial<HookDeps> = {}) =>
    runHook({
      argv,
      readStdin: async () => (text === null ? null : { text, overflow: false }),
      env,
      now: () => 1000,
      append: (_f, l) => {
        appended.push(l);
        return true;
      },
      schedule: () => {
        scheduled++;
      },
      debug: (r) => {
        reasons.push(r);
      },
      writeOut: (s) => out.push(s),
      ...over,
    });
  return { dir, env, files, want, out, appended, reasons, run, scheduled: () => scheduled };
}

const input = (event = 'UserPromptSubmit', sid: unknown = SID) =>
  JSON.stringify({ session_id: sid, hook_event_name: event, prompt: 'SECRET' });

const seqOf = (line: string) => (JSON.parse(line) as { terminalSequence: string }).terminalSequence;

describe('runHook --progress', () => {
  it('writes exactly one terminalSequence line and records it', async () => {
    const s = sandbox();
    s.want();
    await s.run(input());
    expect(s.out).toEqual(['{"terminalSequence":"\\u001b]9;4;4;72\\u0007"}\n']);
    const seq = seqOf(s.out[0]!);
    expect(seq).toBe('\u001b]9;4;4;72\u0007');
    expect(seq.slice(4, -1)).toMatch(SEQ_BODY_RE);
    expect(readSent(s.files.sent)).toEqual({ state: 4, pct: 72 });
    expect(s.appended).toEqual([]);
    expect(s.scheduled()).toBe(0);
    expect(s.reasons).toEqual(['emitted']);
  });

  it('prints nothing when the state is unchanged', async () => {
    const s = sandbox();
    s.want();
    await s.run(input());
    await s.run(input());
    expect(s.out).toHaveLength(1);
    expect(s.reasons.at(-1)).toBe('unchanged');
  });

  it('sends the clear form once after a non-zero state', async () => {
    const s = sandbox();
    s.want();
    await s.run(input());
    s.want({ state: 0, pct: 0 });
    await s.run(input('Stop'));
    await s.run(input('Stop'));
    expect(s.out.map(seqOf)).toEqual(['\u001b]9;4;4;72\u0007', '\u001b]9;4;0;\u0007']);
  });

  it('accepts Stop and StopFailure, ignores other events', async () => {
    for (const [event, n] of [
      ['Stop', 1],
      ['StopFailure', 1],
      ['SessionStart', 0],
      ['Notification', 0],
    ] as const) {
      const s = sandbox();
      s.want();
      await s.run(input(event), ['--progress', 'hook', event]);
      expect(s.out, event).toHaveLength(n);
      expect(s.appended).toEqual([]);
    }
  });

  it('takes the event from argv when stdin has none', async () => {
    const s = sandbox();
    s.want();
    await s.run(JSON.stringify({ session_id: SID }), ['--progress', 'hook', 'StopFailure']);
    expect(s.out).toHaveLength(1);
  });

  it('honours the terminal allowlist and always', async () => {
    const s = sandbox({ TERM_PROGRAM: 'xterm' });
    s.want();
    await s.run(input());
    expect(s.out).toEqual([]);
    expect(s.reasons).toEqual(['terminal']);
    s.want({ always: true });
    await s.run(input());
    expect(s.out).toHaveLength(1);
  });

  it('prints nothing for the tty channel', async () => {
    const s = sandbox();
    s.want({ channel: 'tty' });
    await s.run(input());
    expect(s.out).toEqual([]);
    expect(s.reasons).toEqual(['channel']);
  });

  it('prints nothing and never throws on bad input', async () => {
    const cases: Array<[string, string | null, (s: ReturnType<typeof sandbox>) => void]> = [
      ['malformed', '{"session_id": "x", ', (s) => s.want()],
      ['empty', '', (s) => s.want()],
      ['tty', null, (s) => s.want()],
      ['bad session', input('UserPromptSubmit', '../x'), (s) => s.want()],
      ['numeric session', input('UserPromptSubmit', 7), (s) => s.want()],
      ['no want', input(), () => {}],
      ['broken want', input(), (s) => writeSmall(s.files.want, '{nope')],
      ['invalid want', input(), (s) => s.want({ state: 3, pct: 500 })],
    ];
    for (const [name, text, setup] of cases) {
      const s = sandbox();
      setup(s);
      await expect(s.run(text), name).resolves.toBeUndefined();
      expect(s.out, name).toEqual([]);
      expect(s.appended, name).toEqual([]);
    }
  });

  it('prints nothing when the cache dir is a regular file', async () => {
    const s = sandbox();
    const file = path.join(s.dir, 'not-a-dir');
    fs.writeFileSync(file, '');
    s.env.CCINFOBAR_CACHE_DIR = file;
    await expect(s.run(input())).resolves.toBeUndefined();
    expect(s.out).toEqual([]);
  });

  it('survives a throwing writer without marking sent', async () => {
    const s = sandbox();
    s.want();
    await s.run(input(), ARGV, {
      writeOut: () => {
        throw new Error('EPIPE');
      },
    });
    expect(readSent(s.files.sent)).toBeNull();
    expect(s.reasons).toEqual(['write-failed']);
  });

  it('prints nothing without a writer', async () => {
    const s = sandbox();
    s.want();
    await s.run(input(), ARGV, { writeOut: undefined });
    expect(readSent(s.files.sent)).toBeNull();
  });

  it('ignores --progress after the event', async () => {
    const s = sandbox();
    s.want();
    await s.run(input(), ['hook', 'UserPromptSubmit', '--progress']);
    expect(s.out).toEqual([]);
    expect(s.appended).toHaveLength(1);
  });

  it('leaves StopFailure unknown without --progress', async () => {
    const s = sandbox();
    s.want();
    await s.run(input('StopFailure'), ['hook', 'StopFailure']);
    expect(s.out).toEqual([]);
    expect(s.appended).toEqual([]);
    expect(s.reasons).toEqual(['unknown-event']);
  });
});

describe('pruneHookLogs and progress files', () => {
  it('prunes old progress markers and keeps the current session', async () => {
    const s = sandbox();
    const dir = path.dirname(s.files.want);
    const names = ['old.progress.json', 'old.progress-sent.json', 'old.progress.json.tmp', 'old.txt'];
    fs.mkdirSync(dir, { recursive: true });
    const past = new Date(Date.now() - 30 * 86_400_000);
    for (const n of [...names, `${SID}.progress.json`, `${SID}.progress-sent.json`]) {
      fs.writeFileSync(path.join(dir, n), '{}');
      fs.utimesSync(path.join(dir, n), past, past);
    }
    let keep: string[] = [];
    await s.run(
      JSON.stringify({ session_id: SID, hook_event_name: 'SessionStart', source: 'startup' }),
      ['hook', 'SessionStart'],
      {
        now: Date.now,
        prune: (d, k, now) => {
          keep = k;
          return pruneHookLogs(d, k, now);
        },
      },
    );
    expect(keep).toContain(`${SID}.progress.json`);
    expect(keep).toContain(`${SID}.progress-sent.json`);
    expect(fs.readdirSync(dir).sort()).toEqual(
      ['old.progress.json.tmp', 'old.txt', `${SID}.progress.json`].sort(),
    );
  });

  it('forgets the sent marker on SessionStart, so a resumed tab gets the bar (IN-05)', async () => {
    const s = sandbox();
    s.want();
    await s.run(input());
    expect(readSent(s.files.sent)).toEqual({ state: 4, pct: 72 });
    await s.run(JSON.stringify({ session_id: SID, hook_event_name: 'SessionStart', source: 'resume' }), [
      'hook',
      'SessionStart',
    ]);
    expect(fs.existsSync(s.files.sent)).toBe(false);
    expect(fs.existsSync(s.files.want)).toBe(true);
    await s.run(input());
    expect(s.out).toHaveLength(2);
    expect(s.reasons.at(-1)).toBe('emitted');
  });
});
