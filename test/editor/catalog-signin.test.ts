import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { CatalogState } from '../../src/editor/web/store.js';
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
const ENDPOINT = 'https://market.example.com';
const FLOW = '0123456789abcdef';
const FLOW2 = 'fedcba9876543210';
const HOUR = 3_600_000;

type Call = { method: string; url: string; body: any; at: number };
type Reply = { status: number; data: unknown } | 'network';
let body: FakeEl;
let calls: Call[];
let catalog: CatalogState;
let replies: Record<string, Reply[]>;
let docKeys: ((e: unknown) => void)[];

const start = (over: Record<string, unknown> = {}) => ({
  flow: FLOW,
  userCode: 'WDJB-MJHT',
  verificationUri: 'https://github.com/login/device',
  expiresIn: 900,
  interval: 5,
  ...over,
});

const reply = (key: string, ...rs: Reply[]) => {
  replies[key] = [...(replies[key] ?? []), ...rs];
};
const ok = (data: unknown): Reply => ({ status: 200, data });
const pending = ok({ status: 'pending' });

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0' });
  g.fetch = async (url: string, init: { method: string; body?: string }) => {
    const b = init.body ? JSON.parse(init.body) : null;
    const u = String(url);
    calls.push({ method: init.method, url: u, body: b, at: Date.now() });
    const key = `${init.method} ${u.split('?')[0]}`;
    const queued = replies[key]?.shift();
    const res = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    if (queued === 'network') throw new TypeError('Failed to fetch');
    if (queued) return res(queued.status, queued.data);
    if (key === 'POST /api/catalog/login') return res(200, start());
    if (key.startsWith('GET /api/catalog/login/')) return res(200, { status: 'pending' });
    if (key.startsWith('DELETE /api/catalog/login/')) return res(200, { status: 'cancelled' });
    if (u.startsWith('/api/catalog/previews'))
      return res(200, { previews: Object.fromEntries((b.refs as string[]).map((r) => [r, [`line ${r}`]])) });
    if (u.startsWith('/api/catalog/remote')) return res(200, { endpoint: ENDPOINT, entries: [] });
    if (u.startsWith('/api/catalog')) return res(200, catalog);
    return res(200, { ok: true });
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  setLanguage('en');
  calls = [];
  replies = {};
  docKeys = [];
  catalog = {
    system: [],
    user: [],
    profile: { author: 'Ada' },
    endpoint: ENDPOINT,
    publishable: true,
    market: { endpoint: ENDPOINT, source: 'default', signedIn: false, handle: null },
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
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') docKeys.push(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') docKeys = docKeys.filter((x) => x !== fn);
    },
    activeElement: null,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => {
  Object.assign(g, saved);
  setLanguage('en');
});

async function init() {
  const store = await import('../../src/editor/web/store.js');
  const config = defaultConfig();
  store.init({
    config: clone(config),
    savedConfig: clone(config),
    categories: clone(CATEGORIES),
    widgets: [{ type: 'model', name: 'Model', description: 'Model name', category: 'session', options: [] }],
    themes: clone(listThemes(nowhere)),
    styles: clone(STYLES),
    styleHistory: {},
    presets: [],
    themesDir: nowhere,
    presetsDir: nowhere,
    version: '1.2.3',
  } as any);
  return store;
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const open = () =>
  body.children.filter(
    (c): c is FakeEl =>
      typeof c !== 'string' && c.classList.contains('overlay') && !c.classList.contains('leaving'),
  );
const top = () => open().at(-1)!;
const buttons = (root: FakeEl = top()) => root.all((e) => e.tagName === 'BUTTON');
const button = (label: string, root: FakeEl = top()) =>
  buttons(root).find((e) => e.textContent === label && !e.hidden);
const statusCalls = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/catalog/login/'));
const starts = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/catalog/login');
const cancels = () => calls.filter((c) => c.method === 'DELETE' && c.url.startsWith('/api/catalog/login/'));
const toastText = () => texts(body.children[0] as FakeEl);
const statusLine = (root: FakeEl = top()) => root.all((e) => e.classList.contains('signin-status'))[0]!;
const codeEl = (root: FakeEl = top()) => root.all((e) => e.classList.contains('signin-code'))[0]!;

async function signIn() {
  await init();
  const { signInDialog } = await import('../../src/editor/web/catalog-signin.js');
  const p = signInDialog();
  await tick();
  return { p };
}

describe('sign-in dialog', () => {
  it('shows the code and the fixed GitHub link, never the server value', async () => {
    reply('POST /api/catalog/login', ok(start({ verificationUri: 'https://evil.example/login/device' })));
    await signIn();
    const d = top();
    expect(texts(d)).toContain('Sign in with GitHub');
    expect(codeEl(d).textContent).toBe('WDJB-MJHT');
    const links = d.all((e) => e.tagName === 'A');
    expect(links).toHaveLength(1);
    const a = links[0]!;
    expect(a.getAttribute('href')).toBe('https://github.com/login/device');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')!.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    expect(a.textContent).toBe('Open github.com/login/device');
    expect(statusLine(d).textContent).toBe('Waiting for you to enter the code on GitHub…');
    expect(starts()).toHaveLength(1);
    expect(statusCalls()).toEqual([]);
  });

  it('keeps a hostile user code as text', async () => {
    reply('POST /api/catalog/login', ok(start({ userCode: '<img src=x onerror=alert(1)>' })));
    await signIn();
    expect(codeEl().textContent).toBe('<img src=x onerror=alert(1)>');
    expect(codeEl().children).toEqual(['<img src=x onerror=alert(1)>']);
  });

  it('copies the code; a failing clipboard is ignored', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await signIn();
    button('Copy code')!.dispatch('click');
    await tick();
    expect(writeText).toHaveBeenCalledWith('WDJB-MJHT');
    expect(toastText()).toContain('Code copied.');
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => Promise.reject(new Error('no')) } });
    button('Copy code')!.dispatch('click');
    await tick();
    vi.stubGlobal('navigator', undefined);
    button('Copy code')!.dispatch('click');
    await tick();
    expect(top()).toBeDefined();
  });

  it('polls at the flow interval and resolves with the handle', async () => {
    reply(
      `GET /api/catalog/login/${FLOW}`,
      pending,
      pending,
      ok({ status: 'ok', handle: 'alice', admin: false }),
    );
    const { p } = await signIn();
    const t0 = Date.now();
    await tick(4999);
    expect(statusCalls()).toEqual([]);
    await tick(1);
    expect(statusCalls()).toHaveLength(1);
    await tick(5000);
    expect(statusCalls()).toHaveLength(2);
    await tick(5000);
    expect(statusCalls().map((c) => c.at - t0)).toEqual([5000, 10000, 15000]);
    expect(statusCalls().every((c) => c.url === `/api/catalog/login/${FLOW}`)).toBe(true);
    await expect(p).resolves.toEqual({ handle: 'alice', admin: false });
    expect(toastText()).toContain('Signed in as @alice');
    await tick(HOUR);
    expect(statusCalls()).toHaveLength(3);
    expect(cancels()).toEqual([]);
  });

  it('uses a slower interval from the server', async () => {
    reply('POST /api/catalog/login', ok(start({ interval: 10 })));
    await signIn();
    await tick(9999);
    expect(statusCalls()).toEqual([]);
    await tick(1);
    expect(statusCalls()).toHaveLength(1);
  });

  it.each([
    ['Cancel', () => button('Cancel')!.dispatch('click')],
    ['Escape', () => docKeys.at(-1)!({ key: 'Escape', stopPropagation() {} })],
    ['the overlay', () => top().dispatch('pointerdown', { target: top() })],
  ])('closing with %s cancels the flow and stops polling', async (_, close) => {
    const { p } = await signIn();
    await tick(5000);
    expect(statusCalls()).toHaveLength(1);
    close();
    await expect(p).resolves.toBeNull();
    await tick();
    expect(cancels().map((c) => c.url)).toEqual([`/api/catalog/login/${FLOW}`]);
    await tick(HOUR);
    expect(statusCalls()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a flow that starts after the dialog closed', async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => {
      release = r;
    });
    const fetch = g.fetch;
    g.fetch = async (url: string, init: { method: string; body?: string }) => {
      if (url === '/api/catalog/login' && init.method === 'POST') await slow;
      return fetch(url, init);
    };
    try {
      const { p } = await signIn();
      button('Cancel')!.dispatch('click');
      await expect(p).resolves.toBeNull();
      release(null);
      await tick();
      expect(cancels().map((c) => c.url)).toEqual([`/api/catalog/login/${FLOW}`]);
      await tick(HOUR);
      expect(statusCalls()).toEqual([]);
    } finally {
      g.fetch = fetch;
    }
  });

  it('backs off on fetch errors and gives up after three in a row; Retry starts a new flow', async () => {
    reply(`GET /api/catalog/login/${FLOW}`, 'network', 'network', 'network');
    await signIn();
    const t0 = Date.now();
    await tick(5000);
    expect(statusLine().textContent).toBe('The editor server did not answer; trying again…');
    await tick(HOUR);
    expect(statusCalls().map((c) => c.at - t0)).toEqual([5000, 15000, 35000]);
    expect(statusLine().textContent).toBe('Signing in with GitHub failed. Try again later.');
    expect(statusLine().getAttribute('role')).toBe('alert');
    expect(cancels()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    reply('POST /api/catalog/login', ok(start({ flow: FLOW2, userCode: 'NEW-CODE' })));
    button('Try again')!.dispatch('click');
    await tick();
    expect(starts()).toHaveLength(2);
    expect(codeEl().textContent).toBe('NEW-CODE');
    expect(button('Try again')).toBeUndefined();
    await tick(5000);
    expect(statusCalls().at(-1)!.url).toBe(`/api/catalog/login/${FLOW2}`);
  });

  it('a good answer resets the error count', async () => {
    reply(`GET /api/catalog/login/${FLOW}`, 'network', 'network', pending, 'network', 'network', pending);
    await signIn();
    await tick(5000 + 10000 + 20000 + 5000 + 10000 + 20000);
    expect(statusCalls()).toHaveLength(6);
    expect(statusLine().textContent).toBe('Waiting for you to enter the code on GitHub…');
  });

  it.each([
    ['expired', 'The code expired. Select Try again for a new code.'],
    ['denied', 'Sign-in was denied on GitHub.'],
    ['disabled', "This marketplace's GitHub app does not allow device sign-in."],
    ['cancelled', 'Sign-in cancelled.'],
    ['failed', 'Signing in with GitHub failed. Try again later.'],
  ])('%s ends polling with its message', async (status, text) => {
    reply(`GET /api/catalog/login/${FLOW}`, pending, ok({ status }));
    const { p } = await signIn();
    await tick(10000);
    expect(statusLine().textContent).toBe(text);
    expect(button('Try again')).toBeDefined();
    await tick(HOUR);
    expect(statusCalls()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    button('Cancel')!.dispatch('click');
    await expect(p).resolves.toBeNull();
    await tick();
    expect(cancels()).toEqual([]);
  });

  it('shows the marketplace reason of a failed exchange', async () => {
    reply(
      `GET /api/catalog/login/${FLOW}`,
      ok({ status: 'failed', code: 'upstream', errorId: 'market.error.upstream' }),
    );
    await signIn();
    await tick(5000);
    expect(statusLine().textContent).toBe('The sign-in service (GitHub) is not available; try again later');
  });

  it('stops after ceil(expiresIn / interval) + 3 polls', async () => {
    reply('POST /api/catalog/login', ok(start({ expiresIn: 20 })));
    await signIn();
    await tick(HOUR);
    expect(statusCalls()).toHaveLength(7);
    expect(statusLine().textContent).toBe('The code expired. Select Try again for a new code.');
    expect(cancels()).toHaveLength(1);
  });

  it('shows a start error and offers Retry', async () => {
    reply('POST /api/catalog/login', {
      status: 409,
      data: {
        error: 'not github',
        errorId: 'err.catalog.signIn.notGithub',
        code: 'not-github',
        tokenMode: true,
      },
    });
    await signIn();
    expect(statusLine().textContent).toBe('This marketplace does not offer GitHub sign-in.');
    expect(codeEl().textContent).toBe('');
    await tick(HOUR);
    expect(statusCalls()).toEqual([]);
    button('Try again')!.dispatch('click');
    await tick();
    expect(starts()).toHaveLength(2);
  });

  it('speaks Turkish', async () => {
    setLanguage('tr');
    reply(`GET /api/catalog/login/${FLOW}`, ok({ status: 'expired' }));
    await signIn();
    const all = texts(top());
    expect(all).toEqual(
      expect.arrayContaining([
        'GitHub ile giriş yap',
        "GitHub'ı açın, bu kodu girin ve ccinfobar'a izin verin. İşiniz bitince bu pencere kendiliğinden devam eder.",
        'Kodu kopyala',
        'github.com/login/device adresini aç',
        'İptal',
      ]),
    );
    expect(statusLine().textContent).toBe("Kodu GitHub'da girmeniz bekleniyor…");
    await tick(5000);
    expect(statusLine().textContent).toBe(
      'Kodun süresi doldu. Yeni bir kod için Tekrar dene düğmesine basın.',
    );
    expect(button('Tekrar dene')).toBeDefined();
  });
});
