import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config, WidgetItem } from '../../src/core/types.js';
import { getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

class FakeEl {
  id = '';
  htmlFor = '';
  className = '';
  checked = false;
  disabled = false;
  hidden = false;
  type = '';
  value: unknown = '';
  readonly children: (FakeEl | string)[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string) {}
  get classList() {
    return { contains: (c: string) => this.className.split(' ').includes(c) };
  }
  querySelector(tag: string) {
    return this.find(tag);
  }
  setAttribute(k: string, v: string) {
    if (k === 'checked') this.checked = true;
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(name: string, fn: () => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  fire(name: string) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  append(...c: (FakeEl | string)[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: (FakeEl | string)[]) {
    this.children.length = 0;
    this.children.push(...c);
  }
  find(tag: string): FakeEl | null {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.tagName === tag.toUpperCase()) return c;
      const hit = c.find(tag);
      if (hit) return hit;
    }
    return null;
  }
  text(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.text())).join('');
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

async function control(item: WidgetItem, key: string) {
  const store = await import('../../src/editor/web/store.js');
  const { optionControl } = await import('../../src/editor/web/inspector.js');
  const config: Config = { ...defaultConfig(), lines: [[item]] };
  store.init({ config, savedConfig: config, categories: [], widgets: [] } as any);
  const spec = getWidget(item.type)!.options!.find((o) => o.key === key)!;
  const el = withLang('en', () => optionControl(item, spec)) as unknown as FakeEl;
  return { el, store };
}

describe('web inspector with option aliases', () => {
  it('shows an old-name number under the canonical option and writes the canonical key', async () => {
    const { el, store } = await control(
      { id: 'a', type: 'jj-bookmarks', options: { maxBookmarks: 7 } },
      'maxItems',
    );
    const input = el.find('input')!;
    expect(input.value).toBe('7');
    input.value = '2';
    input.fire('input');
    input.fire('change');
    const saved = store.S.config.lines[0]![0]!;
    expect(saved.options).toEqual({ maxItems: 2 });
  });

  it('inverted option: label and state, fresh item', async () => {
    const { el } = await control({ id: 'a', type: 'compactions' }, 'hideZero');
    expect(el.text()).toContain('Hide when zero');
    expect(el.find('input')!.checked).toBe(true);
  });

  it('inverted option: label and state, old showZero true', async () => {
    const { el, store } = await control(
      { id: 'a', type: 'compactions', options: { showZero: true } },
      'hideZero',
    );
    expect(el.text()).toContain('Hide when zero');
    const input = el.find('input')!;
    expect(input.checked).toBe(false);
    input.checked = true;
    input.fire('change');
    const opts = store.S.config.lines[0]![0]!.options ?? {};
    expect('showZero' in opts).toBe(false);
  });

  it('writes hideZero when turned away from the default', async () => {
    const { el, store } = await control(
      { id: 'a', type: 'compactions', options: { showZero: true } },
      'hideZero',
    );
    const input = el.find('input')!;
    // old showZero:true shows OFF; a fresh toggle on then off writes hideZero:false
    input.checked = true;
    input.fire('change');
    input.checked = false;
    input.fire('change');
    expect(store.S.config.lines[0]![0]!.options).toEqual({ hideZero: false });
  });
});
