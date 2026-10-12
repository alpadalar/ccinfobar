import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { resolveAppearance } from '../../src/core/renderer.js';
import { cycled, displayValue, globalFields, listEntries } from '../../src/tui/fields.js';
import { themeInputFromConfig } from '../../src/tui/themeio.js';

const field = (id: string) => globalFields().find((f) => f.id === id)!;

describe('global override fields', () => {
  it('lists theme and overrides, no powerline fields', () => {
    const ids = globalFields().map((f) => f.id);
    expect(ids.slice(0, 3)).toEqual(['theme', 'style', 'separator']);
    expect(ids).toContain('glyphs.endCap');
    expect(ids.some((i) => i.startsWith('powerline'))).toBe(false);
  });

  it('shows the theme value when unset and the override when set', () => {
    const c = defaultConfig();
    const a = resolveAppearance(c);
    expect(displayValue(field('padding'), c)).toEqual({ text: `${a.padding}  (theme)`, isDefault: true });
    const set = field('padding').set(c, 3);
    expect(c.padding).toBeUndefined();
    expect(displayValue(field('padding'), set)).toEqual({ text: '3', isDefault: false });
  });

  it('resets an override with undefined and removes the key', () => {
    let c = field('separator').set(defaultConfig(), ' // ');
    expect(c.separator).toBe(' // ');
    c = field('separator').set(c, undefined);
    expect('separator' in c).toBe(false);
    c = field('separatorColor').set(c, 'red');
    expect(c.separatorColor).toBe('red');
    expect('separatorColor' in field('separatorColor').set(c, undefined)).toBe(false);
  });

  it('keeps glyph overrides sparse', () => {
    let c = field('glyphs.thin').set(defaultConfig(), '|');
    c = field('glyphs.endCap').set(c, ')');
    expect(c.glyphs).toEqual({ thin: '|', endCap: ')' });
    c = field('glyphs.thin').set(c, undefined);
    expect(c.glyphs).toEqual({ endCap: ')' });
    c = field('glyphs.endCap').set(c, undefined);
    expect(c.glyphs).toBeUndefined();
  });

  it('style offers a theme default entry and cycles from the effective style', () => {
    const f = field('style');
    expect(listEntries(f)[0]).toEqual({ value: undefined, label: 'theme default' });
    const c = defaultConfig();
    const eff = resolveAppearance(c).style;
    expect(cycled(f, c, 1)).not.toBe(eff);
    expect(['text', 'blocks', 'powerline', 'capsule']).toContain(cycled(f, c, 1));
  });

  it('clamps padding', () => {
    expect(field('padding').set(defaultConfig(), 99).padding).toBe(4);
    expect(field('padding').set(defaultConfig(), -2).padding).toBe(0);
  });
});

describe('themeInputFromConfig', () => {
  it('merges overrides into the saved theme and extends the base', () => {
    const c = {
      ...defaultConfig(),
      style: 'blocks' as const,
      separator: '·',
      padding: 2,
      separatorColor: 'red',
      glyphs: { thin: '|' },
    };
    const input = themeInputFromConfig(c, 'mine');
    expect(input.id).toBe('mine');
    expect(input.style).toBe('blocks');
    expect(input.separator).toBe('·');
    expect(input.padding).toBe(2);
    expect(input.colors?.muted).toBe('red');
    expect(input.glyphs?.thin).toBe('|');
    expect(input.extends).toBe(resolveAppearance(c).theme.id);
  });
});
