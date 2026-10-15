import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { editorMessages as enEditor } from '../../src/core/i18n/en/editor.js';
import { inspectorMessages as enInspector } from '../../src/core/i18n/en/inspector.js';
import { themeEditorMessages as en } from '../../src/core/i18n/en/theme-editor.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { editorMessages as trEditor } from '../../src/core/i18n/tr/editor.js';
import { inspectorMessages as trInspector } from '../../src/core/i18n/tr/inspector.js';
import { themeEditorMessages as tr } from '../../src/core/i18n/tr/theme-editor.js';
import type { Message } from '../../src/core/i18n/types.js';
import { listPresets } from '../../src/core/presets.js';
import { STYLES } from '../../src/core/themes/style.js';
import { listThemes } from '../../src/core/themes.js';
import { CATEGORIES } from '../../src/widgets/index.js';
import { FakeEl, texts } from './fake-dom.js';

const g = globalThis as any;
const saved = {
  document: g.document,
  HTMLElement: g.HTMLElement,
  window: g.window,
  localStorage: g.localStorage,
  fetch: g.fetch,
  requestAnimationFrame: g.requestAnimationFrame,
  innerWidth: g.innerWidth,
  innerHeight: g.innerHeight,
};
let body: FakeEl;
const nowhere = path.join(__dirname, 'no-such-dir');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.window = { setTimeout: () => 0, addEventListener() {}, removeEventListener() {} };
  g.localStorage = { getItem: () => null, setItem() {} };
  g.requestAnimationFrame = () => 0;
  g.innerWidth = 1200;
  g.innerHeight = 800;
  g.fetch = async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('theme-previews') ? { previews: {} } : { lines: ['x'] }),
  });
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

const builtinThemes = () => clone(listThemes(nowhere));
const mine = () => ({
  ...builtinThemes().find((th) => th.id === 'classic')!,
  id: 'mine',
  name: 'Mine',
  description: 'My own words here',
  source: 'user' as const,
});
const myPreset = () => ({
  id: 'my-layout',
  name: 'My layout name',
  description: 'Shows my things',
  source: 'user' as const,
  config: { ...defaultConfig(), lines: [[{ id: 'a', type: 'model' }]] },
});

async function init(clip = false) {
  const store = await import('../../src/editor/web/store.js');
  store.init({
    config: defaultConfig(),
    savedConfig: defaultConfig(),
    categories: clone(CATEGORIES),
    widgets: [{ type: 'model', name: 'Model', description: 'Model name', category: 'session', options: [] }],
    themes: [...builtinThemes(), mine()],
    styles: clone(STYLES),
    styleHistory: { a: [{ color: 'red', bold: true, options: { short: true } }] },
    presets: [...listPresets(nowhere).map(({ build, ...p }) => ({ ...p, config: build() })), myPreset()],
    themesDir: '/tmp/themes',
    presetsDir: '/tmp/presets',
    version: '1.2.3',
  } as any);
  store.S.clip = clip ? { snap: { color: 'red' }, from: 'Model', type: 'model' } : null;
  return store;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function shown(lang: 'en' | 'tr', run: () => unknown): Promise<string[]> {
  setLanguage(lang);
  void run();
  await flush();
  await flush();
  return texts(body);
}

const english = new Set<string>(
  (
    [
      [en, tr],
      [enInspector, trInspector],
      [enEditor, trEditor],
    ] as [Record<string, Message>, Record<string, Message>][]
  ).flatMap(([e, x]) =>
    Object.entries(e)
      .filter(([id, v]) => JSON.stringify(x[id]) !== JSON.stringify(v))
      .flatMap(([, v]) => (typeof v === 'string' ? [v] : [v.one, v.other])),
  ),
);
// theme names stay as written (D-13)
const names = new Set(listThemes(nowhere).map((th) => th.name));
const foreign = (list: string[]) => list.filter((s) => english.has(s) && !names.has(s));
const button = (label: string) => body.all((e) => e.tagName === 'BUTTON' && e.textContent === label)[0]!;

describe('theme gallery text', () => {
  it('is Turkish with catalog descriptions and style names', async () => {
    await init();
    const { openGallery } = await import('../../src/editor/web/themes.js');
    const list = await shown('tr', openGallery);
    for (const s of [
      'Temalar',
      'Durum satırınız',
      'Tümü',
      'Metin',
      'Kapsül',
      'Her bileşen kendi renginde, ince çizgi ayraçlar',
      'Classic',
      'Classic temasını uygula',
      'kullanımda',
      'sizin',
      'Mine',
      'My own words here',
      'Mine temasını sil',
      'Temalarınızın yeri: /tmp/themes',
      'Yeni tema',
      'Tamam',
    ])
      expect(list).toContain(s);
    expect(foreign(list)).toEqual([]);
  });

  it('keeps the English text', async () => {
    await init();
    const { openGallery } = await import('../../src/editor/web/themes.js');
    const list = await shown('en', openGallery);
    for (const s of [
      'Themes',
      'Your status line',
      'All',
      'Text',
      'Each widget in its own color, thin bar separators',
      'Apply Classic',
      'current',
      'yours',
      'Edit theme',
      'Edit Mine JSON',
      'Delete Mine',
      'Click a theme to apply it; you can undo. Previews show each theme without your widget colors.',
      'Your themes live in /tmp/themes',
      'New theme',
      'Done',
    ])
      expect(list).toContain(s);
  });

  it('shows the empty preview note as text', async () => {
    const { previewBox } = await import('../../src/editor/web/presets.js');
    setLanguage('tr');
    expect(texts(previewBox([]) as any)).toEqual(['(boş)']);
    setLanguage('en');
    expect(texts(previewBox([]) as any)).toEqual(['(empty)']);
    expect((previewBox(undefined) as any).children).toEqual([]);
  });
});

describe('theme builder text', () => {
  const variants: [string, Record<string, unknown>][] = [
    ['widget', { mode: 'widget' }],
    ['category', { mode: 'category', categories: { git: 'green' } }],
    ['cycle', { mode: 'cycle', cycle: [{ fg: 'black', bg: 'cyan' }] }],
  ];

  it.each(variants)('%s colors are Turkish', async (_name, colors) => {
    const store = await init();
    const { openThemeBuilder } = await import('../../src/editor/web/theme-builder.js');
    const edit = { ...mine(), style: 'blocks' as const, gradient: ['red', 'blue'] };
    edit.colors = { ...(edit.colors as object), ...colors, categories: colors.categories ?? {} } as any;
    const list = await shown('tr', () => openThemeBuilder({ edit: edit as any }));
    expect(list).toContain('Mine temasını düzenle');
    expect(list).toContain('Dosya: mine.json');
    expect(list).toContain('Bloklar');
    expect(list).toContain('Renk geçişi');
    expect(list).toContain('Durak 1');
    if (colors.mode === 'category') expect(list).toContain('Git: metin');
    if (colors.mode === 'cycle') expect(list).toContain('Renk 1: arka plan rengi');
    expect(foreign(list)).toEqual([]);
    expect(store.S.api.themes.some((th) => th.id === 'mine')).toBe(true);
  });

  it('new theme from a built-in is Turkish', async () => {
    await init();
    const { openThemeBuilder } = await import('../../src/editor/web/theme-builder.js');
    const list = await shown('tr', () => openThemeBuilder({}));
    expect(list).toContain('Yeni tema');
    expect(list).toContain('Başlangıç teması');
    expect(list).toContain('Her bileşen kendi renginde, ince çizgi ayraçlar');
    expect(foreign(list)).toEqual([]);
  });

  it('keeps the English text', async () => {
    await init();
    const { openThemeBuilder } = await import('../../src/editor/web/theme-builder.js');
    const edit = { ...mine(), style: 'blocks' as const, gradient: ['red'] };
    edit.colors = { ...(edit.colors as object), mode: 'cycle', cycle: [{ fg: 'black', bg: 'cyan' }] } as any;
    const list = await shown('en', () => openThemeBuilder({ edit: edit as any }));
    for (const s of [
      'Edit Mine',
      'File: mine.json',
      'Color 1',
      'Color 1 background',
      'Color 1 background color',
      'Pick Color 1 text color',
      'Remove color 1',
      'Add color',
      'Text on blocks',
      'Separator',
      'Stop 1',
      'Gradient stop 1 color',
      'Remove gradient stop 1',
      'Add stop',
      'Gradient bars blend these colors from low to high',
      'Per widget',
      'Every widget keeps its own color',
      'Cycle',
      'Save theme',
      'Cancel',
      'none',
    ])
      expect(list).toContain(s);
  });
});

describe('presets gallery text', () => {
  it('is Turkish for built-ins and keeps user presets', async () => {
    await init();
    const { openPresets } = await import('../../src/editor/web/presets.js');
    const list = await shown('tr', openPresets);
    for (const s of [
      'Hazır ayarlar',
      'Varsayılan',
      'Kokpit',
      'Varsayılan hazır ayarını uygula',
      '1 satır',
      'My layout name',
      'Shows my things',
      'sizin',
      'My layout name hazır ayarını sil',
      'Hazır ayarlarınızın yeri: /tmp/presets',
      'Mevcut düzeni hazır ayar olarak kaydet',
    ])
      expect(list).toContain(s);
    expect(foreign(list)).toEqual([]);
  });

  it('applies built-in preset labels in the UI language', async () => {
    const store = await init();
    const { openPresets } = await import('../../src/editor/web/presets.js');
    await shown('tr', openPresets);
    body.all((e) => e.getAttribute('data-preset') === 'cockpit')[0]!.dispatch('click');
    await flush();
    const labels = store.S.config.lines.flat().flatMap((i) => (i.label ? [i.label] : []));
    expect(labels).toEqual(['Süre: ', '5h limiti: ', 'Haftalık limit: ']);
  });

  it('save dialog is Turkish', async () => {
    await init();
    const { openPresets } = await import('../../src/editor/web/presets.js');
    await shown('tr', openPresets);
    button('Mevcut düzeni hazır ayar olarak kaydet').dispatch('click');
    await flush();
    const list = texts(body);
    for (const s of ['Hazır ayar olarak kaydet', 'Düzenim', 'Ne gösterdiği', 'Harf, rakam, nokta, tire'])
      expect(list).toContain(s);
    expect(foreign(list)).toEqual([]);
  });

  it('keeps the English text', async () => {
    await init();
    const { openPresets } = await import('../../src/editor/web/presets.js');
    const list = await shown('en', openPresets);
    for (const s of [
      'Presets',
      'Default',
      'Apply Default',
      '1 line',
      'Delete preset',
      'Click a preset to apply it. You can undo.',
      'Your presets live in /tmp/presets',
      'Save current as preset',
      'Done',
    ])
      expect(list).toContain(s);
    expect(list.some((s) => /^\d+ lines$/.test(s))).toBe(true);
    button('Save current as preset').dispatch('click');
    await flush();
    expect(texts(body)).toEqual(
      expect.arrayContaining(['Save as preset', 'My layout', 'What it shows', 'Letters, numbers, dot, dash']),
    );
  });
});

describe('style tools text', () => {
  it('copy, paste, groups and earlier styles are Turkish', async () => {
    await init(true);
    const { recentStyles, styleTools } = await import('../../src/editor/web/styles.js');
    setLanguage('tr');
    const list = [...texts(styleTools('a') as any), ...texts(recentStyles('a') as any)];
    for (const s of [
      'Kopyala',
      'Stili kopyala (Ctrl+Alt+C)',
      'Kaynak: Model',
      'Renkler + metin',
      'Kalın, soluk, italik',
      'metin red, kalın, short true',
      'Bu önceki stili kullan: metin red, kalın, short true',
    ])
      expect(list).toContain(s);
    expect(foreign(list)).toEqual([]);
    setLanguage('en');
    const enList = [...texts(styleTools('a') as any), ...texts(recentStyles('a') as any)];
    for (const s of [
      'Copy',
      'Paste style (Ctrl+Alt+V)',
      'From Model',
      'Colors + text',
      'Bold, dim, italic',
      'Label switches',
      'text red, bold, short true',
    ])
      expect(enList).toContain(s);
  });

  it('chip menu is Turkish', async () => {
    await init(true);
    const { chipMenu } = await import('../../src/editor/web/styles.js');
    const ev = { preventDefault() {}, clientX: 0, clientY: 0 } as any;
    setLanguage('tr');
    chipMenu(ev, 'a', 0);
    const list = texts(body);
    expect(list).toEqual(expect.arrayContaining(['Stili kopyala', 'Stili tüm satıra yapıştır']));
    expect(foreign(list)).toEqual([]);
    setLanguage('en');
    chipMenu(ev, 'a', 0);
    expect(texts(body)).toEqual(expect.arrayContaining(['Paint other widgets…', 'Reset to theme look']));
  });
});

describe('terminal scheme names', () => {
  it('picker shows translated display words and product names', async () => {
    const { initTerminalPicker } = await import('../../src/editor/web/terminal-picker.js');
    for (const lang of ['tr', 'en'] as const) {
      const mount = new FakeEl('DIV');
      setLanguage(lang);
      initTerminalPicker(mount as any, { bg: '#101010', fg: null, palette: null });
      (mount.children[1] as FakeEl).hidden = true;
      (mount.children[0] as FakeEl).dispatch('click');
      const list = texts(mount);
      expect(list).toEqual(expect.arrayContaining(['Nord', 'Windows Terminal', 'Catppuccin Mocha']));
      if (lang === 'tr') {
        expect(list).toEqual(
          expect.arrayContaining(['Koyu (varsayılan)', 'Lacivert', 'Terminalim (algılandı)']),
        );
        expect(foreign(list)).toEqual([]);
      } else
        expect(list).toEqual(expect.arrayContaining(['Dark (default)', 'Navy', 'My terminal (detected)']));
    }
  });
});
