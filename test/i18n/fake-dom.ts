// minimal DOM for rendering editor code in node
export class FakeEl {
  id = '';
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
    return this.all((e) => e.tagName === sel.toUpperCase());
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
