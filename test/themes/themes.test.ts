import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { contrastRatio, parseColor, stripAnsi } from '../../src/core/ansi.js';
import { normalizeConfig } from '../../src/core/config.js';
import { render, resolveAppearance } from '../../src/core/renderer.js';
import {
  BUILTIN_THEMES,
  deleteUserTheme,
  listThemes,
  parseThemeInput,
  resolveTheme,
  STYLES,
  saveUserTheme,
  type Theme,
  themeExists,
  themeToInput,
} from '../../src/core/themes.js';
import type { WidgetItem } from '../../src/core/types.js';
import { ctxWith } from '../helpers.js';

const text = (t: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({
  id: t,
  type: 'text',
  options: { text: t },
  ...extra,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-themes-'));

describe('built-in themes', () => {
  it('ships every style with unique ids', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of STYLES) expect(BUILTIN_THEMES.some((t) => t.style === s.id)).toBe(true);
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(23);
  });

  it('renders every theme without throwing', () => {
    for (const t of BUILTIN_THEMES) {
      const ctx = ctxWith({
        config: { colorLevel: 3, theme: t.id, lines: [[{ id: 'm', type: 'model' }, text('x')]] },
      });
      const out = render(ctx);
      expect(out.length).toBe(t.style === 'tui' ? 3 : 1);
      expect(out.map(stripAnsi).join('\n')).toContain('Opus 5.5');
    }
  });

  it('falls back to classic for unknown ids', () => {
    expect(resolveTheme('nope', tmp()).id).toBe('classic');
  });

  it('keeps the pinned built-in themes unchanged', () => {
    const pinned = JSON.parse(
      fs.readFileSync(new URL('../fixtures/themes-builtin.json', import.meta.url), 'utf8'),
    ) as Theme[];
    expect(pinned.length).toBeGreaterThanOrEqual(23);
    for (const t of pinned) expect(BUILTIN_THEMES.find((b) => b.id === t.id)).toEqual(t);
    const ids = listThemes(tmp()).map((t) => t.id);
    const order = pinned.map((t) => ids.indexOf(t.id));
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
  });
});

describe('new built-in themes', () => {
  const NEW = {
    'catppuccin-latte': 'powerline',
    'catppuccin-frappe': 'powerline',
    'catppuccin-macchiato': 'powerline',
    'catppuccin-mocha': 'powerline',
    everforest: 'powerline',
    kanagawa: 'powerline',
    'one-dark': 'capsule',
  } as const;

  it.each(Object.entries(NEW))('%s resolves with its style and a 4-stop gradient', (id, style) => {
    const t = resolveTheme(id, tmp());
    expect(t.id).toBe(id);
    expect(t.source).toBe('builtin');
    expect(t.style).toBe(style);
    expect(t.colors.mode).toBe('category');
    expect(t.gradient).toHaveLength(4);
    for (const c of t.gradient!) expect(parseColor(c)).not.toBeNull();
    expect(listThemes(tmp()).some((x) => x.id === id)).toBe(true);
  });

  it.each(Object.keys(NEW))('%s keeps every category swatch at contrast 4.5 or more', (id) => {
    const t = resolveTheme(id, tmp());
    const entries = Object.entries(t.colors.categories);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const [cat, sw] of entries) {
      const bg = typeof sw === 'string' ? sw : (sw?.bg ?? t.colors.bg);
      const fg = typeof sw === 'object' && sw.fg ? sw.fg : t.colors.on;
      const ratio = contrastRatio(fg, bg);
      expect(ratio, `${id} ${cat} ${fg} on ${bg}`).not.toBeNull();
      expect(ratio!, `${id} ${cat} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses each flavour ramp from green to red', () => {
    expect(resolveTheme('catppuccin-mocha', tmp()).gradient).toEqual([
      '#a6e3a1',
      '#f9e2af',
      '#fab387',
      '#f38ba8',
    ]);
    expect(resolveTheme('catppuccin-latte', tmp()).gradient).toEqual([
      '#40a02b',
      '#df8e1d',
      '#fe640b',
      '#d20f39',
    ]);
    expect(resolveTheme('one-dark', tmp()).gradient).toEqual(['#98c379', '#e5c07b', '#d19a66', '#e06c75']);
  });

  it('leaves the capsule catppuccin theme as it was', () => {
    const t = resolveTheme('catppuccin', tmp());
    expect(t.style).toBe('capsule');
    expect('gradient' in t).toBe(false);
  });

  it('paints category blocks in the theme colors', () => {
    const line = render(
      ctxWith({
        config: { colorLevel: 3, theme: 'catppuccin-mocha', lines: [[{ id: 'g', type: 'git-branch' }]] },
      }),
    )[0]!;
    expect(line).toContain('48;2;243;139;168');
    expect(line).toContain('38;2;30;30;46');
  });
});

describe('styles', () => {
  const two = [[text('a'), text('b')]];

  it('text style uses the separator', () => {
    expect(render(ctxWith({ config: { theme: 'classic', lines: two } }))).toEqual(['a │ b']);
  });

  it('blocks style pads segments and paints backgrounds', () => {
    const line = render(ctxWith({ config: { colorLevel: 1, theme: 'blocks', lines: two } }))[0]!;
    expect(stripAnsi(line)).toBe(' a   b ');
    expect(line).toMatch(/\x1b\[(4|10)\dm/);
  });

  it('capsule style wraps each segment in caps', () => {
    const line = render(ctxWith({ config: { theme: 'catppuccin', lines: two } }))[0]!;
    expect(stripAnsi(line)).toBe(' a   b ');
  });

  it('powerline uses the thin glyph between same-colored segments', () => {
    const line = render(
      ctxWith({
        config: { colorLevel: 3, theme: 'blocks', style: 'powerline', lines: [[text('a'), text('b')]] },
      }),
    )[0]!;
    expect(stripAnsi(line)).toBe(' a  b ');
  });

  it('config overrides win over the theme', () => {
    const ctx = ctxWith({ config: { theme: 'neon', separator: ' / ', lines: two } });
    expect(render(ctx)).toEqual(['a / b']);
    expect(resolveAppearance(normalizeConfig({ theme: 'neon', style: 'blocks' })).separator).toBe(' ');
  });

  it('widget color overrides beat theme colors', () => {
    const line = render(
      ctxWith({ config: { colorLevel: 3, theme: 'neon', lines: [[text('a', { color: '#010203' })]] } }),
    )[0]!;
    expect(line).toContain('38;2;1;2;3');
  });

  it('category mode colors by widget category', () => {
    const line = render(
      ctxWith({ config: { colorLevel: 3, theme: 'neon', lines: [[{ id: 'g', type: 'git-branch' }]] } }),
    )[0]!;
    expect(line).toContain('38;2;255;64;129');
  });
});

describe('user themes', () => {
  it('extends a built-in theme and overrides only given fields', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'mine.json'),
      JSON.stringify({ extends: 'nord', separator: '|', colors: { on: '#000000' } }),
    );
    const t = resolveTheme('mine', dir);
    expect(t.source).toBe('user');
    expect(t.style).toBe('powerline');
    expect(t.separator).toBe('|');
    expect(t.colors.on).toBe('#000000');
    expect(t.colors.cycle).toEqual(resolveTheme('nord', dir).colors.cycle);
    expect(listThemes(dir).some((x) => x.id === 'mine')).toBe(true);
  });

  it('can replace a built-in theme by id and survives cycles', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'nord.json'), JSON.stringify({ separator: '!' }));
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ extends: 'b' }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ extends: 'a' }));
    expect(resolveTheme('nord', dir).style).toBe('powerline');
    expect(resolveTheme('nord', dir).separator).toBe('!');
    expect(() => resolveTheme('a', dir)).not.toThrow();
  });

  it('ignores invalid files and fields', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    expect(resolveTheme('bad', dir).id).toBe('classic');
    expect(
      parseThemeInput({ style: 'weird', padding: -3, colors: { mode: 'x', cycle: [1, 'red'] } }),
    ).toEqual({
      colors: { cycle: ['red'] },
    });
  });

  it('saves a theme file that resolves back', () => {
    const dir = tmp();
    const file = saveUserTheme(themeToInput(resolveTheme('dracula', dir), 'my-dracula', 'dracula'), dir);
    expect(fs.existsSync(file)).toBe(true);
    const t = resolveTheme('my-dracula', dir);
    expect(t.colors.cycle).toEqual(resolveTheme('dracula', dir).colors.cycle);
    expect(() => saveUserTheme({ id: '../evil' }, dir)).toThrow();
  });
});

describe('theme gradient', () => {
  it('keeps valid color stops only, at most 8', () => {
    expect(parseThemeInput({ gradient: ['#00ff00', 'nope', 'red', 3] }).gradient).toEqual(['#00ff00', 'red']);
    expect(parseThemeInput({ gradient: Array.from({ length: 10 }, () => 'blue') }).gradient).toHaveLength(8);
    expect('gradient' in parseThemeInput({ gradient: [] })).toBe(false);
    expect('gradient' in parseThemeInput({ gradient: ['\x1b[31m', 'default', null] })).toBe(false);
    expect('gradient' in parseThemeInput({ gradient: 'red' })).toBe(false);
  });

  it('resolves, round-trips and saves a user gradient', () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'ramp.json'),
      JSON.stringify({ extends: 'classic', gradient: ['green', '#ff0000'] }),
    );
    const t = resolveTheme('ramp', dir);
    expect(t.gradient).toEqual(['green', '#ff0000']);
    const input = themeToInput(t, 'ramp-copy');
    expect(input.gradient).toEqual(['green', '#ff0000']);
    const file = saveUserTheme(input, dir);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).gradient).toEqual(['green', '#ff0000']);
    expect(resolveTheme('ramp-copy', dir).gradient).toEqual(['green', '#ff0000']);
    expect('gradient' in resolveTheme('classic', dir)).toBe(false);
  });

  it('inherits the parent gradient unless overridden', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ gradient: ['red', 'blue'] }));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ extends: 'a' }));
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ extends: 'a', gradient: ['cyan'] }));
    expect(resolveTheme('b', dir).gradient).toEqual(['red', 'blue']);
    expect(resolveTheme('c', dir).gradient).toEqual(['cyan']);
  });

  it('is in the theme schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(new URL('../../schema/theme.schema.json', import.meta.url), 'utf8'),
    );
    expect(schema.properties.gradient).toMatchObject({ type: 'array', maxItems: 8 });
  });
});

describe('legacy config', () => {
  it('maps powerline.enabled to the powerline style', () => {
    const cfg = normalizeConfig({ powerline: { enabled: true, theme: 'nord' } });
    expect(cfg.style).toBe('powerline');
    expect(cfg.theme).toBe('nord');
  });
});

describe('reserved ids on win32', () => {
  const onWin32 = (fn: () => void) => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  };
  const setup = () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'con.json'),
      JSON.stringify({ extends: 'nord', colors: { fg: '#123456' } }),
    );
    return dir;
  };

  it('treats a device-name id as absent without opening it', () => {
    const dir = setup();
    const spy = vi.spyOn(fs, 'readFileSync');
    try {
      onWin32(() => {
        expect(resolveTheme('con', dir).source).not.toBe('user');
        expect(themeExists('con', dir)).toBe(false);
        expect(listThemes(dir).some((x) => x.id === 'con')).toBe(false);
        expect(deleteUserTheme('con', dir)).toBe(false);
      });
      expect(spy.mock.calls.every(([p]) => !String(p).endsWith('con.json'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(dir, 'con.json'))).toBe(true);
  });

  it('keeps loading an existing file elsewhere', () => {
    const dir = setup();
    expect(themeExists('con', dir)).toBe(true);
    expect(listThemes(dir).some((x) => x.id === 'con')).toBe(true);
  });
});
