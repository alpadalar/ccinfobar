import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';

class FakeEl {
  id = '';
  htmlFor = '';
  className = '';
  checked = false;
  disabled = false;
  type = '';
  value = '';
  title = '';
  placeholder = '';
  innerHTML = '';
  readonly children: (FakeEl | string)[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string) {}
  get classList() {
    return {
      contains: (c: string) => this.className.split(' ').includes(c),
      toggle: (c: string, on: boolean) => {
        const list = this.className.split(' ').filter((x) => x && x !== c);
        if (on) list.push(c);
        this.className = list.join(' ');
      },
    };
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  append(...c: (FakeEl | string)[]) {
    this.children.push(...c);
  }
  all(pred: (e: FakeEl) => boolean): FakeEl[] {
    const out: FakeEl[] = [];
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (pred(c)) out.push(c);
      out.push(...c.all(pred));
    }
    return out;
  }
  querySelector(tag: string): FakeEl | null {
    return this.all((e) => e.tagName === tag.toUpperCase())[0] ?? null;
  }
}

const g = globalThis as any;
const saved = { document: g.document, HTMLElement: g.HTMLElement };

beforeAll(() => {
  g.HTMLElement = FakeEl;
  g.document = { createElement: (tag: string) => new FakeEl(tag.toUpperCase()) };
});

afterAll(() => {
  g.document = saved.document;
  g.HTMLElement = saved.HTMLElement;
});

const THEMES = [
  { id: 'classic', name: 'Classic' },
  { id: 'nord', name: 'Nord' },
  { id: 'dracula', name: 'Dracula' },
  { id: 'tokyo-night', name: 'Tokyo Night' },
];

async function build(start: Config) {
  const { rotationFields } = await import('../../src/editor/web/settings.js');
  const state = { config: start, keys: [] as (string | undefined)[] };
  const root = new FakeEl('DIV');
  root.append(
    ...(rotationFields(start, THEMES, (fn, key) => {
      state.config = fn(state.config);
      state.keys.push(key);
    }) as unknown as FakeEl[]),
  );
  const byLabel = (label: string) => root.all((e) => e.getAttribute('aria-label') === label)[0]!;
  const pick = (label: string, v: string) => {
    const el = byLabel(label);
    el.value = v;
    el.fire('change');
  };
  return { root, state, byLabel, pick };
}

const withRotation = (themeRotation: Config['themeRotation']): Config => ({
  ...defaultConfig(),
  theme: 'classic',
  themeRotation,
});

describe('settings theme rotation', () => {
  it('adds a theme from the select', async () => {
    const t = await build(defaultConfig());
    expect(t.root.all((e) => e.classList.contains('rotation-row'))).toHaveLength(0);
    t.pick('Add theme…', 'nord');
    expect(t.state.config.themeRotation).toEqual({ themes: ['nord'] });
    expect(t.root.textContent).not.toContain('Now:');
  });

  it('moves and removes themes', async () => {
    const t = await build(withRotation({ themes: ['nord', 'dracula'] }));
    expect(t.root.all((e) => e.classList.contains('rotation-row'))).toHaveLength(2);
    expect(t.byLabel('Move Nord up').getAttribute('disabled')).toBe('');
    t.byLabel('Move Dracula up').fire('click');
    expect(t.state.config.themeRotation).toEqual({ themes: ['dracula', 'nord'] });
    const r = await build(withRotation({ themes: ['nord', 'dracula'] }));
    r.byLabel('Move Nord down').fire('click');
    expect(r.state.config.themeRotation?.themes).toEqual(['dracula', 'nord']);
    const d = await build(withRotation({ themes: ['nord'] }));
    d.byLabel('Remove Nord').fire('click');
    expect(d.state.config.themeRotation).toBeUndefined();
  });

  it('sets custom minutes, shuffle and a weekday', async () => {
    const t = await build(withRotation({ themes: ['nord', 'dracula'] }));
    t.pick('Change', 'custom');
    expect(t.state.config.themeRotation?.every).toBe(30);
    const c = await build(t.state.config);
    const min = c.byLabel('Minutes');
    min.value = '45';
    min.fire('input');
    expect(c.state.config.themeRotation?.every).toBe(45);
    expect(c.state.keys).toEqual(['themeRotation.every']);
    min.value = '0';
    min.fire('input');
    expect(c.state.config.themeRotation?.every).toBe(45);
    c.pick('Order', 'shuffle');
    c.pick('Monday', 'tokyo-night');
    expect(c.state.config.themeRotation).toEqual({
      themes: ['nord', 'dracula'],
      every: 45,
      order: 'shuffle',
      weekdays: { mon: 'tokyo-night' },
    });
    c.pick('Monday', '');
    c.pick('Change', 'day');
    c.pick('Order', 'cycle');
    expect(c.state.config.themeRotation).toEqual({ themes: ['nord', 'dracula'] });
  });

  it('marks unknown ids and names the active theme', async () => {
    const t = await build(withRotation({ themes: ['ghost', 'nord'] }));
    const rows = t.root.all((e) => e.classList.contains('rotation-row'));
    expect(rows[0]!.textContent).toContain('missing');
    expect(rows[1]!.textContent).not.toContain('missing');
    expect(t.root.textContent).toContain('Now: Nord · next change ');
  });

  it('turns rotation off', async () => {
    const t = await build(withRotation({ themes: ['nord'], weekdays: { fri: 'dracula' } }));
    const off = t.root.all((e) => e.tagName === 'BUTTON' && e.textContent === 'Turn off')[0]!;
    off.fire('click');
    expect('themeRotation' in t.state.config).toBe(false);
  });
});
