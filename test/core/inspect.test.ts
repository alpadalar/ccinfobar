import { describe, expect, it, vi } from 'vitest';
import { sanitize } from '../../src/core/ansi.js';
import { t } from '../../src/core/i18n/index.js';
import { emptyReason, inspectRows, lineReport, sessionNotes } from '../../src/core/inspect.js';
import { normalizeResult, renderValue } from '../../src/core/renderer.js';
import { samplePayload } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW } from '../../src/core/scenarios.js';
import type { RenderContext, StatusPayload, WidgetDef, WidgetItem } from '../../src/core/types.js';
import { ALL_WIDGETS, getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, withoutSideEffects } from '../helpers.js';

const seen: RenderContext[] = [];

vi.mock('../../src/widgets/index.js', async (orig) => {
  const mod = await orig<typeof import('../../src/widgets/index.js')>();
  const extra: Record<string, WidgetDef> = {
    boom: {
      type: 'boom',
      name: 'Boom',
      category: 'custom',
      description: '',
      color: 'white',
      render() {
        throw new Error('bo\u001b[31mom\nsecond');
      },
    },
    probe: {
      type: 'probe',
      name: 'Probe',
      category: 'custom',
      description: '',
      color: 'white',
      render(ctx) {
        seen.push(ctx);
        return 'p';
      },
    },
  };
  return { ...mod, getWidget: (type: string) => extra[type] ?? mod.getWidget(type) };
});

const item = (type: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({ id: type, type, ...extra });
const rowsFor = (ctx: RenderContext) => withoutSideEffects(() => inspectRows(ctx));

describe('inspectRows', () => {
  it('gives one shown row per widget on the default config', () => {
    const ctx = ctxWith();
    const rows = rowsFor(ctx);
    const items = ctx.config.lines.flat();
    expect(rows).toHaveLength(items.length);
    for (const [l, line] of ctx.config.lines.entries()) {
      for (const [i, it] of line.entries()) {
        const r = rows.find((x) => x.line === l && x.index === i)!;
        expect(r.id).toBe(it.id);
        expect(r.type).toBe(it.type);
      }
    }
    for (const r of rows.filter((x) => x.type !== 'flex')) {
      if (r.status === 'shown') {
        expect(typeof r.value).toBe('string');
        expect(r.value).not.toContain('\u001b');
      }
      expect(Array.isArray(r.sources)).toBe(true);
    }
    expect(rows.find((r) => r.type === 'model')!.status).toBe('shown');
  });

  it('skips flex', () => {
    const rows = rowsFor(ctxWith({ config: { lines: [[item('model'), item('flex'), item('cwd')]] } }));
    expect(rows[1]).toMatchObject({ status: 'skipped', value: null, empty: null, index: 1 });
  });

  it('marks null results empty or hidden', () => {
    const rows = rowsFor(
      ctxWith({
        git: () => null,
        config: {
          lines: [
            [
              item('git-branch'),
              item('git-changes', { hideEmpty: true }),
              item('text', { options: { text: '' } }),
            ],
          ],
        },
      }),
    );
    expect(rows.map((r) => r.status)).toEqual(['empty', 'hidden', 'hidden']);
    for (const r of rows) {
      expect(r.value).toBeNull();
      expect(r.empty).not.toBeNull();
    }
  });

  it('marks the loading placeholder', () => {
    const b = getScenario('fresh-session')!.build(SCENARIO_NOW);
    const ctx = ctxWith({
      payload: b.payload,
      transcript: b.data.transcript,
      config: { lines: [[item('context-bar')]] },
    });
    const [r] = rowsFor(ctx);
    expect(r).toMatchObject({ status: 'loading', value: 'loading…' });
  });

  it('marks unknown types empty', () => {
    const [r] = rowsFor(ctxWith({ config: { lines: [[item('nope')]] } }));
    expect(r!.status).toBe('empty');
    expect(r!.empty).not.toBeNull();
  });

  it('reports a throwing widget and keeps the others', () => {
    const rows = rowsFor(ctxWith({ config: { lines: [[item('boom'), item('model')]] } }));
    expect(rows[0]).toMatchObject({ status: 'error', error: 'boom', value: null });
    expect(rows[1]!.status).toBe('shown');
  });

  it('gives each widget its own ctx', () => {
    seen.length = 0;
    const ctx = ctxWith({
      config: { lines: [[item('probe'), item('probe'), item('context-graph'), item('cost-graph')]] },
    });
    const rows = rowsFor(ctx);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).not.toBe(ctx);
    expect(rows[2]!.status).toBe('shown');
    expect(rows[3]!.status).toBe('shown');
  });

  it('runs command widgets with commandEnv', () => {
    const base = ctxWith({
      config: {
        lines: [
          [
            item('command', {
              options: {
                command: 'node -e "process.stdout.write(process.env.CCIB_T || \'none\')"',
                timeout: 5000,
              },
            }),
          ],
        ],
      },
    });
    const ctx = { ...base, cwd: process.cwd(), env: { ...process.env } };
    const [plain] = inspectRows(ctx);
    const [withEnv] = inspectRows(ctx, { commandEnv: { ...process.env, CCIB_T: 'v' } });
    expect(plain!.value).toBe('none');
    expect(withEnv!.value).toBe('v');
  });
});

describe('inspectRows sources', () => {
  const one = (type: string, over: Parameters<typeof ctxWith>[0] = {}, opts = {}) =>
    withoutSideEffects(() => inspectRows(ctxWith({ ...over, config: { lines: [[item(type)]] } }), opts))[0]!;
  const rows = (types: string[], over: Parameters<typeof ctxWith>[0] = {}) =>
    withoutSideEffects(() =>
      inspectRows(ctxWith({ ...over, config: { lines: [types.map((x) => item(x))] } })),
    );

  it('names payload paths, git and history', () => {
    expect(one('context-percentage').sources).toContainEqual({
      kind: 'payload',
      path: 'context_window.used_percentage',
    });
    expect(one('five-hour-usage').sources).toContainEqual({
      kind: 'payload',
      path: 'rate_limits.five_hour.used_percentage',
    });
    expect(one('git-branch').sources).toEqual([{ kind: 'git' }]);
    const [a, b] = rows(['context-graph', 'cost-graph']);
    expect(a!.sources).toContainEqual({ kind: 'history' });
    expect(b!.sources).toContainEqual({ kind: 'history' });
  });

  it('maps limits-cache windows with age and origin', () => {
    const path = 'rate_limits.five_hour.used_percentage';
    const meta = (origin: 'session' | 'usage-api') => ({
      meta: { limitWindows: { five_hour: { kind: 'limits-cache' as const, age: 120_000, origin } } },
    });
    expect(one('five-hour-usage', {}, meta('session')).sources).toEqual([
      { kind: 'limits-cache', path, age: 120_000, origin: 'session' },
    ]);
    expect(one('five-hour-usage', {}, meta('usage-api')).sources).toEqual([
      { kind: 'limits-cache', path, age: 120_000, origin: 'usage-api' },
    ]);
    expect(one('weekly-usage', {}, meta('session')).sources).toContainEqual({
      kind: 'payload',
      path: 'rate_limits.seven_day.used_percentage',
    });
    expect(one('five-hour-usage').sources).toEqual([{ kind: 'payload', path }]);
  });

  it('marks usage cache windows and ages', () => {
    const r = one(
      'five-hour-usage',
      {},
      { meta: { limitWindows: { five_hour: { kind: 'usage-cache' } }, ages: { usage: 240_000 } } },
    );
    expect(r.sources).toEqual([
      { kind: 'usage-cache', path: 'rate_limits.five_hour.used_percentage', age: 240_000 },
    ]);
    const t1 = one('message-count', {}, { meta: { ages: { transcript: 12_000 } } });
    expect(t1.sources).toEqual([{ kind: 'transcript', age: 12_000 }]);
    const g = one('git-branch', {}, { meta: { ages: { transcript: 12_000, usage: 1 } } });
    expect(g.sources).toEqual([{ kind: 'git' }]);
    expect(one('gsd-phase', {}, { meta: { gsdPath: 'x/STATE.md' } }).sources).toEqual([
      { kind: 'gsd', path: 'x/STATE.md' },
    ]);
  });

  it('names absent payload fields with the Claude Code version', () => {
    const p = samplePayload(NOW.getTime());
    delete p.prompt_cache;
    const r = one('cache-timer', { payload: p });
    expect(r.status).toBe('empty');
    expect(r.empty!.code).toBe('payload-field-absent');
    expect(r.empty!.text).toContain('prompt_cache');
    expect(r.empty!.text).toContain('2.1.251');
    expect(r.sources).toEqual([]);
    const q = samplePayload(NOW.getTime());
    delete q.prompt_cache!.last_miss_cause;
    const m = one('cache-miss-cause', { payload: q });
    expect(m.empty!.code).toBe('payload-field-absent');
    expect(m.empty!.text).toContain('prompt_cache.last_miss_cause');
    expect(m.empty!.text).toContain('2.1.260');
  });

  it('uses hints for blind widgets', () => {
    for (const type of ['hostname', 'username', 'memory', 'load-average', 'platform']) {
      expect(one(type).sources, type).toEqual([{ kind: 'system' }]);
    }
    expect(one('clock').sources).toContainEqual({ kind: 'clock' });
    expect(one('date').sources).toContainEqual({ kind: 'clock' });
    const cmd = withoutSideEffects(() =>
      inspectRows({
        ...ctxWith({
          config: { lines: [[item('command', { options: { command: 'echo hi', timeout: 5000 } })]] },
        }),
        cwd: process.cwd(),
        env: { ...process.env },
      }),
    )[0]!;
    expect(cmd.sources).toEqual([{ kind: 'config', path: 'options.command' }]);
  });

  it('collapses provider keys and keeps env widget names', () => {
    const r = one('five-hour-usage', { env: { ANTHROPIC_API_KEY: 'x' }, payload: { session_id: 's' } });
    expect(r.sources.filter((s) => s.kind === 'env')).toEqual([{ kind: 'env', path: 'provider' }]);
    const e = withoutSideEffects(() =>
      inspectRows(
        ctxWith({
          env: { MY_VAR: 'v' },
          config: { lines: [[item('env', { options: { name: 'MY_VAR' } })]] },
        }),
      ),
    )[0]!;
    expect(e.sources).toContainEqual({ kind: 'env', path: 'MY_VAR' });
  });

  it('never copies values into sources', () => {
    const b = getScenario('api-key-user')!.build(SCENARIO_NOW);
    const all = ALL_WIDGETS.filter((d) => d.type !== 'command').map((d) => d.type);
    const got = rows(all, {
      payload: b.payload,
      env: b.env,
      git: b.data.git,
      gsd: b.data.gsd,
      transcript: b.data.transcript,
      history: b.data.history,
      agents: b.data.agents,
    });
    const text = JSON.stringify(got.map((r) => r.sources));
    expect(text).not.toContain('sk-ant-scenario');
    expect(text).toContain('"provider"');
  });
});

describe('normalizeResult', () => {
  const def = getWidget('model')!;

  it('drops blank text and sanitizes', () => {
    expect(normalizeResult(def, '  ')).toBeNull();
    expect(normalizeResult(def, null)).toBeNull();
    expect(normalizeResult(def, { text: 'a\u0000\u0007b', color: 'red' })).toEqual({
      text: 'ab',
      color: 'red',
    });
    expect(normalizeResult(def, { text: 'a\u001b[2Jb' })).toEqual({ text: sanitize('a\u001b[2Jb') });
  });

  it('matches renderValue for every widget', () => {
    withoutSideEffects(() => {
      for (const d of ALL_WIDGETS) {
        if (d.type === 'command') continue;
        const it = item(d.type);
        expect(renderValue(ctxWith(), d, it), d.type).toEqual(normalizeResult(d, d.render(ctxWith(), it)));
      }
    });
  });
});

describe('lineReport', () => {
  it('flags a line wider than the max', () => {
    const ctx = ctxWith({ width: 20, config: { autoWrap: false } });
    const [l] = lineReport(ctx);
    expect(l!.cut).toBe(true);
    expect(l!.width).toBeGreaterThan(l!.max!);
  });

  it('is empty for the tui style', () => {
    expect(lineReport(ctxWith({ config: { style: 'tui' } }))).toEqual([]);
  });
});

describe('emptyReason', () => {
  const code = (ctx: RenderContext, it: WidgetItem) => emptyReason(ctx, it).code;
  const bare: StatusPayload = { session_id: 's' };

  it('names unknown types and missing options', () => {
    const ctx = ctxWith();
    expect(emptyReason(ctx, item('nope'))).toEqual({
      code: 'unknown-type',
      text: t('explain.reason.unknown-type', { type: 'nope' }),
    });
    expect(emptyReason(ctx, item('command'))).toEqual({
      code: 'missing-option',
      text: t('explain.reason.missing-option', { key: 'command' }),
    });
    expect(emptyReason(ctx, item('env'))).toEqual({
      code: 'missing-option',
      text: t('explain.reason.missing-option', { key: 'name' }),
    });
  });

  it('separates no GSD project from GSD with nothing', () => {
    expect(emptyReason(ctxWith({ gsd: () => null }), item('gsd-phase'))).toEqual({
      code: 'no-gsd',
      text: t('explain.reason.no-gsd'),
    });
    expect(emptyReason(ctxWith(), item('gsd-phase'))).toEqual({
      code: 'no-data',
      text: t('explain.reason.gsdNothing'),
    });
  });

  it('names the provider when it has no plan limits', () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ ANTHROPIC_API_KEY: 'x' }, t('explain.provider.apiKey')],
      [{ CLAUDE_CODE_USE_BEDROCK: '1' }, t('explain.provider.bedrock')],
      [{ CLAUDE_CODE_USE_VERTEX: '1' }, t('explain.provider.vertex')],
      [{ CLAUDE_CODE_USE_FOUNDRY: '1' }, t('explain.provider.foundry')],
      [
        { ANTHROPIC_BASE_URL: 'https://llm.example.com' },
        t('explain.provider.gateway', { host: 'llm.example.com' }),
      ],
    ];
    for (const [env, provider] of cases) {
      const r = emptyReason(ctxWith({ env, payload: bare }), item('five-hour-usage'));
      expect(r, JSON.stringify(env)).toEqual({
        code: 'provider-no-plan-limits',
        text: t('explain.reason.provider-no-plan-limits', { provider }),
      });
      expect(r.text).toContain(provider);
    }
  });

  it('says limits-expired for a window that rolled over', () => {
    const now = NOW.getTime();
    const payload = { rate_limits: { seven_day: { used_percentage: 10, resets_at: now / 1000 + 86400 } } };
    const limits = () => ({ windows: {}, expired: ['five_hour'], storeAt: now - 60_000 });
    const row = withoutSideEffects(
      () =>
        inspectRows(
          ctxWith({ env: {}, payload, limits, config: { lines: [[item('five-hour-usage')]] } }),
        )[0]!,
    );
    expect(row.empty).toEqual({ code: 'limits-expired', text: t('explain.reason.limits-expired') });
    const week = withoutSideEffects(
      () =>
        inspectRows(ctxWith({ env: {}, payload, limits, config: { lines: [[item('weekly-usage')]] } }))[0]!,
    );
    expect(week.status).toBe('shown');
    const other = withoutSideEffects(
      () =>
        inspectRows(
          ctxWith({
            env: {},
            payload,
            limits: () => ({ windows: {}, expired: [], storeAt: null }),
            config: { lines: [[item('five-hour-usage')]] },
          }),
        )[0]!,
    );
    expect(other.empty?.code).toBe('no-data');
    const broken = () => {
      throw new Error('x');
    };
    expect(
      withoutSideEffects(
        () =>
          inspectRows(
            ctxWith({ env: {}, payload, limits: broken, config: { lines: [[item('five-hour-usage')]] } }),
          )[0]!,
      ).empty?.code,
    ).toBe('no-data');
  });

  it('says projection-warming early in the window', () => {
    const sec = NOW.getTime() / 1000;
    const payload = { rate_limits: { five_hour: { used_percentage: 3, resets_at: sec + 5 * 3600 - 600 } } };
    const lines = [[item('usage-projection')]];
    const row = withoutSideEffects(() => inspectRows(ctxWith({ env: {}, payload, config: { lines } }))[0]!);
    expect(row.empty).toEqual({ code: 'projection-warming', text: t('explain.reason.projection-warming') });
    const week = { ...item('usage-projection'), options: { window: '7d' } };
    expect(emptyReason(ctxWith({ env: {}, payload }), week).code).toBe('no-data');
    const shown = withoutSideEffects(() => inspectRows(ctxWith({ config: { lines } }))[0]!);
    expect(shown.status).toBe('shown');
    expect(emptyReason(ctxWith({ env: {}, payload }), item('limit-eta')).code).toBe('projection-warming');
  });

  it('explains a limit-risk chip below the threshold', () => {
    const row = withoutSideEffects(
      () => inspectRows(ctxWith({ config: { lines: [[item('limit-risk')]] } }))[0]!,
    );
    expect(row.empty).toEqual({ code: 'no-data', text: t('explain.reason.belowRisk') });
    const safe = { ...item('limit-eta'), options: { hideWhenSafe: true } };
    expect(emptyReason(ctxWith(), safe).text).toBe(t('explain.reason.limitSafe'));
  });

  it('says when no rate limits arrived', () => {
    expect(emptyReason(ctxWith({ env: {}, payload: bare }), item('five-hour-usage'))).toEqual({
      code: 'no-rate-limits',
      text: t('explain.reason.no-rate-limits'),
    });
    expect(code(ctxWith({ env: {} }), item('five-hour-usage'))).toBe('no-data');
  });

  it('covers context, git, transcript and replies', () => {
    const noCtx = ctxWith({ payload: bare, transcript: () => null });
    expect(emptyReason(noCtx, item('context-percentage'))).toEqual({
      code: 'no-context-window',
      text: t('explain.reason.no-context-window'),
    });
    expect(emptyReason(ctxWith({ git: () => null }), item('git-branch'))).toEqual({
      code: 'no-git',
      text: t('explain.reason.no-git'),
    });
    expect(emptyReason(ctxWith({ transcript: () => null }), item('skills'))).toEqual({
      code: 'no-transcript',
      text: t('explain.reason.no-transcript'),
    });
    expect(emptyReason(ctxWith({ payload: bare }), item('tokens-input'))).toEqual({
      code: 'no-replies',
      text: t('explain.reason.no-replies'),
    });
  });

  it('falls back to no-data', () => {
    expect(emptyReason(ctxWith(), item('clock'))).toEqual({
      code: 'no-data',
      text: t('explain.reason.no-data'),
    });
    expect(emptyReason(ctxWith(), item('command', { options: { command: 'false' } }))).toEqual({
      code: 'no-data',
      text: t('explain.reason.commandEmpty'),
    });
  });

  it('is wired into rows', () => {
    const [unknown, git, boom] = rowsFor(
      ctxWith({ git: () => null, config: { lines: [[item('nope'), item('git-branch'), item('boom')]] } }),
    );
    expect(unknown!.empty!.code).toBe('unknown-type');
    expect(git!.empty!.code).toBe('no-git');
    expect(boom!.empty).toEqual({ code: 'error', text: t('explain.reason.error') });
  });
});

describe('sessionNotes', () => {
  const full = { used_percentage: 100, resets_at: null };
  it('names the full limits and a session without replies through t()', () => {
    expect(sessionNotes({ rate_limits: { five_hour: full, seven_day: full } })).toEqual([
      t('doctor.note.limitFull', { names: t('doctor.limit.both') }),
      t('doctor.note.noReplies'),
    ]);
    expect(sessionNotes({ rate_limits: { seven_day: full } })[0]).toBe(
      t('doctor.note.limitFull', { names: t('doctor.limit.seven_day') }),
    );
    expect(t('doctor.note.limitFull', { names: t('doctor.limit.five_hour') })).toMatch(
      /^Your 5-hour usage limit/,
    );
    expect(sessionNotes(samplePayload(NOW.getTime()))).toEqual([]);
  });
});

describe('ledger widgets', () => {
  const ledgerItem = (type: string): WidgetItem => ({ id: type, type });

  it('say no-ledger before no-replies', () => {
    const ctx = ctxWith({ ledger: () => null, payload: { session_id: 's' } });
    for (const type of ['cost-today', 'cost-week', 'cost-project'])
      expect(emptyReason(ctx, ledgerItem(type))).toEqual({
        code: 'no-ledger',
        text: t('explain.reason.no-ledger'),
      });
    expect(emptyReason(ctx, ledgerItem('session-cost')).code).toBe('no-replies');
  });

  it('trace ledger reads with their age', () => {
    const row = withoutSideEffects(
      () =>
        inspectRows(ctxWith({ config: { lines: [[ledgerItem('cost-project')]] } }), {
          meta: { ages: { ledger: 5_000 } },
        })[0]!,
    );
    expect(row.value).toBe('$62.00');
    expect(row.sources).toEqual([{ kind: 'ledger', age: 5_000 }]);
  });
});
