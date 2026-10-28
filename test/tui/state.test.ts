import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { PRESETS } from '../../src/core/presets.js';
import { saveUserTheme } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import { pickerItems } from '../../src/tui/catalog.js';
import { runEffect } from '../../src/tui/index.js';
import {
  type Action,
  initialState,
  previewConfig,
  reduce,
  type State,
  selectedItem,
  settingsFields,
  themeItems,
} from '../../src/tui/state.js';
import { withLang } from '../helpers.js';

const cfg = (): Config => ({
  ...defaultConfig(),
  lines: [
    [
      { id: 'a', type: 'model' },
      { id: 'b', type: 'cwd' },
      { id: 'c', type: 'git-branch' },
    ],
    [{ id: 'd', type: 'model' }],
    [],
  ],
});

const run = (s: State, ...actions: Action[]) => actions.reduce(reduce, s);
const ids = (s: State) => s.config.lines.map((l) => l.map((i) => i.id).join(''));
const start = () => initialState(cfg(), '/tmp/c.json');

describe('selection', () => {
  it('clamps at edges', () => {
    let s = run(start(), { type: 'select', dir: 'left' });
    expect(s.sel).toEqual({ line: 0, index: 0 });
    s = run(s, { type: 'select', dir: 'end' });
    expect(s.sel.index).toBe(2);
    s = run(s, { type: 'select', dir: 'right' });
    expect(s.sel.index).toBe(2);
    s = run(s, { type: 'select', dir: 'up' });
    expect(s.sel.line).toBe(0);
  });

  it('clamps index when moving between lines of different length', () => {
    const s = run(start(), { type: 'select', dir: 'end' }, { type: 'select', dir: 'down' });
    expect(s.sel).toEqual({ line: 1, index: 0 });
    const t = run(s, { type: 'select', dir: 'down' }, { type: 'select', dir: 'down' });
    expect(t.sel.line).toBe(2);
    expect(selectedItem(t)).toBeUndefined();
  });
});

describe('moving', () => {
  it('moves a chip within its line and follows it', () => {
    const s = run(start(), { type: 'shiftChip', dir: 'right' });
    expect(ids(s)).toEqual(['bac', 'd', '']);
    expect(s.sel.index).toBe(1);
    const t = run(s, { type: 'shiftChip', dir: 'left' }, { type: 'shiftChip', dir: 'left' });
    expect(ids(t)[0]).toBe('abc');
    expect(t.sel.index).toBe(0);
  });

  it('does not move past the end', () => {
    const s = run(start(), { type: 'select', dir: 'end' }, { type: 'shiftChip', dir: 'right' });
    expect(ids(s)[0]).toBe('abc');
    expect(s.dirty).toBe(false);
  });

  it('moves a chip to the next and previous line', () => {
    const s = run(start(), { type: 'chipLine', dir: 'down' });
    expect(ids(s)).toEqual(['bc', 'ad', '']);
    expect(s.sel).toEqual({ line: 1, index: 0 });
    const t = run(s, { type: 'chipLine', dir: 'up' });
    expect(ids(t)[0]).toBe('abc');
  });

  it('moves lines', () => {
    const s = run(start(), { type: 'moveLine', dir: 'down' });
    expect(ids(s)).toEqual(['d', 'abc', '']);
    expect(s.sel.line).toBe(1);
    expect(run(s, { type: 'moveLine', dir: 'up' }, { type: 'moveLine', dir: 'up' }).sel.line).toBe(0);
  });
});

describe('insert and delete', () => {
  it('removes the selected chip and keeps selection valid', () => {
    const s = run(start(), { type: 'select', dir: 'end' }, { type: 'removeChip' });
    expect(ids(s)[0]).toBe('ab');
    expect(s.sel.index).toBe(1);
  });

  it('inserts from the picker after the selection', () => {
    const s = run(start(), { type: 'openPicker' }, { type: 'text', text: 'branch' }, { type: 'enter' });
    expect(s.mode.kind).toBe('normal');
    expect(s.config.lines[0]).toHaveLength(4);
    expect(s.config.lines[0]![1]!.type).toBe(pickerItems('branch')[0]!.type);
    expect(s.sel).toEqual({ line: 0, index: 1 });
    expect(s.dirty).toBe(true);
  });

  it('inserts into an empty line', () => {
    const s = run(
      start(),
      { type: 'selectAt', line: 2, index: 0 },
      { type: 'openPicker' },
      { type: 'enter' },
    );
    expect(s.config.lines[2]).toHaveLength(1);
    expect(s.sel).toEqual({ line: 2, index: 0 });
  });

  it('creates a new line below the selection', () => {
    const s = run(start(), { type: 'newLine' });
    expect(s.config.lines).toHaveLength(4);
    expect(s.sel).toEqual({ line: 1, index: 0 });
  });

  it('asks before deleting a non-empty line', () => {
    let s = run(start(), { type: 'deleteLine' });
    expect(s.mode.kind).toBe('confirm');
    expect(s.config.lines).toHaveLength(3);
    s = run(s, { type: 'confirm', answer: 'yes' });
    expect(s.config.lines).toHaveLength(2);
    s = run(s, { type: 'selectAt', line: 0, index: 0 }, { type: 'deleteLine' });
    expect(s.mode.kind).toBe('confirm');
    expect(run(s, { type: 'confirm', answer: 'no' }).config.lines).toHaveLength(2);
  });

  it('deletes an empty line without asking', () => {
    const s = run(start(), { type: 'selectAt', line: 2, index: 0 }, { type: 'deleteLine' });
    expect(s.mode.kind).toBe('normal');
    expect(s.config.lines).toHaveLength(2);
  });
});

describe('history and dirty flag', () => {
  it('undoes and redoes, tracking dirty against the saved snapshot', () => {
    let s = run(start(), { type: 'removeChip' });
    expect(s.dirty).toBe(true);
    s = run(s, { type: 'undo' });
    expect(ids(s)[0]).toBe('abc');
    expect(s.dirty).toBe(false);
    s = run(s, { type: 'redo' });
    expect(ids(s)[0]).toBe('bc');
    expect(s.dirty).toBe(true);
  });

  it('clears redo after a new edit', () => {
    const s = run(start(), { type: 'removeChip' }, { type: 'undo' }, { type: 'newLine' });
    expect(s.future).toHaveLength(0);
  });

  it('is clean after saving and dirty again after an edit', () => {
    let s = run(start(), { type: 'removeChip' }, { type: 'save' });
    expect(s.effect).toEqual({ kind: 'save' });
    s = run(s, { type: 'effectDone', ok: true, saved: true, message: 'Saved' });
    expect(s.dirty).toBe(false);
    expect(s.effect).toBeNull();
    expect(run(s, { type: 'removeChip' }).dirty).toBe(true);
  });

  it('keeps dirty when saving fails', () => {
    let s = run(start(), { type: 'removeChip' }, { type: 'save' });
    s = run(s, { type: 'effectDone', ok: false, message: 'Failed' });
    expect(s.dirty).toBe(true);
  });

  it('reports nothing to undo', () => {
    expect(run(start(), { type: 'undo' }).message).toContain('Nothing');
  });
});

describe('quit', () => {
  it('quits immediately when clean', () => {
    expect(run(start(), { type: 'quit' }).quit).toBe(true);
  });

  it('confirms when dirty', () => {
    let s = run(start(), { type: 'removeChip' }, { type: 'quit' });
    expect(s.quit).toBe(false);
    expect(s.mode).toEqual({ kind: 'confirm', what: 'quit' });
    expect(run(s, { type: 'confirm', answer: 'discard' }).quit).toBe(true);
    s = run(s, { type: 'confirm', answer: 'save' });
    expect(s.effect).toEqual({ kind: 'save', thenQuit: true });
    expect(run(s, { type: 'effectDone', ok: true, saved: true, message: 'Saved', thenQuit: true }).quit).toBe(
      true,
    );
  });
});

describe('picker filtering', () => {
  it('lists categories in order and hides GSD when it is not installed', () => {
    expect(pickerItems('')[0]?.category).toBe('session');
    expect(pickerItems('', false).some((w) => w.category === 'gsd')).toBe(false);
    expect(pickerItems('gsd', false).some((w) => w.category === 'gsd')).toBe(false);
  });

  it('filters by name, type and category', () => {
    expect(pickerItems('zzzzqqqq')).toHaveLength(0);
    expect(pickerItems('gsd').length).toBeGreaterThan(0);
    expect(pickerItems('model').some((w) => w.type === 'model')).toBe(true);
    expect(
      pickerItems('git').every(
        (w) => w.category === 'git' || /g.*i.*t/i.test(`${w.name}${w.type}${w.category}`),
      ),
    ).toBe(true);
  });

  it('resets the cursor when the filter changes and clamps navigation', () => {
    let s = run(start(), { type: 'openPicker' }, { type: 'nav', dir: 'down' }, { type: 'nav', dir: 'down' });
    expect(s.mode).toMatchObject({ kind: 'picker', cursor: 2 });
    s = run(s, { type: 'text', text: 'c' });
    expect(s.mode).toMatchObject({ cursor: 0 });
    s = run(s, { type: 'nav', dir: 'up' });
    expect(s.mode).toMatchObject({ cursor: 0 });
    s = run(s, { type: 'backspace' });
    expect(s.mode).toMatchObject({ filter: '' });
    s = run(s, { type: 'cancel' });
    expect(s.mode.kind).toBe('normal');
  });
});

describe('settings editor', () => {
  it('toggles a boolean field', () => {
    let s = run(start(), { type: 'openProps' });
    s = run(s, { type: 'nav', dir: 'down' }, { type: 'nav', dir: 'down' }, { type: 'enter' });
    expect(s.config.lines[0]![0]!.bold).toBe(true);
    s = run(s, { type: 'enter' });
    expect(s.config.lines[0]![0]!.bold).toBeUndefined();
  });

  it('sets a color from the list and custom input', () => {
    let s = run(start(), { type: 'openProps' }, { type: 'enter' });
    s = run(s, { type: 'nav', dir: 'down' }, { type: 'nav', dir: 'down' }, { type: 'enter' });
    expect(s.config.lines[0]![0]!.color).toBe('red');
    s = run(s, { type: 'enter' }, { type: 'nav', dir: 'end' }, { type: 'enter' });
    s = run(s, { type: 'text', text: 'nope' }, { type: 'enter' });
    expect(s.message).toContain('color name');
    s = run(s, { type: 'clear' }, { type: 'text', text: '#ff8800' }, { type: 'enter' });
    expect(s.config.lines[0]![0]!.color).toBe('#ff8800');
  });

  it('edits text with a cursor', () => {
    let s = run(start(), { type: 'openProps' });
    for (let i = 0; i < 5; i++) s = run(s, { type: 'nav', dir: 'down' });
    s = run(
      s,
      { type: 'enter' },
      { type: 'text', text: 'abc' },
      { type: 'nav', dir: 'left' },
      { type: 'text', text: 'X' },
    );
    expect(s.mode).toMatchObject({ sub: { text: 'abXc', pos: 3 } });
    s = run(s, { type: 'backspace' }, { type: 'enter' });
    expect(s.config.lines[0]![0]!.label).toBe('abc');
  });

  it('edits global settings and resets widget fields', () => {
    let s = run(start(), { type: 'openGlobal' });
    for (let i = 0; i < 4; i++) s = run(s, { type: 'nav', dir: 'down' });
    s = run(s, { type: 'cycle', delta: 1 });
    expect(s.config.padding).toBe(2);
    s = run(s, { type: 'undo' });
    expect(s.mode.kind).toBe('settings');
  });

  it('applies a preset after confirmation and can undo it', () => {
    let s = run(start(), { type: 'openPresets' });
    const steps = PRESETS.findIndex((p) => p.id === 'minimal');
    for (let i = 0; i < steps; i++) s = run(s, { type: 'nav', dir: 'down' });
    s = run(s, { type: 'enter' });
    expect(s.mode).toMatchObject({ kind: 'confirm', what: 'preset', preset: 'minimal' });
    s = run(s, { type: 'confirm', answer: 'yes' });
    expect(s.config.lines).toHaveLength(1);
    expect(run(s, { type: 'undo' }).config.lines).toHaveLength(3);
  });
});

describe('drag', () => {
  it('moves a chip on drop', () => {
    let s = run(start(), { type: 'dragStart', from: { line: 0, index: 0 } });
    s = run(s, { type: 'dragOver', to: { line: 1, index: 1 } });
    expect(s.drag?.to).toEqual({ line: 1, index: 1 });
    s = run(s, { type: 'dragEnd', to: { line: 1, index: 1 } });
    expect(ids(s)).toEqual(['bc', 'da', '']);
    expect(s.sel).toEqual({ line: 1, index: 1 });
    expect(s.drag).toBeNull();
  });

  it('treats a drop next to the source as a click', () => {
    const s = run(
      start(),
      { type: 'dragStart', from: { line: 0, index: 1 } },
      { type: 'dragEnd', to: { line: 0, index: 2 } },
    );
    expect(ids(s)[0]).toBe('abc');
    expect(s.dirty).toBe(false);
    expect(s.sel.index).toBe(1);
  });

  it('cancels with escape', () => {
    const s = run(start(), { type: 'dragStart', from: { line: 0, index: 0 } }, { type: 'quit' });
    expect(s.drag).toBeNull();
    expect(s.quit).toBe(false);
  });
});

describe('theme picker', () => {
  const themed = (): State => ({
    ...start(),
    config: { ...cfg(), style: 'blocks', padding: 3, separator: '|', glyphs: { thin: 'x' } },
  });

  it('opens on the current theme and previews without changing the config', () => {
    let s = run(themed(), { type: 'openThemes' });
    expect(s.mode).toMatchObject({
      kind: 'themes',
      cursor: themeItems('').findIndex((t) => t.id === s.config.theme),
    });
    const before = s.config;
    s = run(s, { type: 'nav', dir: 'down' });
    expect(s.config).toBe(before);
    const id = themeItems('')[(s.mode as { cursor: number }).cursor]!.id;
    const preview = previewConfig(s);
    expect(preview.theme).toBe(id);
    expect(preview.style).toBeUndefined();
    expect(preview.glyphs).toBeUndefined();
  });

  it('applies the theme and clears overrides, undoably', () => {
    let s = run(themed(), { type: 'openThemes' }, { type: 'text', text: 'neon' }, { type: 'enter' });
    expect(s.mode.kind).toBe('normal');
    expect(s.config.theme).toBe('neon');
    expect(s.config.style).toBeUndefined();
    expect(s.config.padding).toBeUndefined();
    expect(s.config.glyphs).toBeUndefined();
    expect(s.dirty).toBe(true);
    s = run(s, { type: 'undo' });
    expect(s.config.padding).toBe(3);
  });

  it('reverts on escape and returns to the previous mode', () => {
    let s = run(themed(), { type: 'openGlobal' }, { type: 'enter' });
    expect(s.mode.kind).toBe('themes');
    s = run(s, { type: 'nav', dir: 'down' }, { type: 'cancel' });
    expect(s.mode.kind).toBe('settings');
    expect(s.config.padding).toBe(3);
    expect(s.dirty).toBe(false);
  });

  it('filters by typing', () => {
    expect(themeItems('zzzqqq')).toHaveLength(0);
    expect(themeItems('neon').some((t) => t.id === 'neon')).toBe(true);
    const s = run(themed(), { type: 'openThemes' }, { type: 'text', text: 'zzzqqq' });
    expect(s.mode).toMatchObject({ filter: 'zzzqqq', cursor: 0 });
    expect(run(s, { type: 'enter' }).mode.kind).toBe('themes');
  });

  it('names and saves a user theme through an effect', () => {
    let s = run(themed(), { type: 'openThemes' }, { type: 'saveTheme' });
    s = run(s, { type: 'text', text: 'bad id' }, { type: 'enter' });
    expect(s.effect).toBeNull();
    s = run(s, { type: 'clear' }, { type: 'text', text: 'mine' }, { type: 'enter' });
    expect(s.effect).toEqual({ kind: 'saveTheme', id: 'mine' });
    s = run(s, { type: 'effectDone', ok: true, applyTheme: 'mine', message: 'ok' });
    expect(s.config.theme).toBe('mine');
    expect(s.config.padding).toBeUndefined();
    expect(s.mode.kind).toBe('normal');
  });

  it('refuses a device-name id when saving as', () => {
    const s = run(
      themed(),
      { type: 'openThemes' },
      { type: 'saveTheme' },
      { type: 'text', text: 'nul' },
      { type: 'enter' },
    );
    expect(s.message).toBe(
      '"nul" is a reserved Windows device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9); pick another id',
    );
    expect(s.effect).toBeNull();
  });

  it('stays in the naming prompt when saving fails', () => {
    let s = run(
      themed(),
      { type: 'openThemes' },
      { type: 'saveTheme' },
      { type: 'text', text: 'mine' },
      { type: 'enter' },
    );
    s = run(s, { type: 'effectDone', ok: false, message: 'Failed' });
    expect(s.mode).toMatchObject({ kind: 'themes', naming: { text: 'mine' } });
  });
});

describe('legacy options', () => {
  it('shows a legacy usable switch as basis usable without marking the config dirty', () => {
    const legacy: Config = {
      ...cfg(),
      lines: [[{ id: 'c', type: 'context-percentage', options: { usable: true } }]],
    };
    const s = initialState(legacy, '/tmp/c.json');
    expect(s.config.lines[0]![0]!.options).toEqual({ basis: 'usable' });
    expect(s.dirty).toBe(false);
    expect(legacy.lines[0]![0]!.options).toEqual({ usable: true });
  });
});

describe('theme search across languages', () => {
  const found = (q: string) => themeItems(q).map((x) => x.id);

  it('matches ids and English text in every language', () => {
    expect(found('nord')).toContain('nord');
    expect(withLang('tr', () => found('nord'))).toContain('nord');
    expect(withLang('tr', () => found('NORD'))).toContain('nord');
    expect(withLang('tr', () => found('arctic'))).toContain('nord');
    expect(withLang('tr', () => found('capsule'))).toContain('catppuccin');
  });

  it('matches the Turkish description and style name with Turkish folding', () => {
    expect(found('kutup')).toEqual([]);
    expect(withLang('tr', () => found('kutup'))).toContain('nord');
    expect(withLang('tr', () => found('KUTUP mavileri'))).toEqual(['nord']);
    expect(withLang('tr', () => found('kapsül'))).toContain('catppuccin');
    expect(withLang('tr', () => found('KAPSUL'))).toContain('catppuccin');
    expect(withLang('tr', () => found('İNCE'))).toContain('classic');
    expect(withLang('tr', () => found('ACIK bloklar'))).toEqual(['paper']);
  });

  it('finds user themes by the translated word for yours', () => {
    const prev = process.env.CCINFOBAR_CONFIG_DIR;
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'themes-'));
    process.env.CCINFOBAR_CONFIG_DIR = dir;
    try {
      saveUserTheme({ id: 'mine', extends: 'nord' });
      expect(found('yours')).toEqual(['mine']);
      expect(found('sizin')).toEqual([]);
      expect(withLang('tr', () => found('SİZİN'))).toEqual(['mine']);
      expect(withLang('tr', () => found('yours'))).toEqual(['mine']);
    } finally {
      process.env.CCINFOBAR_CONFIG_DIR = prev;
    }
  });
});

describe('presets keep the language', () => {
  const apply = (config: Config) => {
    const s = { ...initialState(config, '/tmp/c.json'), presets: PRESETS };
    const id = PRESETS.find((p) => p.id === 'minimal')!.id;
    return run(
      s,
      { type: 'openPresets' },
      { type: 'nav', dir: 'end' },
      { type: 'cancel' },
      {
        type: 'openPresets',
      },
      ...pick(s, id),
    );
  };
  const pick = (s: State, id: string): Action[] => [
    { type: 'clickItem', area: 'main', index: s.presets.findIndex((p) => p.id === id) },
    { type: 'confirm', answer: 'yes' },
  ];

  it('carries tr into the new config and adds nothing when unset', () => {
    const tr = apply({ ...cfg(), language: 'tr' });
    expect(tr.config.language).toBe('tr');
    expect(tr.config.lines).toEqual(PRESETS.find((p) => p.id === 'minimal')!.build().lines);
    expect('language' in apply(cfg()).config).toBe(false);
  });

  it('names the preset in the active language', () => {
    expect(apply(cfg()).message).toBe('Applied preset Minimal');
    const s = initialState(cfg(), '/tmp/c.json');
    const done = withLang('tr', () => run(s, { type: 'openPresets' }, ...pick(s, 'cockpit')));
    expect(done.message).toBe('Hazır ayar uygulandı: Kokpit');
  });
});

describe('Turkish status messages', () => {
  it('translates the reducer messages', () => {
    withLang('tr', () => {
      expect(run(start(), { type: 'undo' }).message).toBe('Geri alınacak bir şey yok');
      expect(run(start(), { type: 'redo' }).message).toBe('Yinelenecek bir şey yok');
      expect(run(start(), { type: 'togglePreview' }).message).toBe('Önizleme: son oturumun payload verisi');
      const removed = run(start(), { type: 'removeChip' });
      expect(removed.message).toBe('Kaldırıldı: Model');
      expect(run(removed, { type: 'undo' }).message).toBe('Geri alındı');
      const empty = { ...start(), sel: { line: 2, index: 0 } };
      expect(run(empty, { type: 'openProps' }).message).toBe(
        'Seçili bileşen yok. Bileşen eklemek için a tuşuna basın.',
      );
      const added = run(start(), { type: 'openPicker' }, { type: 'text', text: 'cwd' }, { type: 'enter' });
      expect(added.message).toMatch(/^Eklendi: /);
      const naming = run(
        start(),
        { type: 'openThemes' },
        { type: 'saveTheme' },
        { type: 'text', text: 'a b' },
        {
          type: 'enter',
        },
      );
      expect(naming.message).toBe('Harf, rakam, nokta, tire ya da alt çizgi kullanın');
    });
    expect(run(start(), { type: 'undo' }).message).toBe('Nothing to undo');
    expect(run(start(), { type: 'removeChip' }).message).toBe('Removed Model');
  });

  it('labels Auto with the auto language passed in', () => {
    const s = initialState(cfg(), '/tmp/c.json', '', { autoLanguage: 'tr' });
    expect(s.autoLanguage).toBe('tr');
    const g = run(s, { type: 'openGlobal' });
    const lang = settingsFields(g).find((f) => f.id === 'language')!;
    expect(lang.choices![0]!.label).toBe('Auto (Türkçe)');
    expect('autoLanguage' in initialState(cfg(), '/tmp/c.json')).toBe(false);
  });

  it('switches the language through the field and back to Auto', () => {
    let s = run(start(), { type: 'openGlobal' });
    const at = settingsFields(s).findIndex((f) => f.id === 'language');
    s = run(s, { type: 'clickItem', area: 'main', index: at });
    expect(s.mode).toMatchObject({ kind: 'settings', sub: { kind: 'list', cursor: 0 } });
    s = run(s, { type: 'nav', dir: 'end' }, { type: 'enter' });
    expect(s.config.language).toBe('tr');
    expect(s.dirty).toBe(true);
    s = run(s, { type: 'cycle', delta: 1 });
    expect('language' in s.config).toBe(false);
    s = run(s, { type: 'cancel' }, { type: 'undo' });
    expect(s.config.language).toBe('tr');
  });
});

describe('disabled rotation fields', () => {
  const at = (s: State, id: string) => settingsFields(s).findIndex((f) => f.id === id);

  it('answers enter, click, cycle and delete with the hint only', () => {
    const g = run(start(), { type: 'openGlobal' });
    for (const id of ['rotation.every', 'rotation.order']) {
      const index = at(g, id);
      let s: State = {
        ...g,
        mode: { ...(g.mode as Extract<State['mode'], { kind: 'settings' }>), cursor: index },
      };
      for (const a of [
        { type: 'enter' },
        { type: 'cycle', delta: 1 },
        { type: 'delete' },
        { type: 'backspace' },
      ] as Action[]) {
        const r = run(s, a);
        expect(r.message).toBe('Add themes first');
        expect(r.config).toBe(s.config);
        expect(r.mode).toMatchObject({ kind: 'settings', sub: null });
        expect(r.dirty).toBe(g.dirty);
        s = { ...s, message: '' };
      }
      const c = run(g, { type: 'clickItem', area: 'main', index });
      expect(c.message).toBe('Add themes first');
      expect(c.config.themeRotation).toBeUndefined();
      expect(c.mode).toMatchObject({ sub: null });
    }
  });

  it('persists the change once a theme is in the pool', () => {
    const g = run(start(), { type: 'openGlobal' });
    const themes = at(g, 'rotation.themes');
    let s = run(g, { type: 'clickItem', area: 'main', index: themes });
    s = run(s, { type: 'text', text: 'nord' }, { type: 'enter' });
    expect(s.config.themeRotation?.themes).toEqual(['nord']);
    s = run(s, { type: 'clickItem', area: 'main', index: at(s, 'rotation.every') });
    s = run(s, { type: 'clear' }, { type: 'text', text: '30m' }, { type: 'enter' });
    expect(s.config.themeRotation?.every).toBe(30);
  });
});

describe('Turkish effect messages', () => {
  it('reports save, save failure and a missing install command', () => {
    const dir = fs.mkdtempSync(path.join(process.env.CCIB_TEST_ROOT!, 'tui-'));
    const ok = initialState(cfg(), path.join(dir, 'config.json'));
    fs.writeFileSync(path.join(dir, 'file'), '');
    const bad = initialState(cfg(), path.join(dir, 'file', 'config.json'));
    withLang('tr', () => {
      expect(runEffect(ok, { kind: 'save' })).toMatchObject({ ok: true, message: 'Kaydedildi' });
      expect(runEffect(bad, { kind: 'save' })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/^Başarısız: /),
      });
      expect(runEffect(ok, { kind: 'install', confirmed: true }, { command: () => null })).toMatchObject({
        ok: false,
        message: 'Başarısız: ccinfobar kurulamadı; npm install -g ccinfobar çalıştırın',
      });
    });
    expect(runEffect(ok, { kind: 'save' })).toMatchObject({ message: 'Saved' });
    expect(runEffect(ok, { kind: 'install', confirmed: true }, { command: () => null })).toMatchObject({
      message: 'Failed: could not install ccinfobar; run npm install -g ccinfobar',
    });
  });
});
