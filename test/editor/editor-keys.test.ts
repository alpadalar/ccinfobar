import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl } from '../i18n/fake-dom.js';

const g = globalThis as any;
const KEYS = [
  'document',
  'HTMLElement',
  'window',
  'localStorage',
  'sessionStorage',
  'location',
  'history',
  'CSS',
];
const saved = Object.fromEntries([...KEYS, 'fetch'].map((k) => [k, g[k]]));

let byId: Map<string, FakeEl>;
let keydown: ((e: unknown) => void) | null;
let sel = '';
let docKeys: ((e: unknown) => void)[] = [];

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
      color: w.color,
      options: w.options ?? [],
      sample: w.sample,
      hidden: w.hidden ?? false,
    })),
  ),
);

const config: Config = {
  ...defaultConfig(),
  lines: [
    [
      { id: 'w1', type: 'git-branch', color: 'red', options: { icon: false } },
      { id: 'w2', type: 'model' },
    ],
    [{ id: 'w3', type: 'cost' }],
  ],
};

const state = {
  version: '1.2.3',
  configPath: '/tmp/ccinfobar/config.json',
  configError: null,
  configIssue: null,
  config,
  savedConfig: config,
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
    statusLine: null,
    installed: true,
    defaultCommand: 'ccinfobar',
    settingsFile: '/tmp/settings.json',
  },
  hooks: { installed: [], available: true, events: [], optional: [], progress: [] },
  hasLastPayload: false,
  scenarios: [],
  terminal: null,
  language: { id: 'en', source: 'LANG' },
};

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = {
    setTimeout: () => 0,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') keydown = fn;
    },
    removeEventListener() {},
    getSelection: () => ({ toString: () => sel }),
  };
  g.CSS = { escape: (s: string) => s };
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

type Store = typeof import('../../src/editor/web/store.js');
let store: Store;

beforeEach(async () => {
  byId = new Map();
  keydown = null;
  docKeys = [];
  sel = '';
  const body = new FakeEl('BODY');
  body.append(el('toasts'));
  g.document = {
    body,
    title: '',
    documentElement: new FakeEl('HTML'),
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
    getElementById: (id: string) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') docKeys.push(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') docKeys.splice(docKeys.indexOf(fn), 1);
    },
    activeElement: null,
  };
  vi.resetModules();
  await import('../../src/editor/web/app.js');
  store = await import('../../src/editor/web/store.js');
  await flush();
  await flush();
});

function press(key: string, target: FakeEl) {
  const e = {
    key,
    code: key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target,
    preventDefault: vi.fn(),
  };
  keydown!(e);
  return e;
}

const count = () => store.S.config.lines.flat().length;

function withClass(tag: string, cls: string, ...kids: FakeEl[]) {
  const e = new FakeEl(tag);
  e.className = cls;
  e.append(...kids);
  return e;
}

describe('Delete guard', () => {
  it('keeps the widget when a control has focus', () => {
    const sw = new FakeEl('BUTTON');
    sw.setAttribute('role', 'switch');
    const range = new FakeEl('INPUT');
    range.type = 'range';
    const span = new FakeEl('SPAN');
    withClass('DIV', 'inspector', span);
    const targets = [sw, range, span, new FakeEl('BUTTON')];
    for (const t of targets) {
      store.select('w1');
      press('Delete', t);
      expect(count()).toBe(3);
    }
  });

  it('removes the widget from the page body', () => {
    store.select('w1');
    press('Delete', g.document.body);
    expect(store.S.config.lines[0]!.map((i) => i.id)).toEqual(['w2']);
  });

  it('removes the widget from its own chip', () => {
    const chip = new FakeEl('DIV');
    chip.setAttribute('role', 'button');
    store.select('w2');
    press('Backspace', chip);
    expect(store.S.config.lines[0]!.map((i) => i.id)).toEqual(['w1']);
  });
});

describe('dialog focus trap', () => {
  const open = async () => {
    const { modal } = await import('../../src/editor/web/ui.js');
    const btns: any[] = [0, 1, 2].map(() => g.document.createElement('button'));
    void modal({ title: 't', titleId: 'web.ui.close', body: [], actions: () => btns });
    const overlay = g.document.body.children.at(-1) as FakeEl;
    const first = overlay.all((e) => e.tagName === 'BUTTON')[0]!;
    return { btns, first };
  };
  const tab = (shiftKey: boolean) => {
    const e = { key: 'Tab', shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const fn of [...docKeys]) fn(e);
    return e;
  };
  const esc = () => {
    const e = { key: 'Escape', preventDefault() {}, stopPropagation() {} };
    for (const fn of [...docKeys]) fn(e);
  };

  it('wraps Tab inside the topmost dialog and drops inert when the last closes', async () => {
    const a = await open();
    expect(el('app').attrs.has('inert')).toBe(true);
    g.document.activeElement = a.btns[2];
    const fwd = tab(false);
    expect(g.document.activeElement).toBe(a.first);
    expect(fwd.preventDefault).toHaveBeenCalled();
    g.document.activeElement = a.first;
    tab(true);
    expect(g.document.activeElement).toBe(a.btns[2]);

    const b = await open();
    expect(el('app').attrs.has('inert')).toBe(true);
    g.document.activeElement = b.btns[2];
    tab(false);
    expect(g.document.activeElement).toBe(b.first);
    g.document.activeElement = a.btns[2];
    tab(false);
    expect(g.document.activeElement).toBe(b.first);

    esc();
    expect(el('app').attrs.has('inert')).toBe(true);
    esc();
    expect(el('app').attrs.has('inert')).toBe(false);
  });
});
