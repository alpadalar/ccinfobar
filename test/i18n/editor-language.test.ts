import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { keepLanguage } from '../../src/core/edit.js';
import { en } from '../../src/core/i18n/en/index.js';
import { pickUiLanguage } from '../../src/core/i18n/resolve.js';
import { tr } from '../../src/core/i18n/tr/index.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl, parseHtml, texts } from './fake-dom.js';

const html = fs.readFileSync(path.resolve(__dirname, '../../src/editor/web/index.html'), 'utf8');

describe('UI language in the browser', () => {
  it('config wins over the server', () => {
    expect(pickUiLanguage('tr', 'en', ['en-US'])).toBe('tr');
    expect(pickUiLanguage('en', 'tr', ['tr-TR'])).toBe('en');
  });

  it('auto uses the server answer, then the browser', () => {
    expect(pickUiLanguage(undefined, 'tr', ['en-US'])).toBe('tr');
    expect(pickUiLanguage('auto', 'tr', [])).toBe('tr');
    expect(pickUiLanguage(undefined, undefined, ['tr-TR'])).toBe('tr');
    expect(pickUiLanguage(undefined, undefined, ['de-DE', 'tr'])).toBe('tr');
    expect(pickUiLanguage(undefined, undefined, [])).toBe('en');
  });

  it('ignores ids outside the registry', () => {
    expect(pickUiLanguage(undefined, 'xx', ['tr-TR'])).toBe('tr');
    expect(pickUiLanguage('__proto__', '__proto__', [])).toBe('en');
  });
});

describe('language carry-over', () => {
  const cfg = (language?: Config['language']): Config => ({
    ...defaultConfig(),
    ...(language ? { language } : {}),
  });

  it('a preset without a language keeps the current one', () => {
    expect(keepLanguage(cfg(), cfg('tr')).language).toBe('tr');
  });

  it('keepLanguage keeps the current language, with or without its own', () => {
    expect(keepLanguage(cfg(), cfg('tr')).language).toBe('tr');
    expect(keepLanguage(cfg('en'), cfg('tr')).language).toBe('tr');
    expect('language' in keepLanguage(cfg('tr'), cfg())).toBe(false);
  });
});

// the app booted against the real index.html in a FakeEl tree
const g = globalThis as any;
const KEYS = [
  'document',
  'HTMLElement',
  'window',
  'localStorage',
  'sessionStorage',
  'location',
  'history',
  'requestAnimationFrame',
  'getComputedStyle',
];
const saved = Object.fromEntries([...KEYS, 'fetch'].map((k) => [k, g[k]]));

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
    })),
  ),
);

function state(config: Config, server?: string) {
  return {
    version: '1.2.3',
    configPath: '/tmp/ccinfobar/config.json',
    configError: null,
    configIssue: null,
    config,
    savedConfig: config,
    widgets,
    categories: JSON.parse(JSON.stringify(CATEGORIES)),
    presets: [
      {
        id: 'minimal',
        name: 'Minimal',
        description: 'One line',
        source: 'builtin',
        config: { ...defaultConfig(), lines: [[{ id: 'm1', type: 'model' }]] },
      },
    ],
    presetsDir: '/tmp/presets',
    styleHistory: {},
    gsdInstalled: false,
    themes: JSON.parse(JSON.stringify(listThemes(path.join(__dirname, 'no-such-themes-dir')))),
    styles: JSON.parse(JSON.stringify(STYLES)),
    themesDir: '/tmp/themes',
    claude: { statusLine: null, installed: false, defaultCommand: 'ccinfobar', settingsFile: '/tmp/s.json' },
    hooks: { installed: [], available: true, events: [], optional: [], progress: [] },
    hasLastPayload: false,
    scenarios: [],
    terminal: null,
    ...(server ? { language: { id: server, source: 'LANG' } } : {}),
  };
}

const config: Config = { ...defaultConfig(), lines: [[{ id: 'w1', type: 'model' }]] };

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.sessionStorage = { getItem: () => null, setItem() {} };
  g.location = { search: '', pathname: '/' };
  g.history = { replaceState() {} };
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0' });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

type App = {
  root: FakeEl;
  html: FakeEl;
  byId: (id: string) => FakeEl;
  S: () => { config: Config };
  writes: unknown[];
  previews: Config[];
};

async function boot(opts: { config?: Config; server?: string; nav?: string[]; fail?: string }): Promise<App> {
  const { root } = parseHtml(html);
  const htmlEl = root.all((e) => e.tagName === 'HTML')[0]!;
  const body = root.all((e) => e.tagName === 'BODY')[0]!;
  const find = (id: string) => root.all((e) => e.id === id)[0] ?? null;
  const byId = (id: string) => find(id)!;
  const writes: unknown[] = [];
  const previews: Config[] = [];
  g.document = {
    body,
    title: '',
    documentElement: htmlEl,
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
    getElementById: find,
    querySelector: () => null,
    querySelectorAll: (sel: string) => (/^\[[\w-]+\]$/.test(sel) ? root.querySelectorAll(sel) : []),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
  vi.stubGlobal('navigator', { languages: opts.nav ?? [] });
  const st = state(opts.config ?? config, opts.server);
  g.fetch = async (url: string, init?: { body?: string }) => {
    if (opts.fail) throw new Error(opts.fail);
    const sent = init?.body ? JSON.parse(init.body) : {};
    if (url === '/api/state') return { ok: true, json: async () => JSON.parse(JSON.stringify(st)) };
    if (url === '/api/normalize') return { ok: true, json: async () => ({ config: sent.config }) };
    if (url === '/api/config') writes.push(sent.config);
    if (url === '/api/preview') previews.push(sent.config);
    if (url === '/api/preview') return { ok: true, json: async () => ({ lines: [], hidden: [] }) };
    return { ok: false, status: 500, json: async () => ({ error: 'no' }) };
  };
  vi.resetModules();
  await import('../../src/editor/web/app.js');
  const store = await import('../../src/editor/web/store.js');
  await flush();
  return { root, html: htmlEl, byId, S: () => store.S, writes, previews };
}

const english = (() => {
  const trValues = new Set<string>(
    Object.values(tr).flatMap((v) => (typeof v === 'string' ? [v] : [v.one, v.other])),
  );
  return new Set<string>(
    Object.entries(en)
      .filter(([id, v]) => (tr as Record<string, unknown>)[id] !== v)
      .flatMap(([, v]): string[] => (typeof v === 'string' ? [v] : [v.one, v.other]))
      .filter((s) => !trValues.has(s)),
  );
})();
// theme names stay literal, like in the gallery
const themeNames = new Set(listThemes(path.join(__dirname, 'no-such-themes-dir')).map((th) => th.name));
const foreign = (el: FakeEl) => texts(el).filter((s) => english.has(s) && !themeNames.has(s));

const overlay = (app: App) => app.root.all((e) => e.classList.contains('overlay')).at(-1)!;
const langSelect = (app: App) =>
  overlay(app).all(
    (e) => e.tagName === 'SELECT' && e.children.some((o) => typeof o !== 'string' && o.value === 'auto'),
  )[0]!;
const button = (el: FakeEl, text: string) =>
  el.all((e) => e.tagName === 'BUTTON' && e.textContent.trim() === text)[0]!;

describe('web editor language', () => {
  it('config tr beats the server', async () => {
    const app = await boot({ config: { ...config, language: 'tr' }, server: 'en' });
    expect(app.html.lang).toBe('tr');
    const shown = texts(app.root);
    for (const s of ['Hazır ayarlar', 'Bileşenler', 'Önizleme', 'Genel', 'Satır 1', 'Kaydet', 'Bitir'])
      expect(shown).toContain(s);
    expect(foreign(app.root)).toEqual([]);
  });

  it('auto follows the server, then the browser', async () => {
    expect((await boot({ server: 'tr' })).html.lang).toBe('tr');
    expect((await boot({ nav: ['tr-TR'] })).html.lang).toBe('tr');
    expect((await boot({ server: 'en', nav: ['tr-TR'] })).html.lang).toBe('en');
    const app = await boot({});
    expect(app.html.lang).toBe('en');
    expect(texts(app.root)).toContain('Presets');
  });

  it('switches from Settings at once and back', async () => {
    const app = await boot({ server: 'en' });
    app.byId('settings-btn').dispatch('click');
    await flush();
    const sel = langSelect(app);
    const options = sel.children.filter((c) => typeof c !== 'string') as FakeEl[];
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ['auto', 'Auto (English)'],
      ['en', 'English'],
      ['tr', 'Türkçe'],
    ]);
    expect(sel.value).toBe('auto');

    sel.value = 'tr';
    sel.dispatch('change');
    expect(app.S().config.language).toBe('tr');
    expect(app.html.lang).toBe('tr');
    const shown = texts(app.root);
    for (const s of ['Ayarlar', 'Dil', 'Tamam', 'Kapat', 'Hazır ayarlar', 'Satır 1', 'Genel'])
      expect(shown).toContain(s);
    expect(foreign(app.root)).toEqual([]);
    const tsel = langSelect(app);
    expect(tsel.value).toBe('tr');
    expect((tsel.children[0] as FakeEl).textContent).toBe('Otomatik (English)');
    expect((tsel.children[2] as FakeEl).textContent).toBe('Türkçe');

    tsel.value = 'auto';
    tsel.dispatch('change');
    expect('language' in app.S().config).toBe(false);
    expect(app.html.lang).toBe('en');
    const back = texts(app.root);
    for (const s of ['Settings', 'Language', 'Done', 'Presets', 'Line 1', 'Global'])
      expect(back).toContain(s);
    expect(back).not.toContain('Ayarlar');
    expect(app.writes).toEqual([]);
  });

  it('undo brings the previous language back', async () => {
    const app = await boot({ server: 'en' });
    app.byId('settings-btn').dispatch('click');
    await flush();
    const sel = langSelect(app);
    sel.value = 'tr';
    sel.dispatch('change');
    expect(app.html.lang).toBe('tr');
    app.byId('undo').dispatch('click');
    expect(app.S().config.language).toBeUndefined();
    expect(app.html.lang).toBe('en');
    expect(texts(app.byId('canvas'))).toContain('Line 1');
    app.byId('redo').dispatch('click');
    expect(app.html.lang).toBe('tr');
    expect(texts(app.byId('canvas'))).toContain('Satır 1');
  });

  const importJson = async (app: Awaited<ReturnType<typeof boot>>, json: object, label: string) => {
    app.byId('import').dispatch('click');
    const dlg = overlay(app);
    const area = dlg.all((e) => e.tagName === 'TEXTAREA')[0]!;
    area.value = JSON.stringify(json);
    button(dlg, label).dispatch('click');
    await flush();
  };

  it('import keeps the current language when the config has none', async () => {
    const app = await boot({ config: { ...config, language: 'tr' }, server: 'en' });
    await importJson(app, { lines: [[{ id: 'x', type: 'git-branch' }]] }, 'İçe aktar');
    expect(app.S().config.lines[0]![0]!.type).toBe('git-branch');
    expect(app.S().config.language).toBe('tr');
    expect(app.html.lang).toBe('tr');
  });

  it('import takes the language of a config that has one, and undo brings the old one back', async () => {
    const app = await boot({ config: { ...config, language: 'tr' }, server: 'en' });
    await importJson(app, { lines: [[{ id: 'x', type: 'git-branch' }]], language: 'en' }, 'İçe aktar');
    expect(app.S().config.lines[0]![0]!.type).toBe('git-branch');
    expect(app.S().config.language).toBe('en');
    expect(app.html.lang).toBe('en');
    app.byId('undo').dispatch('click');
    expect(app.S().config.language).toBe('tr');
    expect(app.html.lang).toBe('tr');
    app.byId('redo').dispatch('click');
    expect(app.S().config.language).toBe('en');

    const auto = await boot({ config, server: 'en' });
    await importJson(auto, { lines: [[{ id: 'x', type: 'model' }]], language: 'tr' }, 'Import');
    expect(auto.S().config.language).toBe('tr');
    expect(auto.html.lang).toBe('tr');
  });

  it('preset apply keeps the current language', async () => {
    const app = await boot({ config: { ...config, language: 'tr' }, server: 'en' });
    app.byId('preset-btn').dispatch('click');
    await flush();
    const shown = app.previews.filter((c) => c.lines[0]?.[0]?.id === 'm1');
    expect(shown.length).toBe(1);
    expect(shown[0]!.language).toBe('tr');
    const card = overlay(app).all((e) => e.getAttribute('data-preset') === 'minimal')[0]!;
    card.dispatch('click');
    await flush();
    expect(app.S().config.lines[0]![0]!.type).toBe('model');
    expect(app.S().config.lines[0]![0]!.id).toBe('m1');
    expect(app.S().config.language).toBe('tr');
    expect(app.html.lang).toBe('tr');
  });

  it('the boot error is text in the browser language', async () => {
    const app = await boot({ nav: ['tr-TR'], fail: '<b>offline</b>' });
    const boot_ = app.byId('boot');
    expect(app.html.lang).toBe('tr');
    expect(texts(boot_)).toEqual([
      'Editöre ulaşılamıyor',
      '<b>offline</b>. ',
      'ccinfobar edit',
      ' komutunun yazdırdığı adresi yeniden açın.',
    ]);
    expect((boot_ as unknown as { innerHTML?: string }).innerHTML).toBeUndefined();
    const enApp = await boot({ fail: 'down' });
    expect(texts(enApp.byId('boot'))).toEqual([
      'Cannot reach the editor',
      'down. Reopen the URL printed by ',
      'ccinfobar edit',
      '.',
    ]);
  });
});
