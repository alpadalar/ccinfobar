import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const bin = path.join(root, 'dist/ccinfobar.js');
const SID = 'sess_hook-1';

function sandbox() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-hook-cli-')));
  const cache = path.join(dir, 'cache');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(dir, 'home'),
    USERPROFILE: path.join(dir, 'home'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    CCINFOBAR_CONFIG_DIR: path.join(dir, 'config'),
    CCINFOBAR_CACHE_DIR: cache,
    CCINFOBAR_NO_UPDATE: '1',
    CCINFOBAR_NO_USAGE_API: '1',
  };
  const log = (sid = SID) => path.join(cache, 'hooks', `${sid}.jsonl`);
  const lines = (sid = SID) =>
    fs.existsSync(log(sid))
      ? fs
          .readFileSync(log(sid), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const run = (args: string[], input: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, ...extra },
      input,
      maxBuffer: 1 << 24,
    });
  return { dir, cache, env, log, lines, run };
}

const quiet = (r: { stdout: string; stderr: string; status: number | null }) => {
  expect(r.stdout).toBe('');
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
};

const ups = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: SID,
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'p1',
    prompt: 'SECRET-PROMPT',
    ...extra,
  });

describe.skipIf(!fs.existsSync(bin))('ccinfobar hook (built cli)', () => {
  it('records a valid UserPromptSubmit silently with only allowed fields', () => {
    const s = sandbox();
    quiet(s.run(['hook', 'UserPromptSubmit'], ups()));
    const got = s.lines();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ v: 1, e: 'UserPromptSubmit', p: 'p1' });
    expect(typeof got[0]!.t).toBe('number');
    expect(fs.readFileSync(s.log(), 'utf8')).not.toContain('SECRET-PROMPT');
    if (process.platform !== 'win32') expect(fs.statSync(s.log()).mode & 0o777).toBe(0o600);
  });

  it('stores only prompt_id and stop_hook_active for Stop', () => {
    const s = sandbox();
    const input = JSON.stringify({
      session_id: SID,
      hook_event_name: 'Stop',
      prompt_id: 'p2',
      stop_hook_active: false,
      last_assistant_message: 'SECRET-REPLY',
    });
    quiet(s.run(['hook', 'Stop'], input));
    const got = s.lines();
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]!).sort()).toEqual(['e', 'p', 'sa', 't', 'v']);
    expect(got[0]).toMatchObject({ e: 'Stop', p: 'p2', sa: false });
    expect(fs.readFileSync(s.log(), 'utf8')).not.toContain('SECRET-REPLY');
  });

  it('prefers the stdin event name over the argv event', () => {
    const s = sandbox();
    quiet(s.run(['hook', 'Stop'], ups()));
    expect(s.lines().map((l) => l.e)).toEqual(['UserPromptSubmit']);
  });

  it('is silent and records with flags before hook', () => {
    const s = sandbox();
    const cfg = path.join(s.dir, 'x.json');
    fs.writeFileSync(cfg, '{}');
    const input = JSON.stringify({ session_id: SID, hook_event_name: 'Stop', prompt_id: 'p3' });
    quiet(s.run(['--config', cfg, 'hook', 'Stop'], input));
    expect(s.lines().map((l) => l.e)).toEqual(['Stop']);
  });

  it('does not silence a real command that ends in hook <word>', () => {
    const s = sandbox();
    for (const last of ['Stop', '1']) {
      const r = s.run(['config', 'set', 'hook', last], '');
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).not.toBe('');
    }
    expect(fs.existsSync(s.log())).toBe(false);
  });

  it('records an oversized input from the bounded scan', () => {
    const s = sandbox();
    quiet(s.run(['hook', 'UserPromptSubmit'], ups({ prompt: 'x'.repeat(1_500_000) })));
    const got = s.lines();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ e: 'UserPromptSubmit', p: 'p1' });
  });

  const silent: Array<[string, string[], string, (s: ReturnType<typeof sandbox>) => NodeJS.ProcessEnv]> = [
    ['malformed JSON', ['hook', 'Stop'], '{"session_id": "x", ', () => ({})],
    ['empty stdin', ['hook', 'Stop'], '', () => ({})],
    [
      'an unknown event',
      ['hook', 'PreToolUse'],
      JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_input: { command: 'ls' } }),
      () => ({}),
    ],
    [
      'a path-like session id',
      ['hook', 'Stop'],
      JSON.stringify({ session_id: '../../x', hook_event_name: 'Stop' }),
      () => ({}),
    ],
    [
      'a 129-char session id',
      ['hook', 'Stop'],
      JSON.stringify({ session_id: 'a'.repeat(129), hook_event_name: 'Stop' }),
      () => ({}),
    ],
    [
      'a cache dir that is a regular file',
      ['hook', 'UserPromptSubmit'],
      ups(),
      (s) => {
        const file = path.join(s.dir, 'not-a-dir');
        fs.writeFileSync(file, '');
        return { CCINFOBAR_CACHE_DIR: file };
      },
    ],
  ];

  for (const [name, args, input, env] of silent) {
    it(`prints nothing, writes nothing and exits 0 for ${name}`, () => {
      const s = sandbox();
      quiet(s.run(args, input, env(s)));
      expect(fs.existsSync(path.join(s.cache, 'hooks'))).toBe(false);
    });
  }

  const open = (s: ReturnType<typeof sandbox>) => {
    const child = spawn(process.execPath, [bin, 'hook', 'Stop'], {
      cwd: s.dir,
      env: s.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    const exit = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    return { child, exit, out: () => out };
  };

  it('exits 0 within 2.5 s after a complete payload when stdin never closes', async () => {
    const s = sandbox();
    const start = Date.now();
    const p = open(s);
    p.child.stdin.write(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', prompt_id: 'p9' }));
    const code = await p.exit;
    const elapsed = Date.now() - start;
    p.child.stdin.destroy();
    expect(code).toBe(0);
    expect(p.out()).toBe('');
    expect(elapsed).toBeLessThan(2500);
    expect(s.lines().map((l) => l.p)).toEqual(['p9']);
  }, 10000);

  it('a partial payload writes nothing and exits 0 once the writer closes', async () => {
    const s = sandbox();
    const start = Date.now();
    const p = open(s);
    p.child.stdin.write('{"session_id":');
    setTimeout(() => p.child.stdin.end(), 1500);
    const code = await p.exit;
    expect(code).toBe(0);
    expect(p.out()).toBe('');
    expect(Date.now() - start).toBeLessThan(2500);
    expect(fs.existsSync(path.join(s.cache, 'hooks'))).toBe(false);
  }, 10000);
});
