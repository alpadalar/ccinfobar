import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { sanitize } from '../../src/core/ansi.js';
import { language, t } from '../../src/core/i18n/index.js';
import {
  type EmptyCode,
  emptyReason,
  inspectRows,
  jobEmpty,
  jobReason,
  lineReport,
  sessionNotes,
  sinceFor,
} from '../../src/core/inspect.js';
import { normalizeResult, renderValue } from '../../src/core/renderer.js';
import { samplePayload } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW } from '../../src/core/scenarios.js';
import type { RenderContext, StatusPayload, WidgetDef, WidgetItem } from '../../src/core/types.js';
import type { JobEnvelope } from '../../src/data/jobs/runner.js';
import { findUp } from '../../src/data/repos.js';
import { parseTranscriptText } from '../../src/data/transcript.js';
import { ALL_WIDGETS, getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, withLang, withoutSideEffects } from '../helpers.js';

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
    expect(one('jj-revision').sources).toEqual([{ kind: 'jj' }]);
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

  it('maps model windows to their model key', () => {
    const lw = { kind: 'limits-cache' as const, age: 60_000, origin: 'usage-api' as const };
    const meta = { meta: { limitWindows: { 'model:fable': lw }, limitModels: ['model:fable'] } };
    const src = one('weekly-model-usage', {}, meta).sources;
    expect(src).toContainEqual(expect.objectContaining({ kind: 'limits-cache', origin: 'usage-api' }));
    expect(src.some((x) => x.kind === 'payload')).toBe(false);
    const other = {
      meta: { limitWindows: { 'model:opus': lw }, limitModels: ['model:fable', 'model:opus'] },
    };
    expect(one('weekly-model-usage', {}, other).sources.some((x) => x.kind === 'limits-cache')).toBe(false);
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

  it('names the version for the newer payload fields', () => {
    const v = (path: string) => sinceFor(path);
    expect(v('prompt_cache.miss_causes')).toContain('2.1.260');
    expect(v('prompt_cache.recache_tokens_if_cold')).toContain('2.1.251');
    expect(v('prompt_cache.warm')).toContain('2.1.251');
    expect(v('rate_limits.spend_limit.used_usd')).toContain('2.1.284');
    expect(v('rate_limits.spend_limit.limit_usd')).toContain('2.1.284');
    expect(v('rate_limits.spend_limit')).toContain('2.1.251');
    expect(v('worktree.name')).toContain('2.1.69');
    expect(v('workspace.added_dirs')).toContain('2.1.47');
    expect(v('model.id')).toBe('');
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

  it('cuts only under truncate and lists priority drops', () => {
    const lines = [[item('model'), item('git-branch'), item('gsd-phase'), item('context-percentage')]];
    const rep = (overflow: 'truncate' | 'wrap' | 'priority') =>
      withoutSideEffects(() =>
        lineReport(ctxWith({ width: 40, config: { widthOffset: 0, overflow, lines } })),
      )[0]!;
    expect(rep('truncate').cut).toBe(true);
    expect(rep('wrap').cut).toBe(false);
    const p = rep('priority');
    expect(p.cut).toBe(false);
    expect(p.width).toBeGreaterThan(40);
    expect(p.dropped?.[0]).toBe('gsd-phase');
    expect(rep('truncate').dropped).toBeUndefined();
    expect(rep('truncate').overflow).toBeUndefined();
  });

  it('flags a cut under wrap and priority too (IN-03)', () => {
    const wide = [[item('text', { options: { text: 'x'.repeat(60) } })]];
    const two = [[item('model'), item('text', { id: 't', options: { text: 'y'.repeat(60) } })]];
    const rep = (overflow: 'wrap' | 'priority', lines: WidgetItem[][]) =>
      withoutSideEffects(() =>
        lineReport(ctxWith({ width: 40, config: { widthOffset: 0, overflow, lines } })),
      )[0]!;
    expect(rep('priority', wide)).toMatchObject({ cut: true, overflow: 'priority' });
    expect(rep('wrap', wide)).toMatchObject({ cut: true, overflow: 'wrap' });
    expect(rep('wrap', two)).toMatchObject({ cut: true, overflow: 'wrap' });
  });
});

describe('priority overflow rows', () => {
  const lines = [[item('model'), item('git-branch'), item('gsd-phase'), item('context-percentage')]];

  it('marks dropped rows and carries the effective priority', () => {
    const rows = rowsFor(ctxWith({ width: 40, config: { widthOffset: 0, overflow: 'priority', lines } }));
    const p = rows.find((r) => r.id === 'gsd-phase')!;
    expect(p.status).toBe('hidden');
    expect(p.empty).toEqual({ code: 'dropped-by-priority', text: 'dropped by priority at width 40' });
    expect(rows.find((r) => r.id === 'model')!.status).toBe('shown');
    expect(rows.map((r) => r.priority)).toEqual([70, 50, 30, 70]);
  });

  it('drops nothing when the line fits, wraps or uses the panel', () => {
    for (const config of [
      { overflow: 'priority' as const, lines },
      { overflow: 'wrap' as const, lines, widthOffset: 0 },
      { overflow: 'priority' as const, lines, style: 'tui' as const, widthOffset: 0 },
    ]) {
      const rows = rowsFor(ctxWith({ width: config.widthOffset === 0 ? 40 : null, config }));
      expect(rows.some((r) => r.empty?.code === 'dropped-by-priority')).toBe(false);
    }
  });

  it('leaves layout rows without a priority', () => {
    const rows = rowsFor(ctxWith({ config: { lines: [[item('text', { options: { text: 'x' } })]] } }));
    expect(rows[0]!.priority).toBeUndefined();
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
    const limits = () => ({ windows: {}, expired: ['five_hour'] });
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
            limits: () => ({ windows: {}, expired: [] }),
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
    expect(emptyReason(ctxWith({ git: () => null, jj: () => null }), item('jj-revision'))).toEqual({
      code: 'no-jj',
      text: t('explain.reason.no-jj'),
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

describe('workspace mode rows', () => {
  const repos = () => ({
    root: '/w',
    total: 1,
    repos: [{ name: 'api', branch: 'main', detached: false, activity: null, hidden: false }],
  });
  const ws = [item('git-branch'), item('workspace-repos')];

  it('reports empty git rows as hidden by workspace mode', () => {
    const rows = rowsFor(ctxWith({ git: () => null, repos, config: { lines: [ws] } }));
    expect(rows[0]).toMatchObject({ status: 'hidden', empty: { code: 'workspace-mode' } });
    expect(rows[0]!.empty!.text).toBe(t('explain.reason.workspace-mode'));
    expect(rows[1]).toMatchObject({ status: 'shown', value: 'api (main)' });
  });

  it('keeps empty git rows without workspace mode', () => {
    const rows = rowsFor(ctxWith({ git: () => null, config: { lines: [ws] } }));
    expect(rows[0]).toMatchObject({ status: 'empty', empty: { code: 'no-git' } });
    const off = [item('git-branch'), item('workspace-repos', { options: { hideGitPlaceholders: false } })];
    const rows2 = rowsFor(ctxWith({ git: () => null, repos, config: { lines: [off] } }));
    expect(rows2[0]).toMatchObject({ status: 'empty', empty: { code: 'no-git' } });
  });

  it('explains an empty workspace-repos row without git', () => {
    const git = vi.fn(() => null);
    const lines = [[item('workspace-repos')]];
    const inside = rowsFor(ctxWith({ git, repos: () => null, config: { lines } }));
    expect(inside[0]).toMatchObject({ status: 'hidden', empty: { code: 'inside-repo' } });
    const none = rowsFor(
      ctxWith({ git, repos: () => ({ root: '/w', repos: [], total: 0 }), config: { lines } }),
    );
    expect(none[0]).toMatchObject({ status: 'hidden', empty: { code: 'no-child-repos' } });
    const shown = [[item('workspace-repos', { hideEmpty: false })]];
    const placeholder = rowsFor(ctxWith({ git, repos: () => null, config: { lines: shown } }));
    expect(placeholder[0]).toMatchObject({ status: 'empty', empty: { code: 'inside-repo' } });
    expect(git).not.toHaveBeenCalled();
  });

  it('measures lines as the real render does', () => {
    const ctx = ctxWith({ git: () => null, repos, config: { lines: [ws] } });
    expect(lineReport(ctx)[0]!.width).toBe('repos: api (main)'.length);
  });
});

describe('tool-activity empty reasons', () => {
  const ta: WidgetItem = { id: 'tool-activity', type: 'tool-activity' };

  it('names a missing transcript, then no tools for the scope', () => {
    expect(emptyReason(ctxWith({ transcript: () => null }), ta).code).toBe('no-transcript');
    const empty = emptyReason(ctxWith({ transcript: () => parseTranscriptText('') }), ta);
    expect(empty.code).toBe('no-tools');
    expect(empty.text).toBe('no tool is running and none ran in this turn');
    const session = emptyReason(ctxWith({ transcript: () => parseTranscriptText('') }), {
      ...ta,
      options: { scope: 'session' },
    });
    expect(session.text).toBe('no tool is running and none ran in this session');
  });

  it('reports an empty row through inspectRows', () => {
    const ctx = ctxWith({ transcript: () => parseTranscriptText(''), config: { lines: [[ta]] } });
    expect(inspectRows(ctx)[0]).toMatchObject({ status: 'empty', empty: { code: 'no-tools' } });
  });
});

describe('turn-timer and env-counts empty reasons', () => {
  const tt: WidgetItem = { id: 'turn-timer', type: 'turn-timer' };
  const env: WidgetItem = { id: 'env-counts', type: 'env-counts' };

  it('names a missing turn, then a hidden ended turn', () => {
    const none = emptyReason(ctxWith({ hooks: () => null, transcript: () => parseTranscriptText('') }), tt);
    expect(none).toEqual({ code: 'no-turn', text: t('explain.reason.no-turn') });
    const ended = { ...parseTranscriptText(''), promptStart: 1, turnEnd: 2 };
    const hidden = emptyReason(ctxWith({ hooks: () => null, transcript: () => ended }), {
      ...tt,
      options: { afterStop: 'hide' },
    });
    expect(hidden).toEqual({ code: 'no-data', text: t('explain.reason.turnHidden') });
  });

  it('says every count is zero when the environment was read', () => {
    const zero = { claudeMd: 0, agentsMd: 0, rules: 0, mcp: 0, hooks: 0, hooksDisabled: false, files: [] };
    const ctx = ctxWith({ environment: () => zero, config: { lines: [[env]] } });
    expect(inspectRows(ctx)[0]).toMatchObject({ status: 'empty', empty: { code: 'all-zero' } });
    expect(emptyReason(ctxWith({ environment: () => null }), env).code).toBe('no-data');
  });
});

describe('permission-wait empty reasons', () => {
  const pw: WidgetItem = { id: 'permission-wait', type: 'permission-wait' };

  it('asks for hooks, names a missing hook log, then no wait', () => {
    expect(emptyReason(ctxWith({ hooks: () => null }), pw)).toEqual({
      code: 'needs-hooks',
      text: 'needs `ccinfobar install --hooks`',
    });
    expect(emptyReason(ctxWith({ hooks: () => null }), pw, undefined, { hooksInstalled: true })).toEqual({
      code: 'no-hook-state',
      text: 'hooks are installed but this session has no hook log yet',
    });
    expect(emptyReason(ctxWith(), pw)).toEqual({
      code: 'no-data',
      text: 'no permission prompt waited in this turn',
    });
  });

  it('passes the hook meta through inspectRows', () => {
    const ctx = ctxWith({ hooks: () => null, config: { lines: [[pw]] } });
    expect(inspectRows(ctx)[0]).toMatchObject({ status: 'empty', empty: { code: 'needs-hooks' } });
    expect(inspectRows(ctx, { meta: { hooksInstalled: true } })[0]).toMatchObject({
      empty: { code: 'no-hook-state' },
    });
  });
});

describe('env-counts mcp health note', () => {
  const ec = (options?: WidgetItem['options']): WidgetItem => ({
    id: 'env-counts',
    type: 'env-counts',
    ...(options ? { options } : {}),
  });

  it('notes no-mcp-health on a shown row with mcpHealth on', () => {
    const on = rowsFor(ctxWith({ config: { lines: [[ec({ mcpHealth: true })]] } }))[0]!;
    expect(on).toMatchObject({ status: 'shown', value: 'CLAUDE.md 2 · rules 3 · MCP 4 · hooks 5' });
    expect(on.note).toEqual({ code: 'no-mcp-health', text: 'Claude Code does not expose MCP health' });
    expect(rowsFor(ctxWith({ config: { lines: [[ec()]] } }))[0]!.note).toBeUndefined();
  });
});

describe('job empty reasons', () => {
  const NEW: EmptyCode[] = [
    'job-pending',
    'job-error',
    'nonessential-traffic-off',
    'stale',
    'gh-missing',
    'gh-auth',
    'gh-host',
    'merge-request',
    'no-ci-checks',
    'not-scalar',
    'path-miss',
  ];
  const now = 1_800_000_000_000;
  const okEnv = (at: number): JobEnvelope<unknown> => ({
    v: 1,
    key: 'status',
    fetchedAt: at,
    ok: true,
    value: { a: 1 },
    lastGood: { a: 1 },
    lastGoodAt: at,
  });
  const failed = (lastGood: unknown, lastGoodAt?: number): JobEnvelope<unknown> => ({
    v: 1,
    key: 'status',
    fetchedAt: now - 1000,
    ok: false,
    value: null,
    error: 'http-503',
    blockedUntil: now + 60_000,
    lastGood,
    ...(lastGoodAt !== undefined ? { lastGoodAt } : {}),
  });
  const OFF = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };

  it('has a message for every new code', () => {
    for (const code of NEW) {
      const text = t(`explain.reason.${code}`);
      expect(typeof text, code).toBe('string');
      expect(text.length, code).toBeGreaterThan(0);
    }
  });

  it('says nonessential-traffic-off only for a missing auto job under the flag', () => {
    expect(jobReason(null, 'auto', OFF, now, 60_000)).toBe('nonessential-traffic-off');
    expect(jobReason(null, 'explicit', OFF, now, 60_000)).toBe('job-pending');
    expect(jobReason(null, 'auto', { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' }, now, 60_000)).toBe(
      'job-pending',
    );
  });

  it('says job-pending for a missing envelope', () => {
    expect(jobReason(null, 'auto', {}, now, 60_000)).toBe('job-pending');
    expect(jobReason(null, 'none', {}, now, 60_000)).toBe('job-pending');
  });

  it('says job-error for a failure without a last good value', () => {
    expect(jobReason(failed(null), 'auto', {}, now, 60_000)).toBe('job-error');
    expect(jobReason(failed(undefined), 'explicit', {}, now, 60_000)).toBe('job-error');
  });

  it('says stale past the window, from the shown value time', () => {
    expect(jobReason(okEnv(now - 30_000), 'auto', {}, now, 60_000)).toBeNull();
    expect(jobReason(okEnv(now - 61_000), 'auto', {}, now, 60_000)).toBe('stale');
    expect(jobReason(failed({ a: 1 }, now - 30_000), 'auto', {}, now, 60_000)).toBeNull();
    expect(jobReason(failed({ a: 1 }, now - 90_000), 'auto', {}, now, 60_000)).toBe('stale');
    expect(jobReason(failed({ a: 1 }), 'auto', {}, now, 60_000)).toBe('stale');
  });

  it('builds the text with the error and the CCINFOBAR_NO_JOBS note', () => {
    expect(jobEmpty(okEnv(now), 'auto', {}, now, 60_000)).toBeNull();
    const err = jobEmpty({ ...failed(null), error: 'bad\u001b[31m' }, 'auto', {}, now, 60_000)!;
    expect(err.code).toBe('job-error');
    expect(err.text).toContain('bad');
    expect(err.text).not.toContain('\u001b');
    const pending = jobEmpty(null, 'auto', {}, now, 60_000)!;
    expect(pending).toEqual({ code: 'job-pending', text: t('explain.reason.job-pending') });
    const off = jobEmpty(null, 'explicit', { CCINFOBAR_NO_JOBS: '1' }, now, 60_000)!;
    expect(off.code).toBe('job-pending');
    expect(off.text).toBe(t('explain.reason.job-pending') + t('explain.job.noJobs'));
  });
});

describe('service-status explain', () => {
  const now = NOW.getTime();
  const env = (value: unknown, ok = true, at = now - 30_000): JobEnvelope<unknown> => ({
    v: 1,
    key: 'status',
    fetchedAt: ok ? at : now - 1000,
    ok,
    value: ok ? value : null,
    ...(ok ? {} : { error: 'timeout' }),
    lastGood: value,
    lastGoodAt: at,
  });
  const none = { indicator: 'none', description: 'All Systems Operational', incidents: [] };
  const why = (e: JobEnvelope<unknown> | null, options: WidgetItem['options'] = {}, extra = {}) =>
    withoutSideEffects(() =>
      emptyReason(ctxWith({ jobs: () => ({ job: () => e as never }), ...extra }), {
        id: 's',
        type: 'service-status',
        options,
      }),
    );

  it('reports job states first', () => {
    expect(why(null).code).toBe('job-pending');
    expect(why(null, {}, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }).code).toBe(
      'nonessential-traffic-off',
    );
    expect(why(env(none), {}, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }).code).toBe(
      'nonessential-traffic-off',
    );
    expect(why(env(null, false)).code).toBe('job-error');
    expect(why(env(none, true, now - 31 * 60_000)).code).toBe('stale');
  });

  it('says all systems operational when all is well', () => {
    expect(why(env(none))).toEqual({ code: 'no-data', text: t('explain.reason.serviceOk') });
    expect(why(env(none), { components: 'Claude Code' }).text).toBe(
      t('explain.reason.serviceOkFiltered', { components: 'Claude Code' }),
    );
    expect(why(env(none, false, now - 60_000)).text).toBe(t('explain.reason.serviceStaleOk'));
  });

  it('is hidden in rows with the reason', () => {
    const ctx = ctxWith({
      config: { lines: [[{ id: 's', type: 'service-status' }]] },
      jobs: () => ({ job: () => env(none) as never }),
    });
    const [row] = rowsFor(ctx);
    expect(row?.status).toBe('hidden');
    expect(row?.empty?.text).toBe(t('explain.reason.serviceOk'));
    expect(row?.sources).toContainEqual(expect.objectContaining({ kind: 'job', path: 'status' }));
  });
});

describe('http explain', () => {
  const now = NOW.getTime();
  const PATH = '$.data.balance';
  const item = (options: WidgetItem['options'] = {}): WidgetItem => ({
    id: 'h',
    type: 'http',
    options: { url: 'https://api.x.com/v1', path: PATH, ...options },
  });
  const okEnv = (r: unknown, at = now - 30_000): JobEnvelope<unknown> => ({
    v: 1,
    key: 'http-0123456789abcdef',
    fetchedAt: at,
    ok: true,
    value: { paths: { [PATH]: r } },
    lastGood: { paths: { [PATH]: r } },
    lastGoodAt: at,
  });
  const failed = (error: string, lastGood: unknown = null, lastGoodAt?: number): JobEnvelope<unknown> => ({
    v: 1,
    key: 'http-0123456789abcdef',
    fetchedAt: now - 1000,
    ok: false,
    value: null,
    error,
    lastGood,
    ...(lastGoodAt !== undefined ? { lastGoodAt } : {}),
  });
  const why = (e: JobEnvelope<unknown> | null, it: WidgetItem = item(), env = {}) =>
    withoutSideEffects(() => emptyReason(ctxWith({ jobs: () => ({ job: () => e as never }), env }), it));

  it('says missing-option for an empty url', () => {
    expect(why(null, item({ url: '' }))).toEqual({
      code: 'missing-option',
      text: t('explain.reason.missing-option', { key: 'url' }),
    });
  });

  it('shows the url and path parse errors', () => {
    const url = why(null, item({ url: 'https://${H}.x.com' }));
    expect(url.code).toBe('bad-option');
    expect(url.text).toContain('placeholders are only allowed in query values');
    const path = why(null, item({ path: '$.foo-bar' }));
    expect(path.code).toBe('bad-option');
    expect(path.text).toContain("unexpected '-' at 5");
  });

  it('names the field of a refused item and maps insecure-url', () => {
    const denied = why(null, item({ headers: 'X=$ANTHROPIC_API_KEY' }));
    expect(denied).toEqual({
      code: 'bad-option',
      text: t('explain.reason.bad-option', {
        key: 'headers',
        error: 'env ANTHROPIC_API_KEY is not allowed in http items',
      }),
    });
    const plain = why(null, item({ url: 'http://x.example/?k=${K}' }));
    expect(plain.text).toContain('secrets need https or localhost');
    expect(why(failed('insecure-url')).text).toContain(t('explain.job.insecure-url'));
  });

  it('reports path-miss and not-scalar from the job', () => {
    expect(why(okEnv({ ok: false, code: 'path-miss' })).code).toBe('path-miss');
    expect(why(okEnv({ ok: false, code: 'not-scalar' })).code).toBe('not-scalar');
  });

  it('reports the job states with the error code', () => {
    expect(why(null).code).toBe('job-pending');
    expect(why(null, item(), { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }).code).toBe('job-pending');
    const err = why(failed('env RELAY_TOKEN not set'));
    expect(err.code).toBe('job-error');
    expect(err.text).toContain('env RELAY_TOKEN not set');
    expect(why(failed('http-401')).text).toContain('http-401');
    const old = { paths: { [PATH]: { ok: true, v: 1 } } };
    expect(why(failed('http-503', old, now - 25 * 3_600_000)).code).toBe('stale');
    expect(why(okEnv({ ok: true, v: 1 }, now - 25 * 3_600_000)).code).toBe('stale');
  });

  it('says job-pending when the cached value lacks this path', () => {
    const e = { ...okEnv({ ok: true, v: 1 }), value: { paths: {} } };
    expect(why(e).code).toBe('job-pending');
  });

  it('notes the last error when the last good value is shown', () => {
    const ctx = ctxWith({
      config: { lines: [[item()]] },
      jobs: () => ({
        job: () => failed('http-401', { paths: { [PATH]: { ok: true, v: 2 } } }, now - 60_000) as never,
      }),
    });
    const [row] = rowsFor(ctx);
    expect(row?.status).toBe('shown');
    expect(row?.note?.code).toBe('job-error');
    expect(row?.note?.text).toContain('http-401');
  });
});

describe('rule rows', () => {
  const atPct = (pct: number): StatusPayload => {
    const p = samplePayload(NOW.getTime());
    p.context_window!.used_percentage = pct;
    delete p.context_window!.current_usage;
    return p;
  };
  const one = (it: WidgetItem, payload = atPct(42)) =>
    rowsFor(ctxWith({ payload, config: { lines: [[it]] } }))[0]!;

  it('reports a widget hidden by showWhen without rendering it', () => {
    seen.length = 0;
    const r = one(item('probe', { showWhen: 'context.pct >= 70' }));
    expect(r.status).toBe('hidden');
    expect(r.empty!.code).toBe('hidden-by-rule');
    expect(r.empty!.text).toContain('showWhen "context.pct >= 70"');
    expect(r.empty!.text).toContain('context.pct = 42');
    expect(r.empty!.text).toBe(
      t('explain.reason.hidden-by-rule', {
        key: 'showWhen',
        rule: 'context.pct >= 70',
        metric: 'context.pct',
        value: '42',
      }),
    );
    expect(seen).toHaveLength(0);
    expect(r.sources.some((s) => s.kind === 'payload' && s.path?.startsWith('context_window'))).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it('lists the metric sources for every widget that reads it (IN-02)', () => {
    const rows = rowsFor(
      ctxWith({
        payload: atPct(42),
        config: {
          lines: [
            [
              item('probe', { id: 'a', showWhen: 'context.pct >= 70' }),
              item('probe', { id: 'b', showWhen: 'context.pct >= 70' }),
            ],
          ],
        },
      }),
    );
    const ctxSources = (r: (typeof rows)[number]) =>
      r.sources.filter((s) => s.kind === 'payload' && s.path?.startsWith('context_window'));
    expect(ctxSources(rows[0]!).length).toBeGreaterThan(0);
    expect(ctxSources(rows[1]!)).toEqual(ctxSources(rows[0]!));
  });

  it('shows the row when the rule passes', () => {
    const r = one(item('probe', { showWhen: 'context.pct >= 70' }), atPct(80));
    expect(r).toMatchObject({ status: 'shown', value: 'p' });
    expect(r.warning).toBeUndefined();
  });

  it('names hideWhen and a missing value', () => {
    const hid = one(item('probe', { hideWhen: 'context.pct < 50' }));
    expect(hid.empty!.text).toBe(
      t('explain.reason.hidden-by-rule', {
        key: 'hideWhen',
        rule: 'context.pct < 50',
        metric: 'context.pct',
        value: '42',
      }),
    );
    const none = rowsFor(
      ctxWith({
        hooks: () => null,
        config: { lines: [[item('probe', { showWhen: 'permission.waiting' })]] },
      }),
    )[0]!;
    expect(none.status).toBe('hidden');
    expect(none.empty!.text).toContain(`permission.waiting = ${t('explain.value.noData')}`);
  });

  it.skipIf(findUp(os.tmpdir(), '.git', 'any') !== null)('names a flag rule outside a repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-rule-'));
    try {
      const ctx = { ...ctxWith({ config: { lines: [[item('probe', { hideWhen: ['!git'] })]] } }), cwd: dir };
      const r = rowsFor(ctx)[0]!;
      expect(r.status).toBe('hidden');
      expect(r.empty!.text).toContain('hideWhen "!git"');
      expect(r.empty!.text).toContain(`git = ${t('explain.value.no')}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns about an invalid rule and keeps the row shown', () => {
    const r = one(item('probe', { showWhen: 'contxt.pct > 5' }));
    expect(r.status).toBe('shown');
    expect(r.warning!.code).toBe('invalid-rule');
    expect(r.warning!.text).toBe(
      t('explain.reason.invalid-rule', {
        key: 'showWhen',
        problem: t('rule.error.unknown-metric', { text: 'contxt.pct', at: 1 }),
      }),
    );
  });

  it('sanitizes rule text', () => {
    const r = one(item('probe', { hideWhen: `co\u001b[31mst > 1` }));
    expect(r.warning!.code).toBe('invalid-rule');
    expect(r.warning!.text).not.toContain('\u001b');
  });
});

describe('inspect language', () => {
  const types = ['git-branch', 'weekly-usage', 'model'];
  const ctx = (language?: 'auto' | 'en' | 'tr') =>
    ctxWith({
      payload: { ...samplePayload(NOW.getTime()), rate_limits: undefined },
      git: () => null,
      limits: () => null,
      config: { lines: [types.map((x) => item(x))], ...(language ? { language } : {}) },
    });
  const texts = (c: RenderContext) =>
    rowsFor(c).map((r) => [r.value, r.empty?.text ?? null, r.note?.text ?? null]);

  it('computes the human text in the config language and restores it', () => {
    const en = texts(ctx());
    const tr = withLang('tr', () => texts(ctx()));
    expect(tr).not.toEqual(en);
    expect(texts(ctx('tr'))).toEqual(tr);
    expect(language()).toBe('en');
    withLang('tr', () => {
      expect(texts(ctx('en'))).toEqual(en);
      expect(texts(ctx('auto'))).toEqual(tr);
      expect(language()).toBe('tr');
    });
  });
});
