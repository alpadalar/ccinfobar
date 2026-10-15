import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { editorMessages as en } from '../../src/core/i18n/en/editor.js';
import { en as enAll } from '../../src/core/i18n/en/index.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { editorMessages as tr } from '../../src/core/i18n/tr/editor.js';
import { PROFILES } from '../../src/core/profiles.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';
import { CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl, texts } from './fake-dom.js';

const g = globalThis as any;
const saved = {
  document: g.document,
  HTMLElement: g.HTMLElement,
  window: g.window,
  localStorage: g.localStorage,
  fetch: g.fetch,
};
let body: FakeEl;
let system: Record<string, unknown>;

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.fetch = async () => ({ ok: true, json: async () => system });
});

beforeEach(() => {
  body = new FakeEl('BODY');
  const toasts = new FakeEl('DIV');
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
});

const hooks = (available: boolean) => ({
  installed: available ? ['Stop'] : [],
  available,
  reason: 'Hooks need Claude Code 2.1.0 or newer',
  claudeCode: available ? '2.1.5' : undefined,
  events: ['Stop', 'SubagentStop'],
  optional: ['PermissionRequest'],
  progress: [],
});

async function init(config: Config, installed: boolean, available: boolean) {
  const store = await import('../../src/editor/web/store.js');
  const claude = {
    statusLine: installed ? { command: 'ccinfobar', refreshInterval: 5 } : null,
    installed,
    defaultCommand: 'ccinfobar',
    settingsFile: '/tmp/settings.json',
  };
  store.init({
    config,
    savedConfig: config,
    categories: JSON.parse(JSON.stringify(CATEGORIES)),
    widgets: [],
    themes: JSON.parse(JSON.stringify(listThemes(path.join(__dirname, 'no-such-themes-dir')))),
    styles: JSON.parse(JSON.stringify(STYLES)),
    styleHistory: {},
    claude,
    hooks: hooks(available),
    presets: [],
    version: '1.2.3',
  } as any);
  system = {
    version: '1.2.3',
    kind: 'npm-global',
    update: available ? { checkedAt: Date.UTC(2026, 9, 14, 12), latest: null } : null,
    claude,
    hooks: hooks(available),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function shown(lang: 'en' | 'tr', run: () => unknown): Promise<string[]> {
  setLanguage(lang);
  void run();
  await flush();
  await flush();
  return texts(body);
}

const cfg = (p: Partial<Config> = {}): Config => ({
  ...defaultConfig(),
  profiles: { models: [{ match: 'glm-*', label: 'GLM' }] },
  ...p,
});

const english = new Set<string>(
  Object.entries(en)
    .filter(([id, v]) => tr[id as keyof typeof tr] !== v)
    .flatMap(([, v]) => (typeof v === 'string' ? [v] : [v.one, v.other])),
);
const foreign = (list: string[]) => list.filter((s) => english.has(s));

const SETTINGS: [string, boolean, boolean][] = [
  ['installed, hooks available', true, true],
  ['not installed, no hooks', false, false],
];

describe('web settings text', () => {
  it.each(SETTINGS)('%s shows no English editor text in Turkish', async (_name, installed, available) => {
    await init(cfg(), installed, available);
    const { openSettings } = await import('../../src/editor/web/settings.js');
    const list = await shown('tr', openSettings);
    expect(list).toContain('Ayarlar');
    expect(list).toContain('Güncellemeler');
    expect(foreign(list)).toEqual([]);
  });

  it('keeps the English text', async () => {
    await init(cfg(), true, true);
    const { openSettings } = await import('../../src/editor/web/settings.js');
    const list = await shown('en', openSettings);
    for (const s of [
      'Settings',
      'Claude Code',
      'Claude Code uses ccinfobar.',
      'Command: ccinfobar, refresh every 5s. Saving is enough; Claude Code picks up changes on its next refresh.',
      'Change command or refresh',
      'Hooks',
      'Permission requests',
      'Install automatically',
      'Tell me',
      'Never checks',
      'Check now',
      'Loading text',
      'Usage from Claude',
      'Daily budget (USD)',
      'Warn at (%)',
      'Model profiles',
      'Built-in models',
      'Model match',
      'Cache read price',
      'Remove glm-*',
      'Add model',
      'Done',
    ])
      expect(list).toContain(s);
    expect(list.join('\n')).toContain(
      'Optional. Records Stop, SubagentStop so live widgets are exact; every widget also works without hooks. Claude Code 2.1.5.',
    );
    expect(list.join('\n')).toContain('This is ccinfobar 1.2.3, global npm install; last checked ');
    expect(list).toContain('in 1.4, out 4.4, cache read 0.26 USD');
    expect(list).toContain('CNY prices not verified');
  });

  it('translates the built-in profile notes and words', async () => {
    await init(cfg(), false, false);
    const { openSettings } = await import('../../src/editor/web/settings.js');
    const list = await shown('tr', openSettings);
    expect(list).toContain('CNY fiyatları doğrulanmadı');
    expect(list).toContain('girdi 1.4, çıktı 4.4, önbellek okuma 0.26 USD');
    expect(list).toContain('Bu ccinfobar 1.2.3, global npm kurulumu; henüz denetlenmedi.');
    for (const s of ['glm-*', 'GLM', 'USD', 'Claude Code']) expect(list).toContain(s);
  });

  it('has a note id for every built-in vendor note', () => {
    for (const v of PROFILES) {
      if (!v.priceNote) continue;
      expect((enAll as Record<string, unknown>)[`web.profile.note.${v.id}`], v.id).toBe(v.priceNote);
    }
  });
});

describe('web dialogs text', () => {
  it.each([true, false])('install dialog (installed %s) is Turkish', async (installed) => {
    await init(cfg(), installed, true);
    const { installDialog } = await import('../../src/editor/web/install-dialog.js');
    const list = await shown('tr', installDialog);
    expect(list).toContain("Claude Code'a kur");
    expect(list).toContain('/tmp/settings.json dosyasına yazılacak');
    expect(foreign(list)).toEqual([]);
  });

  it('install dialog keeps the English text', async () => {
    await init(cfg(), false, true);
    const { installDialog } = await import('../../src/editor/web/install-dialog.js');
    const list = await shown('en', installDialog);
    for (const s of [
      'Install in Claude Code',
      'No status line is configured yet.',
      'Command',
      'Refresh interval (seconds, optional)',
      'Will be written to /tmp/settings.json',
      'Cancel',
      'Install',
      'Close',
    ])
      expect(list).toContain(s);
  });

  it('confirm dialog defaults follow the language', async () => {
    const { confirmDialog } = await import('../../src/editor/web/ui.js');
    expect(await shown('tr', () => confirmDialog('Başlık', 'Metin'))).toEqual(
      expect.arrayContaining(['Kapat', 'İptal', 'Devam']),
    );
    body.children = [];
    expect(await shown('en', () => confirmDialog('Title', 'Text'))).toEqual(
      expect.arrayContaining(['Close', 'Cancel', 'Continue']),
    );
  });

  it('terminal picker is Turkish', async () => {
    const { initTerminalPicker } = await import('../../src/editor/web/terminal-picker.js');
    for (const lang of ['tr', 'en'] as const) {
      const mount = new FakeEl('DIV');
      setLanguage(lang);
      initTerminalPicker(mount as any, null);
      const button = mount.children[0] as FakeEl;
      const panel = mount.children[1] as FakeEl;
      button.dispatch('click');
      const list = texts(mount);
      if (lang === 'tr') {
        expect(list).toContain('Önizlemede kullanılan terminal renkleri');
        expect(foreign(list)).toEqual([]);
      } else expect(list).toContain('Terminal colors used for the preview');
      expect(panel.getAttribute('aria-label')).toBe(lang === 'tr' ? 'Terminal renkleri' : 'Terminal colors');
    }
  });

  it('color picker is Turkish and keeps color names', async () => {
    const { colorPicker } = await import('../../src/editor/web/colors.js');
    setLanguage('tr');
    const tr1 = texts(colorPicker({ value: undefined, fallback: 'cyan', onChange() {} }) as any);
    expect(tr1).toEqual(expect.arrayContaining(['Varsayılan (cyan)', 'Özel renk', 'Hex renk seç', 'red']));
    expect(tr1).toContain('Varsayılan renk ');
    expect(foreign(tr1)).toEqual([]);
    setLanguage('en');
    const en1 = texts(colorPicker({ value: undefined, fallback: 'cyan', onChange() {} }) as any);
    expect(en1).toEqual(expect.arrayContaining(['Default (cyan)', 'Custom color', 'Using default ', 'red']));
  });
});
