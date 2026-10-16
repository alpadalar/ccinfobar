import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import type { CatalogEntryInfo, CatalogState, CatalogVersionInfo } from '../../src/editor/web/store.js';
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

type Call = { method: string; url: string; body: any };
type Reply = { status: number; data: unknown };
let body: FakeEl;
let calls: Call[];
let catalog: CatalogState;
let replies: Record<string, Reply[]>;
let docKeys: ((e: unknown) => void)[];

const entry = (over: Partial<CatalogEntryInfo>): CatalogEntryInfo => ({
  ref: 'u-1',
  source: 'user',
  id: 'u-1',
  kind: 'preset',
  name: 'Mine',
  description: '',
  author: 'Alp',
  version: 1,
  rev: 1,
  share: { wanted: false, state: 'local' },
  remote: null,
  updatedAt: '2026-10-16T10:00:00.000Z',
  scenario: null,
  content: { layout: { lines: [[{ id: 'm', type: 'model' }]] } },
  ...over,
});

const sys = entry({
  ref: 'preset/compact',
  source: 'system',
  id: 'compact',
  name: 'Compact',
  author: 'ccinfobar',
  rev: null,
  share: null,
  updatedAt: null,
});
const local = () => entry({ ref: 'u-l', id: 'u-l', name: 'Local one' });
const pub = () =>
  entry({
    ref: 'u-p',
    id: 'u-p',
    kind: 'bundle',
    name: 'Shared one',
    version: 3,
    rev: 7,
    share: { wanted: true, state: 'published' },
    remote: { id: 'alp/shared-one', version: 3 },
  });
const legacy = () =>
  entry({
    ref: 'legacy:preset/old',
    source: 'legacy',
    id: 'old',
    name: 'Old one',
    author: '',
    rev: null,
    share: null,
    updatedAt: null,
  });

const version = (n: number, over: Partial<CatalogVersionInfo> = {}): CatalogVersionInfo => ({
  version: n,
  at: `2026-10-1${n}T09:30:00.000Z`,
  note: `note ${n}`,
  restoredFrom: null,
  overwrittenAt: null,
  content: {},
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
    if (u.startsWith('/api/catalog')) return res(200, catalog);
    return res(200, { ok: true });
  };
});

beforeEach(() => {
  setLanguage('en');
  calls = [];
  replies = {};
  docKeys = [];
  catalog = {
    system: [sys],
    user: [pub(), local(), legacy()],
    profile: { author: 'Alp' },
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
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') docKeys.push(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      if (type === 'keydown') docKeys = docKeys.filter((x) => x !== fn);
    },
    activeElement: null,
  };
});

afterAll(() => {
  Object.assign(g, saved);
  setLanguage('en');
});

async function init(config: Config = defaultConfig()) {
  const store = await import('../../src/editor/web/store.js');
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

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// dialogs still open; closed ones linger while they fade
const open = () =>
  body.children.filter(
    (c): c is FakeEl =>
      typeof c !== 'string' && c.classList.contains('overlay') && !c.classList.contains('leaving'),
  );
const top = () => open().at(-1)!;
const button = (label: string, root: FakeEl = top()) =>
  root.all((e) => e.tagName === 'BUTTON' && e.textContent === label)[0]!;
const input = (label: string) => {
  const d = top();
  const l = d.all((e) => e.tagName === 'LABEL' && e.textContent === label)[0]!;
  return d.all((e) => e.tagName === 'INPUT' && e.id !== '' && e.id === l.htmlFor)[0]!;
};
const shareSwitch = () => top().all((e) => e.classList.contains('switch-input'))[0]!;
const saves = () => calls.filter((c) => c.url === '/api/catalog/save');
const toastText = () => texts(body.children[0] as FakeEl);
const type = (el: FakeEl, value: string) => {
  el.value = value;
  el.dispatch('input');
};

async function saveDialog(data: CatalogState = catalog) {
  const { saveCurrentDialog } = await import('../../src/editor/web/catalog-dialogs.js');
  const p = saveCurrentDialog(data);
  await flush();
  return { p };
}

const savedEntry = (over: Partial<CatalogEntryInfo> = {}) =>
  entry({ ref: 'u-n', id: 'u-n', name: 'New', ...over });

describe('save current dialog', () => {
  it('opens with preset + theme, the remembered author and sharing on', async () => {
    await init();
    await saveDialog();
    const d = top();
    const kinds = d.all((e) => e.getAttribute('aria-pressed') !== null);
    expect(kinds.map((k) => k.textContent)).toEqual(['Preset + theme', 'Preset only', 'Theme only']);
    expect(kinds.map((k) => k.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(input('Author').value).toBe('Alp');
    const sw = shareSwitch();
    // checked attribute = initially checked
    expect(sw.getAttribute('checked')).toBe('');
    const label = d.all((e) => e.id !== '' && e.id === sw.getAttribute('aria-labelledby'))[0]!;
    expect(label.textContent).toBe('Share to marketplace');
    expect(texts(d)).toContain(
      'On by default. Without a marketplace endpoint it waits to publish and nothing is sent.',
    );
    // note only on a name clash
    expect(d.all((e) => e.tagName === 'LABEL' && e.textContent === 'Note')[0]!.parent!.hidden).toBe(true);
  });

  it('sends a new bundle with author and share on', async () => {
    const store = await init();
    const before = clone(store.S.config);
    const next = { ...catalog, user: [savedEntry(), ...catalog.user] };
    reply('POST /api/catalog/save', 200, { ok: true, entry: savedEntry(), catalog: next });
    const { p } = await saveDialog();
    type(input('Name'), 'New');
    type(input('Description'), 'Words');
    button('Save').dispatch('click');
    await flush();
    expect(saves().map((c) => c.body)).toEqual([
      {
        kind: 'bundle',
        name: 'New',
        description: 'Words',
        author: 'Alp',
        share: true,
        mode: 'new',
        config: before,
        lang: 'en',
      },
    ]);
    expect(await p).toEqual(next);
    expect(toastText()).toContain('Saved New v1');
    expect(store.S.config).toEqual(before);
    expect(open()).toEqual([]);
  });

  it('sends share false and the chosen kind', async () => {
    await init();
    reply('POST /api/catalog/save', 200, { ok: true, entry: savedEntry(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    expect(button('Preset only').getAttribute('aria-pressed')).toBe('true');
    const sw = shareSwitch();
    sw.checked = false;
    sw.dispatch('change');
    type(input('Name'), 'New');
    type(input('Author'), 'Ada');
    button('Save').dispatch('click');
    await flush();
    expect(saves()[0]!.body).toMatchObject({ kind: 'preset', share: false, author: 'Ada', mode: 'new' });
  });

  it('needs a name', async () => {
    await init();
    await saveDialog();
    type(input('Name'), '   ');
    button('Save').dispatch('click');
    await flush();
    expect(saves()).toEqual([]);
    expect(texts(top())).toContain('Name must be 1 to 64 characters');
  });

  it('offers update or overwrite on a name clash', async () => {
    await init();
    reply('POST /api/catalog/save', 409, {
      error: 'A bundle named Shared one already exists (v3)',
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'bundle', name: 'Shared one', version: 3 },
      exists: { id: 'u-p', version: 3, name: 'Shared one' },
    });
    reply('POST /api/catalog/save', 200, { ok: true, entry: pub(), catalog });
    const { p } = await saveDialog();
    type(input('Name'), 'Shared one');
    button('Save').dispatch('click');
    await flush();
    const d = top();
    expect(texts(d)).toContain(
      'Shared one already exists as v3. Update adds v4 and keeps the history; overwrite replaces v3.',
    );
    expect(button('Update (adds v4)')).toBeTruthy();
    expect(d.all((e) => e.tagName === 'LABEL' && e.textContent === 'Note')[0]!.parent!.hidden).toBe(false);
    type(input('Note'), 'tweak');
    button('Overwrite v3').dispatch('click');
    await flush();
    expect(saves().map((c) => c.body.mode)).toEqual(['new', 'overwrite']);
    expect(saves()[1]!.body).toMatchObject({ mode: 'overwrite', id: 'u-p', rev: 7, note: 'tweak' });
    expect(await p).toEqual(catalog);
  });

  it('updates on request', async () => {
    await init();
    reply('POST /api/catalog/save', 409, {
      error: 'exists',
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'preset', name: 'Local one', version: 1 },
      exists: { id: 'u-l', version: 1, name: 'Local one' },
    });
    reply('POST /api/catalog/save', 200, { ok: true, entry: local(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    type(input('Name'), 'Local one');
    button('Save').dispatch('click');
    await flush();
    button('Update (adds v2)').dispatch('click');
    await flush();
    expect(saves()[1]!.body).toMatchObject({ mode: 'update', id: 'u-l', rev: 1, kind: 'preset' });
  });

  it('keeps the clashing entry share choice unless the switch is touched (WR-02)', async () => {
    await init();
    const clash = {
      error: 'exists',
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'preset', name: 'Local one', version: 1 },
      exists: { id: 'u-l', version: 1, name: 'Local one' },
    };
    reply('POST /api/catalog/save', 409, clash);
    reply('POST /api/catalog/save', 200, { ok: true, entry: local(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    type(input('Name'), 'Local one');
    button('Save').dispatch('click');
    await flush();
    expect(shareSwitch().checked).toBe(false);
    button('Overwrite v1').dispatch('click');
    await flush();
    expect(saves()[0]!.body.share).toBe(true);
    expect(saves()[1]!.body).toMatchObject({ mode: 'overwrite', id: 'u-l' });
    expect('share' in saves()[1]!.body).toBe(false);

    calls = [];
    reply('POST /api/catalog/save', 409, clash);
    reply('POST /api/catalog/save', 200, { ok: true, entry: local(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    type(input('Name'), 'Local one');
    button('Save').dispatch('click');
    await flush();
    const sw = shareSwitch();
    sw.checked = true;
    sw.dispatch('change');
    button('Update (adds v2)').dispatch('click');
    await flush();
    expect(saves()[1]!.body).toMatchObject({ mode: 'update', share: true });
  });

  it('keeps the clashing entry author unless one is typed (IN-02)', async () => {
    await init();
    catalog.user = [{ ...local(), author: 'Bob' }, pub()];
    const clash = {
      error: 'exists',
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'preset', name: 'Local one', version: 1 },
      exists: { id: 'u-l', version: 1, name: 'Local one' },
    };
    reply('POST /api/catalog/save', 409, clash);
    reply('POST /api/catalog/save', 200, { ok: true, entry: local(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    type(input('Name'), 'Local one');
    expect(input('Author').value).toBe('Alp');
    button('Save').dispatch('click');
    await flush();
    expect(input('Author').value).toBe('Bob');
    button('Overwrite v1').dispatch('click');
    await flush();
    expect(saves()[0]!.body.author).toBe('Alp');
    expect('author' in saves()[1]!.body).toBe(false);

    calls = [];
    reply('POST /api/catalog/save', 409, clash);
    reply('POST /api/catalog/save', 200, { ok: true, entry: local(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    type(input('Name'), 'Local one');
    button('Save').dispatch('click');
    await flush();
    type(input('Author'), 'Cy');
    button('Update (adds v2)').dispatch('click');
    await flush();
    expect(saves()[1]!.body).toMatchObject({ mode: 'update', author: 'Cy' });
  });

  it('keeps the old description on update unless one is typed', async () => {
    await init();
    catalog.user = [{ ...local(), description: 'Old words' }, pub()];
    const clash = {
      error: 'exists',
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'preset', name: 'Local one', version: 1 },
      exists: { id: 'u-l', version: 1, name: 'Local one' },
    };
    reply('POST /api/catalog/save', 409, clash);
    reply('POST /api/catalog/save', 200, { ok: true, entry: local(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    type(input('Name'), 'Local one');
    button('Save').dispatch('click');
    await flush();
    expect(input('Description').value).toBe('Old words');
    button('Update (adds v2)').dispatch('click');
    await flush();
    expect(saves()[1]!.body).toMatchObject({ mode: 'update', id: 'u-l', description: 'Old words' });

    calls = [];
    reply('POST /api/catalog/save', 409, clash);
    reply('POST /api/catalog/save', 200, { ok: true, entry: local(), catalog });
    await saveDialog();
    button('Preset only').dispatch('click');
    type(input('Name'), 'Local one');
    type(input('Description'), 'New words');
    button('Save').dispatch('click');
    await flush();
    button('Overwrite v1').dispatch('click');
    await flush();
    expect(saves()[1]!.body).toMatchObject({ mode: 'overwrite', description: 'New words' });
  });

  it('shows a stale entry error and reloads the list', async () => {
    await init();
    reply('POST /api/catalog/save', 409, {
      error: 'exists',
      errorId: 'err.catalog.exists',
      errorParams: { kind: 'bundle', name: 'Shared one', version: 3 },
      exists: { id: 'u-p', version: 3, name: 'Shared one' },
    });
    reply('POST /api/catalog/save', 409, { error: 'changed', errorId: 'err.catalog.changed' });
    await saveDialog();
    type(input('Name'), 'Shared one');
    button('Save').dispatch('click');
    await flush();
    calls = [];
    button('Update (adds v4)').dispatch('click');
    await flush();
    expect(texts(top())).toContain('This entry changed since you opened it; reload and try again');
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      'POST /api/catalog/save',
      'GET /api/catalog',
    ]);
  });

  it('shows Turkish labels', async () => {
    await init();
    setLanguage('tr');
    await saveDialog();
    const all = texts(top());
    for (const s of [
      'Mevcut kurulumu kaydet',
      'Hazır ayar + tema',
      'Yalnızca hazır ayar',
      'Yalnızca tema',
      'Yazar',
      'Pazar yerinde paylaş',
      'Kaydet',
      'İptal',
    ])
      expect(all).toContain(s);
  });
});

async function openCatalog() {
  const { openCatalog } = await import('../../src/editor/web/catalog.js');
  void openCatalog();
  await flush();
}

const card = (ref: string) => body.all((e) => e.getAttribute('data-ref') === ref)[0];
const actions = (ref: string) =>
  card(ref)!
    .querySelector('.theme-actions')!
    .all((e) => e.tagName === 'BUTTON')
    .map((b) => b.getAttribute('title'));
const action = (ref: string, title: string) =>
  card(ref)!.all((e) => e.tagName === 'BUTTON' && e.getAttribute('title') === title)[0]!;
// click that bubbles up unless stopped
const bubble = (el: FakeEl) => {
  let stopped = false;
  const ev = {
    target: el,
    stopPropagation() {
      stopped = true;
    },
    preventDefault() {},
  };
  for (let at: FakeEl | null = el; at && !stopped; at = at.parent)
    at.dispatch('click', { ...ev, currentTarget: at });
};
const chipOf = (ref: string) => card(ref)!.querySelector('.catalog-chip')?.textContent;

describe('catalog card actions', () => {
  it('shows history, share and delete on user and legacy cards only', async () => {
    await init();
    await openCatalog();
    expect(actions('u-l')).toEqual(['Version history', 'Share to marketplace', 'Delete']);
    expect(actions('u-p')).toEqual(['Version history', 'Stop sharing', 'Delete']);
    expect(actions('legacy:preset/old')).toEqual(['Version history', 'Share to marketplace', 'Delete']);
    expect(texts(card('legacy:preset/old')!)).toContain('Saved before the catalog');
    expect(actions('preset/compact')).toEqual([]);
    expect(action('u-l', 'Delete').getAttribute('aria-label')).toBe('Delete Local one');
  });

  it('opens the save dialog from the footer and shows the new card', async () => {
    await init();
    await openCatalog();
    const next = { ...catalog, user: [savedEntry(), ...catalog.user] };
    reply('POST /api/catalog/save', 200, { ok: true, entry: savedEntry(), catalog: next });
    button('Save current as…').dispatch('click');
    await flush();
    type(input('Name'), 'New');
    button('Save').dispatch('click');
    await flush();
    expect(card('u-n')).toBeTruthy();
  });

  it('lists history newest first and restores as a new version', async () => {
    await init();
    await openCatalog();
    reply('GET /api/catalog/entries/u-p', 200, {
      entry: pub(),
      versions: [version(1), version(2, { note: '<b>x</b>' }), version(3, { restoredFrom: 1, note: 'back' })],
    });
    const restored = { ...pub(), version: 4, rev: 8 };
    reply('POST /api/catalog/restore', 200, {
      ok: true,
      entry: restored,
      catalog: { ...catalog, user: [restored, local(), legacy()] },
    });
    action('u-p', 'Version history').dispatch('click');
    await flush();
    const d = top();
    expect(texts(d)).toContain('Versions of Shared one');
    const rows = d.all((e) => e.classList.contains('catalog-history-row'));
    expect(rows.map((r) => r.querySelector('strong')!.textContent)).toEqual(['v3', 'v2', 'v1']);
    expect(texts(rows[0]!)).toContain('restored from v1');
    expect(texts(rows[0]!)).toContain('Current');
    expect(texts(rows[1]!)).toContain('<b>x</b>');
    expect(d.all((e) => e.tagName === 'B')).toEqual([]);
    expect(rows.map((r) => r.all((e) => e.tagName === 'BUTTON').length)).toEqual([0, 1, 1]);
    button('Restore', rows[2]!).dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/restore').map((c) => c.body)).toEqual([
      { id: 'u-p', version: 1, rev: 7, lang: 'en' },
    ]);
    expect(toastText()).toContain('Restored v1 of Shared one as v4');
    expect(texts(card('u-p')!)).toContain('v4');
  });

  it('shares a local entry and unshares a published one', async () => {
    await init();
    await openCatalog();
    const shared = { ...local(), share: { wanted: true, state: 'pending' as const }, rev: 2 };
    reply('POST /api/catalog/share', 200, {
      ok: true,
      entry: shared,
      catalog: { ...catalog, user: [pub(), shared, legacy()] },
    });
    action('u-l', 'Share to marketplace').dispatch('click');
    await flush();
    expect(chipOf('u-l')).toBe('Waiting to publish');
    expect(toastText()).toContain('Sharing Local one. Nothing is sent until you publish.');
    const off = { ...pub(), share: { wanted: false, state: 'withdraw-pending' as const }, rev: 8 };
    reply('POST /api/catalog/share', 200, {
      ok: true,
      entry: off,
      catalog: { ...catalog, user: [off, shared, legacy()] },
    });
    action('u-p', 'Stop sharing').dispatch('click');
    await flush();
    const bodies = calls.filter((c) => c.url === '/api/catalog/share').map((c) => c.body);
    expect(bodies).toEqual([
      { ref: 'u-l', share: true, rev: 1, lang: 'en' },
      { ref: 'u-p', share: false, rev: 7, lang: 'en' },
    ]);
    expect(chipOf('u-p')).toBe('Waiting to withdraw');
    expect(toastText().join(' ')).toContain(
      'Stopped sharing Shared one. It stays on the marketplace until the next publish withdraws it.',
    );
  });

  it('asks before deleting', async () => {
    await init();
    await openCatalog();
    action('u-l', 'Delete').dispatch('click');
    await flush();
    expect(texts(top())).toContain('Delete Local one?');
    button('Cancel').dispatch('click');
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(card('u-l')).toBeTruthy();
    reply('DELETE /api/catalog/entries/u-l', 200, {
      ok: true,
      catalog: { ...catalog, user: [pub(), legacy()] },
    });
    action('u-l', 'Delete').dispatch('click');
    await flush();
    button('Delete').dispatch('click');
    await flush();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      '/api/catalog/entries/u-l?lang=en',
    ]);
    expect(card('u-l')).toBeUndefined();
    expect(toastText()).toContain('Deleted Local one');
  });

  it('warns that deleting keeps the published copy', async () => {
    await init();
    await openCatalog();
    action('u-p', 'Delete').dispatch('click');
    await flush();
    expect(texts(top()).join(' ')).toContain('The published copy stays on the marketplace');
  });

  it('action buttons never apply', async () => {
    const store = await init();
    await openCatalog();
    const before = clone(store.S.config);
    for (const e of [local(), pub(), legacy()]) {
      reply(`GET /api/catalog/entries/${encodeURIComponent(e.ref)}`, 200, {
        entry: e,
        versions: [version(1)],
      });
      for (const title of ['Version history', 'Delete']) {
        bubble(action(e.ref, title));
        await flush();
        top().querySelector('.modal-head')!.querySelector('button')!.dispatch('click');
        await flush();
      }
    }
    expect(store.S.config).toEqual(before);
    expect(store.S.undo).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes('install-theme'))).toEqual([]);
  });

  it('reloads previews of a changed entry', async () => {
    await init();
    await openCatalog();
    const shared = { ...local(), share: { wanted: true, state: 'pending' as const }, rev: 2 };
    const restored = { ...pub(), version: 4, rev: 8, content: { layout: { lines: [] } } };
    reply('POST /api/catalog/share', 200, {
      ok: true,
      entry: shared,
      catalog: { ...catalog, user: [restored, shared, legacy()] },
    });
    calls = [];
    action('u-l', 'Share to marketplace').dispatch('click');
    await flush();
    expect(calls.filter((c) => c.url === '/api/catalog/previews').flatMap((c) => c.body.refs)).toEqual([
      'u-p',
    ]);
  });

  it('closes only the top dialog on Escape', async () => {
    await init();
    await openCatalog();
    action('u-l', 'Delete').dispatch('click');
    await flush();
    expect(open()).toHaveLength(2);
    for (const fn of [...docKeys]) fn({ key: 'Escape', stopPropagation() {} });
    await flush();
    expect(open()).toHaveLength(1);
    expect(card('u-l')).toBeTruthy();
  });

  it('shows the card actions in Turkish', async () => {
    await init();
    setLanguage('tr');
    await openCatalog();
    expect(actions('u-p')).toEqual(['Sürüm geçmişi', 'Paylaşmayı durdur', 'Sil']);
    expect(texts(body)).toContain('Mevcut olanı kaydet…');
  });
});
