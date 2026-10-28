import { describe, expect, it } from 'vitest';
import { ID_RE, isFileId, reservedId } from '../../src/core/ids.js';

describe('ids', () => {
  it.each([
    'con',
    'CON',
    'Con.json',
    'nul',
    'Nul.theme',
    'prn',
    'aux',
    'com1',
    'COM9.x',
    'lpt5',
    'LPT1',
    'com0',
    'LPT0',
    'lpt0.json',
  ])('refuses device name %s', (id) => {
    expect(reservedId(id)).toBe(true);
    expect(isFileId(id)).toBe(false);
  });

  it.each(['console', 'com10', 'nul-theme', 'aux2', 'dracula', 'my.theme_1'])('accepts %s', (id) => {
    expect(reservedId(id)).toBe(false);
    expect(isFileId(id)).toBe(true);
  });

  it('rejects non-ids', () => {
    for (const v of [1, null, undefined, '', '.hidden', 'a'.repeat(65), 'bad id']) {
      expect(isFileId(v)).toBe(false);
    }
    expect(isFileId('a'.repeat(64))).toBe(true);
  });

  it('keeps the id shape', () => {
    expect(ID_RE.source).toBe('^[a-z0-9][a-z0-9._-]{0,63}$');
    expect(ID_RE.flags).toBe('i');
  });
});
