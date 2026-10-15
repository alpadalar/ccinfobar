import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { presetText, themeDescription } from '../../src/core/i18n/catalog-text.js';
import { PRESETS } from '../../src/core/presets.js';
import type { Config } from '../../src/core/types.js';
import { type Action, initialState, reduce, type State, themeItems } from '../../src/tui/state.js';
import { renderScreen } from '../../src/tui/view.js';
import { withLang } from '../helpers.js';

const build = (config: Config = defaultConfig(), ...actions: Action[]): State =>
  actions.reduce(reduce, initialState(config, '/tmp/cc/config.json'));
const screen = (s: State, cols = 100, rows = 30) => renderScreen(s, cols, rows).lines;
const text = (s: State, cols = 100, rows = 30) => screen(s, cols, rows).map(stripAnsi).join('\n');
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
