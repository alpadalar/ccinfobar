import { describe, expect, it } from 'vitest';
import type { StatusIncident, StatusIndicator, StatusValue } from '../../src/core/job-values.js';
import type { RenderContext, WidgetItem } from '../../src/core/types.js';
import type { JobEnvelope, JobReader } from '../../src/data/jobs/runner.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, withoutSideEffects } from '../helpers.js';

const now = NOW.getTime();
const MIN = 60_000;

const incident = (
  name: string,
  impact: StatusIndicator,
  components: string[] = ['Claude API (api.anthropic.com)'],
  ago = 5,
): StatusIncident => ({
  name,
  impact,
  components,
  updatedAt: new Date(now - ago * MIN).toISOString(),
});

const value = (
  indicator: StatusIndicator,
  incidents: StatusIncident[] = [],
  description = 'Partial System Outage',
): StatusValue => ({ indicator, description, incidents });

const ok = (v: unknown, at = now - 30_000): JobEnvelope<unknown> => ({
  v: 1,
  key: 'status',
  fetchedAt: at,
  ok: true,
  value: v,
  attempts: 0,
  lastGood: v,
  lastGoodAt: at,
});

const failed = (lastGood: StatusValue | null, lastGoodAt: number): JobEnvelope<unknown> => ({
  v: 1,
  key: 'status',
  fetchedAt: now - MIN,
  ok: false,
  value: null,
  error: 'timeout',
  attempts: 1,
  lastGood,
  lastGoodAt,
});

const reader = (e: JobEnvelope<unknown> | null, keys: string[] = []): JobReader => ({
  job<V>(key: string) {
    keys.push(key);
    return (key === 'status' ? e : null) as JobEnvelope<V> | null;
  },
});

const def = getWidget('service-status')!;

function render(e: JobEnvelope<unknown> | null, options: WidgetItem['options'] = {}, ctx?: RenderContext) {
  const c = ctx ?? ctxWith({ jobs: () => reader(e) });
  const out = withoutSideEffects(() => def.render(c, { id: 's', type: 'service-status', options }));
  if (out === null || out === undefined) return null;
  return typeof out === 'string' ? { text: out } : out;
}

const OPUS = 'Elevated errors on Opus';

describe('service-status', () => {
  it('is an opt-in, time-based system widget with documented options', () => {
    expect(def.category).toBe('system');
    expect(def.timeBased).toBe(true);
    expect(def.hideWhenEmpty).toBe(true);
    expect(def.sample).toBeTruthy();
    const keys = (def.options ?? []).map((o) => o.key);
    expect(keys).toEqual(['interval', 'components', 'showName', 'showOk', 'maxLength']);
    for (const o of def.options ?? []) expect(o.help, o.key).toBeTruthy();
  });

  it('is hidden when all is well, unless showOk', () => {
    expect(render(ok(value('none', [], 'All Systems Operational')))).toBeNull();
    expect(render(ok(value('none')), { showOk: true })).toEqual({ text: '✓ Claude OK', color: 'green' });
  });

  it('shows the most severe incident with a count of the rest', () => {
    const e = ok(value('major', [incident('Slow logins', 'minor', undefined, 1), incident(OPUS, 'major')]));
    expect(render(e)).toEqual({ text: `⚠ major: ${OPUS} +1`, color: 'red' });
  });

  it('orders equal impact by newest first', () => {
    const e = ok(
      value('minor', [incident('Older', 'minor', undefined, 30), incident('Newer', 'minor', undefined, 2)]),
    );
    expect(render(e)?.text).toBe('⚠ minor: Newer +1');
  });

  it('colors by indicator', () => {
    expect(render(ok(value('minor', [incident('A', 'minor')])))?.color).toBe('yellow');
    expect(render(ok(value('critical', [incident('A', 'critical')])))?.color).toBe('red');
  });

  it('uses the status description without an incident', () => {
    expect(render(ok(value('maintenance', [], 'Service Under Maintenance')))).toEqual({
      text: '⚠ maintenance: Service Under Maintenance',
      color: 'blue',
    });
  });

  it('cuts long names at maxLength and can hide the name', () => {
    const long = 'x'.repeat(60);
    const e = ok(value('major', [incident(long, 'major')]));
    const text = render(e)!.text;
    expect(text).toBe(`⚠ major: ${'x'.repeat(39)}…`);
    expect(render(e, { maxLength: 10 })!.text).toBe(`⚠ major: ${'x'.repeat(9)}…`);
    expect(render(e, { showName: false })!.text).toBe('⚠ major');
  });

  it('filters incidents by component name', () => {
    const api = incident('API errors', 'major', ['Claude API (api.anthropic.com)']);
    const code = incident('Claude Code login loop', 'minor', ['Claude Code']);
    expect(render(ok(value('major', [api])), { components: 'claude code' })).toBeNull();
    expect(render(ok(value('major', [api])), { components: 'claude code', showOk: true })?.text).toBe(
      '✓ Claude OK',
    );
    expect(render(ok(value('major', [api, code])), { components: 'claude code' })).toEqual({
      text: '⚠ minor: Claude Code login loop',
      color: 'yellow',
    });
    expect(render(ok(value('major', [api, code])), { components: ' , CLAUDE CODE, api ' })?.text).toBe(
      '⚠ major: API errors +1',
    );
  });

  it('shows the last good value with a ? for 30 minutes after a failed fetch', () => {
    const last = value('major', [incident(OPUS, 'major')]);
    expect(render(failed(last, now - 10 * MIN))).toEqual({ text: `⚠ major: ${OPUS} ?`, color: 'red' });
    expect(render(failed(last, now - 31 * MIN))).toBeNull();
    expect(render(failed(null, now - 10 * MIN))).toBeNull();
    expect(render(failed(value('none'), now - 10 * MIN), { showOk: true })).toBeNull();
  });

  it('hides values older than 30 minutes', () => {
    expect(render(ok(value('major', [incident(OPUS, 'major')]), now - 31 * MIN))).toBeNull();
  });

  it('returns null without data or with a value of the wrong shape', () => {
    expect(render(null)).toBeNull();
    expect(render(ok(null))).toBeNull();
    expect(render(ok('major'))).toBeNull();
    expect(render(ok({ indicator: 'major', incidents: 'nope' }))).toEqual({
      text: '⚠ major',
      color: 'red',
    });
    expect(render(ok({ indicator: 'bogus', description: 1, incidents: [null, { name: 3 }] }))).toBeNull();
    const bare = ctxWith();
    (bare.data as { jobs?: unknown }).jobs = undefined;
    expect(render(null, {}, bare)).toBeNull();
  });

  it('is hidden when nonessential traffic is off', () => {
    const e = ok(value('major', [incident(OPUS, 'major')]));
    const c = ctxWith({ jobs: () => reader(e), env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    expect(render(e, {}, c)).toBeNull();
  });

  it('reads only the status job', () => {
    const keys: string[] = [];
    const e = ok(value('major', [incident(OPUS, 'major')]));
    render(e, {}, ctxWith({ jobs: () => reader(e, keys) }));
    expect(keys).toEqual(['status']);
  });

  it('uses ASCII glyphs in the text charset', () => {
    const e = ok(value('major', [incident(OPUS, 'major')]));
    const c = ctxWith({ jobs: () => reader(e), config: { charset: 'text' } });
    expect(render(e, {}, c)?.text).toBe(`! major: ${OPUS}`);
    const okCtx = ctxWith({ jobs: () => reader(ok(value('none'))), config: { charset: 'text' } });
    expect(render(null, { showOk: true }, okCtx)?.text).toBe('Claude OK');
  });
});
