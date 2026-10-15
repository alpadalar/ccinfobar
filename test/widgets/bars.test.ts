import { describe, expect, it } from 'vitest';
import { fgCode, gradientColor, stripAnsi } from '../../src/core/ansi.js';
import { LOOK_OPTIONS } from '../../src/core/edit.js';
import { widthModeFor } from '../../src/core/glyphs.js';
import { render, gradientColor as rendererGradient } from '../../src/core/renderer.js';
import { resolveTheme } from '../../src/core/themes.js';
import { visibleWidthIn } from '../../src/core/width.js';
import { BAR_STYLES, bar, barOptions } from '../../src/widgets/shared.js';
import { ctxWith, renderWidget } from '../helpers.js';

const BLANK = String.fromCodePoint(0x2800);
const codes = (s: string) => [...s.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]!);
const rgb = (code: string) => code.split(';').slice(2).map(Number);

describe('solid bars', () => {
  it('render as before', () => {
    expect(bar(50, 10, 'blocks')).toBe('█████░░░░░');
    expect(bar(34, 10, 'dots', { pace: 50 })).toBe('●●●○○◇○○○○');
    expect(bar(50, 10, 'blocks', { ascii: true })).toBe('=====-----');
    expect(bar(100, 10, 'blocks', { gradient: { level: 0 } })).toBe('██████████');
  });

  it('keeps the gradient stops without a theme ramp', () => {
    expect([0, 25, 50, 80, 100].map((p) => gradientColor(p))).toEqual([
      '#4ccf92',
      '#9fc877',
      '#f2c05c',
      '#f06a6a',
      '#c678dd',
    ]);
    expect(rendererGradient).toBe(gradientColor);
  });

  it('spaces theme stops evenly and skips invalid ones', () => {
    expect(gradientColor(0, ['#000000', '#ffffff'])).toBe('#000000');
    expect(gradientColor(50, ['#000000', '#ffffff'])).toBe('#808080');
    expect(gradientColor(100, ['nope', '#000000', '#ffffff'])).toBe('#ffffff');
    expect(gradientColor(50, ['#000000', '#ff0000', '#ffffff'])).toBe('#ff0000');
    expect(gradientColor(0, ['#123456'])).toBe('#4ccf92');
    expect(gradientColor(0, [])).toBe('#4ccf92');
  });
});

describe('gradient bars', () => {
  it('colors each filled cell with foreground codes only at truecolor', () => {
    const out = bar(100, 10, 'blocks', { gradient: { level: 3 } });
    expect(stripAnsi(out)).toBe('██████████');
    const c = codes(out);
    expect(c.filter((x) => x.startsWith('38;2;')).length).toBeGreaterThan(1);
    expect(c.filter((x) => x.startsWith('38;2;')).length).toBeLessThanOrEqual(10);
    expect(out.endsWith('\x1b[39m')).toBe(true);
    expect(c).not.toContain('0');
    expect(c.some((x) => x.startsWith('4') || x.startsWith('10'))).toBe(false);
    expect(c[0]).toBe(fgCode(gradientColor(5), 3).slice(2, -1));
  });

  it('emits a code only when it changes and stops after the filled cells', () => {
    const out = bar(30, 10, 'blocks', { gradient: { level: 1 } });
    expect(out).toBe('\x1b[32m███\x1b[39m░░░░░░░');
    expect(bar(0, 10, 'blocks', { gradient: { level: 3 } })).toBe('░░░░░░░░░░');
  });

  it('uses the nearest 256 color at level 2', () => {
    const c = codes(bar(100, 10, 'blocks', { gradient: { level: 2 } }));
    expect(c.slice(0, -1).every((x) => x.startsWith('38;5;'))).toBe(true);
    expect(c.at(-1)).toBe('39');
  });

  it('steps green, yellow, red at 16 colors', () => {
    const c = codes(bar(100, 10, 'blocks', { gradient: { level: 1 } }));
    expect(c).toEqual(['32', '33', '31', '39']);
  });

  it('follows the theme ramp', () => {
    const c = codes(bar(100, 10, 'blocks', { gradient: { level: 3, stops: ['#000000', '#ffffff'] } }));
    const sum = (x: string) => rgb(x).reduce((a, b) => a + b, 0);
    expect(sum(c[0]!)).toBeLessThan(sum(c.at(-2)!));
  });

  it('reaches the widget through barColor and the theme gradient', () => {
    const mocha = resolveTheme('catppuccin-mocha').gradient!;
    const item = { id: 'c', type: 'context-bar', options: { barColor: 'gradient' } };
    const line = render(
      ctxWith({ config: { colorLevel: 3, theme: 'catppuccin-mocha', lines: [[item]] } }),
    )[0]!;
    expect(line).toContain(fgCode(gradientColor(5, mocha), 3));
    const plain = renderWidget('context-bar', ctxWith(), { options: { barColor: 'gradient' } });
    expect(plain).toBe(renderWidget('context-bar', ctxWith()));
  });

  it('lists the option and its choices', () => {
    const spec = barOptions.find((o) => o.key === 'barColor')!;
    expect(spec.default).toBe('solid');
    expect(spec.choices?.map((c) => c.value)).toEqual(['solid', 'gradient']);
    expect(LOOK_OPTIONS).toContain('barColor');
    const styles = barOptions.find((o) => o.key === 'style')!.choices!.map((c) => c.value);
    expect(styles).toEqual(expect.arrayContaining(['dots', 'ring', 'matrix']));
  });

  for (const theme of ['catppuccin-mocha', 'one-dark', 'catppuccin']) {
    it(`keeps the part colors after the bar in ${theme}`, () => {
      const t = resolveTheme(theme);
      const item = { id: 'c', type: 'context-bar', options: { barColor: 'gradient' } };
      const line = render(ctxWith({ config: { colorLevel: 3, theme, lines: [[item]] } }))[0]!;
      expect(['powerline', 'capsule']).toContain(t.style);
      expect(line).not.toContain('\x1b[39m');
      const prefix = line.slice(0, line.indexOf(' 34%'));
      const c = codes(prefix);
      const bg = c.map((x) => x.startsWith('48;')).lastIndexOf(true);
      const partFg = c[bg - 1]!;
      expect(partFg.startsWith('38;')).toBe(true);
      const after = c.slice(bg + 1);
      expect(after.filter((x) => x !== partFg).length).toBeGreaterThan(0);
      expect(after.at(-1)).toBe(partFg);
      expect(after.some((x) => x === '' || x === '0' || x === '49' || x === '39')).toBe(false);
      expect(stripAnsi(line)).toContain('███░░░░░░░ 34%');
    });
  }
  for (const theme of ['panel', 'classic']) {
    it(`puts the part color back after the bar in ${theme}`, () => {
      const item = { id: 'c', type: 'context-bar', options: { barColor: 'gradient' } };
      const out = render(ctxWith({ config: { colorLevel: 3, theme, lines: [[item]] } })).join('\n');
      expect(out).not.toContain('\x1b[39m');
      expect(out).toContain(fgCode(gradientColor(5), 3));
      const prefix = out.slice(0, out.indexOf(' 34%'));
      expect(codes(prefix).at(-1)!.startsWith('3')).toBe(true);
    });
  }
});

describe('ring and matrix', () => {
  it('fills the ring clockwise in one cell', () => {
    expect([0, 12.5, 50, 100].map((p) => bar(p, 10, 'ring'))).toEqual([BLANK, '⠁', '⠹', '⣿']);
    expect(bar(62.5, 30, 'ring')).toBe('⢹');
    expect(bar(80, 1, 'ring', { pace: 10 })).toBe('⣹');
  });

  it('fills the matrix two steps per cell', () => {
    expect([0, 12.5, 50, 100].map((p) => bar(p, 4, 'matrix'))).toEqual(['⣀⣀⣀⣀', '⣇⣀⣀⣀', '⣿⣿⣀⣀', '⣿⣿⣿⣿']);
    expect(bar(50, 4, 'matrix', { pace: 75 })).toBe('⣿⣿⣀◇');
    expect(bar(75, 4, 'matrix', { pace: 25 })).toBe('⣿◆⣿⣀');
  });

  it('color the ring by value and the matrix by cell', () => {
    expect(bar(100, 10, 'ring', { gradient: { level: 1 } })).toBe('\x1b[31m⣿\x1b[39m');
    expect(bar(0, 10, 'ring', { gradient: { level: 1 } })).toBe(BLANK);
    expect(bar(50, 4, 'matrix', { gradient: { level: 1 } })).toBe('\x1b[32m⣿⣿\x1b[39m⣀⣀');
    expect(bar(40, 4, 'matrix', { gradient: { level: 1 } })).toBe('\x1b[32m⣿⣇\x1b[39m⣀⣀');
  });

  it('fall back to the ASCII bar under charset text', () => {
    expect(bar(50, 4, 'ring', { ascii: true })).toBe('==--');
    expect(bar(50, 4, 'matrix', { ascii: true })).toBe('==--');
    const ctx = ctxWith({ config: { charset: 'text' } });
    expect(renderWidget('context-bar', ctx, { options: { style: 'ring' } })).toBe('===------- 34%');
    expect(renderWidget('context-bar', ctx, { options: { style: 'matrix' } })).toBe('===------- 34%');
  });

  it('are one column per cell in every width mode', () => {
    const modes = [widthModeFor('normal', 1), widthModeFor('jetbrains', 1), widthModeFor('normal', 2)];
    for (const m of modes) {
      for (const p of [0, 12.5, 50, 100]) {
        expect(visibleWidthIn(bar(p, 10, 'ring'), m)).toBe(1);
        expect(visibleWidthIn(bar(p, 6, 'matrix'), m)).toBe(6);
        expect(visibleWidthIn(bar(p, 6, 'matrix', { gradient: { level: 3 } }), m)).toBe(6);
      }
    }
  });

  it('are listed bar styles', () => {
    expect(Object.keys(BAR_STYLES)).toEqual(expect.arrayContaining(['ring', 'matrix', 'dots']));
    expect(renderWidget('context-bar', ctxWith(), { options: { style: 'ring' } })).toBe('⠙ 34%');
  });
});
