import { describe, expect, it, vi } from 'vitest';
import { sanitize } from '../../src/core/ansi.js';
import { t } from '../../src/core/i18n/index.js';
import { emptyReason, inspectRows, lineReport } from '../../src/core/inspect.js';
import { normalizeResult, renderValue } from '../../src/core/renderer.js';
import { getScenario, SCENARIO_NOW } from '../../src/core/scenarios.js';
import type { RenderContext, StatusPayload, WidgetDef, WidgetItem } from '../../src/core/types.js';
import { ALL_WIDGETS, getWidget } from '../../src/widgets/index.js';
import { ctxWith, withoutSideEffects } from '../helpers.js';

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
      expect(r.sources).toEqual([]);
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
