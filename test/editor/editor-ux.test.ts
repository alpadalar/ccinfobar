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
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
  vi.resetModules();
  await import('../../src/editor/web/app.js');
  store = await import('../../src/editor/web/store.js');
  await flush();
  await flush();
});

function card(type: string): FakeEl {
  const search = byId.get('search')!;
  search.value = type;
  search.dispatch('input');
  const found = byId.get('palette-list')!.all((e) => e.attrs.get('data-type') === type)[0];
  if (!found) throw new Error(`no card ${type}`);
  return found;
}

function press(key: string, extra: Record<string, unknown> = {}) {
  const e = {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: new FakeEl('DIV'),
    preventDefault: vi.fn(),
    ...extra,
  };
  keydown!(e);
  return e;
}

const types = (line: number) => store.S.config.lines[line]!.map((i) => i.type);
const ids = (line: number) => store.S.config.lines[line]!.map((i) => i.id);

describe('palette double-click', () => {
  it('adds the widget to the end of the active line', () => {
    card('model').dispatch('dblclick');
    expect(types(0)).toEqual(['git-branch', 'model', 'model']);
    store.undo();
    expect(types(0)).toEqual(['git-branch', 'model']);
    store.select(null, 1);
    card('model').dispatch('dblclick');
    expect(types(1)).toEqual(['cost', 'model']);
    store.undo();
    expect(types(1)).toEqual(['cost']);
  });

  it('a double click on + does not reach the card', () => {
    const add = card('model').all((e) => e.className === 'add-btn')[0]!;
    const stop = vi.fn();
    add.dispatch('dblclick', { target: add, stopPropagation: stop, preventDefault() {} });
    expect(stop).toHaveBeenCalled();
    add.dispatch('click');
    expect(types(0)).toEqual(['git-branch', 'model', 'model']);
  });

  it('marks the active line', () => {
    store.select(null, 1);
    const rows = byId.get('canvas')!.all((e) => e.attrs.has('data-line'));
    expect(rows.map((r) => r.attrs.get('aria-current') ?? null)).toEqual([null, 'true']);
    expect(rows[1]!.classList.contains('selected')).toBe(true);
  });
});

describe('widget copy, paste and duplicate', () => {
  it('Ctrl+C then Ctrl+V pastes a full copy after the selected chip', () => {
    store.select('w1');
    const c = press('c');
    expect(c.preventDefault).toHaveBeenCalled();
    expect(store.S.itemClip).toEqual({ type: 'git-branch', color: 'red', options: { icon: false } });
    const v = press('v');
    expect(v.preventDefault).toHaveBeenCalled();
    expect(ids(0)).toEqual(['w1', 'git-branch-1', 'w2']);
    expect(store.S.config.lines[0]![1]).toEqual({
      id: 'git-branch-1',
      type: 'git-branch',
      color: 'red',
      options: { icon: false },
    });
    expect(store.S.selectedId).toBe('git-branch-1');
    store.undo();
    expect(ids(0)).toEqual(['w1', 'w2']);
  });

  it('works with the meta key', () => {
    store.select('w2');
    press('c', { ctrlKey: false, metaKey: true });
    press('v', { ctrlKey: false, metaKey: true });
    expect(types(0)).toEqual(['git-branch', 'model', 'model']);
  });

  it('pastes at the end of the active line when nothing is selected', () => {
    store.select('w1');
    press('c');
    store.select(null, 1);
    press('v');
    expect(types(1)).toEqual(['cost', 'git-branch']);
  });

  it('Ctrl+D duplicates the selected chip after itself', () => {
    store.select('w3');
    const d = press('d');
    expect(d.preventDefault).toHaveBeenCalled();
    expect(ids(1)).toEqual(['w3', 'cost-1']);
    expect(store.S.itemClip).toBeNull();
    store.undo();
    expect(ids(1)).toEqual(['w3']);
  });

  it('leaves text fields and page selections alone', () => {
    store.select('w1');
    press('c');
    const before = JSON.stringify(store.S.config);
    const input = new FakeEl('INPUT');
    input.type = 'text';
    const editable = Object.assign(new FakeEl('DIV'), { isContentEditable: true });
    for (const target of [input, new FakeEl('TEXTAREA'), editable]) {
      for (const k of ['c', 'v', 'd']) {
        const e = press(k, { target });
        expect(e.preventDefault).not.toHaveBeenCalled();
      }
    }
    expect(JSON.stringify(store.S.config)).toBe(before);
    store.S.itemClip = null;
    sel = 'some text';
    const e = press('c');
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(store.S.itemClip).toBeNull();
  });

  it('Ctrl+Alt+C still copies only the style', () => {
    store.select('w1');
    const e = press('c', { key: 'ç', code: 'KeyC', altKey: true });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(store.S.clip?.type).toBe('git-branch');
    expect(store.S.itemClip).toBeNull();
  });
});
