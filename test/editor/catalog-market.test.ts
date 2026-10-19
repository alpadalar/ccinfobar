import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type {
  CatalogEntryInfo,
  CatalogState,
  MarketEntryInfo,
  MarketSummaryInfo,
  PublishPlanInfo,
} from '../../src/editor/web/store.js';
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

type Call = { method: string; url: string; body: any };
type Reply = { status: number; data: unknown };
let body: FakeEl;
let calls: Call[];
let catalog: CatalogState;
let replies: Record<string, Reply[]>;

const entry = (over: Partial<CatalogEntryInfo>): CatalogEntryInfo => ({
  ref: 'u-1',
  source: 'user',
  id: 'u-1',
  kind: 'bundle',
  name: 'Mine',
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

const waiting = () => entry({ ref: 'u-w', id: 'u-w', name: 'My setup' });
const local = () =>
  entry({ ref: 'u-l', id: 'u-l', name: 'Local one', share: { wanted: false, state: 'local' } });

const content = { layout: { lines: [[{ id: 'm', type: 'model' }]] } };
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
      payload: {
        kind: 'bundle',
        slug: 'my-setup',
        name: 'My setup',
        description: 'Two lines',
        author: 'Ada',
        content,
        note: '',
      },
    },
    {
      id: 'u-o',
      rev: 4,
      name: 'Old one',
      kind: 'preset',
      action: 'withdraw',
      remoteId: 'ada/old-one',
      payload: null,
    },
  ],
  skipped: [],
  ...over,
});

const summary = (over: Partial<MarketSummaryInfo> = {}): MarketSummaryInfo => ({
  id: 'ada/my-setup',
  kind: 'bundle',
  name: 'My setup',
  description: 'Two lines',
  author: 'Ada',
  publisher: 'ada',
  version: 2,
  updatedAt: '2026-10-16T10:00:00.000Z',
  hash: 'h',
  ...over,
});

const remoteEntry = (over: Partial<MarketEntryInfo> = {}): MarketEntryInfo => ({
  ...summary(),
  versions: [
    { version: 1, at: '2026-10-15T09:30:00.000Z', note: 'first', hash: 'a' },
    { version: 2, at: '2026-10-16T09:30:00.000Z', note: 'second', hash: 'b' },
  ],
  ...over,
});

const reply = (key: string, status: number, data: unknown) => {
  replies[key] = [...(replies[key] ?? []), { status, data }];
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
    if (u.startsWith('/api/catalog/previews'))
      return res(200, { previews: Object.fromEntries((b.refs as string[]).map((r) => [r, [`line ${r}`]])) });
    if (u.startsWith('/api/catalog/publish/plan')) return res(200, plan());
    if (u.startsWith('/api/catalog/remote/previews'))
      return res(200, {
        previews: Object.fromEntries((b.ids as string[]).map((id) => [id, [`line ${id}`]])),
      });
    if (u.startsWith('/api/catalog/remote/')) return res(200, { entry: remoteEntry(), latest: null });
    if (u.startsWith('/api/catalog/remote')) return res(200, { endpoint: ENDPOINT, entries: [] });
    if (u.startsWith('/api/catalog')) return res(200, catalog);
    return res(200, { ok: true });
  };
});

beforeEach(() => {
  setLanguage('en');
  calls = [];
  replies = {};
  catalog = {
    system: [],
    user: [waiting(), local()],
    profile: { author: 'Ada' },
    endpoint: null,
    publishable: false,
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

afterAll(() => {
  Object.assign(g, saved);
  setLanguage('en');
});

const online = () => {
  catalog = { ...catalog, endpoint: ENDPOINT, publishable: true };
};

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

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const open = () =>
  body.children.filter(
    (c): c is FakeEl =>
      typeof c !== 'string' && c.classList.contains('overlay') && !c.classList.contains('leaving'),
  );
const top = () => open().at(-1)!;
const buttons = (root: FakeEl = top()) => root.all((e) => e.tagName === 'BUTTON');
const button = (label: string, root: FakeEl = top()) => buttons(root).find((e) => e.textContent === label);
const foot = (root: FakeEl = top()) => root.all((e) => e.tagName === 'FOOTER')[0]!;
const marketCalls = () =>
  calls.filter((c) => c.url.startsWith('/api/catalog/publish') || c.url.startsWith('/api/catalog/remote'));
const sends = () => calls.filter((c) => c.url === '/api/catalog/publish');
const pres = (root: FakeEl = top()) => root.all((e) => e.tagName === 'PRE');
const toastText = () => texts(body.children[0] as FakeEl);

async function openPage() {
  const { openCatalog } = await import('../../src/editor/web/catalog.js');
  const p = openCatalog();
  await flush();
  return { p };
}

async function publish(data: CatalogState = catalog, refs?: string[]) {
  const { publishDialog } = await import('../../src/editor/web/catalog-market.js');
  const p = publishDialog(data, refs);
  await flush();
  return { p };
}

describe('no marketplace endpoint', () => {
  it('shows no Publish button or Marketplace tab, only the waiting hint, and sends nothing', async () => {
    await init();
    await openPage();
    const d = top();
    expect(button('Publish…', foot(d))).toBeUndefined();
    const tabs = d.all((e) => e.getAttribute('role') === 'tab').map((e) => e.textContent);
    expect(tabs).toEqual(['User', 'Built in']);
    expect(texts(d)).toContain(
      'Shared entries wait to publish. Nothing is sent until you set a marketplace with ccinfobar catalog endpoint <url>.',
    );
    expect(texts(d)).toContain('Waiting to publish');
    expect(marketCalls()).toEqual([]);
  });

  it('has no hint when nothing waits', async () => {
    catalog = { ...catalog, user: [local()] };
    await init();
    await openPage();
    expect(texts(top()).some((x) => x.startsWith('Shared entries wait'))).toBe(false);
    expect(marketCalls()).toEqual([]);
  });

  it('marketplaceSection is null', async () => {
    await init();
    const { marketplaceSection } = await import('../../src/editor/web/catalog-market.js');
    expect(marketplaceSection(catalog)).toBeNull();
    expect(marketCalls()).toEqual([]);
  });
});

describe('publish review', () => {
  it('opens from the footer and shows the endpoint and the exact payload', async () => {
    online();
    await init();
    await openPage();
    expect(texts(top())).not.toContain(
      'Shared entries wait to publish. Nothing is sent until you set a marketplace with ccinfobar catalog endpoint <url>.',
    );
    button('Publish…', foot())!.dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/publish/plan').map((c) => c.body)).toEqual([{}]);
    const d = top();
    const all = texts(d);
    expect(all).toContain('Publish to marketplace');
    expect(all).toContain(
      `This sends the entries above to ${ENDPOINT}. It runs because you asked, even if CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.`,
    );
    expect(all).toEqual(
      expect.arrayContaining(['New', 'My setup', 'Bundle', 'Withdraw', 'Old one', 'Preset']),
    );
    expect(all).toContain('ada/old-one');
    expect(all).toContain('Only the withdraw request is sent.');
    const [json] = pres(d);
    expect(json!.textContent).toBe(JSON.stringify(plan().plan[0]!.payload, null, 2));
    expect(json!.textContent).toContain('"author": "Ada"');
    expect(json!.textContent).not.toContain('budget');
    expect(sends()).toEqual([]);
  });

  it('sends nothing on Cancel', async () => {
    online();
    await init();
    const { p } = await publish();
    button('Cancel')!.dispatch('click');
    expect(await p).toBeNull();
    await flush();
    expect(sends()).toEqual([]);
  });

  it('sends the refs and the planHash as received, then shows each result', async () => {
    online();
    await init();
    setLanguage('tr');
    const next = { ...catalog, user: [entry({ ...waiting(), share: { wanted: true, state: 'published' } })] };
    reply('POST /api/catalog/publish/plan', 200, plan({ planHash: 'abc123' }));
    reply('POST /api/catalog/publish', 200, {
      ok: true,
      code: null,
      results: [
        { id: 'u-w', ok: true, code: null, remoteId: 'ada/my-setup', version: 1, errorId: null },
        {
          id: 'u-o',
          ok: false,
          code: 'network',
          remoteId: 'ada/old-one',
          version: null,
          errorId: 'market.error.network',
        },
      ],
      catalog: next,
    });
    const { p } = await publish(catalog, ['u-w', 'u-o']);
    expect(calls.find((c) => c.url === '/api/catalog/publish/plan')!.body).toEqual({ refs: ['u-w', 'u-o'] });
    button('Yayımla')!.dispatch('click');
    await flush();
    expect(sends().map((c) => c.body)).toEqual([
      { refs: ['u-w', 'u-o'], confirm: true, planHash: 'abc123', lang: 'tr' },
    ]);
    const all = texts(top());
    expect(all).toContain('My setup v1, ada/my-setup olarak yayımlandı');
    expect(all).toContain("Old one: Marketplace'e ulaşılamadı");
    expect(button('Yayımla')).toBeUndefined();
    button('Tamam')!.dispatch('click');
    expect(await p).toEqual(next);
  });

  it('shows a withdraw result and the reserved note', async () => {
    online();
    await init();
    reply('POST /api/catalog/publish', 200, {
      ok: true,
      code: null,
      results: [
        {
          id: 'u-w',
          ok: false,
          code: 'withdrawn',
          remoteId: null,
          version: null,
          errorId: 'market.error.withdrawn',
        },
        { id: 'u-o', ok: true, code: null, remoteId: 'ada/old-one', version: null, errorId: null },
      ],
      catalog,
    });
    await publish();
    button('Publish')!.dispatch('click');
    await flush();
    const all = texts(top());
    expect(all).toContain('Withdrew Old one (ada/old-one)');
    expect(all.some((x) => x.startsWith('My setup was withdrawn from the marketplace'))).toBe(true);
  });

  it('shows the new plan on planChanged and does not send again by itself', async () => {
    online();
    await init();
    const changed = plan({
      planHash: 'hash-2',
      plan: [
        {
          ...plan().plan[0]!,
          name: 'Renamed',
          payload: { ...(plan().plan[0]!.payload as object), name: 'Renamed' },
        },
      ],
    });
    reply('POST /api/catalog/publish', 409, {
      error: 'The entries changed since you reviewed them; review again',
      errorId: 'err.catalog.planChanged',
      ...changed,
    });
    await publish();
    button('Publish')!.dispatch('click');
    await flush();
    expect(sends()).toHaveLength(1);
    const all = texts(top());
    expect(all).toContain('The entries changed since you opened this. Check them again, then publish.');
    expect(all).toContain('Renamed');
    expect(all).not.toContain('Old one');
    expect(pres()[0]!.textContent).toContain('"name": "Renamed"');
    button('Publish')!.dispatch('click');
    await flush();
    expect(sends().map((c) => c.body.planHash)).toEqual(['hash-1', 'hash-2']);
  });

  it('says nothing waits and offers no send on an empty plan', async () => {
    online();
    await init();
    reply('POST /api/catalog/publish/plan', 200, plan({ plan: [] }));
    await publish();
    expect(texts(top())).toContain('Nothing is waiting to publish.');
    expect(button('Publish')).toBeUndefined();
  });

  it('shows the read-only answer', async () => {
    online();
    await init();
    reply('POST /api/catalog/publish', 200, {
      ok: true,
      code: 'read-only',
      submitUrl: 'https://example.com/submit',
      results: [],
      catalog,
    });
    await publish();
    button('Publish')!.dispatch('click');
    await flush();
    expect(texts(top())).toContain(
      'This marketplace is read-only. Submit your entries at https://example.com/submit instead.',
    );
  });

  it('shows a read-only review without a Publish button, and the first-publish registration', async () => {
    online();
    await init();
    reply(
      'POST /api/catalog/publish/plan',
      200,
      plan({ code: 'read-only', submitUrl: 'https://example.com/submit', plan: [] }),
    );
    await publish();
    expect(texts(top())).toContain(
      'This marketplace is read-only. Submit your entries at https://example.com/submit instead.',
    );
    expect(button('Publish')).toBeUndefined();
    button('Cancel')!.dispatch('click');
    await flush();
    reply(
      'POST /api/catalog/publish/plan',
      200,
      plan({ registration: { handle: 'ada', displayName: 'Ada L' } }),
    );
    await publish();
    expect(texts(top())).toContain(
      'The first publish to this marketplace registers the publisher handle @ada, shown as Ada L.',
    );
  });

  it('changes the handle a first publish registers and shows the new plan (WR-06)', async () => {
    online();
    await init();
    reply(
      'POST /api/catalog/publish/plan',
      200,
      plan({ registration: { handle: 'ada', displayName: 'Ada' } }),
    );
    reply(
      'POST /api/catalog/publisher',
      200,
      plan({ planHash: 'hash-2', registration: { handle: 'ada-l', displayName: 'Ada' } }),
    );
    await publish();
    const d = top();
    const field = d.all((e) => e.tagName === 'INPUT' && e.value === 'ada')[0]!;
    field.value = 'ada-l';
    button('Use this handle')!.dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/publisher').map((c) => c.body)).toEqual([
      { handle: 'ada-l' },
    ]);
    expect(texts(top())).toContain(
      'The first publish to this marketplace registers the publisher handle @ada-l, shown as Ada.',
    );
    button('Publish')!.dispatch('click');
    await flush();
    expect(sends().map((c) => c.body.planHash)).toEqual(['hash-2']);
  });

  it('keeps the dialog open with a translated error when sending fails', async () => {
    online();
    await init();
    setLanguage('tr');
    reply('POST /api/catalog/publish', 502, {
      error: 'Could not reach the marketplace',
      errorId: 'market.error.network',
      code: 'network',
    });
    await publish();
    button('Yayımla')!.dispatch('click');
    await flush();
    expect(texts(top())).toContain("Marketplace'e ulaşılamadı");
    expect(button('Yayımla')).toBeDefined();
  });

  it('shows names and payloads as text, with invisible characters escaped', async () => {
    online();
    await init();
    const evil = '<script>alert(1)</script>';
    reply(
      'POST /api/catalog/publish/plan',
      200,
      plan({
        plan: [
          {
            ...plan().plan[0]!,
            name: evil,
            payload: { name: evil, description: 'a\u202eb', content },
          },
        ],
      }),
    );
    await publish();
    const d = top();
    expect(d.all((e) => e.tagName === 'SCRIPT')).toEqual([]);
    expect(texts(d)).toContain(evil);
    const json = pres(d)[0]!.textContent;
    expect(json).toContain('\\u202e');
    expect(json).not.toContain('\u202e');
    expect(JSON.parse(json)).toEqual({ name: evil, description: 'a\u202eb', content });
  });
});

describe('marketplace tab', () => {
  it('opens first and lists only the remote entries with author, publisher and version', async () => {
    online();
    reply('GET /api/catalog/remote', 200, {
      endpoint: ENDPOINT,
      entries: [
        summary(),
        summary({ id: 'bo/gone', name: 'Gone', author: '', publisher: 'bo', withdrawn: true }),
      ],
    });
    await init();
    await openPage();
    const d = top();
    const tabs = d.all((e) => e.getAttribute('role') === 'tab');
    expect(tabs.map((e) => e.textContent)).toEqual(['Bundles', 'Presets', 'Themes', 'User', 'Built in']);
    expect(calls.filter((c) => c.url === '/api/catalog/remote')).toHaveLength(1);
    const sections = d.all((e) => e.tagName === 'SECTION').map((e) => e.getAttribute('data-section'));
    expect(sections).toEqual(['market']);
    expect(d.all((e) => e.getAttribute('data-ref') === 'u-w')).toEqual([]);
    const rows = d.all((e) => e.classList.contains('catalog-remote-row'));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.parent!.classList.contains('catalog-grid'))).toBe(true);
    expect(rows.every((r) => r.classList.contains('catalog-card'))).toBe(true);
    expect(rows[0]!.getAttribute('title')).toBe('Details of My setup');
    expect(texts(rows[0]!)).toEqual(expect.arrayContaining(['My setup', 'Bundle', 'v2', 'Ada · @ada']));
    expect(texts(rows[1]!)).toEqual(expect.arrayContaining(['Gone', '@bo', 'Withdrawn']));
    // tab switch keeps the loaded list
    tabs[3]!.dispatch('click');
    await flush();
    expect(d.all((e) => e.classList.contains('catalog-remote-row'))).toEqual([]);
    expect(d.all((e) => e.getAttribute('data-ref') === 'u-w')).toHaveLength(1);
    d.all((e) => e.getAttribute('role') === 'tab')[0]!.dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/remote')).toHaveLength(1);
  });

  it('loads the marketplace again after a publish', async () => {
    online();
    reply('POST /api/catalog/publish', 200, { ok: true, code: null, results: [], catalog });
    await init();
    await openPage();
    const d = top();
    const tab = (id: string) => d.all((e) => e.getAttribute('data-tab') === id)[0]!;
    tab('user').dispatch('click');
    await flush();
    button('Publish…', foot())!.dispatch('click');
    await flush();
    button('Publish')!.dispatch('click');
    await flush();
    button('Done')!.dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/remote')).toHaveLength(1);
    tab('market-bundle').dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/remote')).toHaveLength(2);
  });

  it('says when the list may be incomplete, and clears it after a full Refresh', async () => {
    online();
    const note =
      'The marketplace changed while the list was loading, so some entries may be missing. Refresh to load it again.';
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: [summary()], partial: true });
    await init();
    const { marketplaceSection } = await import('../../src/editor/web/catalog-market.js');
    const el = marketplaceSection(catalog)!.el as unknown as FakeEl;
    await flush();
    expect(texts(el)).toContain(note);
    const hint = el.all((e) => e.classList.contains('catalog-partial'))[0]!;
    expect(hint.hidden).toBe(false);
    button('Refresh', el)!.dispatch('click');
    await flush();
    expect(texts(el)).not.toContain(note);
    expect(hint.hidden).toBe(true);
  });

  it('has no incomplete note without partial, and says it in Turkish', async () => {
    online();
    await init();
    const { marketplaceSection } = await import('../../src/editor/web/catalog-market.js');
    const plain = marketplaceSection(catalog)!.el as unknown as FakeEl;
    await flush();
    expect(texts(plain).some((x) => x.startsWith('The marketplace changed'))).toBe(false);
    setLanguage('tr');
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: [], partial: true });
    const el = marketplaceSection(catalog)!.el as unknown as FakeEl;
    await flush();
    expect(texts(el)).toContain(
      'Liste yüklenirken marketplace değişti, bu yüzden bazı girdiler eksik olabilir. Yeniden yüklemek için yenileyin.',
    );
  });

  it('shows the partial note in the Marketplace tab of the page', async () => {
    online();
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: [], partial: true });
    await init();
    await openPage();
    expect(texts(top())).toContain(
      'The marketplace changed while the list was loading, so some entries may be missing. Refresh to load it again.',
    );
  });

  it('shows the empty note', async () => {
    online();
    await init();
    const { marketplaceSection } = await import('../../src/editor/web/catalog-market.js');
    const el = marketplaceSection(catalog)!.el as unknown as FakeEl;
    await flush();
    expect(texts(el)).toContain('The marketplace has no entries yet.');
  });

  it('shows the translated marketplace error', async () => {
    online();
    await init();
    setLanguage('tr');
    reply('GET /api/catalog/remote', 502, {
      error: 'Could not reach the marketplace',
      errorId: 'market.error.network',
      code: 'network',
    });
    const { marketplaceSection } = await import('../../src/editor/web/catalog-market.js');
    const el = marketplaceSection(catalog)!.el as unknown as FakeEl;
    await flush();
    expect(texts(el)).toContain("Marketplace okunamadı: Marketplace'e ulaşılamadı");
  });

  it('opens a row as a read-only detail with versions and targets', async () => {
    online();
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: [summary()] });
    reply('GET /api/catalog/remote/ada/my-setup', 200, {
      entry: remoteEntry(),
      latest: {
        version: 2,
        content,
        targets: [
          { kind: 'command', target: 'echo <b>hi</b>' },
          { kind: 'link', target: 'https://example.com/x' },
          { kind: 'command', target: 'ls \u202ex  \u200b     y' },
        ],
      },
    });
    await init();
    await openPage();
    top()
      .all((e) => e.classList.contains('catalog-remote-row'))[0]!
      .dispatch('click');
    await flush();
    expect(calls.map((c) => c.url)).toContain('/api/catalog/remote/ada/my-setup');
    const d = top();
    const all = texts(d);
    expect(all).toEqual(
      expect.arrayContaining([
        'My setup',
        'Ada · @ada',
        'ada/my-setup',
        'Versions',
        'first',
        'second',
        'Applying it runs commands or opens URLs:',
        'command',
        'echo <b>hi</b>',
        'link',
        'https://example.com/x',
        'ls \u27e8U+202E\u27e9x  \u27e8U+200B\u27e9\u27e85 spaces\u27e9y',
      ]),
    );
    expect(d.all((e) => e.tagName === 'B')).toEqual([]);
    const rows = d.all((e) => e.classList.contains('catalog-history-row'));
    expect(texts(rows[0]!)[0]).toBe('v2');
    expect(buttons(foot(d)).map((b) => b.textContent)).toEqual(['Report…', 'Done', 'Install']);
  });

  it('says when nothing runs and shows a version error', async () => {
    online();
    await init();
    setLanguage('tr');
    reply('GET /api/catalog/remote/ada/my-setup', 200, {
      entry: remoteEntry({ withdrawn: true }),
      latest: null,
      code: 'bad-hash',
      errorId: 'market.error.bad-hash',
    });
    reply('GET /api/catalog/remote/ada/other', 200, {
      entry: remoteEntry({ id: 'ada/other' }),
      latest: { version: 2, content, targets: [] },
    });
    const { remoteEntryDialog } = await import('../../src/editor/web/catalog-market.js');
    void remoteEntryDialog('ada/my-setup');
    await flush();
    const all = texts(top());
    expect(all).toContain('İndirilen içerik özet değeriyle eşleşmiyor');
    expect(all).toContain('Geri çekildi');
    void remoteEntryDialog('ada/other');
    await flush();
    expect(texts(top())).toContain('Hiçbir komut çalıştırmaz ve hiçbir URL açmaz.');
  });

  it('toasts a failed detail load', async () => {
    online();
    await init();
    reply('GET /api/catalog/remote/ada/x', 404, {
      error: 'The entry was not found on the marketplace',
      errorId: 'market.error.not-found',
    });
    const { remoteEntryDialog } = await import('../../src/editor/web/catalog-market.js');
    await remoteEntryDialog('ada/x');
    expect(toastText()).toContain('The entry was not found on the marketplace');
    expect(open()).toEqual([]);
  });
});

describe('marketplace tabs by kind', () => {
  const mixed = () => [
    summary({ id: 'ada/b1', name: 'B1', kind: 'bundle' }),
    summary({ id: 'ada/b2', name: 'B2', kind: 'bundle', withdrawn: true }),
    summary({ id: 'ada/p1', name: 'P1', kind: 'preset' }),
    summary({ id: 'ada/p2', name: 'P2', kind: 'preset' }),
  ];
  const tabEl = (id: string) => top().all((e) => e.getAttribute('data-tab') === id)[0]!;
  const show = async (id: string) => {
    tabEl(id).dispatch('click');
    await flush();
  };
  const rows = () => top().all((e) => e.classList.contains('catalog-remote-row'));
  const names = () => rows().map((r) => r.querySelector('STRONG')!.textContent);
  const lists = () => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/catalog/remote'));
  const asked = () => calls.filter((c) => c.url === '/api/catalog/remote/previews').map((c) => c.body.ids);
  const thumbOf = (r: FakeEl) => r.querySelector('.catalog-thumb')!;
  const html = (el: FakeEl) => el.querySelector('.theme-preview')?.getAttribute('innerHTML') ?? '';
  const peeks = () => body.all((e) => e.classList.contains('catalog-peek'));

  it('lists each kind in its own tab from one index load, with its own empty note', async () => {
    online();
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: mixed() });
    await init();
    await openPage();
    const tabs = top().all((e) => e.getAttribute('role') === 'tab');
    expect(tabs.map((e) => e.textContent)).toEqual(['Bundles', 'Presets', 'Themes', 'User', 'Built in']);
    expect(tabs[0]!.getAttribute('data-tab')).toBe('market-bundle');
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(names()).toEqual(['B1', 'B2']);
    await show('market-preset');
    expect(names()).toEqual(['P1', 'P2']);
    await show('market-theme');
    expect(names()).toEqual([]);
    expect(texts(top())).toContain('The marketplace has no themes yet.');
    await show('user');
    expect(rows()).toEqual([]);
    await show('market-bundle');
    expect(names()).toEqual(['B1', 'B2']);
    expect(texts(top())).not.toContain('The marketplace has no themes yet.');
    expect(lists().map((c) => c.url)).toEqual(['/api/catalog/remote']);
    reply('GET /api/catalog/remote', 200, {
      endpoint: ENDPOINT,
      entries: [...mixed(), summary({ id: 'ada/t1', name: 'T1', kind: 'theme' })],
    });
    button('Refresh')!.dispatch('click');
    await flush();
    await show('market-theme');
    expect(names()).toEqual(['T1']);
    await show('market-preset');
    expect(lists().map((c) => c.url)).toEqual(['/api/catalog/remote', '/api/catalog/remote?refresh=1']);
  });

  it('says the marketplace is empty when no kind has entries', async () => {
    online();
    await init();
    await openPage();
    expect(texts(top())).toContain('The marketplace has no entries yet.');
    await show('market-preset');
    expect(texts(top())).toContain('The marketplace has no entries yet.');
    expect(texts(top())).not.toContain('The marketplace has no presets yet.');
    expect(asked()).toEqual([]);
  });

  it('says it in Turkish', async () => {
    online();
    setLanguage('tr');
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: mixed() });
    await init();
    await openPage();
    expect(
      top()
        .all((e) => e.getAttribute('role') === 'tab')
        .map((e) => e.textContent),
    ).toEqual(['Paketler', 'Hazır ayarlar', 'Temalar', 'Kullanıcı', 'Yerleşik']);
    await show('market-theme');
    expect(texts(top())).toContain("Marketplace'te henüz tema yok.");
  });

  it('asks previews once per id and version, only for the shown tab', async () => {
    online();
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: mixed() });
    await init();
    await openPage();
    expect(asked()).toEqual([['ada/b1']]);
    expect(calls.find((c) => c.url === '/api/catalog/remote/previews')!.body).toMatchObject({
      config: expect.any(Object),
      width: expect.any(Number),
      lang: 'en',
    });
    const [b1, b2] = rows();
    expect(html(thumbOf(b1!))).toContain('line ada/b1');
    expect(html(thumbOf(b2!))).not.toContain('line ada/');
    await show('market-preset');
    expect(asked()).toEqual([['ada/b1'], ['ada/p1', 'ada/p2']]);
    expect(rows().map((r) => html(thumbOf(r)))).toEqual([
      expect.stringContaining('line ada/p1'),
      expect.stringContaining('line ada/p2'),
    ]);
    await show('market-bundle');
    await show('user');
    await show('market-preset');
    await show('market-theme');
    expect(asked()).toHaveLength(2);
    // after Refresh only the new version is asked
    reply('GET /api/catalog/remote', 200, {
      endpoint: ENDPOINT,
      entries: [
        summary({ id: 'ada/b1', name: 'B1', kind: 'bundle' }),
        summary({ id: 'ada/p1', name: 'P1', kind: 'preset', version: 3 }),
        summary({ id: 'ada/p2', name: 'P2', kind: 'preset' }),
      ],
    });
    await show('market-preset');
    button('Refresh')!.dispatch('click');
    await flush();
    expect(asked()).toEqual([['ada/b1'], ['ada/p1', 'ada/p2'], ['ada/p1']]);
    await show('market-bundle');
    expect(asked()).toHaveLength(3);
  });

  it('asks again later when a preview request fails', async () => {
    online();
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: mixed() });
    reply('POST /api/catalog/remote/previews', 502, { error: 'no', errorId: 'market.error.network' });
    await init();
    await openPage();
    expect(asked()).toEqual([['ada/b1']]);
    expect(html(thumbOf(rows()[0]!))).not.toContain('line ada/');
    await show('market-preset');
    await show('market-bundle');
    expect(asked()).toEqual([['ada/b1'], ['ada/p1', 'ada/p2'], ['ada/b1']]);
    expect(html(thumbOf(rows()[0]!))).toContain('line ada/b1');
  });

  it('peeks on mouse hover and keyboard focus, and shows the preview in the details', async () => {
    online();
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: mixed() });
    reply('GET /api/catalog/remote/ada/b1', 200, {
      entry: remoteEntry({ id: 'ada/b1', name: 'B1' }),
      latest: { version: 2, content, targets: [] },
    });
    await init();
    await openPage();
    const row = rows()[0]!;
    expect(row.tagName).toBe('DIV');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    thumbOf(row).dispatch('pointerenter', { pointerType: 'touch' });
    expect(peeks().filter((p) => p.classList.contains('on'))).toEqual([]);
    thumbOf(row).dispatch('pointerenter', { pointerType: 'mouse' });
    const p = peeks()[0]!;
    expect(p.classList.contains('on')).toBe(true);
    expect(html(p)).toContain('line ada/b1');
    thumbOf(row).dispatch('pointerleave', {});
    expect(p.classList.contains('on')).toBe(false);
    (row as any).matches = (sel: string) => sel === ':focus-visible';
    row.dispatch('focus', {});
    expect(p.classList.contains('on')).toBe(true);
    row.dispatch('blur', {});
    expect(p.classList.contains('on')).toBe(false);
    const key = (type: string, k: string) =>
      row.dispatch(type, { key: k, target: row, currentTarget: row, preventDefault() {} });
    key('keydown', 'Enter');
    await flush();
    const d = top();
    expect(d.querySelector('H2')!.textContent).toBe('B1');
    expect(html(d.querySelector('.catalog-detail-preview')!)).toContain('line ada/b1');
    expect(asked()).toEqual([['ada/b1']]);
  });

  it('opens the details on space release', async () => {
    online();
    reply('GET /api/catalog/remote', 200, { endpoint: ENDPOINT, entries: mixed() });
    await init();
    await openPage();
    const row = rows()[0]!;
    const before = open().length;
    const key = (type: string, k: string) =>
      row.dispatch(type, { key: k, target: row, currentTarget: row, preventDefault() {} });
    key('keydown', ' ');
    await flush();
    expect(open()).toHaveLength(before);
    key('keyup', ' ');
    await flush();
    expect(open()).toHaveLength(before + 1);
  });
});
