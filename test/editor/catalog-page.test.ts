import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemEntries } from '../../src/catalog/system.js';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { listPresets } from '../../src/core/presets.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import type { CatalogEntryInfo, CatalogState } from '../../src/editor/web/store.js';
import { CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl, texts } from '../i18n/fake-dom.js';

const g = globalThis as any;
const saved = {
  document: g.document,
  HTMLElement: g.HTMLElement,
  window: g.window,
  localStorage: g.localStorage,
  fetch: g.fetch,
  requestAnimationFrame: g.requestAnimationFrame,
  getComputedStyle: g.getComputedStyle,
};
const nowhere = path.join(__dirname, 'no-such-dir');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

type Call = { method: string; url: string; body: any };
let body: FakeEl;
let calls: Call[];
let catalog: CatalogState;
let installed: { id: string; written: boolean; renamed: boolean } | null;

const system = (): CatalogEntryInfo[] =>
  systemEntries({ gsd: true }).map((e) => ({
    ref: e.ref,
    source: 'system',
    id: e.id,
    kind: e.kind,
    name: e.name,
    description: e.description,
    author: e.author,
    version: 1,
    rev: null,
    share: null,
    remote: null,
    updatedAt: null,
    scenario: e.scenario ?? null,
    content: clone(e.content),
  }));

const user = (over: Partial<CatalogEntryInfo>): CatalogEntryInfo => ({
  ref: 'u-1',
  source: 'user',
  id: 'u-1',
  kind: 'preset',
  name: 'Mine',
  description: 'My words',
  author: 'Ada',
  version: 2,
  rev: 3,
  share: { wanted: true, state: 'pending' },
  remote: null,
  updatedAt: '2026-10-16T10:00:00.000Z',
  scenario: null,
  content: { layout: { lines: [[{ id: 'm', type: 'model' }]] } },
  ...over,
});

const myBundle = () =>
  user({
    ref: 'u-b',
    id: 'u-b',
    kind: 'bundle',
    name: 'My bundle',
    share: { wanted: true, state: 'published' },
    remote: { id: 'ada/my-bundle', version: 4 },
    content: {
      layout: { lines: [[{ id: 'c', type: 'cost' }]] },
      appearance: { theme: 'sunset', style: 'powerline' },
      theme: { id: 'sunset', name: 'Sunset', style: 'powerline' } as any,
    },
  });
const myPreset = () => user({ ref: 'u-p', id: 'u-p', name: 'My preset' });

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0' });
  g.fetch = async (url: string, init: { method: string; body?: string }) => {
    const b = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url: String(url), body: b });
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (String(url).startsWith('/api/catalog/previews'))
      return json({ previews: Object.fromEntries((b.refs as string[]).map((r) => [r, [`line ${r}`]])) });
    if (String(url).startsWith('/api/catalog/install-theme'))
      return json({ ok: true, theme: installed, themes: [...builtinThemes(), { id: installed?.id }] });
    if (String(url).startsWith('/api/catalog')) return json(catalog);
    return json({ ok: true });
  };
});

beforeEach(() => {
  setLanguage('en');
  calls = [];
  installed = null;
  catalog = {
    system: system(),
    user: [myBundle(), myPreset()],
    profile: { author: 'Ada' },
    endpoint: null,
    publishable: false,
  };
  body = new FakeEl('BODY');
  const toasts = new FakeEl('DIV');
  toasts.id = 'toasts';
  body.append(toasts);
  g.document = {
    body,
    documentElement: new FakeEl('HTML'),
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
    getElementById: (id: string) => (id === 'toasts' ? toasts : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
});

afterAll(() => {
  Object.assign(g, saved);
  setLanguage('en');
});

const builtinThemes = () => clone(listThemes(nowhere));

async function init(config: Config = defaultConfig()) {
  const store = await import('../../src/editor/web/store.js');
  store.init({
    config: clone(config),
    savedConfig: clone(config),
    categories: clone(CATEGORIES),
    widgets: [{ type: 'model', name: 'Model', description: 'Model name', category: 'session', options: [] }],
    themes: builtinThemes(),
    styles: clone(STYLES),
    styleHistory: {},
    presets: listPresets(nowhere).map(({ build, ...p }) => ({ ...p, config: build() })),
    themesDir: nowhere,
    presetsDir: nowhere,
    version: '1.2.3',
  } as any);
  return store;
}

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function open() {
  const { openCatalog } = await import('../../src/editor/web/catalog.js');
  void openCatalog();
  await flush();
}

const tabs = () => body.all((e) => e.getAttribute('role') === 'tab');
const card = (ref: string) => body.all((e) => e.getAttribute('data-ref') === ref)[0]!;
const cards = () =>
  body.all((e) => e.classList.contains('theme-card')).map((e) => e.getAttribute('data-ref'));
const heads = (cls: string) => body.all((e) => e.classList.contains(cls)).map((e) => e.textContent);
const button = (label: string) => body.all((e) => e.tagName === 'BUTTON' && e.textContent === label).at(-1)!;
const previewCalls = () => calls.filter((c) => c.url === '/api/catalog/previews');
const toastText = () => texts(body.children[0] as FakeEl);

describe('groupEntries', () => {
  it('puts user groups above system groups, each bundle, preset, theme', async () => {
    const { groupEntries } = await import('../../src/editor/web/catalog.js');
    const key = (tab: 'all' | 'user' | 'system') =>
      groupEntries(catalog, tab).map((x) => `${x.section}/${x.kind}`);
    expect(key('all')).toEqual([
      'user/bundle',
      'user/preset',
      'system/bundle',
      'system/preset',
      'system/theme',
    ]);
    expect(key('user')).toEqual(['user/bundle', 'user/preset']);
    expect(key('system')).toEqual(['system/bundle', 'system/preset', 'system/theme']);
    const sys = groupEntries(catalog, 'system').flatMap((x) => x.entries);
    expect(sys).toHaveLength(catalog.system.length);
    expect(groupEntries({ ...catalog, user: [] }, 'user')).toEqual([]);
  });
});

describe('catalog page', () => {
  it('shows tabs, sections and groups in English', async () => {
    await init();
    await open();
    expect(tabs().map((x) => x.textContent)).toEqual(['All', 'User', 'System']);
    expect(tabs().map((x) => x.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(heads('catalog-section-head')).toEqual(['Your entries', 'Built in']);
    expect(heads('catalog-group-head')).toEqual(['Bundles', 'Presets', 'Bundles', 'Presets', 'Themes']);
    const list = texts(body);
    for (const s of [
      'Catalog',
      'My bundle',
      'Bundle',
      'v2',
      'by Ada',
      'Published v4',
      'Waiting to publish',
      'Done',
    ])
      expect(list).toContain(s);
    expect(cards().slice(0, 2)).toEqual(['u-b', 'u-p']);
    expect(cards()).toHaveLength(catalog.system.length + 2);
  });

  it('shows the same in Turkish', async () => {
    await init();
    setLanguage('tr');
    await open();
    expect(tabs().map((x) => x.textContent)).toEqual(['Tümü', 'Kullanıcı', 'Sistem']);
    expect(heads('catalog-section-head')).toEqual(['Sizin girdileriniz', 'Yerleşik']);
    expect(heads('catalog-group-head')).toEqual([
      'Paketler',
      'Hazır ayarlar',
      'Paketler',
      'Hazır ayarlar',
      'Temalar',
    ]);
    const list = texts(body);
    for (const s of ['Katalog', 'Paket', 'Ada tarafından', 'v4 yayımlandı', 'Yayımlanmayı bekliyor', 'Tamam'])
      expect(list).toContain(s);
  });

  it('shows the empty user note', async () => {
    await init();
    catalog.user = [];
    await open();
    expect(texts(body)).toContain('Nothing saved yet. Use Save current as… to add your setup.');
    tabs()[1]!.dispatch('click');
    expect(heads('catalog-group-head')).toEqual([]);
    expect(texts(body)).toContain('Nothing saved yet. Use Save current as… to add your setup.');
  });

  it('switches tabs and loads previews for visible refs in batches of 100', async () => {
    await init();
    catalog.user = Array.from({ length: 130 }, (_, i) =>
      user({ ref: `u-${i}`, id: `u-${i}`, name: `E${i}` }),
    );
    await open();
    const first = previewCalls();
    expect(first.every((c) => c.body.refs.length <= 100)).toBe(true);
    expect(first.flatMap((c) => c.body.refs)).toHaveLength(130 + catalog.system.length);
    calls = [];
    tabs()[2]!.dispatch('click');
    await flush();
    expect(tabs().map((x) => x.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(heads('catalog-section-head')).toEqual([]);
    expect(heads('catalog-group-head')).toEqual(['Bundles', 'Presets', 'Themes']);
    expect(cards()).toHaveLength(catalog.system.length);
    // cached already
    expect(previewCalls()).toEqual([]);
    expect(card('bundle/nord-minimal').querySelector('.theme-preview')!.getAttribute('innerHTML')).toContain(
      'line bundle/nord-minimal',
    );
  });

  it('requests only the visible tab', async () => {
    await init();
    const { openCatalog } = await import('../../src/editor/web/catalog.js');
    void openCatalog();
    await flush(1);
    tabs()[1]!.dispatch('click');
    await flush();
    const refs = previewCalls().flatMap((c) => c.body.refs);
    expect(refs).toEqual(['u-b', 'u-p']);
  });

  it('applies a system bundle in one undoable step without saving', async () => {
    const start = { ...defaultConfig(), budget: { daily: 5 }, language: 'tr' } as Config;
    const store = await init(start);
    setLanguage('en');
    await open();
    const before = clone(store.S.config);
    card('bundle/nord-minimal').dispatch('click');
    await flush();
    expect(store.S.config.theme).toBe('nord');
    const nord = catalog.system.find((e) => e.ref === 'bundle/nord-minimal')!;
    expect(store.S.config.lines.flat().map((i) => i.type)).toEqual(
      nord.content.layout!.lines!.flat().map((i) => i.type),
    );
    expect(store.S.config.budget).toEqual({ daily: 5 });
    expect(store.S.config.language).toBe('tr');
    expect(store.isDirty()).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT' || c.url.includes('save'))).toEqual([]);
    expect(toastText()).toContain('Applied Nord minimal. Save to keep it.');
    store.undo();
    expect(store.S.config).toEqual(before);
  });

  it('keeps theme and style when applying a preset', async () => {
    const store = await init({ ...defaultConfig(), theme: 'dracula', style: 'capsule' } as Config);
    await open();
    card('preset/compact').dispatch('click');
    await flush();
    expect(store.S.config.theme).toBe('dracula');
    expect(store.S.config.style).toBe('capsule');
    expect(store.S.undo).toHaveLength(1);
  });

  it('asks first with unsaved changes', async () => {
    const store = await init();
    store.commit({ ...store.S.config, theme: 'dracula' });
    await open();
    card('preset/compact').dispatch('click');
    await flush();
    expect(texts(body)).toContain('Apply Compact?');
    expect(texts(body)).toContain('Your unsaved changes stay in undo history.');
    button('Apply').dispatch('click');
    await flush();
    expect(store.S.undo).toHaveLength(2);
    store.undo();
    expect(store.S.config.theme).toBe('dracula');
  });

  it('asks about widget colors for a theme', async () => {
    const config = defaultConfig();
    config.lines[0]![0]!.color = 'red';
    const store = await init(config);
    await open();
    card('theme/nord').dispatch('click');
    await flush();
    button('Use theme colors').dispatch('click');
    await flush();
    expect(store.S.config.theme).toBe('nord');
    expect(store.S.config.lines[0]![0]!.color).toBeUndefined();
  });

  it('installs an embedded theme first and shows a rename', async () => {
    installed = { id: 'sunset-2', written: true, renamed: true };
    const store = await init();
    await open();
    card('u-b').dispatch('click');
    await flush();
    const install = calls.filter((c) => c.url === '/api/catalog/install-theme');
    expect(install.map((c) => c.body.ref)).toEqual(['u-b']);
    expect(store.S.config.theme).toBe('sunset-2');
    expect(store.S.config.style).toBe('powerline');
    expect(store.S.api.themes.some((th) => th.id === 'sunset-2')).toBe(true);
    expect(toastText()).toContain('Theme sunset already exists with other colors; installed as sunset-2');
  });

  it('localizes built-in preset labels', async () => {
    const store = await init();
    setLanguage('tr');
    await open();
    card('preset/cockpit').dispatch('click');
    await flush();
    expect(store.S.config.lines.flat().map((i) => i.label)).toContain('Süre: ');
  });

  it('applies on Enter', async () => {
    const store = await init();
    await open();
    card('u-p').dispatch('keydown', { key: 'Enter', preventDefault() {}, target: card('u-p') });
    await flush();
    expect(store.S.config.lines.flat().map((i) => i.type)).toEqual(['model']);
  });

  it('shows entry text as text', async () => {
    await init();
    catalog.user = [user({ name: '<img src=x onerror=1>', description: '<b>x</b>' })];
    await open();
    expect(texts(body)).toContain('<img src=x onerror=1>');
    expect(texts(body)).toContain('<b>x</b>');
    expect(body.all((e) => e.tagName === 'IMG' || e.tagName === 'B')).toEqual([]);
  });
});
