import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { intFlag } from '../../src/cli/flags.js';
import { t, withLanguage } from '../../src/core/i18n/index.js';

const w = (argv: string[]) => intFlag(parseArgs(argv), 'width', 1, 10000);
const msg = () => t('cli.badInt', { flag: '--width', min: 1, max: 10000 });

describe('intFlag', () => {
  it('returns undefined when absent or negated', () => {
    expect(w([])).toBeUndefined();
    expect(w(['--no-width'])).toBeUndefined();
  });

  it('accepts whole numbers in range', () => {
    expect(w(['--width', '80'])).toBe(80);
    expect(w(['--width=1'])).toBe(1);
    expect(w(['--width', '10000'])).toBe(10000);
  });

  it.each([['0'], ['10001'], ['1.5'], ['abc'], ['-1'], ['1e3'], [' 80']])('rejects %s', (v) => {
    expect(() => w([`--width=${v}`])).toThrow(msg());
  });

  it('rejects a bare flag', () => {
    expect(() => w(['--width'])).toThrow(msg());
    expect(msg()).toBe('--width needs a whole number from 1 to 10000');
  });

  it('throws the Turkish text under tr', () => {
    withLanguage('tr', () => {
      expect(() => w(['--width=abc'])).toThrow(t('cli.badInt', { flag: '--width', min: 1, max: 10000 }));
      expect(t('cli.badInt', { flag: '--width', min: 1, max: 10000 })).toContain('tam sayı');
    });
  });
});
