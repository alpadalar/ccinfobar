import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { editorMessages as enEditor } from '../../src/core/i18n/en/editor.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl, texts } from './fake-dom.js';

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
let body: FakeEl;
type Call = { method: string; url: string; body: any };
let calls: Call[];
let openReply: { status: number; data: unknown };
let shareReply: (b: any) => { status: number; data: unknown };
let replaced: string[];

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

const config: Config = { ...defaultConfig(), lines: [[{ id: 'w1', type: 'git-branch' }]], language: 'en' };

const state = () => ({
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
});

const CODE = 'ccib1:AbC';
const shared = {
  code: CODE,
  content: {
    layout: {
      lines: [
        [
          { id: 'm', type: 'model' },
          { id: 'k', type: 'command', options: { command: 'echo hi' } },
        ],
      ],
    },
    appearance: { theme: 'nord' },
  },
  cols: 150,
  targets: [{ kind: 'command', line: 0, index: 1, target: 'echo hi' }],
};

const shareInfo = (included: boolean) => ({
  code: included ? 'ccib1:WITH' : 'ccib1:WITHOUT',
  chars: included ? 10 : 13,
  max: 32768,
  included,
  targets: [{ kind: 'command', target: 'echo hi' }],
  dropped: included ? [] : [{ kind: 'command', target: 'echo hi' }],
});

const clipboard = { writeText: vi.fn(async (_s: string) => {}) };

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = {
    setTimeout: () => 0,
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => null,
  };
  g.CSS = { escape: (s: string) => s };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.sessionStorage = { getItem: () => null, setItem() {} };
  g.history = { replaceState: (_a: unknown, _b: unknown, url: string) => void replaced.push(url) };
  g.fetch = async (url: string, init: { method: string; body?: string }) => {
    const b = init.body ? JSON.parse(init.body) : null;
    const u = String(url).split('?')[0]!;
    calls.push({ method: init.method, url: u, body: b });
    const res = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    if (u === '/api/state') return res(200, state());
    if (u === '/api/share/open') return res(openReply.status, openReply.data);
    if (u === '/api/share') {
      const r = shareReply(b);
      return res(r.status, r.data);
    }
    if (u === '/api/share/install-theme') return res(200, { ok: true, theme: null, themes: [] });
    if (u === '/api/preview') return res(200, { lines: [], hidden: [] });
    return res(200, { ok: true });
  };
  vi.stubGlobal('navigator', { languages: [], clipboard });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  vi.unstubAllGlobals();
  setLanguage('en');
});

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

type Store = typeof import('../../src/editor/web/store.js');
let store: Store;

async function boot(hash = '') {
  byId = new Map();
  calls = [];
  replaced = [];
  openReply = { status: 200, data: shared };
  shareReply = (b) => ({ status: 200, data: shareInfo(b.includeCommands === true) });
  clipboard.writeText.mockClear();
  body = new FakeEl('BODY');
  body.append(el('toasts'));
  g.location = { search: '?t=abc', pathname: '/', hash };
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
}

const open = () =>
  body.children.filter(
    (c): c is FakeEl =>
      typeof c !== 'string' && c.classList.contains('overlay') && !c.classList.contains('leaving'),
  );
const top = () => open().at(-1)!;
const button = (label: string, root: FakeEl = top()) =>
  root.all((e) => e.tagName === 'BUTTON' && e.textContent === label)[0]!;
const posts = (p: string) => calls.filter((c) => c.method === 'POST' && c.url === p);
const saves = () => calls.filter((c) => c.url === '/api/config');
const toastText = () => texts(byId.get('toasts')!).join('\n');
const types = () => store.S.config.lines[0]!.map((i) => i.type);

describe('opening a share code', () => {
  it('reads #c= at boot, cleans the url and asks before keeping commands', async () => {
    await boot(`#c=${CODE}`);
    expect(replaced).toEqual(['/']);
    expect(posts('/api/share/open')[0]!.body).toEqual({ code: CODE });
    expect(texts(top()).join('\n')).toContain('echo hi');
    button('Apply without them').dispatch('click');
    await flush();
    expect(types()).toEqual(['model']);
    expect(store.S.config.theme).toBe('nord');
    expect(store.S.config.language).toBe('en');
    expect(store.S.width).toBe(150);
    expect(store.isDirty()).toBe(true);
    expect(saves()).toEqual([]);
    expect(toastText()).toContain('without 1 command');
    store.undo();
    expect(types()).toEqual(['git-branch']);
  });

  it('Keep keeps the widget and Cancel changes nothing', async () => {
    await boot();
    expect(replaced).toEqual(['/']);
    expect(posts('/api/share/open')).toEqual([]);
    const { openShareCode } = await import('../../src/editor/web/share.js');
    void openShareCode(CODE);
    await flush();
    button('Keep them').dispatch('click');
    await flush();
    expect(types()).toEqual(['model', 'command']);
    store.undo();
    void openShareCode(CODE);
    await flush();
    button('Cancel').dispatch('click');
    await flush();
    expect(types()).toEqual(['git-branch']);
    expect(saves()).toEqual([]);
  });

  it('installs an embedded theme through the server', async () => {
    await boot();
    openReply = {
      status: 200,
      data: { ...shared, targets: [], content: { ...shared.content, theme: { id: 'mine', name: 'Mine' } } },
    };
    const { openShareCode } = await import('../../src/editor/web/share.js');
    await openShareCode(CODE);
    await flush();
    expect(posts('/api/share/install-theme')[0]!.body).toEqual({ code: CODE });
    expect(open()).toEqual([]);
  });

  it('shows a server error and changes nothing', async () => {
    await boot();
    openReply = { status: 400, data: { error: 'damaged', errorId: 'err.share.corrupt' } };
    const { openShareCode } = await import('../../src/editor/web/share.js');
    await openShareCode(CODE);
    expect(toastText()).toContain('damaged or incomplete');
    expect(types()).toEqual(['git-branch']);
  });

  it('the Open… dialog checks the code before sending it', async () => {
    await boot();
    byId.get('open-code')!.dispatch('click');
    await flush();
    const area = top().all((e) => e.tagName === 'TEXTAREA')[0]!;
    area.value = 'hello';
    button('Open').dispatch('click');
    await flush();
    expect(texts(top()).join('\n')).toContain('not a ccinfobar share code');
    expect(posts('/api/share/open')).toEqual([]);
    area.value = `  https://example.org/#c=${CODE}\n`;
    button('Open').dispatch('click');
    await flush();
    expect(posts('/api/share/open')).toHaveLength(1);
  });

  it('lists an env widget by name in the consent dialog', async () => {
    await boot();
    openReply = {
      status: 200,
      data: {
        ...shared,
        content: {
          ...shared.content,
          layout: { lines: [[{ id: 'e', type: 'env', options: { name: 'CCIB_TEST_SECRET' } }]] },
        },
        targets: [{ kind: 'env', line: 0, index: 0, target: 'CCIB_TEST_SECRET' }],
      },
    };
    const { openShareCode } = await import('../../src/editor/web/share.js');
    void openShareCode(CODE);
    await flush();
    const text = texts(top()).join('\n');
    expect(text).toContain('env');
    expect(text).toContain('CCIB_TEST_SECRET');
  });

  it('the Import dialog sends a pasted code to the same flow', async () => {
    await boot();
    byId.get('import')!.dispatch('click');
    await flush();
    const area = top().all((e) => e.tagName === 'TEXTAREA')[0]!;
    area.value = CODE;
    button('Import').dispatch('click');
    await flush();
    expect(posts('/api/share/open')).toHaveLength(1);
    expect(posts('/api/normalize')).toEqual([]);
    expect(texts(top()).join('\n')).toContain('echo hi');
  });
});

describe('the Share dialog', () => {
  it('shows the code, its size and what was removed, and re-asks with Include', async () => {
    await boot();
    byId.get('share')!.dispatch('click');
    await flush();
    expect(posts('/api/share')[0]!.body).toMatchObject({ includeCommands: false, cols: store.S.width });
    const area = () => top().all((e) => e.tagName === 'TEXTAREA')[0]!;
    expect(area().value).toBe('ccib1:WITHOUT');
    const text = texts(top()).join('\n');
    expect(text).toContain('13 of 32768 characters');
    expect(text).toContain('Removed from the code');
    expect(text).toContain('echo hi');
    const box = top().all((e) => e.tagName === 'INPUT' && e.type === 'checkbox')[0]!;
    box.checked = true;
    box.dispatch('change');
    await flush();
    expect(posts('/api/share')[1]!.body.includeCommands).toBe(true);
    expect(area().value).toBe('ccib1:WITH');
    expect(texts(top()).join('\n')).toContain('Included in the code');
    button('Copy code').dispatch('click');
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith('ccib1:WITH');
    expect(toastText()).toContain('Share code copied');
  });

  it('shows a too-big error in the dialog', async () => {
    await boot();
    shareReply = () => ({
      status: 400,
      data: { error: 'too big', errorId: 'err.share.tooBig', errorParams: { chars: 40000, max: 32768 } },
    });
    byId.get('share')!.dispatch('click');
    await flush();
    expect(texts(top()).join('\n')).toContain('40000 characters; the limit is 32768');
  });

  it('renders in Turkish', async () => {
    await boot();
    const i18n = await import('../../src/core/i18n/index.js');
    i18n.setLanguage('tr');
    try {
      byId.get('share')!.dispatch('click');
      await flush();
      const share = texts(top()).join('\n');
      expect(share).toContain('Bu yapılandırmayı paylaş');
      expect(share).toContain('Koddan çıkarılanlar');
      button('Kapat').dispatch('click');
      await flush();
      byId.get('open-code')!.dispatch('click');
      await flush();
      const openText = texts(top()).join('\n');
      expect(openText).toContain('Bir paylaşım kodu aç');
      const english = Object.entries(enEditor)
        .filter(([k]) => k.startsWith('share.'))
        .flatMap(([, v]) => (typeof v === 'string' ? [v] : Object.values(v)))
        .filter((v) => v !== 'ccib1:…');
      for (const v of english) {
        expect(share, v).not.toContain(v);
        expect(openText, v).not.toContain(v);
      }
    } finally {
      i18n.setLanguage('en');
    }
  });
});
