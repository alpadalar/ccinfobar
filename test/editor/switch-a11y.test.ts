import { afterAll, beforeAll, describe, expect, it } from 'vitest';

class FakeEl {
  id = '';
  htmlFor = '';
  className = '';
  checked = false;
  disabled = false;
  type = '';
  readonly children: (FakeEl | string)[] = [];
  readonly attrs = new Map<string, string>();
  constructor(readonly tagName: string) {}
  get classList() {
    return { contains: (c: string) => this.className.split(' ').includes(c) };
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  addEventListener() {}
  append(...c: (FakeEl | string)[]) {
    this.children.push(...c);
  }
  querySelector(tag: string): FakeEl | null {
    for (const c of this.children) {
      if (typeof c === 'string') continue;
      if (c.tagName === tag.toUpperCase()) return c;
      const hit = c.querySelector(tag);
      if (hit) return hit;
    }
    return null;
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

describe('settings switches', () => {
  it('are named by the field title', async () => {
    const { field, toggle } = await import('../../src/editor/web/inspector.js');
    const f = field(
      'Hooks',
      toggle(true, () => {}),
      'hint',
      true,
    ) as unknown as FakeEl;
    const title = f.children[0] as FakeEl;
    const input = f.querySelector('input')!;
    expect(input.className).toBe('switch-input');
    expect(title.children).toEqual(['Hooks']);
    expect(title.id).not.toBe('');
    expect(input.getAttribute('aria-labelledby')).toBe(title.id);
  });

  it('leave plain inputs labelled by for/id', async () => {
    const { field } = await import('../../src/editor/web/inspector.js');
    const input = new FakeEl('INPUT');
    const f = field('Name', input as unknown as HTMLElement) as unknown as FakeEl;
    const title = f.children[0] as FakeEl;
    expect(title.htmlFor).toBe(input.id);
    expect(title.id).toBe('');
    expect(input.getAttribute('aria-labelledby')).toBeNull();
  });
});
