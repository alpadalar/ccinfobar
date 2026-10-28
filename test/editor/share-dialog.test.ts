import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { FakeEl } from '../i18n/fake-dom.js';

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

type Pending = { include: boolean; resolve: (v: unknown) => void; reject: (e: Error) => void };
let body: FakeEl;
let pending: Pending[];
let stored: string[];
let openCols: number | null;

const info = (code: string, included: boolean) => ({
  code,
  chars: code.length,
  max: 1000,
  included,
  targets: [{ kind: 'command', target: 'echo hi' }],
  dropped: included ? [] : [{ kind: 'command', target: 'echo hi' }],
});

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = {
    setTimeout: () => 0,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
  };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0' });
  g.fetch = (url: string, init: { body?: string }) => {
    const b = init.body ? JSON.parse(init.body) : {};
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (url === '/api/share/open')
      return Promise.resolve(
        json({
          code: b.code,
          content: { layout: { lines: [[{ id: 'm', type: 'model' }]] } },
          cols: openCols,
          targets: [],
          unsafe: [],
        }),
      );
    return new Promise((resolve, reject) => {
      pending.push({
        include: b.includeCommands,
        resolve: (v) => resolve(json(v)),
        reject,
      });
    });
  };
});

beforeEach(() => {
  setLanguage('en');
  pending = [];
  stored = [];
  openCols = null;
  g.localStorage = { getItem: () => null, setItem: (_k: string, v: string) => stored.push(v) };
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

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

async function init() {
  const store = await import('../../src/editor/web/store.js');
  const config = defaultConfig();
  store.init({
    config: JSON.parse(JSON.stringify(config)),
    savedConfig: JSON.parse(JSON.stringify(config)),
    categories: [],
    widgets: [],
    themes: [],
    styles: [],
    styleHistory: {},
    presets: [],
    version: '1.2.3',
  } as any);
  return store;
}

const area = () => body.all((e) => e.tagName === 'TEXTAREA')[0]!;
const toggle = () => body.all((e) => e.tagName === 'INPUT' && e.type === 'checkbox')[0]!;

async function openDialog() {
  const { shareDialog } = await import('../../src/editor/web/share.js');
  void shareDialog();
  await flush();
  pending[0]!.resolve(info('A', false));
  await flush();
}

describe('share dialog include toggle (COR2-03)', () => {
  it('shows the final switch state when responses arrive out of order', async () => {
    await init();
    await openDialog();
    expect(area().value).toBe('A');
    const box = toggle();
    const change = box.listeners.get('change')![0]!;
    box.checked = true;
    change({});
    expect(box.disabled).toBe(true);
    box.checked = false;
    change({});
    expect(pending.map((p) => p.include)).toEqual([false, true, false]);
    pending[2]!.resolve(info('C', false));
    await flush();
    pending[1]!.resolve(info('B', true));
    await flush();
    expect(area().value).toBe('C');
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(toggle()).not.toBe(box);
    expect(body.all((e) => e.tagName === 'TEXTAREA' && e.value === 'B')).toEqual([]);
  });

  it('ignores a stale error', async () => {
    await init();
    await openDialog();
    const box = toggle();
    const change = box.listeners.get('change')![0]!;
    box.checked = true;
    change({});
    box.checked = false;
    change({});
    pending[2]!.resolve(info('C', false));
    await flush();
    pending[1]!.reject(new Error('late failure'));
    await flush();
    expect(area().value).toBe('C');
    expect(body.all((e) => e.classList.contains('form-error'))).toEqual([]);
  });
});

describe('opening a share code (COR2-04)', () => {
  it('previews the author width without saving it', async () => {
    const store = await init();
    openCols = 90;
    const { openShareCode } = await import('../../src/editor/web/share.js');
    await openShareCode('code');
    expect(store.S.width).toBe(90);
    expect(stored).toEqual([]);
  });
});
