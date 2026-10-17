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
type Listener = (e: any) => void;
let docKeys: Listener[];
let winKeys: Listener[];

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
  g.window = {
    setTimeout: () => 0,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type: string, fn: Listener) {
      if (type === 'keydown') winKeys.push(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      if (type === 'keydown') winKeys = winKeys.filter((x) => x !== fn);
    },
  };
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
  docKeys = [];
  winKeys = [];
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
    addEventListener(type: string, fn: Listener) {
      if (type === 'keydown') docKeys.push(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      if (type === 'keydown') docKeys = docKeys.filter((x) => x !== fn);
    },
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
const applyBtn = (ref: string, title = 'Apply') =>
  card(ref).all((e) => e.tagName === 'BUTTON' && e.getAttribute('title') === title)[0]!;
// dialogs still open; closed ones linger while they fade
const dialogs = () =>
  body.children.filter(
    (c): c is FakeEl =>
      typeof c !== 'string' && c.classList.contains('overlay') && !c.classList.contains('leaving'),
  );
const top = () => dialogs().at(-1)!;
const titleOf = (d: FakeEl) => d.querySelector('H2')!.textContent;
const peek = () => body.all((e) => e.classList.contains('catalog-peek'));
const thumb = (ref: string) => card(ref).querySelector('.catalog-thumb')!;
// window capture runs before document capture
const press = (key: string) => {
  let stopped = false;
  const ev = {
    key,
    stopPropagation() {
      stopped = true;
    },
    preventDefault() {},
  };
  for (const fn of [...winKeys]) fn(ev);
  if (!stopped) for (const fn of [...docKeys]) fn(ev);
};
const keyOn = (el: FakeEl, type: string, key: string) =>
  el.dispatch(type, { key, preventDefault() {}, target: el, currentTarget: el });

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
    applyBtn('bundle/nord-minimal').dispatch('click');
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

  it('asks before applying commands and links from a saved entry; dropping is the default (IN-03)', async () => {
    const risky = user({
      ref: 'u-r',
      id: 'u-r',
      name: 'Risky',
      content: {
        layout: {
          lines: [
            [
              { id: 'm', type: 'model' },
              { id: 'c', type: 'command', options: { command: 'echo hi' } },
              { id: 'l', type: 'link', options: { url: 'https://example.com/x', text: 'x' } },
            ],
          ],
        },
      },
    });
    catalog.user = [risky];
    const store = await init();
    await open();
    const before = clone(store.S.config);
    applyBtn('u-r').dispatch('click');
    await flush();
    const all = texts(body);
    expect(all).toContain('Commands and links in Risky');
    expect(all).toContain('echo hi');
    expect(all).toContain('https://example.com/x');
    button('Cancel').dispatch('click');
    await flush();
    expect(store.S.config).toEqual(before);
    applyBtn('u-r').dispatch('click');
    await flush();
    button('Apply without them').dispatch('click');
    await flush();
    expect(store.S.config.lines.flat().map((i) => i.type)).toEqual(['model']);
    expect(toastText()).toContain('Applied Risky without 2 command or link widgets. Save to keep it.');
    applyBtn('u-r').dispatch('click');
    await flush();
    // unsaved changes ask first
    button('Apply').dispatch('click');
    await flush();
    button('Keep them').dispatch('click');
    await flush();
    expect(store.S.config.lines.flat().map((i) => i.type)).toEqual(['model', 'command', 'link']);
  });

  it('consent shows every target in full like the CLI, and never keeps an overlong one', async () => {
    const long = `echo ${'x'.repeat(2100)}`;
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`,
      type: 'command',
      options: { command: `echo ${i} ${'y'.repeat(150)}` },
    }));
    const lines = [
      [
        { id: 'm', type: 'model' },
        { id: 'long', type: 'command', options: { command: long } },
        { id: 'zw', type: 'command', options: { command: 'cat\u200b /etc/passwd' } },
        { id: 'bidi', type: 'command', options: { command: 'ls \u202erm -rf\u202c' } },
        { id: 'sp', type: 'command', options: { command: 'echo a     b' } },
        { id: 'esc', type: 'command', options: { command: 'printf \u001b[2J' } },
        ...many,
      ],
    ];
    catalog.user = [user({ ref: 'u-r', id: 'u-r', name: 'Risky', content: { layout: { lines } } as any })];
    const store = await init();
    await open();
    applyBtn('u-r').dispatch('click');
    await flush();
    const codes = body.all((e) => e.tagName === 'CODE' && e.classList.contains('catalog-consent-target'));
    const shownText = codes.map((c) => c.textContent);
    expect(shownText).toHaveLength(44);
    expect(shownText).toContain('cat\u27e8U+200B\u27e9 /etc/passwd');
    expect(shownText).toContain('ls \u27e8U+202E\u27e9rm -rf\u27e8U+202C\u27e9');
    expect(shownText).toContain('echo a\u27e85 spaces\u27e9b');
    expect(shownText).toContain('printf \u27e8U+001B\u27e9[2J');
    // full text, no ellipsis
    for (const x of many) expect(shownText).toContain(x.options.command);
    expect(shownText.some((x) => x.includes('\u2026'))).toBe(false);
    expect(texts(body)).toContain('command: 2105 characters, too long to review, dropped');
    expect(shownText.some((x) => x.includes('x'.repeat(100)))).toBe(false);
    // the safe button is the focused default
    const drop = button('Apply without them');
    expect(drop.classList.contains('primary')).toBe(true);
    button('Keep them').dispatch('click');
    await flush();
    const ids = store.S.config.lines.flat().map((i) => i.id);
    expect(ids).not.toContain('long');
    expect(ids).toHaveLength(45);
    expect(toastText()).toContain('Applied Risky without 1 command or link widget. Save to keep it.');
  });

  it('offers no Keep when every target is too long', async () => {
    const lines = [[{ id: 'long', type: 'command', options: { command: 'z'.repeat(2001) } }]];
    catalog.user = [user({ ref: 'u-r', id: 'u-r', name: 'Risky', content: { layout: { lines } } as any })];
    const store = await init();
    await open();
    applyBtn('u-r').dispatch('click');
    await flush();
    expect(body.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Keep them')).toEqual([]);
    button('Apply without them').dispatch('click');
    await flush();
    expect(store.S.config.lines.flat()).toEqual([]);
  });

  it('keeps theme and style when applying a preset', async () => {
    const store = await init({ ...defaultConfig(), theme: 'dracula', style: 'capsule' } as Config);
    await open();
    applyBtn('preset/compact').dispatch('click');
    await flush();
    expect(store.S.config.theme).toBe('dracula');
    expect(store.S.config.style).toBe('capsule');
    expect(store.S.undo).toHaveLength(1);
  });

  it('asks first with unsaved changes', async () => {
    const store = await init();
    store.commit({ ...store.S.config, theme: 'dracula' });
    await open();
    applyBtn('preset/compact').dispatch('click');
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
    applyBtn('theme/nord').dispatch('click');
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
    applyBtn('u-b').dispatch('click');
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
    applyBtn('preset/cockpit', 'Uygula').dispatch('click');
    await flush();
    expect(store.S.config.lines.flat().map((i) => i.label)).toContain('Süre: ');
  });

  it('opens details on Enter and Space', async () => {
    const store = await init();
    await open();
    const before = clone(store.S.config);
    keyOn(card('u-p'), 'keydown', 'Enter');
    await flush();
    expect(dialogs()).toHaveLength(2);
    expect(titleOf(top())).toBe('My preset');
    press('Escape');
    await flush();
    keyOn(card('u-p'), 'keydown', ' ');
    expect(dialogs()).toHaveLength(1);
    keyOn(card('u-p'), 'keyup', ' ');
    await flush();
    expect(titleOf(top())).toBe('My preset');
    press('Escape');
    await flush();
    // keys from a child button stay there
    const child = applyBtn('u-p');
    card('u-p').dispatch('keydown', {
      key: 'Enter',
      preventDefault() {},
      target: child,
      currentTarget: card('u-p'),
    });
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(store.S.config).toEqual(before);
  });

  it('shows entry text as text', async () => {
    await init();
    catalog.user = [user({ name: '<img src=x onerror=1>', description: '<b>x</b>' })];
    await open();
    expect(texts(body)).toContain('<img src=x onerror=1>');
    expect(texts(body)).toContain('<b>x</b>');
    expect(body.all((e) => e.tagName === 'IMG' || e.tagName === 'B')).toEqual([]);
    card('u-1').dispatch('click');
    await flush();
    expect(texts(top())).toContain('<img src=x onerror=1>');
    expect(texts(top())).toContain('<b>x</b>');
    expect(body.all((e) => e.tagName === 'IMG' || e.tagName === 'B')).toEqual([]);
  });
});

describe('catalog details and peek', () => {
  it('opens details on click without applying', async () => {
    const store = await init();
    await open();
    const before = clone(store.S.config);
    expect(card('u-p').getAttribute('title')).toBe('Details of My preset');
    card('u-p').dispatch('click');
    await flush();
    const d = top();
    expect(dialogs()).toHaveLength(2);
    expect(titleOf(d)).toBe('My preset');
    const all = texts(d);
    for (const s of ['Preset', 'v2', 'Your entries', 'by Ada', 'Waiting to publish', 'My words'])
      expect(all).toContain(s);
    const preview = d.querySelector('.catalog-detail-preview')!;
    expect(preview.getAttribute('aria-label')).toBe('Preview with your setup');
    expect(preview.querySelector('.theme-preview')!.getAttribute('innerHTML')).toContain('line u-p');
    const labels = d
      .querySelector('FOOTER')!
      .all((e) => e.tagName === 'BUTTON')
      .map((b) => b.textContent);
    expect(labels).toEqual(['Version history', 'Stop sharing', 'Delete', 'Close', 'Apply']);
    expect(store.S.config).toEqual(before);
    expect(calls.filter((c) => c.url.includes('install-theme'))).toEqual([]);
  });

  it('shows the source of built-in and file entries', async () => {
    await init();
    catalog.user = [
      user({ ref: 'legacy:theme/old', source: 'legacy', kind: 'theme', name: 'Old', share: null }),
    ];
    await open();
    card('legacy:theme/old').dispatch('click');
    await flush();
    expect(texts(top())).toContain('Theme file');
    press('Escape');
    await flush();
    card('preset/compact').dispatch('click');
    await flush();
    expect(texts(top())).toContain('Built in');
    const labels = top()
      .querySelector('FOOTER')!
      .all((e) => e.tagName === 'BUTTON')
      .map((b) => b.textContent);
    expect(labels).toEqual(['Close', 'Apply']);
  });

  it('has an Apply button on every card', async () => {
    await init();
    await open();
    for (const ref of ['u-b', 'u-p', 'preset/compact', 'theme/nord']) {
      const b = applyBtn(ref);
      expect(b).toBeTruthy();
      expect(
        card(ref)
          .querySelector('.theme-actions')!
          .all((e) => e.tagName === 'BUTTON')[0],
      ).toBe(b);
    }
    expect(applyBtn('u-p').getAttribute('aria-label')).toBe('Apply My preset');
  });

  it('applies from the details dialog and closes it', async () => {
    const store = await init();
    await open();
    card('u-p').dispatch('click');
    await flush();
    button('Apply').dispatch('click');
    await flush();
    expect(store.S.config.lines.flat().map((i) => i.type)).toEqual(['model']);
    expect(toastText()).toContain('Applied My preset. Save to keep it.');
    expect(dialogs()).toHaveLength(0);
    store.undo();
    expect(store.S.undo).toHaveLength(0);
  });

  it('focuses Close, and Escape or Close return to the card', async () => {
    await init();
    await open();
    const el = card('u-p');
    let focused = 0;
    el.focus = () => {
      focused++;
    };
    const closeBtns: FakeEl[] = [];
    const origFocus = FakeEl.prototype.focus;
    FakeEl.prototype.focus = function (this: FakeEl) {
      closeBtns.push(this);
    };
    g.document.activeElement = el;
    el.dispatch('click');
    await flush();
    FakeEl.prototype.focus = origFocus;
    expect(closeBtns.at(-1)!.textContent).toBe('Close');
    press('Escape');
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(titleOf(top())).toBe('Catalog');
    expect(focused).toBe(1);
    el.dispatch('click');
    await flush();
    button('Close').dispatch('click');
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(focused).toBe(2);
  });

  it('runs history and delete from the details dialog', async () => {
    await init();
    await open();
    card('u-p').dispatch('click');
    await flush();
    button('Delete').dispatch('click');
    await flush();
    expect(titleOf(top())).toBe('Delete My preset?');
    expect(dialogs()).toHaveLength(2);
    press('Escape');
    await flush();
    card('u-p').dispatch('click');
    await flush();
    button('Version history').dispatch('click');
    await flush();
    expect(calls.some((c) => c.url.startsWith('/api/catalog/entries/u-p'))).toBe(true);
  });

  it('fills the details preview when it arrives later', async () => {
    await init();
    const { openCatalog } = await import('../../src/editor/web/catalog.js');
    void openCatalog();
    await flush(1);
    card('u-p').dispatch('click');
    const box = () => top().querySelector('.catalog-detail-preview')!.querySelector('.theme-preview')!;
    expect(box().getAttribute('innerHTML') ?? '').not.toContain('line u-p');
    await flush();
    expect(box().getAttribute('innerHTML')).toContain('line u-p');
  });

  it('peeks on mouse hover only and hides on leave and Escape', async () => {
    await init();
    await open();
    thumb('u-p').dispatch('pointerenter', { pointerType: 'touch' });
    expect(peek().filter((p) => p.classList.contains('on'))).toEqual([]);
    thumb('u-p').dispatch('pointerenter', { pointerType: 'mouse' });
    expect(peek()).toHaveLength(1);
    const p = peek()[0]!;
    expect(p.getAttribute('aria-hidden')).toBe('true');
    expect(p.classList.contains('on')).toBe(true);
    expect(p.querySelector('.theme-preview')!.getAttribute('innerHTML')).toContain('line u-p');
    thumb('u-p').dispatch('pointerleave', {});
    expect(p.classList.contains('on')).toBe(false);
    thumb('u-b').dispatch('pointerenter', { pointerType: 'mouse' });
    expect(peek()).toHaveLength(1);
    expect(p.querySelector('.theme-preview')!.getAttribute('innerHTML')).toContain('line u-b');
    press('Escape');
    await flush();
    expect(p.classList.contains('on')).toBe(false);
    expect(dialogs()).toHaveLength(1);
    // no peek: Escape closes the catalog as before
    button('Done').dispatch('click');
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(peek()).toEqual([]);
    expect(winKeys).toEqual([]);
  });

  it('opening details hides the peek', async () => {
    await init();
    await open();
    thumb('u-p').dispatch('pointerenter', { pointerType: 'mouse' });
    card('u-p').dispatch('click');
    await flush();
    expect(peek()[0]!.classList.contains('on')).toBe(false);
  });

  it('shows details and Apply in Turkish', async () => {
    await init();
    setLanguage('tr');
    await open();
    expect(card('u-p').getAttribute('title')).toBe('My preset ayrıntıları');
    expect(applyBtn('u-p', 'Uygula').getAttribute('aria-label')).toBe('Uygula: My preset');
    card('u-p').dispatch('click');
    await flush();
    const d = top();
    expect(d.querySelector('.catalog-detail-preview')!.getAttribute('aria-label')).toBe(
      'Kurulumunuzla önizleme',
    );
    const labels = d
      .querySelector('FOOTER')!
      .all((e) => e.tagName === 'BUTTON')
      .map((b) => b.textContent);
    expect(labels.slice(-2)).toEqual(['Kapat', 'Uygula']);
    expect(texts(d)).toContain('Sizin girdileriniz');
  });
});
