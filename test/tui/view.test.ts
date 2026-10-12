import { describe, expect, it } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import { type Action, initialState, reduce, type State } from '../../src/tui/state.js';
import { MIN_COLS, MIN_ROWS, renderScreen } from '../../src/tui/view.js';

const build = (config: Config = defaultConfig(), ...actions: Action[]): State =>
  actions.reduce(reduce, initialState(config, '/tmp/cc/config.json'));
const text = (s: State, cols = 100, rows = 30) => renderScreen(s, cols, rows).lines.map(stripAnsi);

describe('renderScreen', () => {
  it('always returns exactly rows lines that fit the width', () => {
    for (const [cols, rows] of [
      [60, 16],
      [80, 24],
      [120, 40],
      [200, 50],
    ] as const) {
      const lines = renderScreen(build(), cols, rows).lines;
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(cols);
    }
  });

  it('shows the header, preview, chips and key hints', () => {
    const out = text(build()).join('\n');
    expect(out).toContain('ccinfobar');
    expect(out).toContain('/tmp/cc/config.json');
    expect(out).toContain('Preview');
    expect(out).toContain('[Model]');
    expect(out).toContain('[Git branch]');
    expect(out).toContain('q quit');
  });

  it('marks the dirty state in the header', () => {
    const s = build(defaultConfig(), { type: 'removeChip' });
    expect(text(s)[0]).toContain('modified');
    expect(text(build())[0]).toContain('saved');
  });

  it('highlights the selected chip with inverse video', () => {
    const lines = renderScreen(build(defaultConfig(), { type: 'select', dir: 'right' }), 100, 30).lines;
    const row = lines.find((l) => l.includes('[Effort]'))!;
    expect(row).toMatch(/\x1b\[[0-9;]*7m[^\x1b]*\[Effort\]/);
    expect(row).not.toMatch(/7m[^\x1b]*\[Model\]/);
  });

  it('produces hit boxes that match chip positions on screen', () => {
    const screen = renderScreen(build(), 100, 30);
    const chips = screen.hits.filter((h) => h.kind === 'chip');
    expect(chips.length).toBe(defaultConfig().lines.flat().length);
    for (const c of chips) {
      if (c.kind !== 'chip') continue;
      const row = stripAnsi(screen.lines[c.y]!);
      expect(row.slice(c.x, c.x + c.w)).toMatch(/^\[.*\]$/);
    }
  });

  it('keeps alignment with wide characters in labels', () => {
    const cfg = defaultConfig();
    cfg.lines = [
      [
        { id: 'a', type: 'text', options: { text: '日本語🙂' } },
        { id: 'b', type: 'model' },
      ],
    ];
    for (const l of renderScreen(build(cfg), 70, 20).lines) expect(visibleWidth(l)).toBeLessThanOrEqual(70);
  });

  it('wraps long lines and keeps the selection visible in short terminals', () => {
    const cfg = defaultConfig();
    cfg.lines = Array.from({ length: 12 }, (_, l) =>
      Array.from({ length: 6 }, (_, i) => ({ id: `m${l}-${i}`, type: 'model' })),
    );
    const s = build(cfg, { type: 'selectAt', line: 11, index: 5 });
    const screen = renderScreen(s, MIN_COLS, MIN_ROWS);
    expect(screen.lines).toHaveLength(MIN_ROWS);
    expect(screen.hits.some((h) => h.kind === 'chip' && h.line === 11 && h.index === 5)).toBe(true);
  });

  it('shows a message when the terminal is too small', () => {
    const out = renderScreen(build(), 40, 10).lines.join('\n');
    expect(out).toContain('too small');
  });

  it('shows empty lines and the empty state', () => {
    const cfg = { ...defaultConfig(), lines: [[]] };
    expect(text(build(cfg)).join('\n')).toContain('(empty line)');
    expect(text(build({ ...cfg, lines: [] })).join('\n')).toContain('No lines yet');
  });

  it('draws a drop marker while dragging', () => {
    const s = build(
      defaultConfig(),
      { type: 'dragStart', from: { line: 0, index: 0 } },
      { type: 'dragOver', to: { line: 1, index: 2 } },
    );
    expect(text(s).join('\n')).toContain('┃');
  });
});

describe('modals', () => {
  it('renders the picker with category headers and a filter', () => {
    const s = build(defaultConfig(), { type: 'openPicker' }, { type: 'text', text: 'gsd' });
    const out = text(s).join('\n');
    expect(out).toContain('Add widget');
    expect(out).toContain('Filter: gsd');
    expect(out).toContain('GSD');
    const screen = renderScreen(s, 100, 30);
    expect(screen.hits.some((h) => h.kind === 'item' && h.index === 0)).toBe(true);
  });

  it('renders property fields with values', () => {
    const s = build(defaultConfig(), { type: 'openProps' });
    const out = text(s).join('\n');
    expect(out).toContain('properties');
    expect(out).toContain('Color');
    expect(out).toContain('Background');
    expect(out).toContain('Merge with previous');
  });

  it('renders the color list and the custom input', () => {
    let s = build(defaultConfig(), { type: 'openProps' }, { type: 'enter' });
    expect(text(s).join('\n')).toContain('brightCyan');
    s = reduce(reduce(s, { type: 'nav', dir: 'end' }), { type: 'enter' });
    expect(text(s).join('\n')).toContain('#rrggbb');
  });

  it('renders global settings, presets, confirm and help', () => {
    expect(text(build(defaultConfig(), { type: 'openGlobal' })).join('\n')).toContain('Glyph: end cap');
    expect(text(build(defaultConfig(), { type: 'openPresets' })).join('\n')).toContain('Minimal');
    expect(text(build(defaultConfig(), { type: 'removeChip' }, { type: 'quit' })).join('\n')).toContain(
      'unsaved',
    );
    expect(text(build(defaultConfig(), { type: 'help' })).join('\n')).toContain('undo');
  });

  it('fits every modal into small terminals', () => {
    const modes: Action[][] = [
      [{ type: 'openPicker' }],
      [{ type: 'openProps' }, { type: 'enter' }],
      [{ type: 'openGlobal' }],
      [{ type: 'openPresets' }],
      [{ type: 'help' }],
    ];
    for (const actions of modes) {
      const lines = renderScreen(build(defaultConfig(), ...actions), MIN_COLS, MIN_ROWS).lines;
      expect(lines).toHaveLength(MIN_ROWS);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(MIN_COLS);
    }
  });
});
