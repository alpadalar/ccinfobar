import { describe, expect, it } from 'vitest';
import type { GhValue } from '../../src/core/job-values.js';
import { samplePayload } from '../../src/core/sample.js';
import type { StatusPayload, WidgetItem } from '../../src/core/types.js';
import { ghParam } from '../../src/data/jobs/gh.js';
import { ghKey } from '../../src/data/jobs/keys.js';
import type { JobEnvelope, JobReader } from '../../src/data/jobs/runner.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, withoutSideEffects } from '../helpers.js';

const now = NOW.getTime();
const MIN = 60_000;
const URL_ = 'https://github.com/acme/api/pull/128';
const REPO = { host: 'github.com', owner: 'acme', name: 'api' };
const payload = (pr: StatusPayload['pr'] | undefined, repo: unknown = REPO): StatusPayload => {
  const p = samplePayload(now);
  return {
    ...p,
    workspace: { ...p.workspace, repo } as StatusPayload['workspace'],
    ...(pr === undefined ? { pr: undefined } : { pr }),
  };
};
const PR = { number: 128, review_state: 'approved', url: URL_, kind: 'pr' } as StatusPayload['pr'];
const KEY = ghKey('github.com/acme/api#128');

const counts = (c: Partial<GhValue>): GhValue => ({
  pass: 0,
  fail: 0,
  pending: 0,
  skipped: 0,
  cancelled: 0,
  total: 0,
  names: [],
  ...c,
});

const ok = (v: GhValue, at = now - 30_000): JobEnvelope<GhValue> => ({
  v: 1,
  key: KEY,
  fetchedAt: at,
  ok: true,
  value: v,
  attempts: 0,
  lastGood: v,
  lastGoodAt: at,
});

const failed = (error: string, lastGood: GhValue | null, lastGoodAt?: number): JobEnvelope<GhValue> => ({
  v: 1,
  key: KEY,
  fetchedAt: now - MIN,
  ok: false,
  value: null,
  error,
  attempts: 1,
  lastGood,
  ...(lastGoodAt !== undefined ? { lastGoodAt } : {}),
});

const reader = (e: JobEnvelope<unknown> | null, keys: string[] = []): JobReader => ({
  job<V>(key: string) {
    keys.push(key);
    return (key === KEY ? e : null) as JobEnvelope<V> | null;
  },
});

const def = getWidget('pr')!;

function render(
  p: StatusPayload,
  options: Record<string, unknown>,
  jobs: JobReader = reader(null),
  charset: 'text' | undefined = undefined,
): string | null {
  const ctx = ctxWith({
    payload: p,
    jobs: () => jobs,
    ...(charset ? { config: { charset } } : {}),
  });
  const item = { id: 'pr', type: 'pr', options } as WidgetItem;
  const out = withoutSideEffects(() => def.render(ctx, item));
  if (out === null || out === undefined) return null;
  return typeof out === 'string' ? out : out.text;
}

const link = (text: string) => `\x1b]8;;${URL_}\x1b\\${text}\x1b]8;;\x1b\\`;

describe('pr widget, ci off', () => {
  // captured before the ci option existed
  const before: [string, StatusPayload, Record<string, unknown>, string | null][] = [
    ['review state', payload(PR), {}, '#128 approved'],
    ['no review state', payload({ number: 128, url: URL_ }), {}, '#128'],
    ['link', payload(PR), { link: true }, link('#128 approved')],
    ['link without url', payload({ number: 7, review_state: 'pending' }), { link: true }, '#7 pending'],
    ['unsafe url', payload({ number: 7, url: 'javascript:alert(1)' }), { link: true }, '#7'],
    ['merge request', payload({ number: 9, review_state: 'open', kind: 'mr' }), {}, '#9 open'],
    ['no pr', payload(undefined), {}, null],
    ['no number', payload({ review_state: 'approved' } as StatusPayload['pr']), {}, null],
  ];
  for (const [name, p, o, want] of before) {
    it(`${name} is unchanged`, () => {
      const jobs = reader(ok(counts({ fail: 2, pass: 9, total: 11 })));
      expect(render(p, o, jobs)).toBe(want);
      expect(render(p, { ...o, ci: false }, jobs)).toBe(want);
    });
  }

  it('never reads the job', () => {
    const keys: string[] = [];
    render(payload(PR), { link: true }, reader(ok(counts({ fail: 2, total: 2 })), keys));
    expect(keys).toEqual([]);
  });

  it('sample payload output is unchanged', () => {
    const ctx = ctxWith({});
    const out = withoutSideEffects(() => def.render(ctx, { id: 'pr', type: 'pr' }));
    expect(out).toBe('#128 pending');
  });
});

describe('pr widget, ci on', () => {
  const ci = { ci: true };

  it('failing checks win', () => {
    const v = counts({ pass: 9, fail: 2, pending: 3, total: 14 });
    expect(render(payload(PR), ci, reader(ok(v)))).toBe('#128 approved ✗ 2');
  });

  it('pending checks', () => {
    const v = counts({ pass: 4, pending: 3, total: 7 });
    expect(render(payload(PR), ci, reader(ok(v)))).toBe('#128 approved ● 3');
  });

  it('all passed', () => {
    const v = counts({ pass: 10, skipped: 1, total: 11 });
    expect(render(payload(PR), ci, reader(ok(v)))).toBe('#128 approved ✓');
  });

  it('no checks adds nothing', () => {
    expect(render(payload(PR), ci, reader(ok(counts({}))))).toBe('#128 approved');
  });

  it('no envelope keeps the pr part', () => {
    expect(render(payload(PR), ci, reader(null))).toBe('#128 approved');
    expect(render(payload(PR), ci)).toBe('#128 approved');
  });

  it('a failed envelope shows the last good part', () => {
    const e = failed('gh-failed', counts({ pass: 1, fail: 1, total: 2 }), now - 2 * MIN);
    expect(render(payload(PR), ci, reader(e))).toBe('#128 approved ✗ 1');
  });

  it('a failed envelope without last good keeps the pr part', () => {
    expect(render(payload(PR), ci, reader(failed('gh-missing', null)))).toBe('#128 approved');
  });

  it('drops a last good older than an hour', () => {
    const e = failed('gh-auth', counts({ pass: 3, total: 3 }), now - 61 * MIN);
    expect(render(payload(PR), ci, reader(e))).toBe('#128 approved');
    expect(render(payload(PR), ci, reader(ok(counts({ pass: 3, total: 3 }), now - 61 * MIN)))).toBe(
      '#128 approved',
    );
  });

  it('ignores a value that is not counts', () => {
    const e = { ...ok(counts({})), value: { fail: 'x', total: 3 } } as unknown as JobEnvelope<GhValue>;
    expect(render(payload(PR), ci, reader(e))).toBe('#128 approved');
  });

  it('reads the key for the payload pr', () => {
    const keys: string[] = [];
    render(payload(PR), ci, reader(ok(counts({ pass: 1, total: 1 })), keys));
    expect(keys).toEqual([ghKey(ghParam(payload(PR))!)]);
    expect(keys).toEqual([KEY]);
  });

  it('skips merge requests without a lookup', () => {
    const keys: string[] = [];
    const p = payload({ ...PR!, kind: 'mr' });
    expect(render(p, ci, reader(ok(counts({ fail: 2, total: 2 })), keys))).toBe('#128 approved');
    expect(keys).toEqual([]);
  });

  it('skips without repo owner or name', () => {
    const keys: string[] = [];
    const jobs = reader(ok(counts({ fail: 2, total: 2 })), keys);
    expect(render(payload(PR, { host: 'github.com', name: 'api' }), ci, jobs)).toBe('#128 approved');
    expect(render(payload(PR, null), ci, jobs)).toBe('#128 approved');
    expect(keys).toEqual([]);
  });

  it('puts the ci part after the link', () => {
    const v = counts({ pass: 9, fail: 2, total: 11 });
    expect(render(payload(PR), { ci: true, link: true }, reader(ok(v)))).toBe(`${link('#128 approved')} ✗ 2`);
  });

  it('no pr gives null', () => {
    expect(render(payload(undefined), ci, reader(ok(counts({ fail: 2, total: 2 }))))).toBeNull();
  });

  it('text charset uses ascii marks', () => {
    const r = (v: GhValue) => render(payload(PR), ci, reader(ok(v)), 'text');
    expect(r(counts({ fail: 2, total: 2 }))).toBe('#128 approved x 2');
    expect(r(counts({ pending: 3, total: 3 }))).toBe('#128 approved * 3');
    expect(r(counts({ pass: 3, total: 3 }))).toBe('#128 approved ok');
  });

  it('never spawns', () => {
    const v = counts({ pass: 9, fail: 2, total: 11 });
    expect(() => render(payload(PR), { ci: true, link: true }, reader(ok(v)))).not.toThrow();
  });

  it('has the ci option off by default', () => {
    expect(def.options?.find((o) => o.key === 'ci')).toMatchObject({ kind: 'boolean', default: false });
  });
});
