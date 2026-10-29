import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { LanguageDef, MetaTable } from '../../src/core/i18n/index.js';
import {
  categoryText,
  choiceLabel,
  optionHelp,
  optionLabel,
  widgetText,
} from '../../src/core/i18n/widget-text.js';
import type { WidgetItem } from '../../src/core/types.js';
import { paletteMatches } from '../../src/editor/web/search.js';
import type { WidgetInfo } from '../../src/editor/web/store.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const meta: MetaTable = {
  widgets: {
    'context-percentage': {
      name: 'İstatistik',
      description: 'Bağlam penceresinin yüzdesi',
      sample: '%34',
      options: { mode: { label: 'Kip', choices: { used: 'Kullanılan' } } },
    },
  },
  options: { Remaining: 'Kalan', 'Color by threshold': 'Eşiğe göre renk' },
  categories: { context: 'Bağlam penceresi', limits: 'Kullanım limitleri' },
  catalog: {},
};
const zz: LanguageDef = { id: 'zz', name: 'Test', aliases: [], locale: 'tr', messages: {}, meta };

// same shape as widgetCatalog() in src/editor/server.ts, after JSON
const catalog: WidgetInfo[] = JSON.parse(
  JSON.stringify(
    ALL_WIDGETS.map((w) => ({
      type: w.type,
      name: w.name,
      category: w.category,
      description: w.description,
      label: w.label,
      icon: w.icon,
      color: w.color,
      options: w.options ?? [],
      sample: w.sample,
      hidden: w.hidden ?? false,
      timeBased: w.timeBased === true,
      hideWhenEmpty: w.hideWhenEmpty === true,
    })),
  ),
);
const categories: { id: string; name: string }[] = JSON.parse(JSON.stringify(CATEGORIES));
const entry = catalog.find((w) => w.type === 'context-percentage')!;
const cat = categories.find((c) => c.id === 'context')!;

describe('paletteMatches', () => {
  it('matches type, English fields and category in English', () => {
    for (const q of ['', '  ', 'context-percentage', 'CONTEXT PERC', 'window used', 'Context window']) {
      expect(paletteMatches(entry, cat.id, cat.name, q), q).toBe(true);
    }
    for (const q of ['ctx', 'istatistik']) expect(paletteMatches(entry, cat.id, cat.name, q), q).toBe(false);
  });

  it('matches translated text with Turkish folding and keeps English', () => {
    withLang(zz, () => {
      for (const q of ['istatistik', 'İstatistik', 'ISTATISTIK', 'İSTATİSTİK', 'penceresinin', 'BAĞLAM']) {
        expect(paletteMatches(entry, cat.id, cat.name, q), q).toBe(true);
      }
      for (const q of ['context-percentage', 'Context percentage', 'Context window']) {
        expect(paletteMatches(entry, cat.id, cat.name, q), q).toBe(true);
      }
      expect(paletteMatches(entry, cat.id, cat.name, 'kalan')).toBe(false);
      const model = catalog.find((w) => w.type === 'model')!;
      expect(paletteMatches(model, 'session', 'Session & model', 'istatistik')).toBe(false);
    });
  });
});

describe('editor catalog translation', () => {
  it('has no render function and translates by type', () => {
    expect('render' in entry).toBe(false);
    withLang(zz, () => {
      expect(widgetText(entry, 'name')).toBe('İstatistik');
      expect(widgetText(entry, 'description')).toBe('Bağlam penceresinin yüzdesi');
      expect(widgetText(entry, 'sample')).toBe('%34');
      expect(widgetText(entry, 'label')).toBe(entry.label);
      const mode = entry.options.find((o) => o.key === 'show')!;
      expect(optionLabel(entry, mode)).toBe('Kip');
      expect(mode.choices!.map((c) => choiceLabel(entry, mode, c))).toEqual(['Kullanılan', 'Kalan']);
      const th = entry.options.find((o) => o.key === 'thresholdColors')!;
      expect(optionLabel(entry, th)).toBe('Eşiğe göre renk');
      expect(optionHelp(entry, th)).toBe(th.help);
    });
  });

  it('translates api categories by id', () => {
    withLang(zz, () => {
      expect(categories.map((c) => categoryText(c.id, c.name))).toEqual(
        CATEGORIES.map((c) => meta.categories[c.id] ?? c.name),
      );
    });
    withLang('tr', () => expect(categoryText(cat.id, cat.name)).toBe('Bağlam penceresi'));
  });

  it('keeps every English field without metadata', () => {
    for (const w of catalog) {
      expect(widgetText(w, 'name')).toBe(w.name);
      expect(widgetText(w, 'description')).toBe(w.description);
      for (const o of w.options) {
        expect(optionLabel(w, o)).toBe(o.label);
        for (const c of o.choices ?? []) expect(choiceLabel(w, o, c)).toBe(c.label);
      }
    }
  });
});

class FakeEl {
  id = '';
  htmlFor = '';
  className = '';
  value = '';
  hidden = false;
  children: (FakeEl | string)[] = [];
  readonly attrs = new Map<string, string>();
  constructor(readonly tagName: string) {}
  get classList() {
    return { contains: (c: string) => this.className.split(' ').includes(c) };
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener() {}
  append(...c: (FakeEl | string)[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: (FakeEl | string)[]) {
    this.children = [...c];
  }
  querySelector(): FakeEl | null {
    return null;
  }
  all(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (pred(c)) out.push(c);
      out.push(...c.all(pred));
    }
    return out;
  }
}

const g = globalThis as any;
const saved = { document: g.document, HTMLElement: g.HTMLElement };

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.document = { createElement: (tag: string) => new FakeEl(tag.toUpperCase()) };
});

afterAll(() => {
  g.document = saved.document;
  g.HTMLElement = saved.HTMLElement;
});

describe('inspector option controls', () => {
  let optionControl: typeof import('../../src/editor/web/inspector.js').optionControl;

  beforeAll(async () => {
    optionControl = (await import('../../src/editor/web/inspector.js')).optionControl;
    const store = await import('../../src/editor/web/store.js');
    const config = { ...defaultConfig(), lines: [[item]] };
    store.init({ config, savedConfig: config, categories, widgets: catalog } as any);
  });

  const item: WidgetItem = { id: 'c', type: 'context-percentage' };
  const control = (key: string) =>
    optionControl(item, entry.options.find((o) => o.key === key)!) as unknown as FakeEl;

  it('shows translated labels and choices', () => {
    const en = control('show');
    expect(en.textContent).toContain('Mode');
    expect(en.all((e) => e.tagName === 'OPTION').map((e) => e.textContent)).toEqual(['Used', 'Remaining']);
    const el = withLang(zz, () => control('show'));
    expect(el.textContent).toContain('Kip');
    const options = el.all((e) => e.tagName === 'OPTION');
    expect(options.map((e) => e.textContent)).toEqual(['Kullanılan', 'Kalan']);
    expect(options.map((e) => e.value || e.getAttribute('value'))).toEqual(['used', 'remaining']);
  });

  it('shows translated boolean labels', () => {
    const el = withLang(zz, () => control('thresholdColors'));
    expect(el.textContent).toContain('Eşiğe göre renk');
  });
});
