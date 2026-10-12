import { describe, expect, it } from 'vitest';
import { parseColorReplies } from '../../src/editor/terminal-colors.js';
import { detectedProfile, isLight, resolveProfile, TERMINALS } from '../../src/editor/web/terminals.js';

describe('parseColorReplies', () => {
  it('reads OSC 10, 11 and 4 replies in 16 and 8 bit forms', () => {
    const data =
      '\x1b]11;rgb:2e2e/3434/3636\x07\x1b]10;rgb:ff/ff/ff\x1b\\\x1b]4;1;rgb:cccc/0000/0000\x07\x1b[?64;1c';
    expect(parseColorReplies(data)).toEqual({
      bg: '#2e3436',
      fg: '#ffffff',
      palette: [null, '#cc0000', ...Array(14).fill(null)],
    });
  });

  it('returns null without a background reply', () => {
    expect(parseColorReplies('\x1b[?1;2c')).toBeNull();
    expect(parseColorReplies('')).toBeNull();
  });
});

describe('terminal profiles', () => {
  it('have 16 colors and unique ids', () => {
    for (const t of TERMINALS) expect(t.palette).toHaveLength(16);
    expect(new Set(TERMINALS.map((t) => t.id)).size).toBe(TERMINALS.length);
  });

  it('builds a detected profile and fills missing palette entries', () => {
    const p = detectedProfile({ bg: '#fdf6e3', fg: null, palette: [null, '#dc322f'] });
    expect(p.id).toBe('detected');
    expect(p.light).toBe(true);
    expect(p.palette[1]).toBe('#dc322f');
    expect(p.palette[2]).toMatch(/^#/);
    expect(isLight('#0a0a0c')).toBe(false);
  });

  it('applies custom colors and falls back for unknown ids', () => {
    expect(resolveProfile({ id: 'nope' }, null).id).toBe('default');
    const p = resolveProfile({ id: 'nord', bg: '#ffffff', fg: 'bad' }, null);
    expect(p.bg).toBe('#ffffff');
    expect(p.fg).toBe('#d8dee9');
    expect(p.light).toBe(true);
  });
});
