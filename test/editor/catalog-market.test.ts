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
    expect(tabs).toEqual(['All', 'User', 'System']);
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
    expect(all).toContain('Old one: Pazar yerine ulaşılamadı');
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
    expect(texts(top())).toContain('Pazar yerine ulaşılamadı');
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
  it('lists remote entries read-only with author, publisher and version', async () => {
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
    expect(tabs.map((e) => e.textContent)).toEqual(['All', 'User', 'System', 'Marketplace']);
    expect(marketCalls()).toEqual([]);
    tabs[3]!.dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/remote')).toHaveLength(1);
    const rows = d.all((e) => e.classList.contains('catalog-remote-row'));
    expect(rows).toHaveLength(2);
    expect(texts(rows[0]!)).toEqual(expect.arrayContaining(['My setup', 'Bundle', 'v2', 'Ada · @ada']));
    expect(texts(rows[1]!)).toEqual(expect.arrayContaining(['Gone', '@bo', 'Withdrawn']));
    expect(buttons(d).some((b) => /apply|install/i.test(b.textContent))).toBe(false);
    // tab switch keeps the loaded list
    tabs[0]!.dispatch('click');
    await flush();
    d.all((e) => e.getAttribute('role') === 'tab')[3]!.dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/remote')).toHaveLength(1);
  });

  it('loads the marketplace again after a publish', async () => {
    online();
    reply('POST /api/catalog/publish', 200, { ok: true, code: null, results: [], catalog });
    await init();
    await openPage();
    const tab = () => top().all((e) => e.getAttribute('role') === 'tab')[3]!;
    tab().dispatch('click');
    await flush();
    button('Publish…', foot())!.dispatch('click');
    await flush();
    button('Publish')!.dispatch('click');
    await flush();
    button('Done')!.dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/remote')).toHaveLength(2);
  });

  it('shows the empty note', async () => {
    online();
    await init();
    const { marketplaceSection } = await import('../../src/editor/web/catalog-market.js');
    const el = marketplaceSection(catalog) as unknown as FakeEl;
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
    const el = marketplaceSection(catalog) as unknown as FakeEl;
    await flush();
    expect(texts(el)).toContain('Pazar yeri okunamadı: Pazar yerine ulaşılamadı');
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
        ],
      },
    });
    await init();
    await openPage();
    top()
      .all((e) => e.getAttribute('role') === 'tab')[3]!
      .dispatch('click');
    await flush();
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
        'Read only: installing from the marketplace is not available yet.',
      ]),
    );
    expect(d.all((e) => e.tagName === 'B')).toEqual([]);
    const rows = d.all((e) => e.classList.contains('catalog-history-row'));
    expect(texts(rows[0]!)[0]).toBe('v2');
    expect(buttons(foot(d)).map((b) => b.textContent)).toEqual(['Done']);
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
