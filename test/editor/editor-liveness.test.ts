import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { en } from '../../src/core/i18n/en/index.js';
import { scenarioList } from '../../src/core/scenarios.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl, texts } from '../i18n/fake-dom.js';

const g = globalThis as any;
const KEYS = ['document', 'HTMLElement', 'window', 'localStorage', 'sessionStorage', 'location', 'history'];
const saved = Object.fromEntries(
  [...KEYS, 'fetch', 'requestAnimationFrame', 'getComputedStyle', 'URL', 'Blob'].map((k) => [k, g[k]]),
);

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

type Call = { method: string; url: string; token?: string };
let calls: Call[];
let replaced: unknown[][];
let byId: Map<string, FakeEl>;
let body: FakeEl;
let visibility: 'visible' | 'hidden';
let visHandlers: Array<() => void>;
let keydown: ((e: unknown) => void) | null;
let failPing = false;
let failSave = false;
const MIN = 60_000;

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
  g.window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') keydown = fn;
    },
    removeEventListener() {},
  };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.sessionStorage = { getItem: () => null, setItem() {} };
  g.location = { search: '?t=abc', pathname: '/', origin: 'http://127.0.0.1:4000' };
  g.history = {
    replaceState(...a: unknown[]) {
      replaced.push(a);
    },
  };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', fontSize: '16px' });
  vi.stubGlobal('navigator', { languages: [] });
  g.fetch = async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    calls.push({ method, url: u, token: init.headers?.['x-ccinfobar-token'] });
    const res = (data: unknown) => ({ ok: true, status: 200, json: async () => clone(data) });
    const p = u.split('?')[0]!;
    if (p === '/api/ping' && failPing) throw new TypeError('Failed to fetch');
    if (p === '/api/config' && method === 'PUT' && failSave) throw new TypeError('Failed to fetch');
    if (p === '/api/state') return res(state);
    if (p === '/api/preview') return res({ lines: [], hidden: [] });
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
const pings = () => calls.filter((c) => c.url === '/api/ping');
const banners = () => el('app').children.filter((c) => typeof c !== 'string' && c.id === 'stopped-banner');

async function boot() {
  calls = [];
  replaced = [];
  byId = new Map();
  visHandlers = [];
  visibility = 'visible';
  keydown = null;
  failPing = false;
  failSave = false;
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
    addEventListener(type: string, fn: () => void) {
      if (type === 'visibilitychange') visHandlers.push(fn);
    },
    removeEventListener() {},
    activeElement: null,
    get visibilityState() {
      return visibility;
    },
  };
  vi.resetModules();
  await import('../../src/editor/web/app.js');
  await tick(1000);
}

function save() {
  keydown!({
    key: 's',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    preventDefault() {},
  });
}

describe('detached editor liveness (ROB-04)', () => {
  it('pings every five minutes while the tab is visible', async () => {
    await boot();
    expect(pings()).toHaveLength(0);
    await tick(5 * MIN + 10);
    expect(pings()).toHaveLength(1);
    await tick(5 * MIN);
    expect(pings()).toHaveLength(2);
  });

  it('a hidden tab never pings and pings once when it becomes visible', async () => {
    await boot();
    visibility = 'hidden';
    await tick(10 * MIN);
    expect(pings()).toHaveLength(0);
    visibility = 'visible';
    for (const fn of visHandlers) fn();
    await tick(0);
    expect(pings()).toHaveLength(1);
  });

  it('a failed save with a live server shows a toast and no banner', async () => {
    await boot();
    failSave = true;
    save();
    await tick(0);
    await tick(1000);
    expect(banners()).toHaveLength(0);
    expect(texts(el('toasts')).join('')).toContain(en['web.app.networkError']);
    expect(pings()).toHaveLength(1);
    await tick(5 * MIN);
    expect(pings().length).toBeGreaterThan(1);
  });

  it('a failed save with a dead server shows the stopped banner once and stops the heartbeat', async () => {
    await boot();
    failSave = true;
    failPing = true;
    save();
    await tick(0);
    expect(banners()).toHaveLength(0);
    await tick(1000);
    expect(banners()).toHaveLength(1);
    const banner = banners()[0] as FakeEl;
    expect(texts(banner)).toContain(en['web.app.stopped']);
    const button = banner.all((e) => e.tagName === 'BUTTON')[0]!;
    expect(texts(button)).toContain(en['web.app.stoppedExport']);
    expect(texts(el('toasts')).join('')).not.toContain(en['web.app.networkError']);
    const before = pings().length;
    await tick(10 * MIN);
    expect(pings()).toHaveLength(before);
  });

  it('concurrent failures share one confirm ping', async () => {
    await boot();
    failSave = true;
    failPing = true;
    save();
    save();
    await tick(0);
    await tick(1000);
    expect(pings()).toHaveLength(1);
    expect(banners()).toHaveLength(1);
  });

  it('a failed ping shows the banner once', async () => {
    await boot();
    failPing = true;
    await tick(5 * MIN + 10);
    await tick(1000);
    expect(banners()).toHaveLength(1);
    await tick(5 * MIN);
    expect(banners()).toHaveLength(1);
  });

  it('the export button downloads the config', async () => {
    await boot();
    failPing = true;
    await tick(5 * MIN + 10);
    await tick(1000);
    const button = (banners()[0] as FakeEl).all((e) => e.tagName === 'BUTTON')[0]!;
    g.Blob = class {};
    const realUrl = g.URL;
    g.URL = Object.assign(function URLStub() {}, {
      createObjectURL: vi.fn(() => 'blob:x'),
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(FakeEl.prototype, 'click');
    button.dispatch('click');
    expect(g.URL.createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    g.URL = realUrl;
  });
});

describe('token hygiene (REL2-03)', () => {
  it('cleans the url on boot and sends the token only in the header', async () => {
    await boot();
    save();
    await tick(1000);
    expect(replaced).toEqual([[null, '', '/']]);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.url).not.toMatch(/[?&]t=/);
      expect(c.token).toBe('abc');
    }
  });
});
