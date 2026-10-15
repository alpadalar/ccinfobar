import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  detectLevel,
  parseColor,
  sanitize,
  stripAnsi,
  style,
  truncate,
  visibleWidth,
} from '../../src/core/ansi.js';

describe('ansi', () => {
  it('sanitize keeps SGR but strips C1 and bidi', () => {
    expect(sanitize('\x1b[31mx\x1b[0m')).toBe('\x1b[31mx\x1b[0m');
    expect(sanitize('a\x85b\x9bc')).toBe('abc');
    expect(sanitize('a\u202eb\u2066c')).toBe('abc');
  });

  it('measures emoji-presentation symbols as 2 cells', () => {
    expect(visibleWidth('⚡')).toBe(2);
    expect(visibleWidth('✅')).toBe(2);
    expect(visibleWidth('🪐')).toBe(2);
    expect(visibleWidth('🇹🇷')).toBe(2);
    expect(visibleWidth('☐')).toBe(1);
    expect(visibleWidth('✓')).toBe(1);
    expect(visibleWidth('★')).toBe(1);
  });

  it('parses named, 256 and hex colors', () => {
    expect(parseColor('red')).toEqual({ kind: 'basic', index: 1 });
    expect(parseColor('ansi256:208')).toEqual({ kind: '256', index: 208 });
    expect(parseColor('#ff8000')).toEqual({ kind: 'rgb', rgb: [255, 128, 0] });
    expect(parseColor('#abc')).toEqual({ kind: 'rgb', rgb: [170, 187, 204] });
    expect(parseColor('nope')).toBeNull();
  });

  it('downgrades colors by level', () => {
    expect(style('x', { fg: '#ff0000' }, 3)).toBe('\x1b[38;2;255;0;0mx\x1b[0m');
    expect(style('x', { fg: '#ff0000' }, 2)).toBe('\x1b[38;5;196mx\x1b[0m');
    expect(style('x', { fg: '#ff0000' }, 1)).toMatch(/^\x1b\[[39]1mx/);
    expect(style('x', { fg: 'red', bold: true }, 0)).toBe('x');
  });

  it('respects NO_COLOR and FORCE_COLOR', () => {
    expect(detectLevel('auto', { NO_COLOR: '1' })).toBe(0);
    expect(detectLevel('auto', { FORCE_COLOR: '3' })).toBe(3);
    expect(detectLevel('auto', { COLORTERM: 'truecolor' })).toBe(3);
    expect(detectLevel(1, { COLORTERM: 'truecolor' })).toBe(1);
  });

  it('measures visible width', () => {
    expect(visibleWidth('\x1b[31mabc\x1b[0m')).toBe(3);
    expect(visibleWidth('日本')).toBe(4);
    expect(visibleWidth('á')).toBe(1);
  });

  it('closes a hyperlink cut by truncation', () => {
    const link = '\u001b]8;;https://example.com\u001b\\a long link text\u001b]8;;\u001b\\';
    const out = truncate(`${link} tail`, 6);
    expect(out).toBe('\u001b]8;;https://example.com\u001b\\a lon…\u001b]8;;\u001b\\\u001b[0m');
    expect(truncate(`${link} more text here`, 20).endsWith('…\u001b[0m')).toBe(true);
  });

  it('truncates keeping ansi intact', () => {
    const out = truncate('\x1b[31mhello world\x1b[0m', 6);
    expect(stripAnsi(out)).toBe('hello…');
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates whole grapheme clusters', () => {
    expect(truncate('ab\u{1F468}\u{200D}\u{1F469}cd', 3)).toBe('ab…');
    expect(truncate('\u{1F1F9}\u{1F1F7}\u{1F1FA}\u{1F1F8}', 3)).toBe('\u{1F1F9}\u{1F1F7}…');
    expect(truncate('\x1b[32m1\u{FE0F}\u{20E3}2\u{FE0F}\u{20E3}\x1b[0m', 3)).toBe(
      '\x1b[32m1\u{FE0F}\u{20E3}…\x1b[0m',
    );
    expect(visibleWidth('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toBe(2);
  });

  it('measures contrast between colors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrastRatio('blue', 'blue')).toBe(1);
    expect(contrastRatio('nope', 'blue')).toBeNull();
  });
});
