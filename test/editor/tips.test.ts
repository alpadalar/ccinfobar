import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBundled } from '../../src/core/i18n/bundled.js';
import { editorMessages as en } from '../../src/core/i18n/en/editor.js';
import { setLanguage } from '../../src/core/i18n/index.js';
import { editorMessages as tr } from '../../src/core/i18n/tr/editor.js';
import { initTips, setTipsHidden, TIP_MS, TIPS, TIPS_KEY, tipsHidden } from '../../src/editor/web/tips.js';
import { FakeEl } from '../i18n/fake-dom.js';

const g = globalThis as any;
const KEYS = ['document', 'window', 'localStorage'];
const saved = Object.fromEntries(KEYS.map((k) => [k, g[k]]));
const EN = en as Record<string, unknown> as Record<string, string>;
const TR = tr as Record<string, unknown> as Record<string, string>;
let reduced = false;
let store: Map<string, string>;

const tip = (id: string) => EN[id]!.replaceAll('{mod}', 'Ctrl');

beforeAll(() => {
  installBundled();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  g.document = { createElement: (tag: string) => new FakeEl(tag.toUpperCase()) };
  g.window = {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    matchMedia: (q: string) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' }),
  };
  vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
});

afterAll(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  reduced = false;
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

afterEach(() => {
  vi.clearAllTimers();
});

const text = (host: FakeEl) => host.all((e) => e.classList.contains('tip-text'))[0]!.textContent;
const button = (host: FakeEl, label: string) => host.all((e) => e.attrs.get('aria-label') === label)[0]!;

describe('tips line', () => {
  it('rotates through the tips', () => {
    const host = new FakeEl('DIV');
    initTips(host as any);
    expect(host.hidden).toBe(false);
    expect(host.getAttribute('role')).toBe('note');
    expect(text(host)).toBe(tip(TIPS[0]!));
    vi.advanceTimersByTime(TIP_MS);
    expect(text(host)).toBe(tip(TIPS[1]!));
  });

  it('pauses while hovered or focused', () => {
    const host = new FakeEl('DIV');
    initTips(host as any);
    host.dispatch('pointerenter');
    vi.advanceTimersByTime(TIP_MS * 3);
    expect(text(host)).toBe(tip(TIPS[0]!));
    host.dispatch('pointerleave');
    vi.advanceTimersByTime(TIP_MS);
    expect(text(host)).toBe(tip(TIPS[1]!));
    host.dispatch('focusin');
    vi.advanceTimersByTime(TIP_MS * 3);
    expect(text(host)).toBe(tip(TIPS[1]!));
    host.dispatch('focusout');
    vi.advanceTimersByTime(TIP_MS);
    expect(text(host)).toBe(tip(TIPS[2]!));
  });

  it('does not rotate under reduced motion, next still works', () => {
    reduced = true;
    const host = new FakeEl('DIV');
    initTips(host as any);
    vi.advanceTimersByTime(TIP_MS * 3);
    expect(text(host)).toBe(tip(TIPS[0]!));
    button(host, en['web.tips.next']).dispatch('click');
    expect(text(host)).toBe(tip(TIPS[1]!));
    vi.advanceTimersByTime(TIP_MS * 3);
    expect(text(host)).toBe(tip(TIPS[1]!));
  });

  it('wraps around with next', () => {
    const host = new FakeEl('DIV');
    initTips(host as any);
    const next = button(host, en['web.tips.next']);
    for (let i = 0; i < TIPS.length; i++) next.dispatch('click');
    expect(text(host)).toBe(tip(TIPS[0]!));
  });

  it('dismisses and remembers it', () => {
    const host = new FakeEl('DIV');
    initTips(host as any);
    button(host, en['web.tips.dismiss']).dispatch('click');
    expect(host.hidden).toBe(true);
    expect(store.get(TIPS_KEY)).toBe('1');
    expect(vi.getTimerCount()).toBe(0);
    const again = new FakeEl('DIV');
    initTips(again as any);
    expect(again.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows again after being hidden and rotates', () => {
    const host = new FakeEl('DIV');
    initTips(host as any);
    button(host, en['web.tips.dismiss']).dispatch('click');
    expect(host.hidden).toBe(true);
    setTipsHidden(false);
    expect(store.has(TIPS_KEY)).toBe(false);
    expect(host.hidden).toBe(false);
    expect(text(host)).toBe(tip(TIPS[0]!));
    vi.advanceTimersByTime(TIP_MS);
    expect(text(host)).toBe(tip(TIPS[1]!));
  });

  it('shows after a hidden page load', () => {
    store.set(TIPS_KEY, '1');
    expect(tipsHidden()).toBe(true);
    const host = new FakeEl('DIV');
    initTips(host as any);
    expect(host.hidden).toBe(true);
    setTipsHidden(false);
    expect(host.hidden).toBe(false);
    expect(tipsHidden()).toBe(false);
    vi.advanceTimersByTime(TIP_MS);
    expect(text(host)).toBe(tip(TIPS[1]!));
  });

  it('setTipsHidden(true) acts like the dismiss button', () => {
    const host = new FakeEl('DIV');
    initTips(host as any);
    setTipsHidden(true);
    expect(store.get(TIPS_KEY)).toBe('1');
    expect(host.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(TIP_MS * 3);
    expect(text(host)).toBe(tip(TIPS[0]!));
  });

  it('setTipsHidden survives a throwing localStorage', () => {
    const host = new FakeEl('DIV');
    initTips(host as any);
    g.localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => setTipsHidden(true)).not.toThrow();
    expect(host.hidden).toBe(true);
    expect(() => setTipsHidden(false)).not.toThrow();
    expect(host.hidden).toBe(false);
  });

  it('survives a throwing localStorage', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const host = new FakeEl('DIV');
    expect(() => initTips(host as any)).not.toThrow();
    expect(host.hidden).toBe(false);
    expect(() => button(host, en['web.tips.dismiss']).dispatch('click')).not.toThrow();
    expect(host.hidden).toBe(true);
  });

  it('relabels in the active language', () => {
    const host = new FakeEl('DIV');
    const { relabel } = initTips(host as any);
    setLanguage('tr');
    relabel();
    expect(text(host)).toBe(TR[TIPS[0]!]!.replaceAll('{mod}', 'Ctrl'));
    expect(button(host, tr['web.tips.next'])).toBeDefined();
    expect(host.textContent).toContain(tr['web.tips.label']);
  });

  it('uses Cmd on a Mac', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const host = new FakeEl('DIV');
    initTips(host as any);
    button(host, en['web.tips.next']).dispatch('click');
    expect(text(host)).toContain('Cmd+C');
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
  });

  it('every tip has English and Turkish text', () => {
    for (const id of [...TIPS, 'web.tips.label', 'web.tips.next', 'web.tips.dismiss']) {
      const e = EN[id];
      const t = TR[id];
      expect(e, id).toBeTruthy();
      expect(t, id).toBeTruthy();
      expect(t, id).not.toBe(e);
    }
  });
});
