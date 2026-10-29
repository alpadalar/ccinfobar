import { describe, expect, it } from 'vitest';
import { normalizeSubagentLine } from '../../src/core/config.js';
import { SUBAGENT_FIELDS, subagentFieldList } from '../../src/core/subagent-fields.js';
import { SUBAGENT_FIELDS as FROM_SHARED } from '../../src/widgets/shared.js';

describe('subagentFieldList', () => {
  it('keeps order, dedupes, drops unknown and non-string ids', () => {
    expect(subagentFieldList(['label', 'status', 'label', 'bogus', 7])).toEqual(['label', 'status']);
  });

  it('returns an empty list for non-arrays and empty arrays', () => {
    expect(subagentFieldList('x')).toEqual([]);
    expect(subagentFieldList(undefined)).toEqual([]);
    expect(subagentFieldList([])).toEqual([]);
  });

  it('normalizeSubagentLine maps empty to undefined and dedupes', () => {
    expect(normalizeSubagentLine({ fields: ['bogus'] })).toBeUndefined();
    expect(normalizeSubagentLine({ fields: ['tokens', 'tokens'] })).toEqual({ fields: ['tokens'] });
  });

  it('shares one SUBAGENT_FIELDS array with widgets/shared', () => {
    expect(FROM_SHARED).toBe(SUBAGENT_FIELDS);
  });
});
