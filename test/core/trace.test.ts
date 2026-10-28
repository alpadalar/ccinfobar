import { types } from 'node:util';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { samplePayload } from '../../src/core/sample.js';
import { createTrace, leaves, type TraceRead } from '../../src/core/trace.js';
import type { RenderContext, StatusPayload } from '../../src/core/types.js';
import { ctxWith, NOW } from '../helpers.js';

function traced(payload: StatusPayload = samplePayload(NOW.getTime()), withHistory = true) {
  const trace = createTrace();
  const base = createContext({
    payload,
    config: { ...defaultConfig(), colorLevel: 0 },
    env: { HOME: '/home/x', SECRET: 'hunter2' },
    now: NOW,
    terminalWidth: 100,
    data: {
      git: () => null,
      gsd: () => null,
      transcript: () => null,
      agents: () => [],
      ...(withHistory ? { history: () => [], limits: () => null } : {}),
    },
  });
  const ctx = trace.wrap(base);
  const reads = (fn: (c: RenderContext) => unknown, c: RenderContext = trace.forWidget(ctx)): TraceRead[] => {
    trace.begin();
    fn(c);
    return trace.end();
  };
  return { trace, ctx, reads };
}

describe('createTrace', () => {
  it('records payload paths', () => {
    const { reads } = traced();
    expect(reads((c) => c.payload.context_window?.used_percentage)).toEqual([
      { kind: 'payload', path: 'context_window' },
      { kind: 'payload', path: 'context_window.used_percentage' },
    ]);
  });

  it('folds array indices', () => {
    const p = samplePayload(NOW.getTime());
    p.rate_limits = { ...p.rate_limits, seven_day_models: [{ used_percentage: 3 }] } as typeof p.rate_limits;
    const { reads } = traced(p);
    const got = reads(
      (c) =>
        (c.payload.rate_limits as { seven_day_models: { used_percentage: number }[] }).seven_day_models[0]!
          .used_percentage,
    );
    expect(got.map((r) => r.path)).toContain('rate_limits.seven_day_models[].used_percentage');
  });

  it('marks absent fields', () => {
    const p = samplePayload(NOW.getTime());
    delete p.prompt_cache;
    const { reads } = traced(p);
    expect(reads((c) => c.payload.prompt_cache)).toEqual([
      { kind: 'payload', path: 'prompt_cache', absent: true },
    ]);
  });

  it('skips array methods, length and symbols', () => {
    const { reads } = traced({ session_id: 's', list: [1, 2] } as StatusPayload);
    const got = reads((c) => {
      const list = (c.payload as { list: number[] }).list;
      void list.length;
      list.forEach(() => {});
      void (list as unknown as Record<symbol, unknown>)[Symbol.iterator];
    });
    expect(got.map((r) => r.path)).toEqual(['list', 'list[]', 'list[]']);
  });

  it('records env key names but never values', () => {
    const { reads } = traced();
    const got = reads((c) => c.env.HOME);
    expect(got).toEqual([{ kind: 'env', path: 'HOME' }]);
    expect(JSON.stringify(reads((c) => c.env.SECRET))).not.toContain('hunter2');
  });

  it('records data calls and keeps history absent when absent', () => {
    const { reads } = traced();
    const got = reads((c) => {
      c.data.git();
      c.data.transcript();
      c.data.gsd();
      c.data.agents();
      c.data.history?.();
      c.data.limits?.();
    });
    expect(got.map((r) => r.kind)).toEqual(['git', 'transcript', 'gsd', 'agents', 'history', 'limits-cache']);
    const none = traced(undefined, false);
    expect(none.ctx.data.history).toBeUndefined();
    expect(none.ctx.data.limits).toBeUndefined();
    expect(none.trace.forWidget(none.ctx).data.history).toBeUndefined();
  });

  it('gives a fresh ctx per widget that records clock, width and cwd', () => {
    const { trace, ctx, reads } = traced();
    const a = trace.forWidget(ctx);
    expect(a).not.toBe(trace.forWidget(ctx));
    expect(reads((c) => c.now, a)).toEqual([{ kind: 'clock' }]);
    expect(reads((c) => c.terminalWidth, a)).toEqual([{ kind: 'system' }]);
    expect(reads((c) => c.cwd, a)).toEqual([{ kind: 'payload', path: 'workspace.current_dir' }]);
    expect(a.now).toBe(NOW);
    expect(a.terminalWidth).toBe(100);
    const bare = traced({ session_id: 's' });
    expect(bare.reads((c) => c.cwd)).toEqual([{ kind: 'system' }]);
  });

  it('only records between begin and end', () => {
    const { trace, ctx } = traced();
    const c = trace.forWidget(ctx);
    void c.payload.model;
    trace.begin();
    void c.payload.cost;
    expect(trace.end()).toEqual([{ kind: 'payload', path: 'cost' }]);
    void c.payload.model;
    trace.begin();
    expect(trace.end()).toEqual([]);
  });

  it('keeps values and Proxy-free plain objects', () => {
    const { ctx } = traced();
    expect(types.isProxy(ctx)).toBe(false);
    expect(types.isProxy(ctx.payload)).toBe(true);
    expect(ctx.payload.context_window?.used_percentage).toBe(
      samplePayload(NOW.getTime()).context_window?.used_percentage,
    );
  });
});

describe('leaves', () => {
  it('drops prefixes of the same kind and dedupes', () => {
    expect(
      leaves([
        { kind: 'payload', path: 'context_window' },
        { kind: 'payload', path: 'context_window.used_percentage' },
        { kind: 'payload', path: 'context_window.used_percentage' },
        { kind: 'payload', path: 'rate_limits' },
        { kind: 'payload', path: 'rate_limits.seven_day_models[]' },
        { kind: 'env', path: 'context_window' },
        { kind: 'git' },
        { kind: 'git' },
      ]),
    ).toEqual([
      { kind: 'payload', path: 'context_window.used_percentage' },
      { kind: 'payload', path: 'rate_limits.seven_day_models[]' },
      { kind: 'env', path: 'context_window' },
      { kind: 'git' },
    ]);
  });
});

describe('createContext without trace', () => {
  it('returns a plain object of the same shape', () => {
    const ctx = ctxWith();
    expect(types.isProxy(ctx)).toBe(false);
    expect(types.isProxy(ctx.payload)).toBe(false);
    expect(types.isProxy(ctx.env)).toBe(false);
    expect(Object.keys(ctx).sort()).toEqual(
      [
        'budget',
        'clock',
        'config',
        'cwd',
        'data',
        'env',
        'now',
        'payload',
        'preview',
        'terminalWidth',
      ].sort(),
    );
  });
});
