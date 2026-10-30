import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { optionValue, setOption } from '../../src/core/edit.js';
import { aliasesFor, aliasValue } from '../../src/core/option-aliases.js';
import type { Config } from '../../src/core/types.js';
import { opt } from '../../src/widgets/shared.js';

const KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
const TYPES = ['budget', 'constructor', '__proto__'];

describe('alias lookups ignore inherited keys', () => {
  for (const type of TYPES) {
    for (const key of KEYS) {
      it(`${type} / ${key}`, () => {
        expect(() => aliasValue(type, key, {})).not.toThrow();
        expect(aliasValue(type, key, {})).toBeUndefined();
        expect(aliasesFor(type, key)).toEqual([]);
        expect(opt({ id: 'x', type }, key, 'd')).toBe('d');
        expect(optionValue({ id: 'x', type, options: {} }, key)).toBeUndefined();
        const cfg: Config = { ...defaultConfig(), lines: [[{ id: 'x', type }]] };
        expect(() => setOption(cfg, 'x', key, 1)).not.toThrow();
      });
    }
  }

  it('still resolves real aliases', () => {
    expect(aliasesFor('budget', 'show')).toEqual([{ key: 'display' }]);
    expect(aliasValue('budget', 'show', { display: 'bar' })).toBe('bar');
  });
});
