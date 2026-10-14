import { describe, expect, it } from 'vitest';
import type { StatusPayload } from '../../src/core/types.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget } from '../helpers.js';

const miss = (cause: unknown) =>
  renderWidget(
    'cache-miss-cause',
    ctxWith({ payload: { prompt_cache: { last_miss_cause: cause } } as unknown as StatusPayload }),
  );

const cases: [string, unknown, string | null][] = [
  ['tool counts', { causes: ['tools_changed'], tools_added: 2, tools_removed: 0 }, 'tools changed (+2/-0)'],
  ['missing removed count', { causes: ['tools_changed'], tools_added: 1 }, 'tools changed (+1/-0)'],
  ['no counts', { causes: ['tools_changed'] }, 'tools changed'],
  [
    'positive delta',
    { causes: ['system_prompt_changed'], system_char_delta: 120 },
    'system prompt changed (+120 chars)',
  ],
  [
    'negative delta',
    { causes: ['system_prompt_changed'], system_char_delta: -40 },
    'system prompt changed (-40 chars)',
  ],
  [
    'several causes',
    { causes: ['model_changed', 'tools_changed'], tools_added: 0, tools_removed: 3 },
    'model changed, tools changed (+0/-3)',
  ],
  ['mixed entries', { causes: [5, 'model_changed', null] }, 'model changed'],
  ['non-string entries', { causes: [5, null] }, null],
  [
    'non-finite counts',
    { causes: ['tools_changed'], tools_added: 'x', tools_removed: Number.NaN },
    'tools changed',
  ],
  ['string delta', { causes: ['system_prompt_changed'], system_char_delta: '5' }, 'system prompt changed'],
  ['null', null, null],
  ['empty causes', { causes: [] }, null],
  ['causes not an array', { causes: 'tools_changed' }, null],
  ['number', 42, null],
  ['undefined', undefined, null],
  ['legacy string', 'tools_changed', 'tools changed'],
  ['empty string', '', null],
  ['blank string', '  ', null],
];

describe('cache-miss-cause', () => {
  it.each(cases)('%s', (_name, cause, expected) => {
    expect(miss(cause)).toBe(expected);
  });

  it('returns null without prompt_cache', () => {
    expect(renderWidget('cache-miss-cause', ctxWith({ payload: {} }))).toBeNull();
  });
});

const SEC = NOW.getTime() / 1000;
const pc = (prompt_cache: unknown) => ctxWith({ payload: { prompt_cache } as unknown as StatusPayload });
const cause = { causes: ['tools_changed'], tools_added: 2, tools_removed: 0 };

describe('cache-miss-cause show', () => {
  const latest = { last_miss_cause: cause, ttl: '5m', expires_at: SEC + 300, last_miss_at: SEC };
  const older = { ...latest, last_miss_at: SEC - 600 };

  it('shows the cause while the latest request missed', () => {
    expect(renderWidget('cache-miss-cause', pc(latest))).toBe('tools changed (+2/-0)');
  });
  it('hides an older miss by default', () => {
    expect(renderWidget('cache-miss-cause', pc(older))).toBeNull();
  });
  it("keeps an older miss with show: 'always'", () => {
    expect(renderWidget('cache-miss-cause', pc(older), { options: { show: 'always' } })).toBe(
      'tools changed (+2/-0)',
    );
  });
  it('treats an unknown ttl like always', () => {
    expect(renderWidget('cache-miss-cause', pc({ ...older, ttl: '7m' }))).toBe('tools changed (+2/-0)');
  });
});

describe('cache-timer', () => {
  const out = (p: unknown, options = {}) =>
    getWidget('cache-timer')!.render(pc(p), { id: 'c', type: 'cache-timer', options });

  it('shows off when Claude Code saw no caching', () => {
    expect(renderWidget('cache-timer', pc({ caching_observed: false }))).toBe('off');
    expect(out({ caching_observed: false })).toMatchObject({ color: 'brightBlack' });
  });
  it('shows cold when not warm', () => {
    expect(out({ warm: false })).toEqual({ text: 'cold', color: 'red' });
  });
  it('shows cold when expired', () => {
    expect(renderWidget('cache-timer', pc({ warm: true, expires_at: SEC - 5 }))).toBe('cold');
  });
  it('appends the ttl with showTtl', () => {
    const p = { warm: true, caching_observed: true, ttl: '1h', expires_at: SEC + 41 * 60 };
    expect(renderWidget('cache-timer', pc(p), { options: { showTtl: true } })).toBe('41m/1h');
    expect(renderWidget('cache-timer', pc(p))).toBe('41m');
  });
  it('accepts null expires_at', () => {
    expect(renderWidget('cache-timer', pc({ warm: true, expires_at: null }))).toBeNull();
  });
  it('returns null without prompt_cache', () => {
    expect(renderWidget('cache-timer', ctxWith({ payload: {} }))).toBeNull();
  });
});
