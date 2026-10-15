import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { OptionSpec, WidgetItem } from '../../src/core/types.js';
import { getWidget } from '../../src/widgets/index.js';

class FakeEl {
  id = '';
  htmlFor = '';
  className = '';
  value = '';
  hidden = false;
  children: (FakeEl | string)[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, (() => void)[]>();
  constructor(readonly tagName: string) {}
  get classList() {
    return { contains: (c: string) => this.className.split(' ').includes(c) };
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
  replaceChildren(...c: (FakeEl | string)[]) {
    this.children = [...c];
  }
  querySelector(): FakeEl | null {
    return null;
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

const spec = (key: string): OptionSpec => getWidget('http')!.options!.find((o) => o.key === key)!;

async function control(key: string, value: string, others: Record<string, string> = {}) {
  const { optionControl } = await import('../../src/editor/web/inspector.js');
  const store = await import('../../src/editor/web/store.js');
  const item: WidgetItem = { id: 'h', type: 'http', options: { ...others, [key]: value } };
  const config = { ...defaultConfig(), lines: [[item]] };
  store.init({ config, savedConfig: config, categories: [], widgets: [] } as any);
  const el = optionControl(item, spec(key)) as unknown as FakeEl;
  const error = () => {
    const e = el.all((x) => x.classList.contains('field-error'))[0];
    return e && !e.hidden ? e.textContent : '';
  };
  const input = el.all((x) => x.tagName === 'INPUT')[0]!;
  const type = (v: string) => {
    input.value = v;
    input.fire('input');
  };
  return { error, type };
}

describe('editor http option validation', () => {
  it('shows the path parse error under the path field', async () => {
    const c = await control('path', '$.foo-bar');
    expect(c.error()).toBe("unexpected '-' at 5; use ['foo-bar']");
    c.type('$.data.balance');
    expect(c.error()).toBe('');
    c.type('$..x');
    expect(c.error()).toContain("recursive descent '..'");
  });

  it('shows the url error for a placeholder in the host', async () => {
    const c = await control('url', 'https://${H}.x.com');
    expect(c.error()).toBe('placeholders are only allowed in query values');
    c.type('https://api.x.com/v1?key=${API_KEY}');
    expect(c.error()).toBe('');
    c.type('');
    expect(c.error()).toBe('');
  });

  it('shows the header error for a literal value, never the value', async () => {
    const c = await control('headers', 'Authorization=Bearer abc');
    expect(c.error()).toContain("header 'Authorization': literal values are not allowed");
    expect(c.error()).not.toContain('abc');
    c.type('Authorization=Bearer $RELAY_TOKEN, X-Key=${K}');
    expect(c.error()).toBe('');
  });

  it('flags env values over plain http on the url and headers fields', async () => {
    const url = await control('url', 'http://api.x.com/v1?key=${API_KEY}');
    expect(url.error()).toBe('secrets need https or localhost');
    url.type('http://localhost:8080/v1?key=${API_KEY}');
    expect(url.error()).toBe('');
    const withHeaders = await control('url', 'http://api.x.com/v1', { headers: 'X-Key=$K' });
    expect(withHeaders.error()).toBe('secrets need https or localhost');
    const headers = await control('headers', 'X-Key=$K', { url: 'http://api.x.com/v1' });
    expect(headers.error()).toBe('secrets need https or localhost');
    headers.type('');
    expect(headers.error()).toBe('');
  });

  it('flags denied env names on the field that uses them', async () => {
    const headers = await control('headers', 'X-Key=$ANTHROPIC_API_KEY', { url: 'https://x.example/v1' });
    expect(headers.error()).toBe('env ANTHROPIC_API_KEY is not allowed in http items');
    headers.type('X-Key=$RELAY_TOKEN');
    expect(headers.error()).toBe('');
    const url = await control('url', 'https://x.example/v1?k=${AWS_SECRET_ACCESS_KEY}');
    expect(url.error()).toBe('env AWS_SECRET_ACCESS_KEY is not allowed in http items');
    const other = await control('url', 'https://x.example/v1', { headers: 'X-Key=$NPM_TOKEN' });
    expect(other.error()).toBe('');
  });

  it('shows no error for other widgets or options', async () => {
    const c = await control('format', '{value');
    expect(c.error()).toBe('');
  });

  it('imports only the pure validators', () => {
    const src = fs.readFileSync(new URL('../../src/editor/web/inspector.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from 'node:/);
    expect(src).toContain("from '../../core/http-spec.js'");
    expect(src).toContain("from '../../core/jsonpath.js'");
  });
});
