import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { progressTarget, syncProgress } from '../../src/cli/progress.js';
import { runRender } from '../../src/cli/render.js';
import { fs as nodeFs } from '../../src/core/builtins.js';
import type { ProgressConfig, StatusPayload } from '../../src/core/types.js';
import { contextPercent } from '../../src/widgets/context.js';
import { ctxWith } from '../helpers.js';

const SID = 'progress-sess';
const tmp = (p: string) => fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, p));

function payload(used: number, extra: Partial<StatusPayload> = {}): StatusPayload {
  return {
    session_id: SID,
    model: { display_name: 'Opus' },
    context_window: { context_window_size: 200_000, used_percentage: used },
    ...extra,
  } as StatusPayload;
}

function setup(progress: ProgressConfig | undefined, used = 72, extra: Partial<StatusPayload> = {}) {
  const cache = tmp('progress-cache-');
  const env = { CCINFOBAR_CACHE_DIR: cache };
  const ctx = ctxWith({
    payload: payload(used, extra),
    config: progress ? { progress } : {},
    env,
  });
  return { ctx, env, file: path.join(cache, 'hooks', `${SID}.progress.json`) };
}

const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('progressTarget', () => {
  it('maps the percentage to a state', () => {
    const p: ProgressConfig = { enabled: true };
    expect(progressTarget(setup(p, 10).ctx, p)).toEqual({ state: 1, pct: 10 });
    expect(progressTarget(setup(p, 50).ctx, p)).toEqual({ state: 4, pct: 50 });
    expect(progressTarget(setup(p, 80).ctx, p)).toEqual({ state: 2, pct: 80 });
    const q: ProgressConfig = { enabled: true, warnAt: 20, errorAt: 30 };
    expect(progressTarget(setup(q, 25).ctx, q)).toEqual({ state: 4, pct: 25 });
  });

  it('returns null without data', () => {
    const p: ProgressConfig = { enabled: true };
    const ctx = ctxWith({
      payload: { session_id: SID } as StatusPayload,
      config: { progress: p },
      transcript: () => null,
    });
    expect(progressTarget(ctx, p)).toBeNull();
  });
});

describe('syncProgress', () => {
  it('does no IO without a progress key', () => {
    const { ctx, env } = setup(undefined);
    const spies = (['readFileSync', 'writeFileSync', 'mkdirSync', 'renameSync', 'statSync'] as const).map(
      (k) => vi.spyOn(nodeFs, k),
    );
    expect(syncProgress(ctx, env)).toEqual({ changed: false, want: null });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('writes the desired state once per change', () => {
    const p: ProgressConfig = { enabled: true };
    const { ctx, env, file } = setup(p, 72);
    const first = syncProgress(ctx, env, 'linux');
    expect(first.changed).toBe(true);
    expect(first.want).toEqual({ v: 1, state: 4, pct: 72, channel: 'hook', always: false });
    expect(read(file)).toEqual(first.want);
    const mtime = fs.statSync(file).mtimeMs;
    const rename = vi.spyOn(nodeFs, 'renameSync');
    const again = syncProgress(ctx, env, 'linux');
    expect(again.changed).toBe(false);
    expect(again.want).toEqual(first.want);
    expect(rename).not.toHaveBeenCalled();
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    rename.mockRestore();
    const hot = ctxWith({ payload: payload(85), config: { progress: p }, env });
    expect(syncProgress(hot, env, 'linux')).toMatchObject({ changed: true, want: { state: 2, pct: 85 } });
    expect(read(file)).toMatchObject({ state: 2, pct: 85 });
  });

  it('uses the auto-compact basis and the 5h usage', () => {
    const auto: ProgressConfig = { enabled: true, scaleTo: 'autocompact' };
    const a = setup(auto, 60);
    const usable = Math.round(contextPercent(a.ctx, 'usable')!);
    expect(usable).not.toBe(60);
    expect(syncProgress(a.ctx, a.env).want?.pct).toBe(usable);
    const five: ProgressConfig = { enabled: true, source: 'usage5h' };
    const b = setup(five, 60, {
      rate_limits: { five_hour: { used_percentage: 33, resets_at: 2_000_000_000 } },
    } as Partial<StatusPayload>);
    expect(syncProgress(b.ctx, b.env).want).toMatchObject({ state: 1, pct: 33 });
  });

  it('picks the channel and the terminal mode', () => {
    const p: ProgressConfig = { enabled: true, channel: 'tty', terminals: 'always' };
    const a = setup(p);
    expect(syncProgress(a.ctx, a.env, 'linux').want).toMatchObject({ channel: 'tty', always: true });
    const b = setup(p);
    expect(syncProgress(b.ctx, b.env, 'win32').want).toMatchObject({ channel: 'hook' });
    const c = setup({ enabled: true, channel: 'auto' });
    expect(syncProgress(c.ctx, c.env, 'darwin').want).toMatchObject({ channel: 'hook', always: false });
  });

  it('clears once after progress is turned off', () => {
    const { ctx, env, file } = setup({ enabled: true });
    syncProgress(ctx, env, 'linux');
    const off = ctxWith({ payload: payload(72), config: { progress: { enabled: false } }, env });
    const r = syncProgress(off, env, 'linux');
    expect(r.changed).toBe(true);
    expect(r.want).toMatchObject({ state: 0, pct: 0 });
    expect(read(file)).toMatchObject({ state: 0 });
    expect(syncProgress(off, env, 'linux').changed).toBe(false);
  });

  it('writes nothing when off and nothing was shown', () => {
    const { ctx, env, file } = setup({ enabled: false });
    expect(syncProgress(ctx, env, 'linux').changed).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ignores an unsafe session id', () => {
    const p: ProgressConfig = { enabled: true };
    const cache = tmp('progress-unsafe-');
    const env = { CCINFOBAR_CACHE_DIR: cache };
    const ctx = ctxWith({ payload: { ...payload(72), session_id: '../x' }, config: { progress: p }, env });
    expect(syncProgress(ctx, env).changed).toBe(false);
    expect(fs.readdirSync(cache)).toEqual([]);
  });
});

describe('render wiring', () => {
  it('syncs after the stdout write, inside the post-stdout try', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../../src/cli/render.ts'), 'utf8');
    const out = text.indexOf('process.stdout.write(lines');
    const sync = text.indexOf('syncProgress(');
    expect(out).toBeGreaterThan(0);
    expect(sync).toBeGreaterThan(out);
    const tryAt = text.lastIndexOf('try {', sync);
    expect(tryAt).toBeGreaterThan(out);
    expect(text).not.toMatch(/terminalProgressBarEnabled/);
  });

  it('writes the progress file from a real render', async () => {
    const dir = tmp('progress-run-');
    const file = path.join(dir, 'p.json');
    const sid = `render-${process.pid}`;
    fs.writeFileSync(file, JSON.stringify({ ...payload(64), session_id: sid }));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfg,
      JSON.stringify({ lines: [[{ id: 'm', type: 'model' }]], progress: { enabled: true } }),
    );
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    await runRender(parseArgs(['--payload', file]), cfg);
    const want = path.join(process.env.CCINFOBAR_CACHE_DIR!, 'hooks', `${sid}.progress.json`);
    try {
      expect(read(want)).toEqual({ v: 1, state: 4, pct: 64, channel: 'hook', always: false });
      expect(writes.join('')).not.toContain('\u001b]9;');
    } finally {
      fs.rmSync(want, { force: true });
    }
  });
});
