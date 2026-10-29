import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installBundled } from '../../src/core/i18n/bundled.js';
import { editorMessages as en } from '../../src/core/i18n/en/editor.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { editorMessages as tr } from '../../src/core/i18n/tr/editor.js';
import { setTipsHidden, TIPS_KEY } from '../../src/editor/web/tips.js';
import { FakeEl } from '../i18n/fake-dom.js';

const g = globalThis as any;
const KEYS = ['document', 'window', 'localStorage', 'HTMLElement'];
const saved = Object.fromEntries(KEYS.map((k) => [k, g[k]]));
const EN = en as Record<string, unknown> as Record<string, string>;
const TR = tr as Record<string, unknown> as Record<string, string>;
let store: Map<string, string>;

beforeAll(() => {
  installBundled();
  g.HTMLElement = FakeEl;
  g.document = { createElement: (tag: string) => new FakeEl(tag.toUpperCase()) };
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v;
});

beforeEach(() => {
  store = new Map();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  setLanguage('en');
});

// fake h() sets a true prop as an attribute
const isOn = (e: FakeEl) => e.checked || e.hasAttribute('checked');

async function build() {
  const { tipsField } = await import('../../src/editor/web/settings.js');
  const root = tipsField() as unknown as FakeEl;
  const input = root.all((e) => e.tagName === 'INPUT')[0]!;
  return { root, input };
}

describe('settings show tips', () => {
  it('is on when the tips are not hidden', async () => {
    const { input } = await build();
    expect(isOn(input)).toBe(true);
  });

  it('is off when the tips were hidden', async () => {
    store.set(TIPS_KEY, '1');
    const { input } = await build();
    expect(isOn(input)).toBe(false);
  });

  it('is off after hiding when localStorage throws', async () => {
    const deny = () => {
      throw new Error('denied');
    };
    g.localStorage = { getItem: deny, setItem: deny, removeItem: deny };
    try {
      setTipsHidden(true);
      const { input } = await build();
      expect(isOn(input)).toBe(false);
    } finally {
      g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
      setTipsHidden(false);
    }
  });

  it('flips localStorage and nothing else', async () => {
    const { input } = await build();
    input.checked = false;
    input.dispatch('change');
    expect(store.get(TIPS_KEY)).toBe('1');
    input.checked = true;
    input.dispatch('change');
    expect(store.has(TIPS_KEY)).toBe(false);
  });

  it('uses the localized label and help', async () => {
    let { root } = await build();
    expect(root.textContent).toContain(EN['web.settings.showTips']);
    expect(root.textContent).toContain(EN['web.settings.showTipsHelp']);
    setLanguage('tr');
    ({ root } = await build());
    expect(TR['web.settings.showTips']).toBe('İpuçlarını göster');
    expect(root.textContent).toContain(TR['web.settings.showTips']);
    expect(root.textContent).toContain(TR['web.settings.showTipsHelp']);
  });
});
