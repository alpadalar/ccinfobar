import { describe, expect, it } from 'vitest';
import type { StatusPayload } from '../../src/core/types.js';
import { ctxWith, renderWidget } from '../helpers.js';

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
