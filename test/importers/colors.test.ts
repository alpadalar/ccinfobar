import { describe, expect, it } from 'vitest';
import { parseColor } from '../../src/core/ansi.js';
import { ansiColor, hudColor, namedColor, rgbColor, starshipStyle } from '../../src/importers/colors.js';

describe('ansiColor', () => {
  it('maps c16, c256 and rgb', () => {
    expect(ansiColor({ c16: 0 })).toBe('black');
    expect(ansiColor({ c16: 7 })).toBe('white');
    expect(ansiColor({ c16: 9 })).toBe('brightRed');
    expect(ansiColor({ c16: 15 })).toBe('brightWhite');
    expect(ansiColor({ c256: 208 })).toBe('ansi256:208');
    expect(ansiColor({ r: 255, g: 136, b: 0 })).toBe('#ff8800');
    expect(ansiColor({ r: 0, g: 0, b: 0 })).toBe('#000000');
  });

  it('rejects anything else', () => {
    for (const v of [
      { c16: 16 },
      { c16: -1 },
      { c16: 1.5 },
      { c256: 256 },
      { c256: '1' },
      { r: 256, g: 0, b: 0 },
      { r: 1, g: 2 },
      'red',
      null,
      undefined,
      3,
    ]) {
      expect(ansiColor(v), JSON.stringify(v)).toBeUndefined();
    }
  });
});

describe('starshipStyle', () => {
  it('maps fg, bg and attributes', () => {
    expect(starshipStyle('bold fg:#ff8800 bg:blue')).toEqual({
      color: '#ff8800',
      background: 'blue',
      bold: true,
      unknown: [],
    });
    expect(starshipStyle('italic dimmed purple')).toEqual({
      color: 'magenta',
      italic: true,
      dim: true,
      unknown: [],
    });
  });

  it('maps bright names, numbers and short hex', () => {
    expect(starshipStyle('bright-cyan').color).toBe('brightCyan');
    expect(starshipStyle('bg:bright-purple').background).toBe('brightMagenta');
    expect(starshipStyle('fg:208').color).toBe('ansi256:208');
    expect(starshipStyle('fg:#ABC').color).toBe('#aabbcc');
    expect(starshipStyle('Bold RED')).toEqual({ color: 'red', bold: true, unknown: [] });
  });

  it('returns unknown tokens as written', () => {
    expect(starshipStyle('underline blink')).toEqual({ unknown: ['underline', 'blink'] });
    expect(starshipStyle('fg:256 bg:#12 constructor bright-gray fg:prev_bg').unknown).toEqual([
      'fg:256',
      'bg:#12',
      'constructor',
      'bright-gray',
      'fg:prev_bg',
    ]);
    expect(starshipStyle('')).toEqual({ unknown: [] });
    expect(starshipStyle('  ')).toEqual({ unknown: [] });
  });

  it('resolves palette names one level deep', () => {
    const palette = { blue_dark: '#4c566a', base: '#2e3440', red: '#bf616a', alias: 'base' };
    expect(starshipStyle('bold fg:blue_dark bg:base', palette)).toEqual({
      color: '#4c566a',
      background: '#2e3440',
      bold: true,
      unknown: [],
    });
    expect(starshipStyle('bold fg:blue_dark bg:base').unknown).toEqual(['fg:blue_dark', 'bg:base']);
    expect(starshipStyle('Blue_Dark red', palette).color).toBe('#bf616a');
    expect(starshipStyle('fg:Blue_Dark', palette).color).toBe('#4c566a');
    expect(starshipStyle('fg:alias', palette).unknown).toEqual(['fg:alias']);
    expect(starshipStyle('fg:cyan', palette).color).toBe('cyan');
  });

  it('never resolves palette names through the prototype', () => {
    const palette = { base: '#2e3440' };
    expect(starshipStyle('fg:constructor bg:__proto__ tostring', palette).unknown).toEqual([
      'fg:constructor',
      'bg:__proto__',
      'tostring',
    ]);
    const bad = { constructor: 42 } as unknown as Record<string, string>;
    expect(starshipStyle('fg:constructor', bad).unknown).toEqual(['fg:constructor']);
  });
});

describe('hudColor', () => {
  it('maps claude-hud colors', () => {
    expect(hudColor('dim')).toEqual({ dim: true });
    expect(hudColor('brightBlue')).toEqual({ color: 'brightBlue' });
    expect(hudColor('red')).toEqual({ color: 'red' });
    expect(hudColor(208)).toEqual({ color: 'ansi256:208' });
    expect(hudColor(0)).toEqual({ color: 'ansi256:0' });
    expect(hudColor('#a1b2c3')).toEqual({ color: '#a1b2c3' });
    expect(hudColor('#A1B2C3')).toEqual({ color: '#a1b2c3' });
  });

  it('rejects what claude-hud rejects', () => {
    for (const v of [300, -1, 1.5, '208', 'chartreuse', '#abc', 'brightRed', 'constructor', null, {}]) {
      expect(hudColor(v), String(v)).toBeUndefined();
    }
  });
});

describe('namedColor', () => {
  it('maps ANSI names, aliases and bright forms', () => {
    for (const v of ['bright_blue', 'bright-blue', 'brightBlue', 'BrightBlue']) {
      expect(namedColor(v), v).toBe('brightBlue');
    }
    expect(namedColor('purple')).toBe('magenta');
    expect(namedColor('bright_purple')).toBe('brightMagenta');
    expect(namedColor('grey')).toBe('brightBlack');
    expect(namedColor('gray')).toBe('brightBlack');
    expect(namedColor('Red')).toBe('red');
    expect(namedColor('white')).toBe('white');
    expect(namedColor('bright_black')).toBe('brightBlack');
  });

  it('rejects anything else', () => {
    for (const v of ['orange', 'bright_orange', 'bright', 'bright_grey', 'constructor', '', 3, null, {}]) {
      expect(namedColor(v), String(v)).toBeUndefined();
    }
  });
});

describe('rgbColor', () => {
  it('maps hex, R,G,B and 256-color numbers', () => {
    expect(rgbColor('136,192,208')).toBe('#88c0d0');
    expect(rgbColor('136, 192, 208')).toBe('#88c0d0');
    expect(rgbColor('#ABC')).toBe('#aabbcc');
    expect(rgbColor('#A1B2C3')).toBe('#a1b2c3');
    expect(rgbColor(214)).toBe('ansi256:214');
    expect(rgbColor(0)).toBe('ansi256:0');
    expect(rgbColor('214')).toBe('ansi256:214');
  });

  it('rejects anything else', () => {
    for (const v of ['300,0,0', '1,2', '1,2,3,4', '#12', '#abcd', 256, -1, 1.5, '256', 'red', null, {}]) {
      expect(rgbColor(v), String(v)).toBeUndefined();
    }
  });
});

describe('color output', () => {
  it('is always a color parseColor accepts', () => {
    const colors = [
      ...[{ c16: 0 }, { c16: 8 }, { c16: 15 }, { c256: 0 }, { c256: 255 }, { r: 1, g: 2, b: 3 }].map(
        ansiColor,
      ),
      ...['black', 'purple', 'bright-white', 'bright-black', '0', '255', '#fff', '#123456'].flatMap((s) => [
        starshipStyle(s).color,
        starshipStyle(`bg:${s}`).background,
      ]),
      ...['red', 'brightMagenta', 17, '#00ff00'].map((v) => hudColor(v)?.color),
      ...['bright_cyan', 'grey', 'purple'].map(namedColor),
      ...['1,2,3', '#abc', 9].map(rgbColor),
    ];
    for (const c of colors) {
      expect(c).toBeTypeOf('string');
      expect(parseColor(c), c).not.toBeNull();
    }
  });
});
