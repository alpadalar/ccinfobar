import { describe, expect, it } from 'vitest';
import {
  sampleGsd,
  sampleJj,
  sampleLedger,
  samplePayload,
  sampleRepos,
  sampleTranscript,
} from '../../src/core/sample.js';
import type { OptionValue, RenderContext, StatusPayload } from '../../src/core/types.js';
import { slotKey } from '../../src/data/ledger.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW } from '../helpers.js';

type Opts = Record<string, OptionValue>;

interface Case {
  id: string;
  type: string;
  old: Opts;
  canonical: Opts;
  group: 'rename' | 'hide';
  ctx?: () => RenderContext;
}

const now = NOW.getTime();
const cur = slotKey(now);
const transcript =
  (over: Partial<ReturnType<typeof sampleTranscript>> = {}) =>
  () => ({
    ...sampleTranscript(now),
    ...over,
  });

const legacyCtx = () => {
  const p = samplePayload(now);
  const w = { used_percentage: 23, resets_at: p.rate_limits!.seven_day!.resets_at };
  return ctxWith({
    payload: { ...p, rate_limits: { ...p.rate_limits, seven_day_opus: w, seven_day_sonnet: w } },
  });
};
const budgetCtx = () =>
  ctxWith({
    ledger: () => ({ ...sampleLedger(now), today: 4.1 }),
    config: { budget: { daily: 10 } },
  });
const missCtx = () =>
  ctxWith({
    payload: {
      prompt_cache: {
        requests: 48,
        misses: 5,
        miss_causes: { tools_changed: 2, ttl_expired_5m: 2, model_changed: 1 },
      },
    } as unknown as StatusPayload,
  });

const CASES: Case[] = [
  {
    id: 'jj-bookmarks',
    type: 'jj-bookmarks',
    old: { maxBookmarks: 1 },
    canonical: { maxItems: 1 },
    group: 'rename',
    ctx: () => ctxWith({ jj: () => ({ ...sampleJj(), bookmarks: () => ['main', 'dev', 'x'] }) }),
  },
  {
    id: 'workspace-repos',
    type: 'workspace-repos',
    old: { maxRepos: 2 },
    canonical: { maxItems: 2 },
    group: 'rename',
    ctx: () => ctxWith({ repos: () => sampleRepos(now) }),
  },
  { id: 'agents', type: 'agents', old: { maxAgents: 1 }, canonical: { maxItems: 1 }, group: 'rename' },
  {
    id: 'tool-activity-max',
    type: 'tool-activity',
    old: { maxTools: 1 },
    canonical: { maxItems: 1 },
    group: 'rename',
  },
  {
    id: 'skills-limit',
    type: 'skills',
    old: { mode: 'list', limit: 1 },
    canonical: { show: 'list', maxItems: 1 },
    group: 'rename',
  },
  {
    id: 'cache-miss-cause',
    type: 'cache-miss-cause',
    old: { show: 'summary', maxCauses: 1 },
    canonical: { show: 'summary', maxItems: 1 },
    group: 'rename',
    ctx: missCtx,
  },
  {
    id: 'gsd-phase',
    type: 'gsd-phase',
    old: { maxNameLength: 7 },
    canonical: { maxLength: 7 },
    group: 'rename',
  },
  {
    id: 'budget',
    type: 'budget',
    old: { display: 'percent' },
    canonical: { show: 'percent' },
    group: 'rename',
    ctx: budgetCtx,
  },
  {
    id: 'five-hour-usage',
    type: 'five-hour-usage',
    old: { display: 'bar' },
    canonical: { show: 'bar' },
    group: 'rename',
  },
  {
    id: 'weekly-usage',
    type: 'weekly-usage',
    old: { display: 'bar' },
    canonical: { show: 'bar' },
    group: 'rename',
  },
  {
    id: 'weekly-model-usage',
    type: 'weekly-model-usage',
    old: { display: 'bar' },
    canonical: { show: 'bar' },
    group: 'rename',
  },
  {
    id: 'weekly-opus-usage',
    type: 'weekly-opus-usage',
    old: { display: 'bar' },
    canonical: { show: 'bar' },
    group: 'rename',
    ctx: legacyCtx,
  },
  {
    id: 'weekly-sonnet-usage',
    type: 'weekly-sonnet-usage',
    old: { display: 'bar' },
    canonical: { show: 'bar' },
    group: 'rename',
    ctx: legacyCtx,
  },
  {
    id: 'todo-list',
    type: 'todo-list',
    old: { display: 'current' },
    canonical: { show: 'current' },
    group: 'rename',
  },
  {
    id: 'activity-strip',
    type: 'activity-strip',
    old: { slots: 4, mode: 'presence' },
    canonical: { slots: 4, show: 'presence' },
    group: 'rename',
    ctx: () => ctxWith({ ledger: () => ({ ...sampleLedger(now), slots: { [cur - 2]: 1, [cur]: 4 } }) }),
  },
  {
    id: 'context-percentage',
    type: 'context-percentage',
    old: { mode: 'remaining' },
    canonical: { show: 'remaining' },
    group: 'rename',
  },
  {
    id: 'skills-mode',
    type: 'skills',
    old: { mode: 'count' },
    canonical: { show: 'count' },
    group: 'rename',
  },
  {
    id: 'tool-activity-mode',
    type: 'tool-activity',
    old: { mode: 'counts' },
    canonical: { show: 'counts' },
    group: 'rename',
  },
  {
    id: 'performance',
    type: 'performance',
    old: { display: 'badge' },
    canonical: { style: 'badge' },
    group: 'rename',
  },
  {
    id: 'jj-workspace',
    type: 'jj-workspace',
    old: { hideDefault: true },
    canonical: { hideZero: true },
    group: 'hide',
  },
  {
    id: 'compactions',
    type: 'compactions',
    old: { showZero: true },
    canonical: { hideZero: false },
    group: 'hide',
    ctx: () => ctxWith({ transcript: transcript({ compactions: 0 }) }),
  },
  {
    id: 'gsd-plans',
    type: 'gsd-plans',
    old: { showEmpty: true },
    canonical: { hideZero: false },
    group: 'hide',
    ctx: () => {
      const g = sampleGsd();
      return ctxWith({ gsd: () => ({ ...g!, phase: { ...g!.phase!, plans: 0, summaries: 0 } }) });
    },
  },
  {
    id: 'output-style',
    type: 'output-style',
    old: { showDefault: true },
    canonical: { hideZero: false },
    group: 'hide',
  },
  {
    id: 'fast-mode',
    type: 'fast-mode',
    old: { showOff: true },
    canonical: { hideOff: false },
    group: 'hide',
  },
  {
    id: 'sandbox',
    type: 'sandbox',
    old: { showOff: true },
    canonical: { hideOff: false },
    group: 'hide',
    ctx: () => ctxWith({ sandbox: () => ({ enabled: false, strict: false }) }),
  },
];

function run(c: Case, options: Opts): unknown {
  const ctx = c.ctx ? c.ctx() : ctxWith();
  const def = getWidget(c.type);
  if (!def) throw new Error(`unknown widget ${c.type}`);
  try {
    return def.render(ctx, { id: c.type, type: c.type, options });
  } catch (e) {
    return `THROWS ${String(e)}`;
  }
}

const byId = (id: string) => CASES.find((c) => c.id === id)!;
const oldOut = (id: string) => run(byId(id), byId(id).old);
const flipped = (c: Case): Opts =>
  Object.fromEntries(Object.entries(c.old).map(([k, v]) => [k, typeof v === 'boolean' ? !v : v]));

describe('old option names stay pinned', () => {
  for (const c of CASES) {
    it(`${c.id}: old names change the output`, () => {
      if (c.group === 'rename') expect(run(c, c.old)).not.toEqual(run(c, {}));
      else expect(run(c, c.old)).not.toEqual(run(c, flipped(c)));
    });
  }

  it('renders the old names as captured before the rename', () => {
    expect(oldOut('jj-bookmarks')).toMatchInlineSnapshot(`"main +2"`);
    expect(oldOut('workspace-repos')).toMatchInlineSnapshot(`"api (main) · docs (main) +5"`);
    expect(oldOut('agents')).toMatchInlineSnapshot(`
      "▸ Explore · Find where token totals are computed  2,400 t/m · 0.1% · 3.2k · ↑420 · 1m20s · sonnet
        └ Bash[grep -rn "billed_in" src/]"
    `);
    expect(oldOut('tool-activity-max')).toMatchInlineSnapshot(`"Bash npm test · Read 4 +2"`);
    expect(oldOut('skills-limit')).toMatchInlineSnapshot(`"frontend-design +1"`);
    expect(oldOut('cache-miss-cause')).toMatchInlineSnapshot(`"5/48 miss · tools changed ×2"`);
    expect(oldOut('gsd-phase')).toMatchInlineSnapshot(`"4/6 Invoic…"`);
    expect(oldOut('budget')).toMatchInlineSnapshot(`"41%"`);
    expect(oldOut('five-hour-usage')).toMatchInlineSnapshot(`
      {
        "color": "green",
        "text": "████░░░░░░ 42%",
      }
    `);
    expect(oldOut('weekly-usage')).toMatchInlineSnapshot(`
      {
        "color": "yellow",
        "text": "██████░░░░ 61%",
      }
    `);
    expect(oldOut('weekly-model-usage')).toMatchInlineSnapshot(`
      {
        "color": "green",
        "text": "Fable ██░░░░░░░░ 23%",
      }
    `);
    expect(oldOut('weekly-opus-usage')).toMatchInlineSnapshot(`
      {
        "color": "green",
        "text": "██░░░░░░░░ 23%",
      }
    `);
    expect(oldOut('weekly-sonnet-usage')).toMatchInlineSnapshot(`
      {
        "color": "green",
        "text": "██░░░░░░░░ 23%",
      }
    `);
    expect(oldOut('todo-list')).toMatchInlineSnapshot(`"2/5 ▸ Wiring GSD widgets into renderer"`);
    expect(oldOut('activity-strip')).toMatchInlineSnapshot(`"·▪·▪"`);
    expect(oldOut('context-percentage')).toMatchInlineSnapshot(`
      {
        "color": "green",
        "text": "66%",
      }
    `);
    expect(oldOut('skills-mode')).toMatchInlineSnapshot(`"2"`);
    expect(oldOut('tool-activity-mode')).toMatchInlineSnapshot(`"Read 4, Edit 2, Bash 1"`);
    expect(oldOut('performance')).toMatchInlineSnapshot(`
      {
        "color": "yellow",
        "text": "94% · 16.9s",
      }
    `);
  });

  it('renders the old hide and show toggles in both polarities', () => {
    const both = (id: string) => [run(byId(id), byId(id).old), run(byId(id), flipped(byId(id)))];
    expect(both('jj-workspace')).toMatchInlineSnapshot(`
      [
        null,
        "default",
      ]
    `);
    expect(both('compactions')).toMatchInlineSnapshot(`
      [
        "0x",
        null,
      ]
    `);
    expect(both('gsd-plans')).toMatchInlineSnapshot(`
      [
        "none",
        null,
      ]
    `);
    expect(both('output-style')).toMatchInlineSnapshot(`
      [
        "default",
        null,
      ]
    `);
    expect(both('fast-mode')).toMatchInlineSnapshot(`
      [
        "normal",
        null,
      ]
    `);
    expect(both('sandbox')).toMatchInlineSnapshot(`
      [
        "sandbox off",
        null,
      ]
    `);
  });
});
