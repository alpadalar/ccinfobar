import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { scenarioList } from '../../src/core/scenarios.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { CatalogState } from '../../src/editor/web/store.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl } from '../i18n/fake-dom.js';

// R-11: the editor page sends marketplace requests only on explicit actions
const g = globalThis as any;
const KEYS = ['document', 'HTMLElement', 'window', 'localStorage', 'sessionStorage', 'location', 'history'];
const saved = Object.fromEntries(
  [...KEYS, 'fetch', 'requestAnimationFrame', 'getComputedStyle'].map((k) => [k, g[k]]),
);
const ENDPOINT = 'https://market.example.com';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MARKET = [
  '/api/catalog/remote',
  '/api/catalog/login',
  '/api/catalog/install',
  '/api/catalog/report',
  '/api/catalog/publish',
];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const widgets = clone(
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
);
const config = defaultConfig();
const state = {
  version: '1.2.3',
  configPath: path.join(__dirname, 'no-such-dir', 'config.json'),
  configError: null,
  configIssue: null,
  config,
  savedConfig: config,
  widgets,
  categories: clone(CATEGORIES),
  presets: [],
  presetsDir: path.join(__dirname, 'no-such-dir'),
  styleHistory: {},
  gsdInstalled: false,
  themes: clone(listThemes(path.join(__dirname, 'no-such-dir'))),
  styles: clone(STYLES),
  themesDir: path.join(__dirname, 'no-such-dir'),
  claude: { statusLine: null, installed: false, defaultCommand: 'ccinfobar', settingsFile: 'settings.json' },
  hooks: { installed: [], available: true, events: [], optional: [], progress: [] },
  hasLastPayload: false,
  scenarios: scenarioList(),
  terminal: null,
  language: { id: 'en', source: 'LANG' },
};
const catalog: CatalogState = {
  system: [],
  user: [],
  profile: { author: 'Ada' },
  endpoint: ENDPOINT,
  publishable: true,
  market: { endpoint: ENDPOINT, source: 'default', signedIn: true, handle: 'alice' },
};

type Call = { method: string; url: string };
let calls: Call[];
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

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  g.HTMLElement = FakeEl;
  // the page's own timers run on the fake clock too
  g.window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.sessionStorage = { getItem: () => null, setItem() {} };
  g.location = { search: '?t=abc', pathname: '/', origin: 'http://127.0.0.1:4000' };
  g.history = { replaceState() {} };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', fontSize: '16px' });
  vi.stubGlobal('navigator', { languages: [] });
  g.fetch = async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    calls.push({ method, url: u });
    const res = (data: unknown) => ({ ok: true, status: 200, json: async () => clone(data) });
    const p = u.split('?')[0]!;
    if (p === '/api/state') return res(state);
    if (p === '/api/preview') return res({ lines: [], hidden: [] });
    if (p === '/api/catalog/previews') return res({ previews: {} });
    if (p === '/api/catalog/remote')
      return res({ endpoint: ENDPOINT, entries: [], checkedAt: '2026-10-17T08:00:00.000Z' });
    if (p === '/api/catalog/login' && method === 'POST')
      return res({
        flow: '0123456789abcdef',
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      });
    if (p.startsWith('/api/catalog/login/'))
      return res({ status: method === 'DELETE' ? 'cancelled' : 'pending' });
    if (p === '/api/catalog') return res(catalog);
    return res({ ok: true });
  };
});

afterEach(() => {
  vi.clearAllTimers();
});

afterAll(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  vi.unstubAllGlobals();
});

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const market = () => calls.filter((c) => MARKET.some((m) => c.url.startsWith(m)));
// relative paths stay on the editor origin
const foreign = () => calls.filter((c) => !c.url.startsWith('/'));
const tabs = () => body.all((e) => e.getAttribute('role') === 'tab');
const dialogs = () =>
  body.children.filter(
    (c): c is FakeEl =>
      typeof c !== 'string' && c.classList.contains('overlay') && !c.classList.contains('leaving'),
  );

async function boot() {
  calls = [];
  byId = new Map();
  body = new FakeEl('BODY');
  body.append(el('toasts'));
  g.document = {
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
  vi.resetModules();
  await import('../../src/editor/web/app.js');
  await tick(1000);
}

describe('editor page left idle with a marketplace endpoint (R-11)', () => {
  it('sends nothing to the marketplace for 24 h, and the Marketplace page reads the list once', async () => {
    await boot();
    expect(calls.map((c) => c.url)).toContain('/api/state');
    expect(market()).toEqual([]);
    calls = [];
    await tick(DAY);
    expect(market()).toEqual([]);
    expect(foreign()).toEqual([]);
    expect(calls).toEqual([]);

    el('catalog-btn').dispatch('click');
    await tick(1000);
    expect(tabs().map((x) => x.textContent)).toEqual(['Bundles', 'Presets', 'Themes', 'User', 'Built in']);
    expect(market().map((c) => c.url)).toEqual(['/api/catalog/remote']);
    await tick(DAY);
    for (const i of [1, 2, 3, 4, 0, 2, 3, 0]) {
      tabs()[i]!.dispatch('click');
      await tick(HOUR);
    }
    await tick(DAY);
    expect(market().map((c) => c.url)).toEqual(['/api/catalog/remote']);
    expect(foreign()).toEqual([]);
  });

  it('asks no sign-in status after the sign-in dialog is closed', async () => {
    await boot();
    const { signInDialog } = await import('../../src/editor/web/catalog-signin.js');
    calls = [];
    const p = signInDialog();
    await tick(50);
    const login = () => market().filter((c) => c.url.startsWith('/api/catalog/login'));
    expect(login().map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/catalog/login']);
    await tick(5000);
    expect(login().filter((c) => c.method === 'GET')).toHaveLength(1);
    const d = dialogs().at(-1)!;
    d.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Cancel')[0]!.dispatch('click');
    expect(await p).toBeNull();
    await tick(50);
    const after = calls.length;
    expect(login().filter((c) => c.method === 'DELETE')).toHaveLength(1);
    await tick(HOUR);
    expect(calls.slice(after)).toEqual([]);
    expect(login().filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(foreign()).toEqual([]);
  });
});
