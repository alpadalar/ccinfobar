import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { CatalogEntryInfo, CatalogState, PublishPlanInfo } from '../../src/editor/web/store.js';
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
const needsSignIn: Reply = {
  status: 401,
  data: {
    error: 'Sign in first: ccinfobar catalog login',
    errorId: 'err.catalog.signInFirst',
    code: 'sign-in',
  },
};

const entry = (over: Partial<CatalogEntryInfo> = {}): CatalogEntryInfo => ({
  ref: 'u-w',
  source: 'user',
  id: 'u-w',
  kind: 'bundle',
  name: 'My setup',
  description: '',
  author: 'Ada',
  version: 1,
  rev: 1,
  share: { wanted: true, state: 'pending' },
  remote: null,
  updatedAt: '2026-10-16T10:00:00.000Z',
  scenario: null,
  content: { layout: { lines: [[{ id: 'm', type: 'model' }]] } },
  ...over,
});

const plan = (over: Partial<PublishPlanInfo> = {}): PublishPlanInfo => ({
  endpoint: ENDPOINT,
  planHash: 'hash-1',
  notice: 'catalog.publish.where',
  plan: [
    {
      id: 'u-w',
      rev: 1,
      name: 'My setup',
      kind: 'bundle',
      action: 'publish',
      remoteId: null,
      payload: { kind: 'bundle', slug: 'my-setup', name: 'My setup', description: '', author: 'Ada' },
    },
  ],
  skipped: [],
  ...over,
});

const signedIn = (handle: string | null = 'alice'): CatalogState => ({
  ...catalog,
  market: { endpoint: ENDPOINT, source: 'default', signedIn: true, handle },
});
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
    if (key === 'POST /api/catalog/publish/plan') return res(200, plan());
    if (key === 'POST /api/catalog/logout')
      return res(200, {
        ok: true,
        signedOut: true,
        catalog: { ...catalog, market: { ...catalog.market!, signedIn: false, handle: null } },
      });
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

const planCalls = () => calls.filter((c) => c.url === '/api/catalog/publish/plan');
const logouts = () => calls.filter((c) => c.url.split('?')[0] === '/api/catalog/logout');
const remoteCalls = () => calls.filter((c) => c.url.startsWith('/api/catalog/remote'));
const tabNames = (root: FakeEl = top()) =>
  root.all((e) => e.getAttribute('role') === 'tab').map((e) => e.textContent);
const tab = (name: string, root: FakeEl = top()) =>
  root.all((e) => e.getAttribute('role') === 'tab' && e.textContent === name)[0]!;
const chips = (root: FakeEl = top()) =>
  root.all((e) => e.classList.contains('catalog-chip')).map((e) => [e.className, e.textContent]);

async function publish(data: CatalogState = catalog) {
  await init();
  const { publishDialog } = await import('../../src/editor/web/catalog-market.js');
  const p = publishDialog(data);
  await tick();
  return { p };
}

async function openPage() {
  await init();
  const { openCatalog } = await import('../../src/editor/web/catalog.js');
  const p = openCatalog();
  await tick(50);
  return { p };
}

describe('publish dialog sign-in step', () => {
  it('asks to sign in, then reviews the plan again after sign-in', async () => {
    catalog = { ...catalog, user: [entry()] };
    reply('POST /api/catalog/publish/plan', needsSignIn);
    reply(`GET /api/catalog/login/${FLOW}`, ok({ status: 'ok', handle: 'alice', admin: false }));
    const { p } = await publish();
    const d = top();
    expect(texts(d)).toContain(
      'This marketplace takes entries only from publishers signed in with GitHub. Sign in to continue; ccinfobar keeps only the marketplace token.',
    );
    expect(button('Publish', d)).toBeUndefined();
    button('Sign in with GitHub', d)!.dispatch('click');
    await tick();
    expect(top()).not.toBe(d);
    expect(starts()).toHaveLength(1);
    await tick(5000);
    expect(top()).toBe(d);
    expect(planCalls()).toHaveLength(2);
    expect(texts(d)).toEqual(expect.arrayContaining(['New', 'My setup', 'Signed in as @alice']));
    expect(texts(d)).not.toContain(
      'This marketplace takes entries only from publishers signed in with GitHub. Sign in to continue; ccinfobar keeps only the marketplace token.',
    );
    expect(button('Publish', d)).toBeDefined();
    expect(calls.filter((c) => c.url === '/api/catalog/publish')).toEqual([]);
    button('Cancel', d)!.dispatch('click');
    const next = await p;
    expect(next).not.toBeNull();
  });

  it('stays on the sign-in step when the sign-in dialog is cancelled', async () => {
    reply('POST /api/catalog/publish/plan', needsSignIn);
    await publish();
    const d = top();
    button('Sign in with GitHub', d)!.dispatch('click');
    await tick();
    button('Cancel')!.dispatch('click');
    await tick();
    expect(top()).toBe(d);
    expect(planCalls()).toHaveLength(1);
    expect(button('Sign in with GitHub', d)).toBeDefined();
    await tick(HOUR);
    expect(statusCalls()).toEqual([]);
  });

  it('other plan errors still close with a toast', async () => {
    reply('POST /api/catalog/publish/plan', {
      status: 502,
      data: { error: 'x', errorId: 'market.error.network', code: 'network' },
    });
    const { p } = await publish();
    expect(await p).toBeNull();
    expect(open()).toEqual([]);
    expect(starts()).toEqual([]);
  });

  it('signs out from the publish dialog and reviews again', async () => {
    catalog = signedIn();
    reply('POST /api/catalog/publish/plan', ok(plan()), needsSignIn);
    await publish();
    const d = top();
    expect(texts(d)).toContain('Signed in as @alice');
    button('Sign out', d)!.dispatch('click');
    await tick();
    button('Sign out')!.dispatch('click');
    await tick();
    expect(logouts()).toHaveLength(1);
    expect(logouts()[0]!.method).toBe('POST');
    expect(planCalls()).toHaveLength(2);
    expect(texts(d)).not.toContain('Signed in as @alice');
    expect(button('Sign in with GitHub', d)).toBeDefined();
  });

  it('keeps the sign-in when the sign-out is not confirmed', async () => {
    catalog = signedIn();
    await publish();
    const d = top();
    button('Sign out', d)!.dispatch('click');
    await tick();
    button('Cancel')!.dispatch('click');
    await tick();
    expect(logouts()).toEqual([]);
    expect(texts(d)).toContain('Signed in as @alice');
  });
});

describe('catalog page marketplace state', () => {
  it('opens on the Marketplace tab for the default endpoint and reads it once', async () => {
    await openPage();
    expect(tabNames()).toEqual(['Marketplace', 'User', 'Built in']);
    expect(remoteCalls().map((c) => c.url)).toEqual(['/api/catalog/remote']);
    await tick(HOUR);
    tab('User').dispatch('click');
    await tick();
    tab('Marketplace').dispatch('click');
    await tick(HOUR);
    expect(remoteCalls()).toHaveLength(1);
  });

  it('hides the Marketplace tab when the marketplace is off', async () => {
    catalog = {
      ...catalog,
      endpoint: null,
      publishable: false,
      market: { endpoint: null, source: 'off', signedIn: false, handle: null },
    };
    await openPage();
    expect(tabNames()).not.toContain('Marketplace');
    expect(button('Publish…')).toBeUndefined();
    await tick(HOUR);
    expect(remoteCalls()).toEqual([]);
  });

  it('shows @handle and signs out from the Marketplace tab', async () => {
    catalog = signedIn();
    await openPage();
    const d = top();
    tab('Marketplace', d).dispatch('click');
    await tick();
    expect(texts(d)).toContain('Signed in as @alice');
    button('Sign out', d)!.dispatch('click');
    await tick();
    expect(texts(top())).toContain(
      `Sign out of ${ENDPOINT}? ccinfobar removes the marketplace token from this computer.`,
    );
    button('Sign out')!.dispatch('click');
    await tick();
    expect(logouts()).toHaveLength(1);
    expect(top()).toBe(d);
    expect(texts(d)).not.toContain('Signed in as @alice');
    expect(button('Sign out', d)).toBeUndefined();
    expect(toastText()).toContain(
      `Signed out of ${ENDPOINT}. The marketplace token was removed from this computer.`,
    );
  });

  it('has no account line when signed out', async () => {
    await openPage();
    tab('Marketplace').dispatch('click');
    await tick();
    expect(button('Sign out')).toBeUndefined();
    expect(texts(top()).some((x) => x.startsWith('Signed in'))).toBe(false);
  });

  it('marks entries the marketplace holds for review', async () => {
    catalog = {
      ...catalog,
      user: [
        entry({
          share: { wanted: true, state: 'published' },
          remote: { id: 'alice/my-setup', version: 1, review: 'pending' },
        }),
        entry({
          ref: 'u-2',
          id: 'u-2',
          name: 'Live one',
          share: { wanted: true, state: 'published' },
          remote: { id: 'alice/live-one', version: 2 },
        }),
      ],
    };
    await openPage();
    tab('User').dispatch('click');
    await tick();
    expect(chips()).toEqual([
      ['catalog-chip review', 'Waiting for review'],
      ['catalog-chip published', 'Published v2'],
    ]);
    const card = top().all((e) => e.getAttribute('data-ref') === 'u-w')[0]!;
    card.dispatch('click', { target: card });
    await tick();
    expect(chips()).toEqual([['catalog-chip review', 'Waiting for review']]);
  });

  it('speaks Turkish', async () => {
    setLanguage('tr');
    catalog = {
      ...signedIn(),
      user: [
        entry({
          share: { wanted: true, state: 'published' },
          remote: { id: 'alice/x', version: 1, review: 'pending' },
        }),
      ],
    };
    reply('POST /api/catalog/publish/plan', needsSignIn);
    await publish();
    const d = top();
    expect(texts(d)).toEqual(
      expect.arrayContaining([
        'Bu marketplace yalnızca GitHub ile giriş yapmış yayıncılardan girdi kabul eder. Devam etmek için giriş yapın; ccinfobar yalnızca marketplace belirtecini saklar.',
        'GitHub ile giriş yap',
      ]),
    );
    button('İptal', d)!.dispatch('click');
    await tick(200);
    await openPage();
    tab('Marketplace').dispatch('click');
    await tick();
    expect(texts(top())).toEqual(expect.arrayContaining(['@alice olarak giriş yapıldı', 'Çıkış yap']));
    tab('Kullanıcı').dispatch('click');
    await tick();
    expect(chips()).toEqual([['catalog-chip review', 'İnceleme bekliyor']]);
  });
});
