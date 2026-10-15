import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { inspectorMessages as en } from '../../src/core/i18n/en/inspector.js';
import { inspectorMessages as tr } from '../../src/core/i18n/tr/inspector.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';
import { FakeEl, texts } from './fake-dom.js';

const g = globalThis as any;
const saved = {
  document: g.document,
  HTMLElement: g.HTMLElement,
  window: g.window,
  localStorage: g.localStorage,
};
let host: FakeEl;

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.document = {
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
    getElementById: (id: string) => (id === 'inspector-body' ? host : null),
    querySelectorAll: () => [],
    activeElement: null,
  };
});

afterAll(() => {
  Object.assign(g, saved);
});

const widgets = JSON.parse(
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

async function render(config: Config, tab: 'widget' | 'global', lang: 'en' | 'tr'): Promise<string[]> {
  const store = await import('../../src/editor/web/store.js');
  const { renderInspector } = await import('../../src/editor/web/inspector.js');
  store.init({
    config,
    savedConfig: config,
    categories: JSON.parse(JSON.stringify(CATEGORIES)),
    widgets,
    themes: JSON.parse(JSON.stringify(listThemes(path.join(__dirname, 'no-such-themes-dir')))),
    styles: JSON.parse(JSON.stringify(STYLES)),
    styleHistory: {},
    claude: {},
    hooks: {},
    presets: [],
  } as any);
  store.S.tab = tab;
  store.S.selectedId = tab === 'widget' ? (config.lines[0]?.[0]?.id ?? null) : null;
  host = new FakeEl('DIV');
  withLang(lang, () => renderInspector());
  return texts(host);
}

const item = { id: 'w1', type: 'git-branch' };
const cfg = (p: Partial<Config> = {}): Config => ({ ...defaultConfig(), lines: [[item]], ...p });

const CASES: [string, Config, 'widget' | 'global'][] = [
  ['widget tab', cfg(), 'widget'],
  ['empty widget tab', cfg({ lines: [[]] }), 'widget'],
  ['unknown widget', cfg({ lines: [[{ id: 'x', type: 'nope-widget' }]] }), 'widget'],
  ['global tab', cfg(), 'global'],
  ['global powerline', cfg({ style: 'powerline' }), 'global'],
  ['global capsule', cfg({ style: 'capsule' }), 'global'],
  ['global panel', cfg({ style: 'tui', tui: { breakpoints: [{ minWidth: 0, areas: ['w1'] }] } }), 'global'],
  ['global panel, custom box', cfg({ style: 'tui', tui: { box: { tl: '+' } as any } }), 'global'],
];

const english = new Set(
  Object.entries(en)
    .filter(([id, v]) => tr[id as keyof typeof tr] !== v)
    .map(([, v]) => v as string),
);

describe('web inspector text', () => {
  it.each(CASES)('%s shows no English inspector text in Turkish', async (_name, config, tab) => {
    const shown = await render(config, tab, 'tr');
    expect(shown.length).toBeGreaterThan(1);
    expect(shown.filter((s) => english.has(s))).toEqual([]);
  });

  it('keeps the English text', async () => {
    const widget = await render(cfg(), 'widget', 'en');
    for (const s of ['Label override', 'Hide when no data', 'Appearance', 'Bold', 'Remove widget (Delete)'])
      expect(widget).toContain(s);
    const global = await render(cfg({ style: 'tui', tui: { breakpoints: [] } }), 'global', 'en');
    for (const s of ['Rendering', 'Color level', 'Reset to theme', 'Theme: " │ "', 'Change theme'])
      expect(global).toContain(s);
    expect(global).toContain('Each widget in its own color, thin bar separators');
    for (const s of [
      'Panel',
      'Grid layout',
      'Add breakpoint',
      'Using the theme default.',
      'Tokens: {git-branch} {w1}',
    ])
      expect(global).toContain(s);
  });

  it('uses the catalog for theme descriptions and style names', async () => {
    const shown = await render(cfg(), 'global', 'tr');
    expect(shown).toContain('Her bileşen kendi renginde, ince çizgi ayraçlar');
    for (const s of ['Metin', 'Bloklar', 'Kapsül', 'Yuvarlak kapsüller (Nerd Font)'])
      expect(shown).toContain(s);
    expect(shown).toContain('Classic');
    expect(shown).not.toContain('Text');
  });

  it('keeps ids, glyphs and values literal', async () => {
    const shown = await render(cfg({ style: 'tui', tui: { breakpoints: [] } }), 'global', 'tr');
    for (const s of ['rounded', 'heavy-dashed', 'tui', '{model}', 'ccinfobar', 'Nerd Font', 'ASCII'])
      expect(shown).toContain(s);
    const widget = await render(cfg(), 'widget', 'tr');
    expect(widget).toContain('git-branch');
  });

  it('keeps style button classes in Turkish', async () => {
    const store = await import('../../src/editor/web/store.js');
    const { renderInspector } = await import('../../src/editor/web/inspector.js');
    await render(cfg(), 'widget', 'tr');
    store.S.tab = 'widget';
    withLang('tr', () => renderInspector());
    const classes = host.all((e) => e.classList.contains('style-btn')).map((e) => e.className);
    expect(classes).toEqual(['style-btn style-bold', 'style-btn style-dim', 'style-btn style-italic']);
  });
});
