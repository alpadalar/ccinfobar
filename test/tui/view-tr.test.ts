import { describe, expect, it } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { setThemeRotation } from '../../src/core/edit.js';
import { presetText, themeDescription } from '../../src/core/i18n/catalog-text.js';
import { PRESETS } from '../../src/core/presets.js';
import type { Config } from '../../src/core/types.js';
import { visibleWidthIn, widthMode } from '../../src/core/width.js';
import {
  type Action,
  initialState,
  reduce,
  type State,
  settingsFields,
  themeItems,
} from '../../src/tui/state.js';
import { renderScreen } from '../../src/tui/view.js';
import { withLang } from '../helpers.js';

const build = (config: Config = defaultConfig(), ...actions: Action[]): State =>
  actions.reduce(reduce, initialState(config, '/tmp/cc/config.json'));
const screen = (s: State, cols = 100, rows = 30) => renderScreen(s, cols, rows).lines;
const text = (s: State, cols = 100, rows = 30) => screen(s, cols, rows).map(stripAnsi).join('\n');
const onField = (s: State, id: string): State => {
  const cursor = settingsFields(s).findIndex((f) => f.id === id);
  return { ...s, mode: { ...(s.mode as Extract<State['mode'], { kind: 'settings' }>), cursor } };
};
const pooled = () => setThemeRotation(defaultConfig(), { themes: ['nord'], every: 'hour' });

const boldParts = (line: string) =>
  [...line.matchAll(/\x1b\[1m([^\x1b]*)\x1b\[22m/g)].map((m) => m[1]!.trim());
const hintKeys = (s: State) => boldParts(screen(s, 300, 30).at(-1)!);

const MODES: Action[][] = [
  [],
  [{ type: 'openPicker' }],
  [{ type: 'openGlobal' }],
  [{ type: 'openProps' }, { type: 'enter' }],
  [{ type: 'openThemes' }],
  [{ type: 'openPresets' }],
  [{ type: 'removeChip' }, { type: 'quit' }],
  [{ type: 'help' }],
];

describe('Turkish TUI view', () => {
  it('keeps the key letters in the hint bar and translates the words', () => {
    const words: Record<string, string> = { type: 'yaz', 'any key': 'bir tuş' };
    for (const actions of MODES) {
      const s = build(defaultConfig(), ...actions);
      const en = hintKeys(s);
      expect(en.length).toBeGreaterThan(0);
      expect(withLang('tr', () => hintKeys(s))).toEqual(en.map((k) => words[k] ?? k));
    }
    const hints = withLang('tr', () => stripAnsi(screen(build(), 300, 30).at(-1)!));
    for (const h of ['←→↑↓ seç', 'S-arrows taşı', 'a ekle', 's kaydet', 'q çık', '? yardım', 'u geri al'])
      expect(hints).toContain(h);
    expect(hints).not.toMatch(/\b(?:select|quit|help|undo)\b/);
  });

  it('keeps the help key column', () => {
    const s = build(defaultConfig(), { type: 'help' });
    const keys = (lines: string[]) => {
      const top = lines.findIndex((l) => stripAnsi(l).startsWith('── '));
      return lines.slice(top + 1, -2).flatMap((l) => boldParts(l).slice(0, 1));
    };
    const en = keys(screen(s, 80, 40));
    const tr = withLang('tr', () => keys(screen(s, 80, 40)));
    expect(en).toContain('q  Esc');
    expect(tr).toEqual(en.map((k) => (k === 'Mouse' ? 'Fare' : k)));
    const out = withLang('tr', () => text(s, 80, 40));
    expect(out).toContain('Tuşlar · kapatmak için bir tuşa basın');
    expect(out).toContain('geri al');
    expect(out).toContain("Claude Code'a kur");
  });

  it('translates the canvas, header and preview title', () => {
    const one = { ...defaultConfig(), lines: [defaultConfig().lines[0]!, []] };
    const out = withLang('tr', () => text(build(one)));
    expect(out).toContain('Önizleme · örnek veri');
    expect(out).toContain('Satırlar · 2 satır');
    expect(out).toContain('(boş satır)');
    expect(out).toContain('Seçili');
    expect(out).toContain('kaydedildi');
    expect(out).not.toMatch(/Preview|Lines ·|Selected|empty line/);
    expect(withLang('tr', () => text(build(one, { type: 'removeChip' }))).split('\n')[0]).toContain(
      'değişti',
    );
    expect(withLang('tr', () => text(build({ ...one, lines: [] })))).toContain('Henüz satır yok');
    expect(withLang('tr', () => text(build(), 50, 10))).toContain('Terminal çok küçük (50x10).');
  });

  it('translates the modals', () => {
    const tr = (...actions: Action[]) => withLang('tr', () => text(build(defaultConfig(), ...actions)));
    expect(tr({ type: 'openPicker' })).toContain('Bileşen ekle');
    expect(tr({ type: 'openPicker' })).toContain('Filtre:');
    expect(tr({ type: 'openPicker' }, { type: 'text', text: 'zzzqqq' })).toContain('Eşleşen bileşen yok');
    expect(tr({ type: 'openGlobal' })).toContain('Genel ayarlar');
    expect(tr({ type: 'openProps' })).toContain('· özellikler');
    expect(tr({ type: 'removeChip' }, { type: 'quit' })).toContain('kaydet ve çık');
    expect(tr({ type: 'deleteLine' })).toMatch(/Satır 1 silinsin mi\? İçinde \d+ bileşen var\./);
    expect(tr({ type: 'openThemes' })).toContain('Temalar');
    expect(tr({ type: 'openThemes' })).toMatch(/\d+ tema · Ctrl\+S/);
    expect(tr({ type: 'openThemes' }, { type: 'saveTheme' })).toContain('Kendi temam olarak kaydet');
    expect(tr({ type: 'openPresets' })).toContain('Hazır ayarlar · mevcut düzenin yerine geçer');
  });

  it('translates the install subagent toggle', () => {
    const plan = { current: null, proposed: 'ccinfobar', needsConfirm: false };
    const tr = (subagents: boolean) =>
      withLang('tr', () => text(build(defaultConfig(), { type: 'installPlanned', plan, subagents })));
    expect(tr(false)).toContain('s Alt ajan satırları: kapalı');
    expect(tr(true)).toContain('s Alt ajan satırları: açık');
  });

  it('translates the kept subagent state', () => {
    const plan = {
      current: 'ccinfobar',
      proposed: 'ccinfobar',
      needsConfirm: false,
      subagent: { owner: 'us' as const, change: 'x' },
    };
    const out = withLang('tr', () =>
      text(build(defaultConfig(), { type: 'installPlanned', plan, subagents: false })),
    );
    expect(out).toContain('s Alt ajan satırları: korunur');
    expect(out).toContain("ccinfobar'ın kurduğu alt ajan satırı kalır");
  });

  it('shows preset and theme text from the catalog', () => {
    const presets = withLang('tr', () => text(build(defaultConfig(), { type: 'openPresets' })));
    const p = PRESETS[0]!;
    const name = withLang('tr', () => presetText(p, 'name'));
    expect(name).not.toBe(p.name);
    expect(presets).toContain(name);
    const themes = withLang('tr', () => text(build(defaultConfig(), { type: 'openThemes' }), 200, 40));
    const first = themeItems('')[0]!;
    const desc = withLang('tr', () => themeDescription(first));
    expect(desc).not.toBe(first.description);
    expect(themes).toContain(desc.slice(0, 20));
  });
});

describe('Turkish TUI width', () => {
  const SIZES = [
    [100, 30],
    [80, 24],
    [60, 20],
  ] as const;
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
  const WIDE = { emoji: 2, ambiguous: 2 } as const;

  it.each([1, 2] as const)('every screen fits its width with ambiguousWidth %i', (amb) => {
    const config: Config = {
      ...defaultConfig(),
      language: 'tr',
      ...(amb === 2 ? { ambiguousWidth: 2 } : {}),
    };
    const width = (l: string) => (amb === 2 ? visibleWidthIn(l, WIDE) : visibleWidth(l));
    withLang('tr', () => {
      for (const [name, actions] of Object.entries(SCREENS)) {
        const s = build(config, ...actions);
        for (const [cols, rows] of SIZES) {
          const lines = renderScreen(s, cols, rows).lines;
          expect(lines, `${name} ${cols}x${rows}`).toHaveLength(rows);
          for (const l of lines)
            expect(width(l), `${name} ${cols}x${rows}: ${stripAnsi(l)}`).toBeLessThanOrEqual(cols);
          const plain = lines.map(stripAnsi);
          const top = plain.findIndex((l) => l.startsWith('┌'));
          expect(plain[top]!.endsWith('┐'), `${name} ${cols}x${rows}`).toBe(true);
          for (let i = top + 1; plain[i]!.startsWith('│'); i++) expect(plain[i]!.endsWith('│')).toBe(true);
          expect(plain.at(-1)!.endsWith('…')).toBe(false);
        }
      }
    });
  });

  it('measures with the configured ambiguous width and restores the mode', () => {
    const config: Config = { ...defaultConfig(), language: 'tr', ambiguousWidth: 2 };
    const before = widthMode();
    const lines = withLang('tr', () => renderScreen(build(config), 80, 24).lines.map(stripAnsi));
    expect(widthMode()).toBe(before);
    const top = lines.find((l) => l.startsWith('┌'))!;
    expect(visibleWidthIn(top, WIDE)).toBeLessThanOrEqual(80);
    expect(visibleWidthIn(top, WIDE)).toBeGreaterThanOrEqual(79);
    expect(visibleWidth(top)).toBeLessThan(60);
  });
});

describe('TUI theme previews', () => {
  it('follow a language switch at once', () => {
    const config: Config = {
      ...defaultConfig(),
      language: 'en',
      lines: [[{ id: 'c', type: 'context-bar' }]],
    };
    const s = build(config, { type: 'openThemes' });
    const en = text(s);
    expect(en).toContain('Ctx ');
    const next: State = { ...s, config: { ...s.config, language: 'tr' } };
    const tr = withLang('tr', () => text(next));
    expect(tr).toContain('Bağlam ');
    expect(tr).not.toContain('Ctx ');
  });
});

describe('disabled rotation rows', () => {
  it('shows the hint in the value column and the help line until a theme is added', () => {
    const empty = onField(build(defaultConfig(), { type: 'openGlobal' }), 'rotation.every');
    const lines = withLang('tr', () => text(empty, 100, 90)).split('\n');
    expect(lines.filter((l) => l.includes('Önce tema ekleyin')).length).toBeGreaterThanOrEqual(3);
    const withPool = onField(build(pooled(), { type: 'openGlobal' }), 'rotation.every');
    expect(withLang('tr', () => text(withPool, 100, 90))).not.toContain('Önce tema ekleyin');
  });
});
