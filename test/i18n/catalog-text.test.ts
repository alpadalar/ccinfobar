import { describe, expect, it } from 'vitest';
import { SYSTEM_BUNDLES } from '../../src/catalog/system.js';
import { visibleWidth } from '../../src/core/ansi.js';
import { STYLE_GROUPS } from '../../src/core/edit.js';
import {
  bundleText,
  presetText,
  scenarioText,
  styleGroupName,
  styleText,
  themeDescription,
} from '../../src/core/i18n/catalog-text.js';
import type { LanguageDef } from '../../src/core/i18n/index.js';
import { TR } from '../../src/core/i18n/languages.js';
import { catalog } from '../../src/core/i18n/tr/meta/catalog.js';
import { trMeta } from '../../src/core/i18n/tr/meta/index.js';
import { PRESETS } from '../../src/core/presets.js';
import { SCENARIOS } from '../../src/core/scenarios.js';
import { BUILTIN_THEMES, STYLES } from '../../src/core/themes.js';
import { withLang } from '../helpers.js';

const clean = (s: string) =>
  s.trim() !== '' &&
  s === s.normalize('NFC') &&
  !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s);

const sets: [string, Record<string, unknown> | undefined, string[]][] = [
  ['themes', catalog.themes, BUILTIN_THEMES.map((t) => t.id)],
  ['styles', catalog.styles, STYLES.map((s) => s.id)],
  ['presets', catalog.presets, PRESETS.map((p) => p.id)],
  ['scenarios', catalog.scenarios, SCENARIOS.map((s) => s.id)],
  ['styleGroups', catalog.styleGroups, STYLE_GROUPS.map((g) => g.id)],
  ['bundles', catalog.bundles, SYSTEM_BUNDLES.map((b) => b.id)],
];

const texts = (v: unknown): string[] => (typeof v === 'string' ? [v] : Object.values(v as object));

describe('Turkish catalog metadata', () => {
  it.each(sets)('%s has an entry for every built-in id and no others', (_name, table, ids) => {
    expect(Object.keys(table ?? {}).sort()).toEqual([...ids].sort());
  });

  it.each(sets)('%s texts are non-empty, NFC and free of control characters', (_name, table) => {
    for (const [id, v] of Object.entries(table ?? {})) {
      for (const s of texts(v)) expect(clean(s), `${id}: ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it('carries descriptions only for themes, so names stay proper nouns', () => {
    for (const v of Object.values(catalog.themes ?? {})) expect(Object.keys(v)).toEqual(['description']);
  });

  it('keeps bundle names within 16 cells and translates descriptions', () => {
    for (const b of SYSTEM_BUNDLES) {
      const tr = catalog.bundles?.[b.id];
      expect(visibleWidth(tr!.name), b.id).toBeLessThanOrEqual(16);
      expect(tr!.description, b.id).not.toBe(b.description);
    }
  });

  it('is the catalog of the Turkish language', () => {
    expect(trMeta.catalog).toBe(catalog);
    expect(TR.meta?.catalog).toBe(catalog);
  });
});

describe('catalog helpers', () => {
  const classic = BUILTIN_THEMES.find((t) => t.id === 'classic')!;
  const preset = PRESETS.find((p) => p.id === 'default')!;
  const scenario = SCENARIOS.find((s) => s.id === 'context-full')!;
  const style = STYLES.find((s) => s.id === 'capsule')!;
  const group = STYLE_GROUPS.find((g) => g.id === 'colors')!;
  const nord = SYSTEM_BUNDLES.find((b) => b.id === 'nord-minimal')!;

  it('returns the English text in English', () => {
    for (const t of BUILTIN_THEMES) expect(themeDescription(t)).toBe(t.description);
    for (const s of STYLES) {
      expect(styleText(s, 'name')).toBe(s.name);
      expect(styleText(s, 'description')).toBe(s.description);
    }
    for (const p of PRESETS) {
      expect(presetText(p, 'name')).toBe(p.name);
      expect(presetText(p, 'description')).toBe(p.description);
    }
    for (const s of SCENARIOS) {
      expect(scenarioText(s, 'label')).toBe(s.label);
      expect(scenarioText(s, 'description')).toBe(s.description);
    }
    for (const g of STYLE_GROUPS) expect(styleGroupName(g)).toBe(g.name);
    for (const b of SYSTEM_BUNDLES) {
      expect(bundleText(b, 'name')).toBe(b.name);
      expect(bundleText(b, 'description')).toBe(b.description);
    }
  });

  it('translates built-in text in Turkish with ids unchanged', () => {
    withLang('tr', () => {
      expect(themeDescription(classic)).toBe('Her bileşen kendi renginde, ince çizgi ayraçlar');
      expect(styleText(style, 'name')).toBe('Kapsül');
      expect(styleText(style, 'description')).toBe('Yuvarlak kapsüller (Nerd Font)');
      expect(presetText(preset, 'name')).toBe('Varsayılan');
      expect(presetText({ ...preset, source: 'builtin' }, 'name')).toBe('Varsayılan');
      expect(scenarioText(scenario, 'label')).toBe('Bağlam neredeyse dolu');
      expect(scenarioText(scenario, 'description')).toBe('Bağlam penceresi yaklaşık %94 dolu');
      expect(styleGroupName(group)).toBe('Renkler');
      expect(bundleText(nord, 'name')).toBe('Nord minimal');
      expect(bundleText(nord, 'description')).toBe('Serin Nord powerline renklerinde tek, kompakt bir satır');
    });
    expect(bundleText(nord, 'description')).toBe(nord.description);
    expect(classic.id).toBe('classic');
  });

  it('never translates user themes and user presets', () => {
    withLang('tr', () => {
      expect(themeDescription({ ...classic, source: 'user', description: 'Mine' })).toBe('Mine');
      const user = { ...preset, source: 'user' as const, name: 'Mine', description: 'My lines' };
      expect(presetText(user, 'name')).toBe('Mine');
      expect(presetText(user, 'description')).toBe('My lines');
    });
  });

  it('falls back to English for unknown and inherited ids', () => {
    withLang('tr', () => {
      for (const id of ['nope', '__proto__', 'constructor', 'toString']) {
        expect(themeDescription({ id, description: 'D' })).toBe('D');
        expect(styleText({ id, name: 'N', description: 'D' }, 'name')).toBe('N');
        expect(presetText({ id, name: 'N', description: 'D' }, 'description')).toBe('D');
        expect(scenarioText({ id, label: 'L', description: 'D' }, 'label')).toBe('L');
        expect(styleGroupName({ id, name: 'N' })).toBe('N');
        expect(bundleText({ id, name: 'N', description: 'D' }, 'name')).toBe('N');
      }
    });
  });

  it('reads the catalog of any language and tolerates none', () => {
    const fake: LanguageDef = {
      id: 'xx',
      name: 'Test',
      aliases: [],
      locale: 'en',
      messages: {},
      meta: {
        widgets: {},
        options: {},
        categories: {},
        catalog: { presets: { default: { name: 'X', description: 'Y' } } },
      },
    };
    withLang(fake, () => {
      expect(presetText(preset, 'name')).toBe('X');
      expect(themeDescription(classic)).toBe(classic.description);
    });
    withLang({ ...fake, meta: undefined }, () => expect(presetText(preset, 'name')).toBe(preset.name));
  });
});
