// minimal DOM for rendering editor code in node
export class FakeEl {
  id = '';
  lang = '';
  htmlFor = '';
  className = '';
  value = '';
  hidden = false;
  checked = false;
  disabled = false;
  type = '';
  scrollTop = 0;
  dataset: Record<string, string> = {};
  children: (FakeEl | string)[] = [];
  readonly attrs = new Map<string, string>();
  constructor(readonly tagName: string) {}
  get classList() {
    const list = () => this.className.split(' ').filter(Boolean);
    return {
      contains: (c: string) => list().includes(c),
      add: (c: string) => {
        this.className = [...new Set([...list(), c])].join(' ');
      },
      remove: (c: string) => {
        this.className = list()
          .filter((x) => x !== c)
          .join(' ');
      },
      toggle: (c: string, on?: boolean) => {
        const want = on ?? !list().includes(c);
        if (want) this.classList.add(c);
        else this.classList.remove(c);
        return want;
      },
    };
  }
  get textContent(): string {
    return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v: string) {
    this.children = [v];
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  style = { cssText: '', setProperty() {} };
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  dispatch(type: string, e: unknown = { target: this, stopPropagation() {}, preventDefault() {} }) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  focus() {}
  click() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  remove() {
    const list = this.parent?.children;
    if (list) list.splice(list.indexOf(this), 1);
    this.parent = null;
  }
  contains(other: unknown): boolean {
    return other === this || this.all((e) => e === other).length > 0;
  }
  prepend(...c: (FakeEl | string)[]) {
    for (const x of c) if (typeof x !== 'string') x.parent = this;
    this.children.unshift(...c);
  }
  parent: FakeEl | null = null;
  append(...c: (FakeEl | string)[]) {
    for (const x of c) if (typeof x !== 'string') x.parent = this;
    this.children.push(...c);
  }
  replaceChildren(...c: (FakeEl | string)[]) {
    this.children = [];
    this.append(...c);
  }
  after(...c: FakeEl[]) {
    const list = this.parent?.children;
    if (!list) return;
    for (const x of c) x.parent = this.parent;
    list.splice(list.indexOf(this) + 1, 0, ...c);
  }
  querySelector(sel: string): FakeEl | null {
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    return this.all((e) => (cls ? e.classList.contains(cls) : e.tagName === sel.toUpperCase()))[0] ?? null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const attr = /^\[([\w-]+)\]$/.exec(sel)?.[1];
    return this.all((e) => (attr ? e.attrs.has(attr) : e.tagName === sel.toUpperCase()));
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

// every text node and every title, placeholder and aria-label
export function texts(el: FakeEl): string[] {
  const out: string[] = [];
  const walk = (e: FakeEl) => {
    for (const k of ['title', 'placeholder', 'aria-label']) {
      const v = e.getAttribute(k) ?? (k === 'title' ? (e as { title?: string }).title : null);
      if (v) out.push(v);
    }
    for (const c of e.children) {
      if (typeof c === 'string') out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr']);
const ENTITIES: Record<string, string> = {
  hellip: '…',
  gt: '>',
  lt: '<',
  amp: '&',
  nbsp: '\u00a0',
  quot: '"',
};

const decode = (s: string) => s.replace(/&(\w+);/g, (m, k: string) => ENTITIES[k] ?? m);
export type HtmlNode = { el: FakeEl; tag: string; attrs: Map<string, string>; elements: number };
export type HtmlText = { text: string; stack: HtmlNode[] };

// index.html as FakeEl, with every element and text node
export function parseHtml(src: string): { root: FakeEl; nodes: HtmlNode[]; textNodes: HtmlText[] } {
  const root = new FakeEl('ROOT');
  const stack: HtmlNode[] = [];
  const nodes: HtmlNode[] = [];
  const textNodes: HtmlText[] = [];
  const top = () => stack[stack.length - 1]?.el ?? root;
  for (const m of src.matchAll(/<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const text = decode(m[4]);
      top().append(text);
      if (text.trim()) textNodes.push({ text: text.trim(), stack: [...stack] });
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      while (stack.length && stack.pop()!.tag !== tag) {}
      continue;
    }
    const attrs = new Map<string, string>();
    for (const a of m[3]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs.set(a[1]!, decode(a[2] ?? ''));
    const el = new FakeEl(tag.toUpperCase());
    for (const [k, v] of attrs) el.setAttribute(k, v);
    el.id = attrs.get('id') ?? '';
    el.className = attrs.get('class') ?? '';
    el.hidden = attrs.has('hidden');
    const parent = stack[stack.length - 1];
    if (parent) parent.elements++;
    top().append(el);
    const node: HtmlNode = { el, tag, attrs, elements: 0 };
    nodes.push(node);
    if (!VOID.has(tag)) stack.push(node);
  }
  return { root, nodes, textNodes };
}
