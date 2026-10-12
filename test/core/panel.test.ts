import { describe, expect, it } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { parseArea, pickBreakpoint, sizeColumns } from '../../src/core/panel.js';
import { render } from '../../src/core/renderer.js';
import type { TuiConfig, WidgetItem } from '../../src/core/types.js';
import { ctxWith } from '../helpers.js';

const text = (t: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({
  id: t,
  type: 'text',
  options: { text: t },
  ...extra,
});
const panel = (
  tui: TuiConfig = {},
  width: number | null = 40,
  lines = [[text('alpha'), text('beta')], [text('gamma')]],
) => render(ctxWith({ width, config: { theme: 'panel', widthOffset: 0, tui, lines } })).map(stripAnsi);

describe('grid helpers', () => {
  it('parses spans, dots and dividers', () => {
    expect(parseArea('a a b . .')).toEqual({
      divider: false,
      cells: [
        { name: 'a', span: 2 },
        { name: 'b', span: 1 },
        { name: '.', span: 1 },
        { name: '.', span: 1 },
      ],
    });
    expect(parseArea(' ---- ')).toEqual({ divider: true });
  });

  it('picks the widest matching breakpoint', () => {
    const bps = [
      { minWidth: 0, areas: ['s'] },
      { minWidth: 80, areas: ['l'] },
      { minWidth: 50, areas: ['m'] },
    ];
    expect(pickBreakpoint(bps, 100)?.areas).toEqual(['l']);
    expect(pickBreakpoint(bps, 60)?.areas).toEqual(['m']);
    expect(pickBreakpoint(bps, 10)?.areas).toEqual(['s']);
  });

  it('sizes auto, fixed and fr columns', () => {
    const rows = [parseArea('a b c'), parseArea('dd dd c')];
    const w = { a: 3, b: 5, c: 2, dd: 12 } as Record<string, number>;
    expect(sizeColumns(['auto', '4', '1fr'], rows, (n) => w[n]!, 30, 1)).toEqual([3, 8, 17]);
    expect(sizeColumns(['auto', 'auto', 'auto'], rows, (n) => w[n]!, null, 1)).toEqual([3, 8, 2]);
  });
});

describe('panel style', () => {
  it('draws a rounded box with title, lines and dividers', () => {
    const out = panel();
    expect(out).toHaveLength(5);
    expect(out[0]).toMatch(/^╭─ .*ccinfobar ─╮$/);
    expect(out[1]).toBe(`│ alpha  beta${' '.repeat(25)} │`);
    expect(out[2]).toBe(`├${'─'.repeat(38)}┤`);
    expect(out[4]).toBe(`╰${'─'.repeat(38)}╯`);
    for (const l of out) expect(visibleWidth(l)).toBe(40);
  });

  it('supports box presets, ascii charset and custom title/footer', () => {
    const out = panel({
      box: 'double',
      dividers: false,
      title: { left: 'T', right: false },
      footer: { right: '{gamma}' },
    });
    expect(out[0]).toBe(`╔─ T ${'═'.repeat(34)}╗`.replace('╔─', '╔═'));
    expect(out).toHaveLength(4);
    expect(out[3]!.endsWith(' gamma ═╝')).toBe(true);
    const ascii = render(
      ctxWith({
        width: 30,
        config: { theme: 'panel', charset: 'text', widthOffset: 0, lines: [[text('x')]] },
      }),
    ).map(stripAnsi);
    expect(ascii[0]!.startsWith('+-')).toBe(true);
    expect(ascii[1]!.startsWith('| x')).toBe(true);
  });

  it('fits content when asked', () => {
    const out = panel({ fitContent: true, minWidth: 10, title: { right: false } }, null);
    expect(visibleWidth(out[1]!)).toBe(visibleWidth('│ alpha  beta │'));
  });

  it('lays out a grid with spans, alignment and culling', () => {
    const out = panel(
      {
        dividers: false,
        minWidth: 10,
        title: { left: '', right: false },
        breakpoints: [
          {
            minWidth: 30,
            areas: ['alpha alpha beta', '---', 'missing . .', 'gamma . beta'],
            columns: ['auto', 'auto', '1fr'],
            align: ['left', 'left', 'right'],
          },
        ],
      },
      30,
    );
    expect(out).toEqual([
      `╭${'─'.repeat(28)}╮`,
      `│ alpha${' '.repeat(17)}beta │`,
      `├${'─'.repeat(28)}┤`,
      `│ gamma${' '.repeat(17)}beta │`,
      `╰${'─'.repeat(28)}╯`,
    ]);
  });

  it('switches breakpoints with width and resolves widget parts', () => {
    const tui: TuiConfig = {
      title: { left: '', right: false },
      breakpoints: [
        { minWidth: 60, areas: ['model.label model.value'] },
        { minWidth: 0, areas: ['model.value'] },
      ],
    };
    const lines = [[{ id: 'm', type: 'model', label: 'M: ' }]];
    const wide = render(ctxWith({ width: 70, config: { theme: 'panel', widthOffset: 0, tui, lines } })).map(
      stripAnsi,
    );
    const narrow = render(ctxWith({ width: 40, config: { theme: 'panel', widthOffset: 0, tui, lines } })).map(
      stripAnsi,
    );
    expect(wide[1]).toMatch(/^│ M: {3}Opus 5\.5 +│$/);
    expect(narrow[1]).toMatch(/^│ Opus 5\.5 +│$/);
  });

  it('renders templates with between justification', () => {
    const out = panel(
      {
        minWidth: 10,
        title: { left: '', right: false },
        templates: { pair: { items: ['{alpha}', '{beta}'], justify: 'between' } },
        breakpoints: [{ minWidth: 0, areas: ['pair'] }],
      },
      30,
    );
    expect(out[1]).toBe(`│ alpha${' '.repeat(17)}beta │`);
    expect(visibleWidth(out[1]!)).toBe(30);
  });

  it('returns nothing when every cell is empty', () => {
    expect(panel({ breakpoints: [{ minWidth: 0, areas: ['nope'] }] })).toEqual([]);
  });
});

describe('auto wrap and charset', () => {
  it('wraps widgets onto new lines instead of truncating', () => {
    const lines = [[text('aaaaaa'), text('bbbbbb'), text('cccccc')]];
    const wrapped = render(ctxWith({ width: 20, config: { widthOffset: 0, autoWrap: true, lines } }));
    expect(wrapped).toEqual(['aaaaaa │ bbbbbb', 'cccccc']);
    const cut = render(ctxWith({ width: 20, config: { widthOffset: 0, lines } }));
    expect(cut).toHaveLength(1);
  });

  it('uses ascii glyphs, bars and labels in text charset', () => {
    const lines = [[text('a'), text('b'), { id: 'c', type: 'context-bar' }]];
    const out = render(
      ctxWith({ config: { theme: 'tokyo-night', charset: 'text', icons: 'nerd', lines } }),
    ).map(stripAnsi);
    expect(out[0]).toBe(' a  b  Ctx ===------- 34% ');
    expect(out[0]).not.toMatch(/[^\x20-\x7e]/);
  });
});
