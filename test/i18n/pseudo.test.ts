import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { en } from '../../src/core/i18n/en/index.js';
import { type Message, t } from '../../src/core/i18n/index.js';
import { isLanguageId, LANGUAGES } from '../../src/core/i18n/languages.js';
import { widgetText } from '../../src/core/i18n/widget-text.js';
import { render } from '../../src/core/renderer.js';
import type { Config, OverflowMode, TuiConfig, WidgetItem } from '../../src/core/types.js';
import { visibleWidthIn, type WidthMode } from '../../src/core/width.js';
import { type Action, initialState, reduce, type State } from '../../src/tui/state.js';
import { renderScreen } from '../../src/tui/view.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { ctxWith, renderWidget, withLang } from '../helpers.js';
import { IDEOGRAPH, pseudoLanguage, wide } from './pseudo.js';

const zz = pseudoLanguage();
const mode = (amb: 1 | 2): WidthMode => ({ emoji: 2, ambiguous: amb });
const params = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
const edges = (s: string) =>
  s.split('\n').map((l) => [/^\s*/.exec(l)![0], /\s*$/.exec(l)![0], l.trim() === ''].join('|'));
const forms = (m: Message) => (typeof m === 'string' ? [m] : [m.one, m.other]);

describe('pseudo-locale zz', () => {
  it('is never registered for users', () => {
    expect(isLanguageId('zz')).toBe(false);
    expect(LANGUAGES.map((l) => l.id)).not.toContain('zz');
  });

  it('has every English id with the same params and whitespace', () => {
    expect(Object.keys(zz.messages).sort()).toEqual(Object.keys(en).sort());
    for (const [id, m] of Object.entries(en) as [string, Message][]) {
      const w = (zz.messages as Record<string, Message>)[id]!;
      expect(typeof w, id).toBe(typeof m);
      const [a, b] = [forms(m), forms(w)];
      for (let i = 0; i < a.length; i++) {
        expect(params(b[i]!), id).toEqual(params(a[i]!));
        expect(edges(b[i]!), id).toEqual(edges(a[i]!));
        if (/[A-Za-z]/.test(a[i]!))
          expect(visibleWidthIn(b[i]!, mode(1)), id).toBeGreaterThan(visibleWidthIn(a[i]!, mode(1)));
      }
    }
  });

  it('widens words and keeps params', () => {
    expect(wide('  Saved {path}\n')).toBe(`  Ｓａｖｅｄ {path}${IDEOGRAPH}\n`);
    expect(wide('a\n\nb')).toBe(`ａ${IDEOGRAPH}\n\nｂ${IDEOGRAPH}`);
    expect(withLang(zz, () => t('tui.view.lines', { count: 1 }))).toContain(IDEOGRAPH);
  });

  it('covers widget and catalog metadata', () => {
    for (const d of ALL_WIDGETS) {
      const name = withLang(zz, () => widgetText(d, 'name'));
      expect(name, d.type).toBe(wide(d.name));
      if (d.label)
        expect(
          withLang(zz, () => widgetText(d, 'label')),
          d.type,
        ).toBe(wide(d.label));
    }
  });
});

const build = (config: Config, ...actions: Action[]): State =>
  actions.reduce(reduce, initialState(config, '/tmp/cc/config.json'));

const SCREENS: Record<string, Action[]> = {
  normal: [],
  picker: [{ type: 'openPicker' }],
  help: [{ type: 'help' }],
  presets: [{ type: 'openPresets' }],
  themes: [{ type: 'openThemes' }],
  naming: [{ type: 'openThemes' }, { type: 'saveTheme' }],
  global: [{ type: 'openGlobal' }],
  props: [{ type: 'openProps' }, { type: 'enter' }],
  quit: [{ type: 'removeChip' }, { type: 'quit' }],
  deleteLine: [{ type: 'deleteLine' }],
};

const SIZES = [
  [100, 30],
  [80, 24],
  [60, 20],
  [81, 25],
  [61, 21],
] as const;

describe('TUI under zz', () => {
  it.each([1, 2] as const)('every screen fits and keeps its box with ambiguousWidth %i', (amb) => {
    const config: Config = { ...defaultConfig(), ...(amb === 2 ? { ambiguousWidth: 2 } : {}) };
    withLang(zz, () => {
      for (const [name, actions] of Object.entries(SCREENS)) {
        const s = build(config, ...actions);
        for (const [cols, rows] of SIZES) {
          const where = `${name} ${cols}x${rows}`;
          const lines = renderScreen(s, cols, rows).lines;
          expect(lines, where).toHaveLength(rows);
          for (const l of lines)
            expect(visibleWidthIn(l, mode(amb)), `${where}: ${stripAnsi(l)}`).toBeLessThanOrEqual(cols);
          const plain = lines.map(stripAnsi);
          expect(plain.join('\n'), where).toContain(IDEOGRAPH);
          const top = plain.findIndex((l) => l.startsWith('┌'));
          expect(plain[top]!.endsWith('┐'), where).toBe(true);
          const box = visibleWidthIn(plain[top]!, mode(amb));
          let i = top + 1;
          for (; plain[i]!.startsWith('│'); i++) {
            expect(plain[i]!.endsWith('│'), `${where}: ${plain[i]}`).toBe(true);
            expect(visibleWidthIn(plain[i]!, mode(amb)), `${where}: ${plain[i]}`).toBe(box);
          }
          expect(plain[i]!.endsWith('┘'), `${where}: ${plain[i]}`).toBe(true);
          expect(visibleWidthIn(plain[i]!, mode(amb)), `${where}: ${plain[i]}`).toBe(box);
        }
      }
    });
  });
});

const text = (s: string): WidgetItem => ({ id: s, type: 'text', options: { text: s } });

describe('panels under zz', () => {
  const lines = (): WidgetItem[][] => [
    [{ id: 'm', type: 'model' }, { id: 'c', type: 'context-percentage' }, text('alpha')],
    [
      { id: 'b', type: 'git-branch' },
      { id: 'cost', type: 'session-cost' },
    ],
  ];
  const grid: TuiConfig = {
    title: { left: 'ccinfobar' },
    breakpoints: [
      {
        minWidth: 60,
        areas: ['m.label m.value c', '---', 'b cost alpha'],
        columns: ['auto', 'auto', '1fr'],
        align: ['left', 'left', 'right'],
      },
      { minWidth: 0, areas: ['m c', 'b cost'], columns: ['auto', '1fr'] },
    ],
  };
  const panel = (tui: TuiConfig, width: number, amb: 1 | 2) =>
    withLang(zz, () =>
      render(
        ctxWith({
          width,
          config: {
            theme: 'panel',
            widthOffset: 0,
            tui: { fitContent: false, ...tui },
            lines: lines(),
            ...(amb === 2 ? { ambiguousWidth: 2 } : {}),
          },
        }),
      ).map(stripAnsi),
    );

  it.each([1, 2] as const)('line and grid layouts stay inside the width with ambiguousWidth %i', (amb) => {
    for (const [name, tui] of [
      ['lines', {}],
      ['grid', grid],
    ] as const) {
      for (const width of [80, 50]) {
        const out = panel(tui, width, amb);
        const where = `${name} ${width}`;
        expect(out.length, where).toBeGreaterThan(2);
        expect(out.join('\n'), where).toContain(IDEOGRAPH);
        const ws = out.map((l) => visibleWidthIn(l, mode(amb)));
        for (const [i, w] of ws.entries()) expect(w, `${where}: ${out[i]}`).toBeLessThanOrEqual(width);
        if (name === 'grid') expect(new Set(ws).size, `${where}\n${out.join('\n')}`).toBe(1);
      }
    }
  });
});

describe('widget line under zz', () => {
  const labelled = ALL_WIDGETS.filter(
    (d) => d.label && withLang(zz, () => renderWidget(d.type, ctxWith())) !== null,
  ).slice(0, 6);

  it.each([
    ['truncate', 1],
    ['priority', 1],
    ['truncate', 2],
    ['priority', 2],
  ] as [OverflowMode, 1 | 2][])(
    'six labelled widgets fit 60 columns with overflow %s, ambiguous %i',
    (overflow, amb) => {
      expect(labelled).toHaveLength(6);
      const out = withLang(zz, () =>
        render(
          ctxWith({
            width: 60,
            config: {
              widthOffset: 0,
              maxWidth: 60,
              overflow,
              lines: [labelled.map((d) => ({ id: d.type, type: d.type }))],
              ...(amb === 2 ? { ambiguousWidth: 2 } : {}),
            },
          }),
        ),
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out.map(stripAnsi).join('\n')).toContain(IDEOGRAPH);
      for (const l of out) expect(visibleWidthIn(l, mode(amb)), stripAnsi(l)).toBeLessThanOrEqual(60);
    },
  );
});
