import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { render } from '../../src/core/renderer.js';
import { sampleJobs, samplePayload } from '../../src/core/sample.js';
import { SCENARIO_NOW } from '../../src/core/scenarios.js';
import type { WidgetItem } from '../../src/core/types.js';
import { cacheKey } from '../../src/data/cache.js';
import { commandGroups } from '../../src/data/jobs/command.js';
import { createJobReader, failEnvelope, okEnvelope, writeEnvelope } from '../../src/data/jobs/runner.js';
import { ctxWith, renderWidget } from '../helpers.js';

const cmd = (id: string, command: string, options: Record<string, string | number> = {}): WidgetItem => ({
  id,
  type: 'command',
  options: { command, timeout: 1000, ...options },
});

function fake(clock: { t: number }, outs: (string | null)[] = []) {
  const calls: number[] = [];
  const exec = (_c: string, o: { timeout: number }) => {
    calls.push(o.timeout);
    clock.t += o.timeout;
    return outs[calls.length - 1] ?? null;
  };
  return { calls, exec };
}

describe('command budget', () => {
  it('shares one budget across hanging command items and keeps the rest', () => {
    const clock = { t: 1000 };
    const f = fake(clock);
    const ctx = ctxWith({
      config: {
        commandBudgetMs: 600,
        lines: [[cmd('a', 'a'), cmd('b', 'b'), cmd('c', 'c'), { id: 'm', type: 'model' }]],
      },
      exec: f.exec,
      clock: () => clock.t,
    });
    const lines = render(ctx).map(stripAnsi);
    expect(f.calls.every((t) => t <= 600)).toBe(true);
    expect(f.calls.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600);
    expect(f.calls.length).toBe(1);
    expect(lines.join('\n')).toContain('Opus 5.5');
  });

  it('caps each item at its own timeout', () => {
    const clock = { t: 0 };
    const f = fake(clock, ['ok']);
    const ctx = ctxWith({ config: { commandBudgetMs: 600 }, exec: f.exec, clock: () => clock.t });
    expect(renderWidget('command', ctx, cmd('a', 'a', { timeout: 200 }))).toBe('ok');
    expect(f.calls).toEqual([200]);
  });

  describe('cache', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-budget-'));
    const env = { CCINFOBAR_CACHE_DIR: dir };
    const file = (command: string, cwd: string) => path.join(dir, `cmd-${cacheKey(command, cwd)}.json`);

    it('shows stale cache once the budget is spent and refreshes while budget is left', () => {
      const clock = { t: 10_000_000 };
      const f = fake(clock, ['new']);
      const mk = () => ctxWith({ config: { commandBudgetMs: 600 }, exec: f.exec, clock: () => clock.t, env });
      const item = cmd('b', 'echo-b', { cacheSeconds: 1 });
      const ctx = mk();
      fs.writeFileSync(
        file('echo-b', path.resolve(ctx.cwd)),
        JSON.stringify({ at: clock.t - 3_600_000, out: 'old' }),
      );
      clock.t = ctx.budget.deadline - 10;
      expect(renderWidget('command', ctx, item)).toBe('old');
      expect(f.calls).toEqual([]);
      const ctx2 = mk();
      expect(renderWidget('command', ctx2, item)).toBe('new');
      expect(f.calls.length).toBe(1);
      expect(JSON.parse(fs.readFileSync(file('echo-b', path.resolve(ctx.cwd)), 'utf8')).out).toBe('new');
    });

    it('returns null without cache and writes nothing when cacheSeconds is 0', () => {
      const clock = { t: 5_000 };
      const f = fake(clock);
      const ctx = ctxWith({ config: { commandBudgetMs: 600 }, exec: f.exec, clock: () => clock.t, env });
      clock.t = ctx.budget.deadline;
      expect(renderWidget('command', ctx, cmd('c', 'echo-c'))).toBeNull();
      expect(f.calls).toEqual([]);
      expect(fs.existsSync(file('echo-c', path.resolve(ctx.cwd)))).toBe(false);
    });
  });

  it('still executes in a scenario preview with a fixed past now', () => {
    const calls: number[] = [];
    const ctx = createContext({
      payload: samplePayload(SCENARIO_NOW),
      config: { ...defaultConfig(), commandBudgetMs: 3000 },
      now: new Date(SCENARIO_NOW),
      preview: true,
      data: {
        exec: (_c, o) => {
          calls.push(o.timeout);
          return 'hi';
        },
      },
    });
    expect(renderWidget('command', ctx, cmd('a', 'echo hi'))).toBe('hi');
    expect(calls.length).toBe(1);
    expect(calls[0]).toBeLessThanOrEqual(3000);
  });

  // fake-exec cases cover Windows; cmd.exe timing differs
  it.skipIf(process.platform === 'win32')('three real hanging commands finish within the budget', () => {
    const hang = 'node -e "setTimeout(()=>{},5000)"';
    const ctx = ctxWith({
      config: {
        commandBudgetMs: 600,
        lines: [
          [
            cmd('a', hang, { timeout: 5000 }),
            cmd('b', hang, { timeout: 5000 }),
            cmd('c', hang, { timeout: 5000 }),
            { id: 'm', type: 'model' },
          ],
        ],
      },
    });
    ctx.cwd = process.cwd();
    ctx.env = { ...process.env };
    const start = Date.now();
    const out = render(ctx).map(stripAnsi).join('\n');
    const wall = Date.now() - start;
    expect(wall).toBeLessThan(2500);
    expect(out).toContain('Opus 5.5');
  });
});

describe('command background', () => {
  const boom = () => {
    throw new Error('exec must not run');
  };
  const setup = (opts: Record<string, string | number | boolean>) => {
    const env = { CCINFOBAR_CACHE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-bg-')) };
    const item: WidgetItem = {
      id: 'b',
      type: 'command',
      options: { command: 'echo x', cacheSeconds: 30, background: true, ...opts },
    };
    const ctx = ctxWith({ env, exec: boom, jobs: () => createJobReader(env) });
    return { env, item, ctx, key: `cmd-${cacheKey('echo x', path.resolve(ctx.cwd))}` };
  };

  it('reads the worker envelope and never runs the command', () => {
    const { env, item, ctx, key } = setup({});
    expect(renderWidget('command', ctx, item)).toBeNull();
    writeEnvelope(okEnvelope(key, { out: 'from worker' }, 1000), env);
    expect(renderWidget('command', ctx, item)).toBe('from worker');
  });

  it.each([
    ['a trailing separator', (base: string) => path.join(base, 'proj') + path.sep],
    ['a dot-dot segment', (base: string) => `${path.join(base, 'proj', 'x')}${path.sep}..`],
  ])('finds the worker result when the payload folder has %s', (_name, shape) => {
    const { env, item } = setup({});
    const raw = shape(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-cwd-')));
    const payload = { ...samplePayload(Date.now()), cwd: raw, workspace: { current_dir: raw } };
    const ctx = ctxWith({ env, exec: boom, jobs: () => createJobReader(env), payload });
    const [key] = [...commandGroups({ lines: [[item]] }, path.resolve(raw)).keys()];
    expect(renderWidget('command', ctx, item)).toBeNull();
    writeEnvelope(okEnvelope(key as string, { out: 'from worker' }, 1000), env);
    expect(renderWidget('command', ctx, item)).toBe('from worker');
  });

  it('takes background "true" as a string like true', () => {
    const { env, item, ctx, key } = setup({ background: 'true' });
    expect(renderWidget('command', ctx, item)).toBeNull();
    writeEnvelope(okEnvelope(key, { out: 'from worker' }, 1000), env);
    expect(renderWidget('command', ctx, item)).toBe('from worker');
  });

  it('shows the last good value of a failed envelope', () => {
    const { env, item, ctx, key } = setup({});
    const prev = okEnvelope(key, { out: 'older' }, 1000);
    writeEnvelope(failEnvelope(key, prev, 'exit-1', 2000, { retryMs: 60_000 }), env);
    expect(renderWidget('command', ctx, item)).toBe('older');
  });

  // envelopes are sanitized on write and read, so colors never survive the worker
  it('formats the envelope text with preserveColors on', () => {
    const { env, item, ctx, key } = setup({ preserveColors: true });
    writeEnvelope(okEnvelope(key, { out: '\u001b[31mred\u001b[0m' }, 1000), env);
    expect(renderWidget('command', ctx, item)).toBe('red');
  });

  it('falls back to the budgeted path with cacheSeconds 0', () => {
    const { env } = setup({});
    const ctx = ctxWith({ env, exec: () => 'ran' });
    const item: WidgetItem = {
      id: 'z',
      type: 'command',
      options: { command: 'echo x', cacheSeconds: 0, background: true },
    };
    expect(renderWidget('command', ctx, item)).toBe('ran');
  });

  it('shows the sample in a preview', () => {
    const { item } = setup({});
    const ctx = ctxWith({ exec: boom, jobs: () => sampleJobs() });
    expect(renderWidget('command', ctx, item)).toBe('command output');
  });
});
