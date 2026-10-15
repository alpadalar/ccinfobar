import { describe, expect, it } from 'vitest';
import { help, OPTIONS, USAGE } from '../../src/cli/help.js';
import { benchTable, type RowName, type Stats } from '../../src/commands/bench.js';
import { rowLine } from '../../src/commands/explain.js';
import { NAMED_COLORS, stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { en } from '../../src/core/i18n/en/index.js';
import { type Message, t } from '../../src/core/i18n/index.js';
import { isLanguageId, LANGUAGES } from '../../src/core/i18n/languages.js';
import { widgetText } from '../../src/core/i18n/widget-text.js';
import { inspectRows } from '../../src/core/inspect.js';
import { PRESETS } from '../../src/core/presets.js';
import { scenarioListLines } from '../../src/core/preview.js';
import { render } from '../../src/core/renderer.js';
import {
  sampleAgents,
  sampleGit,
  sampleGsd,
  sampleHistory,
  sampleJobs,
  sampleLimits,
  samplePayload,
  sampleTranscript,
} from '../../src/core/sample.js';
import { SCENARIOS } from '../../src/core/scenarios.js';
import { BUILTIN_THEMES, STYLES } from '../../src/core/themes.js';
import type { Config, OverflowMode, TuiConfig, WidgetItem } from '../../src/core/types.js';
import { visibleWidthIn, type WidthMode } from '../../src/core/width.js';
import { type Action, initialState, reduce, type State } from '../../src/tui/state.js';
import { renderScreen } from '../../src/tui/view.js';
import { ALL_WIDGETS } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget, withLang } from '../helpers.js';
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

const COL = 34;
const KNOWN = [...USAGE, ...OPTIONS].map(([u]) => u);
const usageOf = (line: string) =>
  KNOWN.filter((u) => line === `  ${u}` || line.startsWith(`  ${u} `)).sort((a, b) => b.length - a.length)[0];
const FULL = /[\uff21-\uff5a]/;
const startCol = (line: string, at: number) => visibleWidthIn(line.slice(0, at), mode(1));

// description column of help(), with the visible column each part starts at
function helpDescriptions(text: string): { line: string; col: number; desc: string }[] {
  const out: { line: string; col: number; desc: string }[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('  ')) continue;
    const u = line.startsWith('   ') ? undefined : usageOf(line);
    if (u !== undefined && line === `  ${u}`) continue;
    const head = u === undefined ? '' : `  ${u}`;
    const at = head.length + /^ */.exec(line.slice(head.length))![0].length;
    out.push({ line, col: startCol(line, at), desc: line.slice(at) });
  }
  return out;
}

describe('help and CLI tables under zz', () => {
  it('starts every help description at column 34', () => {
    const text = withLang(zz, () => help());
    const rows = helpDescriptions(text);
    expect(rows.length).toBeGreaterThanOrEqual(KNOWN.length);
    for (const r of rows) {
      expect(r.col, r.line).toBe(COL);
      expect(r.desc, r.line).toMatch(FULL);
    }
    expect(text.split('\n').filter((l) => usageOf(l) !== undefined)).toHaveLength(KNOWN.length);
  });

  it('aligns the scenario list', () => {
    const lines = withLang(zz, () => scenarioListLines());
    expect(lines[0]).toContain(IDEOGRAPH);
    const cols = lines.slice(1).map((l) => startCol(l, /^ +\S+ +/.exec(l)![0].length));
    expect(cols).toHaveLength(SCENARIOS.length);
    expect(new Set(cols).size, lines.join('\n')).toBe(1);
  });

  it('starts explain rows and their notes at fixed columns', () => {
    const lines = [
      [
        { id: 'model', type: 'model' },
        { id: 'ctx', type: 'context-percentage' },
        { id: 'flex', type: 'flex' },
        { id: 'branch', type: 'git-branch' },
      ],
      [
        { id: 'messages', type: 'message-count' },
        { id: 'nope', type: 'nope' },
      ],
    ];
    const out = withLang(zz, () => {
      const rows = inspectRows(ctxWith({ config: { lines, overflow: 'priority' } }));
      return rows.map((r) => ({ r, line: rowLine(r, true), note: t('explain.row.note', { reason: 'x' }) }));
    });
    expect(out.length).toBe(6);
    for (const { r, line, note } of out) {
      const name = r.id === r.type ? r.type : `${r.id} (${r.type})`;
      expect(startCol(line, line.indexOf(name)), line).toBe(4);
      expect(startCol(line, 2), line).toBe(2);
      expect(startCol(note, note.indexOf('x')), note).toBe(6);
    }
  });

  it('aligns the bench table', () => {
    const s = (median: number): Stats => ({ n: 20, median, p95: median * 2, min: 1.25, max: 1234.5 });
    const rows: [RowName, Stats][] = [
      ['control', s(67.3)],
      ['cold', s(144.6)],
      ['warm', s(125.6)],
      ['warm-no-compile-cache', s(135.3)],
      ['hook', s(77.7)],
    ];
    const lines = withLang(zz, () => benchTable(rows));
    const ends = (line: string) =>
      [...line.matchAll(/[\d.]+(?=\s|$)/g)].map((m) => startCol(line, m.index + m[0].length));
    const want = ends(lines[1]!);
    expect(want).toHaveLength(5);
    for (const l of lines.slice(1)) expect(ends(l), l).toEqual(want);
    expect(new Set(lines.slice(1).map((l) => visibleWidthIn(l, mode(1)))).size).toBe(1);
    const head = lines[0]!;
    const heads = [...head.matchAll(/\S+/g)].slice(1, 6).map((m) => startCol(head, m.index + m[0].length));
    expect(heads).toEqual(want);
  });
});

// words of string values only, not of object keys
const wordsOf = (v: unknown): string[] =>
  typeof v === 'string'
    ? (v.match(/[A-Za-z]{3,}/g) ?? [])
    : v && typeof v === 'object'
      ? Object.values(v).flatMap(wordsOf)
      : [];

// ids, key names, proper nouns and sample user data
function allowList(): Set<string> {
  const ids = [
    ...ALL_WIDGETS.map((d) => d.type),
    ...BUILTIN_THEMES.flatMap((x) => [x.id, x.name]),
    ...STYLES.map((x) => x.id),
    ...PRESETS.map((x) => x.id),
    ...SCENARIOS.map((x) => x.id),
    ...Object.keys(defaultConfig()),
    ...Object.keys(NAMED_COLORS),
    ...LANGUAGES.map((l) => l.name),
    ...KNOWN,
    'auto',
  ];
  const keys = ['Enter', 'Esc', 'Tab', 'Ctrl', 'Shift', 'Alt', 'Space', 'Del', 'Delete', 'arrows'];
  const names = ['ccinfobar', 'Claude', 'Code', 'GSD', 'JSON', 'MCP', 'API'];
  const now = NOW.getTime();
  const data = [
    samplePayload(now),
    sampleGit(),
    sampleGsd(),
    sampleTranscript(now),
    sampleAgents(now),
    sampleHistory(now),
    sampleLimits(now),
    sampleJobs(now),
    '/tmp/cc/config.json',
  ].flatMap(wordsOf);
  return new Set([...ids.flatMap(wordsOf), ...keys, ...names, ...data]);
}

describe('untranslated text under zz', () => {
  const allow = allowList();
  const hits = (where: string, lines: string[]) =>
    lines.flatMap((l) =>
      [...stripAnsi(l).matchAll(/[A-Za-z]{3,}/g)]
        .filter((m) => !allow.has(m[0]))
        .map((m) => `${where}: "${m[0]}" in ${stripAnsi(l).trim()}`),
    );

  it('leaves no English word on the TUI screens', () => {
    const found = withLang(zz, () =>
      Object.entries(SCREENS).flatMap(([name, actions]) => {
        const s = build(defaultConfig(), ...actions);
        return [
          [120, 40],
          [80, 24],
        ].flatMap(([cols, rows]) => hits(`${name} ${cols}x${rows}`, renderScreen(s, cols!, rows!).lines));
      }),
    );
    expect(found).toEqual([]);
  });

  it('leaves no English word in the help descriptions', () => {
    const rows = helpDescriptions(withLang(zz, () => help()));
    expect(
      hits(
        'help',
        rows.map((r) => r.desc),
      ),
    ).toEqual([]);
  });

  it('catches a hard-coded word', () => {
    expect(hits('probe', ['Ｓａｖｅｄ中 Opus Wibble'])).toEqual([
      'probe: "Wibble" in Ｓａｖｅｄ中 Opus Wibble',
    ]);
  });
});
