import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { CatalogEntryInfo, CatalogState, MarketSummaryInfo } from '../../src/editor/web/store.js';
import { REPORT_REASON_MAX } from '../../src/market/protocol.js';
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
const HOUR = 3_600_000;

type Call = { method: string; url: string; body: any };
type Reply = { status: number; data: unknown };
let body: FakeEl;
let calls: Call[];
let catalog: CatalogState;
let replies: Record<string, Reply[]>;

const summary = (over: Partial<MarketSummaryInfo> = {}): MarketSummaryInfo => ({
  id: 'bo/night-owl',
  kind: 'bundle',
  name: 'Night owl',
  description: 'Dark and quiet',
  author: 'Bo',
  publisher: 'bo',
  version: 3,
  updatedAt: '2026-10-16T10:00:00.000Z',
  hash: 'h3',
  ...over,
});

const targets = [
  { kind: 'link', target: 'https://example.com/docs' },
  { kind: 'command', target: 'echo <b>hi</b>' },
];

const installPlan = (over: Record<string, unknown> = {}) => ({
  id: 'bo/night-owl',
  version: 3,
  hash: 'sha-3',
  kind: 'bundle',
  name: 'Night owl',
  description: 'Dark and quiet',
  author: 'Bo',
  publisher: 'bo',
  targets,
  existing: null,
  ...over,
});

const installedEntry = (): CatalogEntryInfo => ({
  ref: 'u-n',
  source: 'user',
  id: 'u-n',
  kind: 'bundle',
  name: 'Night owl',
  description: 'Dark and quiet',
  author: 'Bo',
  version: 1,
  rev: 1,
  share: { wanted: false, state: 'local' },
  remote: null,
  origin: { endpoint: ENDPOINT, id: 'bo/night-owl', version: 3 },
  updatedAt: '2026-10-17T10:00:00.000Z',
  scenario: null,
  content: { layout: { lines: [[{ id: 'm', type: 'model' }]] } },
});

const reply = (key: string, ...rs: Reply[]) => {
  replies[key] = [...(replies[key] ?? []), ...rs];
};

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0' });
  g.fetch = async (url: string, init: { method: string; body?: string }) => {
    const b = init.body ? JSON.parse(init.body) : null;
    const u = String(url);
    calls.push({ method: init.method, url: u, body: b });
    const key = `${init.method} ${u.split('?')[0]}`;
    const queued = replies[key]?.shift();
    const res = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    if (queued) return res(queued.status, queued.data);
    if (key === 'POST /api/catalog/login')
      return res(200, {
        flow: '0123456789abcdef',
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      });
    if (key.startsWith('GET /api/catalog/login/')) return res(200, { status: 'pending' });
    if (key.startsWith('DELETE /api/catalog/login/')) return res(200, { status: 'cancelled' });
    if (key === 'POST /api/catalog/install/plan') return res(200, installPlan());
    if (key === 'POST /api/catalog/report') return res(201, { reported: true, report: 7 });
    if (key === 'GET /api/catalog/remote/bo/night-owl')
      return res(200, {
        entry: { ...summary(), versions: [] },
        latest: { version: 3, content: {}, targets },
      });
    if (u.startsWith('/api/catalog/previews'))
      return res(200, { previews: Object.fromEntries((b.refs as string[]).map((r) => [r, [`line ${r}`]])) });
    if (key === 'GET /api/catalog/remote')
      return res(200, {
        endpoint: ENDPOINT,
        entries: [summary()],
        checkedAt: '2026-10-17T08:00:00.000Z',
      });
    if (u.startsWith('/api/catalog')) return res(200, catalog);
    return res(200, { ok: true });
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  setLanguage('en');
  calls = [];
  replies = {};
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
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
});

afterEach(() => {
  vi.useRealTimers();
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
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const open = () =>
  body.children.filter(
    (c): c is FakeEl =>
      typeof c !== 'string' && c.classList.contains('overlay') && !c.classList.contains('leaving'),
  );
const top = () => open().at(-1)!;
const button = (label: string, root: FakeEl = top()) =>
  root.all((e) => e.tagName === 'BUTTON' && e.textContent === label)[0];
const footLabels = (root: FakeEl = top()) =>
  root
    .all((e) => e.tagName === 'FOOTER')[0]!
    .all((e) => e.tagName === 'BUTTON')
    .map((b) => b.textContent);
const toastText = () => texts(body.children[0] as FakeEl);
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url.split('?')[0] === path);
const tab = (id: string) => top().all((e) => e.getAttribute('data-tab') === id)[0]!;
const row = () => top().all((e) => e.classList.contains('catalog-remote-row'))[0]!;

async function openPage() {
  await init();
  const { openCatalog } = await import('../../src/editor/web/catalog.js');
  void openCatalog();
  await tick(50);
}

async function openEntry() {
  await openPage();
  row().dispatch('click');
  await tick(50);
}

describe('install from the marketplace (D-11)', () => {
  it('lists the links it keeps, posts the reviewed hash and targets, and shows the entry in User', async () => {
    reply('POST /api/catalog/install', {
      status: 200,
      data: {
        ok: true,
        entryId: 'u-n',
        name: 'Night owl',
        result: 'new',
        catalog: { ...catalog, user: [installedEntry()] },
      },
    });
    await openEntry();
    expect(footLabels()).toEqual(['Report…', 'Done', 'Install']);
    button('Install')!.dispatch('click');
    await tick(50);
    expect(posts('/api/catalog/install/plan').map((c) => c.body)).toEqual([{ id: 'bo/night-owl' }]);
    const d = top();
    expect(d.querySelector('H2')!.textContent).toBe('Install Night owl?');
    const all = texts(d);
    expect(all).toEqual(
      expect.arrayContaining([
        'Night owl',
        'Bundle',
        'v3',
        'Bo · @bo',
        'bo/night-owl',
        'It keeps these commands and URLs. Nothing runs until you apply it, and applying asks again:',
        'https://example.com/docs',
        'echo <b>hi</b>',
        'It goes to your entries in the User tab. Applying it is a separate step.',
      ]),
    );
    expect(d.all((e) => e.tagName === 'B')).toEqual([]);
    expect(posts('/api/catalog/install')).toEqual([]);
    expect(footLabels(d)).toEqual(['Cancel', 'Install']);
    button('Install', d)!.dispatch('click');
    await tick(50);
    const sent = posts('/api/catalog/install');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ id: 'bo/night-owl', version: 3, hash: 'sha-3', targets, lang: 'en' });
    expect(toastText()).toContain('Installed Night owl. Apply it from the User tab.');
    expect(open()).toHaveLength(1);
    // the Marketplace tab never shows your entries
    expect(top().all((e) => e.getAttribute('data-ref') === 'u-n')).toEqual([]);
    tab('user').dispatch('click');
    await tick(50);
    const card = top().all((e) => e.getAttribute('data-ref') === 'u-n')[0]!;
    // installed entries cannot be shared as yours
    expect(texts(card)).toContain('From the marketplace');
    const titles = card.all((e) => e.tagName === 'BUTTON').map((b) => b.getAttribute('title'));
    expect(titles).toEqual(['Apply', 'Version history', 'Delete']);
    card.dispatch('click', { target: card });
    await tick(50);
    expect(footLabels()).toEqual(['Version history', 'Delete', 'Close', 'Apply']);
  });

  it('says when nothing runs and sends nothing on Cancel', async () => {
    reply('POST /api/catalog/install/plan', { status: 200, data: installPlan({ targets: [] }) });
    await init();
    const { installDialog } = await import('../../src/editor/web/catalog-market.js');
    const p = installDialog('bo/night-owl');
    await tick(50);
    expect(texts(top())).toContain('It runs no commands and opens no URLs.');
    button('Cancel')!.dispatch('click');
    expect(await p).toBe(false);
    expect(posts('/api/catalog/install')).toEqual([]);
  });

  it('stops on a changed entry and installs only after the new review', async () => {
    const next = installPlan({
      hash: 'sha-4',
      version: 4,
      targets: [{ kind: 'link', target: 'https://example.com/new' }],
    });
    reply('POST /api/catalog/install', {
      status: 409,
      data: {
        error:
          'bo/night-owl changed on the marketplace after you reviewed it; nothing was installed. Review it again',
        errorId: 'err.catalog.install.changed',
        errorParams: { id: 'bo/night-owl' },
        code: 'changed',
        plan: next,
      },
    });
    reply('POST /api/catalog/install', {
      status: 200,
      data: { ok: true, entryId: 'u-n', name: 'Night owl', result: 'new', catalog },
    });
    await init();
    const { installDialog } = await import('../../src/editor/web/catalog-market.js');
    void installDialog('bo/night-owl');
    await tick(50);
    button('Install')!.dispatch('click');
    await tick(50);
    const d = top();
    expect(texts(d).some((x) => x.startsWith('bo/night-owl changed on the marketplace'))).toBe(true);
    expect(button('Install', d)).toBeUndefined();
    await tick(HOUR);
    expect(posts('/api/catalog/install')).toHaveLength(1);
    button('Review again', d)!.dispatch('click');
    await tick(50);
    expect(texts(d)).toContain('https://example.com/new');
    expect(texts(d)).toContain('v4');
    button('Install', d)!.dispatch('click');
    await tick(50);
    const sent = posts('/api/catalog/install');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.hash).toBe('sha-4');
    expect(sent[1]!.body.targets).toEqual([{ kind: 'link', target: 'https://example.com/new' }]);
  });

  it('offers no Install for an entry you already have', async () => {
    catalog = { ...catalog, user: [installedEntry()] };
    reply('POST /api/catalog/install/plan', {
      status: 200,
      data: installPlan({ existing: { entryId: 'u-n', same: true } }),
    });
    await init();
    const { installDialog } = await import('../../src/editor/web/catalog-market.js');
    void installDialog('bo/night-owl', { data: () => catalog, onChange() {} });
    await tick(50);
    expect(texts(top())).toContain('You already have bo/night-owl v3 as Night owl.');
    expect(footLabels()).toEqual(['Cancel']);
  });
});

describe('report from the marketplace (D-09)', () => {
  it('opens the sign-in dialog first when signed out, and sends nothing when it is cancelled', async () => {
    await openEntry();
    button('Report…')!.dispatch('click');
    await tick(50);
    expect(posts('/api/catalog/login')).toHaveLength(1);
    expect(top().querySelector('H2')!.textContent).toBe('Sign in with GitHub');
    button('Cancel')!.dispatch('click');
    await tick(50);
    expect(open()).toHaveLength(1);
    expect(posts('/api/catalog/report')).toEqual([]);
  });

  it('knows about a sign-in on the User tab and opens the report directly', async () => {
    reply('GET /api/catalog/login/0123456789abcdef', {
      status: 200,
      data: { status: 'ok', handle: 'alice', admin: false },
    });
    await openPage();
    tab('user').dispatch('click');
    await tick(50);
    catalog = { ...catalog, market: { ...catalog.market!, signedIn: true, handle: 'alice' } };
    button('Sign in with GitHub')!.dispatch('click');
    await tick(5050);
    expect(texts(top())).toContain('Signed in as @alice');
    tab('market').dispatch('click');
    await tick(50);
    row().dispatch('click');
    await tick(50);
    button('Report…')!.dispatch('click');
    await tick(50);
    expect(posts('/api/catalog/login')).toHaveLength(1);
    expect(top().querySelector('H2')!.textContent).toBe('Report Night owl');
  });

  it('refuses a reason over 200 characters and sends a short one', async () => {
    expect(REPORT_REASON_MAX).toBe(200);
    catalog = { ...catalog, market: { ...catalog.market!, signedIn: true, handle: 'alice' } };
    reply('POST /api/catalog/report', { status: 200, data: { reported: false, already: true } });
    await openEntry();
    button('Report…')!.dispatch('click');
    await tick(50);
    expect(posts('/api/catalog/login')).toEqual([]);
    const d = top();
    expect(d.querySelector('H2')!.textContent).toBe('Report Night owl');
    const area = d.querySelector('TEXTAREA')!;
    expect(area.getAttribute('maxLength')).toBe('200');
    button('Send report', d)!.dispatch('click');
    await tick(50);
    expect(texts(d)).toContain('Give a reason of 1 to 200 characters');
    area.value = 'x'.repeat(201);
    area.dispatch('input');
    expect(texts(d)).toContain('201/200');
    button('Send report', d)!.dispatch('click');
    await tick(50);
    expect(posts('/api/catalog/report')).toEqual([]);
    area.value = '  Opens a strange URL  ';
    area.dispatch('input');
    button('Send report', d)!.dispatch('click');
    await tick(50);
    expect(posts('/api/catalog/report').map((c) => c.body)).toEqual([
      { id: 'bo/night-owl', reason: 'Opens a strange URL' },
    ]);
    expect(toastText()).toContain('You already reported bo/night-owl.');
    expect(open()).toHaveLength(1);
  });

  it('confirms a report in Turkish', async () => {
    setLanguage('tr');
    catalog = { ...catalog, market: { ...catalog.market!, signedIn: true, handle: 'alice' } };
    await init();
    const { reportDialog } = await import('../../src/editor/web/catalog-market.js');
    void reportDialog('bo/night-owl', 'Night owl', { data: () => catalog, onChange() {} });
    await tick(50);
    const d = top();
    expect(texts(d)).toEqual(
      expect.arrayContaining([
        'Night owl girdisini bildir',
        'Bu girdide neyin yanlış olduğunu marketplace yöneticilerine yazın. Yöneticiler yayıncı adınızı ve bu nedeni görür.',
        'Neden',
        'İptal',
        'Bildirimi gönder',
      ]),
    );
    d.querySelector('TEXTAREA')!.value = 'Spam';
    button('Bildirimi gönder', d)!.dispatch('click');
    await tick(50);
    expect(toastText()).toContain('bo/night-owl marketplace yöneticilerine bildirildi.');
  });
});

describe('marketplace refresh (R-12)', () => {
  it('sends one refresh request and shows the new last checked time', async () => {
    reply('GET /api/catalog/remote', {
      status: 200,
      data: { endpoint: ENDPOINT, entries: [summary()], checkedAt: '2026-10-17T08:00:00.000Z' },
    });
    reply('GET /api/catalog/remote', {
      status: 200,
      data: {
        endpoint: ENDPOINT,
        entries: [summary(), summary({ id: 'bo/two', name: 'Two' })],
        checkedAt: '2026-10-17T09:30:00.000Z',
      },
    });
    await openPage();
    const remote = () => calls.filter((c) => c.url.startsWith('/api/catalog/remote'));
    expect(remote().map((c) => c.url)).toEqual(['/api/catalog/remote']);
    const checked = () => top().querySelector('.catalog-checked')!.textContent;
    const first = checked();
    expect(first.startsWith('Last checked ')).toBe(true);
    await tick(24 * HOUR);
    expect(remote()).toHaveLength(1);
    button('Refresh')!.dispatch('click');
    await tick(50);
    expect(remote().map((c) => c.url)).toEqual(['/api/catalog/remote', '/api/catalog/remote?refresh=1']);
    expect(checked()).not.toBe(first);
    expect(top().all((e) => e.classList.contains('catalog-remote-row'))).toHaveLength(2);
  });

  it('shows Refresh, Install and Report in Turkish', async () => {
    setLanguage('tr');
    await openEntry();
    expect(footLabels()).toEqual(['Bildir…', 'Tamam', 'Yükle']);
    button('Yükle')!.dispatch('click');
    await tick(50);
    const d = top();
    expect(d.querySelector('H2')!.textContent).toBe('Night owl yüklensin mi?');
    expect(texts(d)).toEqual(
      expect.arrayContaining([
        "Şu komutları ve URL'leri içerir. Siz uygulayana kadar hiçbiri çalışmaz; uygularken yeniden sorulur:",
        'Kullanıcı sekmesindeki girdilerinize eklenir. Uygulamak ayrı bir adımdır.',
      ]),
    );
    button('İptal', d)!.dispatch('click');
    await tick(50);
    expect(button('Yenile')).toBeDefined();
    expect(top().querySelector('.catalog-checked')!.textContent.startsWith('Son kontrol: ')).toBe(true);
  });
});
