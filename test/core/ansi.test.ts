import { describe, expect, it } from 'vitest';
import { detectLevel, parseColor, stripAnsi, style, truncate, visibleWidth } from '../../src/core/ansi.js';

describe('ansi', () => {
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

  it('truncates keeping ansi intact', () => {
    const out = truncate('\x1b[31mhello world\x1b[0m', 6);
    expect(stripAnsi(out)).toBe('hello…');
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(truncate('short', 10)).toBe('short');
  });
});
