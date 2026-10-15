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

class FakeEl {
  id = '';
  htmlFor = '';
  className = '';
  value = '';
  hidden = false;
  checked = false;
  disabled = false;
  type = '';
  scrollTop = 0;
  dataset: Record<string, string> = {};
  children: (FakeEl | string)[] = [];
  readonly attrs = new Map<string, string>();
  constructor(readonly tagName: string) {}
  get classList() {
    const list = () => this.className.split(' ').filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => {
        this.className = [...new Set([...list(), c])].join(' ');
      },
      remove: (c: string) => {
        this.className = list()
          .filter((x) => x !== c)
          .join(' ');
      },
      toggle: (c: string, on?: boolean) => {
        const want = on ?? !list().includes(c);
        if (want) this.classList.add(c);
        else this.classList.remove(c);
        return want;
      },
    };
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v: string) {
    this.children = [v];
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener() {}
  parent: FakeEl | null = null;
  append(...c: (FakeEl | string)[]) {
    for (const x of c) if (typeof x !== 'string') x.parent = this;
    this.children.push(...c);
  }
  replaceChildren(...c: (FakeEl | string)[]) {
    this.children = [];
    this.append(...c);
  }
  after(...c: FakeEl[]) {
    const list = this.parent?.children;
    if (!list) return;
    for (const x of c) x.parent = this.parent;
    list.splice(list.indexOf(this) + 1, 0, ...c);
  }
  querySelector(sel: string): FakeEl | null {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    return this.all((e) => (cls ? e.classList.contains(cls) : e.tagName === sel.toUpperCase()))[0] ?? null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    return this.all((e) => e.tagName === sel.toUpperCase());
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

// every text node and every title, placeholder and aria-label
function texts(el: FakeEl): string[] {
  const out: string[] = [];
  const walk = (e: FakeEl) => {
    for (const k of ['title', 'placeholder', 'aria-label']) {
      const v = e.getAttribute(k);
      if (v) out.push(v);
    }
    for (const c of e.children) {
      if (typeof c === 'string') out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

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
