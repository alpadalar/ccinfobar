import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/types.js';
import { SUBAGENT_FIELDS } from '../../src/widgets/shared.js';
import { withLang } from '../helpers.js';

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

const ALL = [...SUBAGENT_FIELDS] as string[];

async function build(start: Config, lang?: 'tr') {
  const { subagentRows } = await import('../../src/editor/web/settings.js');
  const state = { config: start, applied: 0 };
  const make = () =>
    subagentRows(start, ALL, (fn) => {
      state.config = fn(state.config);
      state.applied++;
    }) as unknown as FakeEl[];
  const root = new FakeEl('DIV');
  root.append(...(lang ? withLang(lang, make) : make()));
  const rows = root.all((e) => e.classList.contains('rotation-row'));
  const input = (i: number) => rows[i]!.all((e) => e.tagName === 'INPUT')[0]!;
  const byLabel = (label: string) => root.all((e) => e.getAttribute('aria-label') === label)[0]!;
  return { root, state, rows, input, byLabel };
}

describe('settings subagent rows', () => {
  it('shows nine rows in default order, all on', async () => {
    const t = await build(defaultConfig());
    expect(t.rows).toHaveLength(9);
    expect(t.rows[0]!.textContent).toContain('Status');
    expect(t.rows[8]!.textContent).toContain('Elapsed');
    expect(t.input(0).getAttribute('checked')).toBe('');
    expect(t.byLabel('Move Status up').getAttribute('disabled')).toBe('');
    expect(t.byLabel('Move Elapsed down').getAttribute('disabled')).toBe('');
  });

  it('switching a field off applies setSubagentField', async () => {
    const t = await build(defaultConfig());
    const spark = t.input(3);
    spark.checked = false;
    spark.fire('change');
    expect(t.state.config.subagentLine?.fields).toEqual(ALL.filter((f) => f !== 'spark'));
  });

  it('disables the switch of the last enabled field', async () => {
    const t = await build({ ...defaultConfig(), subagentLine: { fields: ['label'] } });
    expect(t.rows[0]!.textContent).toContain('Label');
    expect(t.input(0).getAttribute('disabled')).toBe('');
    expect(t.rows).toHaveLength(9);
  });

  it('moves a field up and ignores the first row', async () => {
    const t = await build(defaultConfig());
    t.byLabel('Move Agent type up').fire('click');
    expect(t.state.config.subagentLine?.fields?.slice(0, 2)).toEqual(['type', 'status']);
    const f = await build(defaultConfig());
    f.byLabel('Move Status up').fire('click');
    expect(f.state.applied).toBe(0);
  });

  it('localizes names in tr', async () => {
    const t = await build(defaultConfig(), 'tr');
    expect(t.rows[1]!.textContent).toContain('Ajan türü');
  });
});
