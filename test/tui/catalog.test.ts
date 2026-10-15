import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import type { LanguageDef, MetaTable } from '../../src/core/i18n/index.js';
import { categoryName, pickerItems, widgetScore } from '../../src/tui/catalog.js';
import { displayValue, widgetFields } from '../../src/tui/fields.js';
import { initialState, reduce } from '../../src/tui/state.js';
import { renderScreen } from '../../src/tui/view.js';
import { getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const meta: MetaTable = {
  widgets: {
    'context-percentage': {
      name: 'İstatistik',
      description: 'Bağlam penceresinin yüzdesi',
      options: { mode: { choices: { used: 'Kullanılan' } } },
    },
  },
  options: {
    Mode: 'Kip',
    'Color by threshold': 'Eşiğe göre renk',
    'Green below 50%, yellow below 80%, red above': 'Yeşil, sarı, kırmızı',
  },
  categories: { context: 'Bağlam penceresi', gsd: 'GSD' },
  catalog: {},
};
const zz: LanguageDef = { id: 'zz', name: 'Test', aliases: [], locale: 'tr', messages: {}, meta };
const def = getWidget('context-percentage')!;

describe('widgetScore', () => {
  it('finds a widget by type and English name', () => {
    for (const lang of ['en', zz] as const) {
      withLang(lang, () => {
        expect(widgetScore(def, 'context-percentage')).not.toBeNull();
        expect(widgetScore(def, 'Context percentage')).not.toBeNull();
        expect(widgetScore(def, 'zzz')).toBeNull();
      });
    }
  });

  it('finds a widget by its translated name with Turkish folding', () => {
    expect(widgetScore(def, 'istatistik')).toBeNull();
    withLang(zz, () => {
      for (const q of ['istatistik', 'İstatistik', 'ISTATISTIK', 'İSTATİSTİK', 'ıstatıstık', 'ista']) {
        expect(widgetScore(def, q), q).not.toBeNull();
      }
      expect(pickerItems('İstatistik')[0]?.type).toBe('context-percentage');
    });
  });

  it('matches the translated category name', () => {
    withLang(zz, () => {
      expect(widgetScore(def, 'bağlam')).not.toBeNull();
      expect(widgetScore(def, 'BAĞLAM')).not.toBeNull();
      expect(widgetScore(getWidget('model')!, 'bağlam')).toBeNull();
    });
  });

  it('keeps the English scores when nothing is translated', () => {
    const en = ['ctx', 'git', 'cost', 'mod'].map((q) => pickerItems(q).map((d) => d.type));
    const empty: LanguageDef = { ...zz, meta: { widgets: {}, options: {}, categories: {}, catalog: {} } };
    withLang(empty, () => {
      expect(['ctx', 'git', 'cost', 'mod'].map((q) => pickerItems(q).map((d) => d.type))).toEqual(en);
    });
  });
});

describe('TUI widget metadata', () => {
  it('names categories in the active language', () => {
    expect(categoryName('context')).toBe('Context window');
    withLang('tr', () => expect(categoryName('context')).toBe('Bağlam penceresi'));
  });

  it('shows translated picker rows and headers', () => {
    const s = [{ type: 'openPicker' as const }, { type: 'text' as const, text: 'İstatistik' }].reduce(
      reduce,
      initialState(defaultConfig(), '/tmp/cc/config.json'),
    );
    const out = withLang(zz, () => renderScreen(s, 120, 30).lines.map(stripAnsi).join('\n'));
    expect(out).toContain('Bağlam penceresi');
    expect(out).toContain('İstatistik');
    expect(out).toContain('context-percentage');
    expect(out).toContain('Bağlam penceresinin yüzdesi');
  });

  it('shows translated option labels, help and choices', () => {
    const config = defaultConfig();
    config.lines = [[{ id: 'c', type: 'context-percentage' }]];
    const fields = withLang(zz, () => widgetFields(def, 'c', config));
    const mode = fields.find((f) => f.id === 'option:mode')!;
    expect(mode.label).toBe('Kip');
    expect(mode.choices?.map((c) => c.label)).toEqual(['Kullanılan', 'Remaining']);
    expect(mode.choices?.map((c) => c.value)).toEqual(['used', 'remaining']);
    expect(withLang(zz, () => displayValue(mode, config).text)).toBe('Kullanılan');
    const th = fields.find((f) => f.id === 'option:thresholdColors')!;
    expect(th.label).toBe('Eşiğe göre renk');
    expect(th.help).toBe('Yeşil, sarı, kırmızı');
    const en = widgetFields(def, 'c', config).find((f) => f.id === 'option:mode')!;
    expect(en.label).toBe('Mode');
    expect(en.choices).toEqual(def.options!.find((o) => o.key === 'mode')!.choices);
  });
});
