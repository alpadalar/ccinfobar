import { describe, expect, it } from 'vitest';
import { mapTheme } from '../../src/importers/themes-map.js';

const table = { exact: { nord: 'nord', 'tokyo-night': 'tokyo-night' }, approx: { cobalt2: 'dark' } };

describe('mapTheme', () => {
  it('maps exact names without a note', () => {
    expect(mapTheme('Nord', { exact: { nord: 'nord' } }, 'X')).toEqual({ theme: 'nord', notes: [] });
    expect(mapTheme(' tokyo-night ', table, 'X')).toEqual({ theme: 'tokyo-night', notes: [] });
  });

  it('notes approximations', () => {
    const r = mapTheme('Cobalt2', table, 'X');
    expect(r.theme).toBe('dark');
    expect(r.notes).toEqual([
      { kind: 'approx', text: 'X theme "Cobalt2" is approximated by the dark theme' },
    ]);
  });

  it('falls back on unknown names without prototype hits', () => {
    for (const name of ['constructor', 'toString', '__proto__', 42, null, undefined, {}]) {
      const r = mapTheme(name, table, 'X');
      expect(r.theme, String(name)).toBe('classic');
      expect(r.notes).toHaveLength(1);
      expect(r.notes[0]!.kind).toBe('info');
    }
    expect(mapTheme('nope', { ...table, fallback: 'catppuccin-mocha' }, 'X')).toEqual({
      theme: 'catppuccin-mocha',
      notes: [
        {
          kind: 'info',
          text: 'X theme "nope" has no ccinfobar equivalent, used the catppuccin-mocha theme',
        },
      ],
    });
  });

  it('sanitizes foreign names in notes', () => {
    const r = mapTheme('a\x1b[31mb\u202ec', table, 'X');
    expect(r.notes[0]!.text).not.toMatch(/[\u0000-\u001f\u202e]/);
  });
});
