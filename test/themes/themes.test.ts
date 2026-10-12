import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { normalizeConfig } from '../../src/core/config.js';
import { render, resolveAppearance } from '../../src/core/renderer.js';
import {
  BUILTIN_THEMES,
  listThemes,
  parseThemeInput,
  resolveTheme,
  STYLES,
  saveUserTheme,
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

describe('legacy config', () => {
  it('maps powerline.enabled to the powerline style', () => {
    const cfg = normalizeConfig({ powerline: { enabled: true, theme: 'nord' } });
    expect(cfg.style).toBe('powerline');
    expect(cfg.theme).toBe('nord');
  });
});
