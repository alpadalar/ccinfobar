import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { scenarioText } from '../../src/core/i18n/catalog-text.js';
import { editorMessages as en } from '../../src/core/i18n/en/editor.js';
import { withLanguage } from '../../src/core/i18n/index.js';
import { editorMessages as tr } from '../../src/core/i18n/tr/editor.js';
import { scenarioList } from '../../src/core/scenarios.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl, texts } from './fake-dom.js';

const g = globalThis as any;
const KEYS = ['document', 'HTMLElement', 'window', 'localStorage', 'sessionStorage', 'location', 'history'];
const saved = Object.fromEntries([...KEYS, 'fetch'].map((k) => [k, g[k]]));

let byId: Map<string, FakeEl>;
let body: FakeEl;

function el(id: string): FakeEl {
  let e = byId.get(id);
  if (!e) {
    e = new FakeEl('DIV');
    e.id = id;
    if (id === 'dirty') e.append(new FakeEl('SPAN'));
    if (id === 'theme-btn') {
      const label = new FakeEl('SPAN');
      label.className = 'theme-btn-label';
      e.append(label);
    }
    byId.set(id, e);
  }
  return e;
}

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

const config: Config = {
  ...defaultConfig(),
  lines: [
    [
      { id: 'w1', type: 'git-branch', merge: true },
      { id: 'w2', type: 'model' },
    ],
    [],
  ],
  lineAlign: [null, 'center'],
};

const state = {
  version: '1.2.3',
  configPath: '/tmp/ccinfobar/config.json',
  configError: 'bad value at lines',
  configIssue: null,
  config,
  savedConfig: { ...config, lines: [] },
  widgets,
  categories: JSON.parse(JSON.stringify(CATEGORIES)),
  presets: [],
  presetsDir: '/tmp/presets',
  styleHistory: {},
  gsdInstalled: false,
  themes: JSON.parse(JSON.stringify(listThemes(path.join(__dirname, 'no-such-themes-dir')))),
  styles: JSON.parse(JSON.stringify(STYLES)),
  themesDir: '/tmp/themes',
  claude: {
    statusLine: { command: 'ccinfobar', refreshInterval: 5 },
    installed: true,
    defaultCommand: 'ccinfobar',
    settingsFile: '/tmp/settings.json',
  },
  hooks: { installed: [], available: true, events: [], optional: [], progress: [] },
  hasLastPayload: false,
  scenarios: scenarioList(),
  terminal: null,
};

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.sessionStorage = { getItem: () => null, setItem() {} };
  g.location = { search: '', pathname: '/' };
  g.history = { replaceState() {} };
  g.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(state)) });
  vi.stubGlobal('navigator', { languages: [] });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  vi.unstubAllGlobals();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function boot(lang: 'en' | 'tr'): Promise<{ shown: () => string[]; title: () => string }> {
  byId = new Map();
  body = new FakeEl('BODY');
  const toasts = el('toasts');
  body.append(toasts);
  const doc = {
    body,
    title: '',
    documentElement: new FakeEl('HTML'),
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
    getElementById: (id: string) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
  g.document = doc;
  vi.resetModules();
  // the app takes its language from /api/state
  (state as Record<string, unknown>).language = { id: lang, source: 'LANG' };
  await import('../../src/editor/web/app.js');
  await flush();
  await flush();
  return {
    shown: () => [...byId.values(), body].flatMap((e) => texts(e)),
    title: () => doc.title,
  };
}

const english = new Set<string>(
  Object.entries(en)
    .filter(([id, v]) => (tr as Record<string, unknown>)[id] !== v)
    .flatMap(([, v]) => (typeof v === 'string' ? [v] : [v.one, v.other])),
);
const foreign = (list: string[]) => list.filter((s) => english.has(s));

describe('web app shell text', () => {
  it('boots in Turkish without English shell text', async () => {
    const app = await boot('tr');
    const list = app.shown();
    expect(app.title()).toBe('● ccinfobar editörü');
    for (const s of [
      'Satır 1',
      'Satır 2',
      '2 bileşen',
      '0 bileşen',
      'Kaydedilmemiş değişiklikler',
      'Yapılandırma sorunu: bad value at lines',
      'Bileşenleri buraya sürükleyin ya da paletteki + düğmesine basın',
      'Sonrakiyle birleşik',
      'Ortalı. Genel hizalamaya dönmek için tıklayın',
      'Bu satırı sola hizala',
      "Henüz kaydedilmiş bir oturum payload'ı yok",
      'v1.2.3',
    ])
      expect(list).toContain(s);
    expect(list.some((s) => /, satır 1, konum 1$/.test(s))).toBe(true);
    expect(foreign(list)).toEqual([]);
  });

  it('shows the scenario labels and descriptions from the catalog', async () => {
    const app = await boot('tr');
    const list = app.shown();
    const s = scenarioList()[0]!;
    const label = withLanguage('tr', () => scenarioText(s, 'label'));
    const description = withLanguage('tr', () => scenarioText(s, 'description'));
    expect(label).not.toBe(s.label);
    expect(list).toContain(label);
    expect(list).toContain(description);
    const option = byId.get('src-scenario')!.children.find((c) => typeof c !== 'string') as FakeEl;
    expect(option.getAttribute('value') ?? (option as any).value).toBe(s.id);
  });

  it('translates search, import and close dialogs', async () => {
    await boot('tr');
    const search = byId.get('search')!;
    search.value = 'zzqx';
    search.dispatch('input');
    expect(texts(byId.get('palette-list')!)).toContain('"zzqx" ile eşleşen bileşen yok');
    byId.get('import')!.dispatch('click');
    byId.get('done')!.dispatch('click');
    const list = texts(body);
    for (const s of [
      'Yapılandırmayı içe aktar',
      'Dosyadan',
      'İçe aktar',
      'İptal',
      'Kaydedilmemiş değişiklikler silinsin mi?',
      'Kaydetmeden kapat',
    ])
      expect(list).toContain(s);
    expect(foreign(list)).toEqual([]);
  });

  it('keeps the English text', async () => {
    const app = await boot('en');
    const list = app.shown();
    expect(app.title()).toBe('● ccinfobar editor');
    for (const s of [
      'Line 1',
      '2 widgets',
      '0 widgets',
      'Unsaved changes',
      'Config problem: bad value at lines',
      'Drag widgets here, or press + in the palette',
      'Merged with next',
      'Aligned center. Click to follow the global alignment',
      'Align this line left',
      'Drag to reorder line',
      'Delete line 1',
      'No session payload recorded yet',
      'Will write: ccinfobar',
      'Claude Code runs: ccinfobar\nSaved changes show up on its next refresh. Settings: Global tab.',
    ])
      expect(list).toContain(s);
    expect(list.some((s) => /, line 1, position 1$/.test(s))).toBe(true);
    const sc = scenarioList()[0]!;
    expect(list).toContain(sc.label);
  });
});
