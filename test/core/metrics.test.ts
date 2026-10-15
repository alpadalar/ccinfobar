import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasItemRules, metricGetter, metricPrev, ruleDecision } from '../../src/core/metrics.js';
import { sampleHooks, samplePayload } from '../../src/core/sample.js';
import type { RenderContext, StatusPayload } from '../../src/core/types.js';
import { findUp } from '../../src/data/repos.js';
import { ctxWith, NOW, renderWidget, withoutSideEffects } from '../helpers.js';

const payload = (patch: (p: StatusPayload) => void = () => {}): StatusPayload => {
  const p = samplePayload(NOW.getTime());
  patch(p);
  return p;
};

const withCwd = (ctx: RenderContext, cwd: string): RenderContext => ({ ...ctx, cwd });

const tmpRepo = fs.existsSync(path.join(os.tmpdir(), '.git')) || findUp(os.tmpdir(), '.git', 'any') !== null;
const tmpGsd = findUp(os.tmpdir(), '.planning', 'dir') !== null;
let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-metrics-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('number metrics', () => {
  it('context.pct matches the context widget', () => {
    const ctx = ctxWith({});
    const shown = renderWidget('context-percentage', ctx);
    expect(shown).toContain(`${metricGetter(ctx)('context.pct')}%`);
  });

  it('rounds percentages and costs to what the user sees', () => {
    const ctx = ctxWith({
      payload: payload((p) => {
        p.context_window!.used_percentage = 69.6;
        p.cost!.total_cost_usd = 1.234;
        p.rate_limits!.five_hour!.used_percentage = 79.5;
      }),
      limits: () => null,
    });
    const get = metricGetter(ctx);
    expect(get('context.pct')).toBe(70);
    expect(get('cost.session')).toBe(1.23);
    expect(get('usage.5h')).toBe(80);
    expect(get('usage.7d')).toBe(61);
  });

  it('reads usage from the limits view when the payload has none', () => {
    const ctx = ctxWith({
      payload: payload((p) => {
        delete p.rate_limits;
      }),
      limits: () => ({
        windows: { five_hour: { pct: 55.4, resetsAt: null, at: null, source: 'limits-cache', samples: [] } },
        expired: [],
      }),
    });
    expect(metricGetter(ctx)('usage.5h')).toBe(55);
    expect(metricGetter(ctx)('usage.7d')).toBeNull();
  });

  it('gives time, weekday and provider', () => {
    const ctx = ctxWith({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
    const get = metricGetter(ctx);
    expect(get('time.hour')).toBe(NOW.getHours());
    expect(get('time.weekday')).toBe(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][NOW.getDay()]);
    expect(get('provider')).toBe('bedrock');
    expect(metricGetter(ctxWith({}))('provider')).toBe('firstParty');
  });

  it('cost.today needs the ledger view', () => {
    expect(metricGetter(ctxWith({}))('cost.today')).toBe(4.12);
    const ctx = ctxWith({});
    delete ctx.data.ledger;
    expect(metricGetter(ctx)('cost.today')).toBeNull();
  });

  it('tokens.total matches the tokens widget', () => {
    const ctx = ctxWith({});
    expect(metricGetter(ctx)('tokens.total')).toBe(412_000 + 38_400);
  });

  it('counts running agents', () => {
    const agent = (id: string, running: boolean) => ({
      id,
      type: 't',
      description: '',
      model: null,
      input: 0,
      output: 0,
      total: 0,
      fresh: 0,
      start: null,
      last: null,
      tool: null,
      running,
    });
    const ctx = ctxWith({ agents: () => [agent('a', true), agent('b', false), agent('c', true)] });
    expect(metricGetter(ctx)('agents.running')).toBe(2);
    expect(metricGetter(ctx)('agents')).toBe(true);
    const none = ctxWith({ agents: () => [agent('a', false)] });
    expect(metricGetter(none)('agents.running')).toBe(0);
    expect(metricGetter(none)('agents')).toBe(false);
  });

  it('permission.waiting needs hooks', () => {
    const ctx = ctxWith({});
    delete ctx.data.hooks;
    expect(metricGetter(ctx)('permission.waiting')).toBeNull();
    expect(metricGetter(ctxWith({}))('permission.waiting')).toBe(false);
    const open = ctxWith({
      hooks: () => ({
        ...sampleHooks(NOW.getTime()),
        pendingPermission: { since: NOW.getTime(), tool: 'Bash' },
      }),
    });
    expect(metricGetter(open)('permission.waiting')).toBe(true);
  });

  it('limit-risk follows the limit-risk widget', () => {
    const ctx = ctxWith({});
    expect(metricGetter(ctx)('limit-risk')).toBe(renderWidget('limit-risk', ctx) !== null);
    const none = ctxWith({ payload: payload((p) => delete p.rate_limits), limits: () => null });
    expect(metricGetter(none)('limit-risk')).toBeNull();
  });

  it('returns null for unknown metrics', () => {
    expect(metricGetter(ctxWith({}))('nope')).toBeNull();
  });

  it('returns null when a data source throws', () => {
    const boom = () => {
      throw new Error('boom');
    };
    const ctx = ctxWith({ agents: boom, ledger: boom, limits: boom, hooks: boom, transcript: boom });
    ctx.payload = {} as StatusPayload;
    const get = metricGetter(ctx);
    for (const m of [
      'context.pct',
      'context.usable',
      'usage.5h',
      'usage.7d',
      'cost.session',
      'cost.today',
      'tokens.total',
      'agents.running',
      'agents',
      'limit-risk',
      'permission.waiting',
    ]) {
      expect(get(m), m).toBeNull();
    }
  });
});

describe.skipIf(tmpRepo || tmpGsd)('presence', () => {
  it('finds .git up the tree and nothing in a bare dir', () => {
    fs.mkdirSync(path.join(dir, 'r', '.git'), { recursive: true });
    const deep = path.join(dir, 'r', 'a', 'b');
    fs.mkdirSync(deep, { recursive: true });
    const git = vi.fn(() => null);
    const ctx = ctxWith({ git });
    withoutSideEffects(() => {
      expect(metricGetter(withCwd(ctx, deep))('git')).toBe(true);
      expect(metricGetter(withCwd(ctxWith({ git }), dir))('git')).toBe(false);
    });
    expect(git).not.toHaveBeenCalled();
  });

  it('wants a .planning directory, not a file', () => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.mkdirSync(path.join(a, '.planning', 'x'), { recursive: true });
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, '.planning'), '');
    const gsd = vi.fn(() => null);
    withoutSideEffects(() => {
      expect(metricGetter(withCwd(ctxWith({ gsd }), path.join(a, '.planning', 'x')))('gsd')).toBe(true);
      expect(metricGetter(withCwd(ctxWith({ gsd }), b))('gsd')).toBe(false);
    });
    expect(gsd).not.toHaveBeenCalled();
  });

  it('findUp stops at the root', () => {
    expect(findUp(dir, 'no-such-name-ccib', 'any')).toBeNull();
    fs.mkdirSync(path.join(dir, 'x'));
    expect(findUp(path.join(dir, 'x'), 'x', 'dir')).toBe(dir);
  });
});

describe('memo and prev', () => {
  it('shares one map across copies of a render context', () => {
    const agents = vi.fn(() => []);
    const ctx = ctxWith({ agents });
    const a = metricGetter(ctx);
    const b = metricGetter({ ...ctx, extra: 3 });
    expect(a('agents.running')).toBe(0);
    expect(b('agents')).toBe(false);
    expect(b('agents.running')).toBe(0);
    expect(agents).toHaveBeenCalledTimes(1);
  });

  it('usage prev is the newest earlier ring sample', () => {
    const t = NOW.getTime();
    const ctx = ctxWith({
      limits: () => ({
        windows: {
          five_hour: {
            pct: 80,
            resetsAt: null,
            at: null,
            source: 'payload',
            samples: [
              { t: t - 60_000, pct: 81 },
              { t: t - 120_000, pct: 70 },
              { t: t + 1000, pct: 99 },
            ],
          },
        },
        expired: [],
      }),
    });
    const prev = metricPrev(ctx);
    expect(prev('usage.5h')).toBe(81);
    expect(prev('usage.7d')).toBeNull();
    expect(prev('cost.session')).toBeNull();
  });

  it('context prev needs history', () => {
    const ctx = ctxWith({});
    delete ctx.data.history;
    expect(metricPrev(ctx)('context.pct')).toBeNull();
    const t = NOW.getTime();
    const withHist = ctxWith({ history: () => [{ t: t - 1000, ctx: 720_000 }] });
    expect(metricPrev(withHist)('context.pct')).toBe(72);
  });

  it('applies a band from the ring', () => {
    const t = NOW.getTime();
    const ring = (pct: number) => () => ({
      windows: {
        five_hour: {
          pct: 0,
          resetsAt: null,
          at: null,
          source: 'payload' as const,
          samples: [{ t: t - 1000, pct }],
        },
      },
      expired: [],
    });
    const item = { id: 'm', type: 'model', showWhen: 'usage.5h >= 80 ~5' };
    const at = (pct: number, prev: number) =>
      ruleDecision(
        ctxWith({
          payload: payload((p) => (p.rate_limits!.five_hour!.used_percentage = pct)),
          limits: ring(prev),
        }),
        item,
      ).visible;
    expect(at(77, 82)).toBe(true);
    expect(at(77, 70)).toBe(false);
    expect(at(74, 82)).toBe(false);
  });

  it('hasItemRules', () => {
    expect(hasItemRules({ id: 'a', type: 'model' })).toBe(false);
    expect(hasItemRules({ id: 'a', type: 'model', hideWhen: '!git' })).toBe(true);
    expect(hasItemRules({ id: 'a', type: 'model', showWhen: [] })).toBe(true);
  });
});
