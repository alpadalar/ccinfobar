import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { PROFILES, PROFILES_UPDATED } from '../../src/core/profiles.js';
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

async function build(start: Config, draft: Record<string, unknown> = {}) {
  const { profilesFields } = await import('../../src/editor/web/settings.js');
  const state = { config: start, keys: [] as (string | undefined)[] };
  const root = new FakeEl('DIV');
  root.append(
    ...(profilesFields(
      start,
      (fn, key) => {
        state.config = fn(state.config);
        state.keys.push(key);
      },
      draft,
    ) as unknown as FakeEl[]),
  );
  const rows = root.all((e) => e.classList.contains('profile-row'));
  const input = (row: FakeEl, label: string) => row.all((e) => e.getAttribute('aria-label') === label)[0]!;
  const type = (el: FakeEl, v: string) => {
    el.value = v;
    el.fire('input');
  };
  return { root, rows, state, input, type };
}

const withModels = (models: NonNullable<Config['profiles']>['models']): Config => ({
  ...defaultConfig(),
  profiles: { models },
});

describe('settings model profiles', () => {
  it('lists every built-in vendor and the table date', async () => {
    const { root } = await build(defaultConfig());
    const text = root.textContent;
    for (const v of PROFILES) expect(text).toContain(v.label);
    expect(text).toContain(`Updated ${PROFILES_UPDATED}`);
    expect(text).toContain('Updated 2026-10-14');
    expect(text).toContain('GLM-5.3');
    expect(text).toContain('in 1.4, out 4.4, cache read 0.26 USD');
    expect(text).toContain('1M');
    expect(text).toContain('—');
    expect(text).toContain("vendor's own API host");
  });

  it('builtIn toggle writes false and removes the key when on', async () => {
    const off = await build(defaultConfig());
    const sw = off.root.all((e) => e.classList.contains('switch-input'))[0]!;
    expect(sw.attrs.has('checked')).toBe(true);
    sw.checked = false;
    sw.fire('change');
    expect(off.state.config.profiles).toEqual({ builtIn: false });

    const on = await build({ ...defaultConfig(), profiles: { builtIn: false } });
    const sw2 = on.root.all((e) => e.classList.contains('switch-input'))[0]!;
    expect(sw2.attrs.has('checked')).toBe(false);
    sw2.checked = true;
    sw2.fire('change');
    expect(on.state.config.profiles).toBeUndefined();
  });

  it('adds a row from the draft', async () => {
    const draft: Record<string, unknown> = {};
    const t = await build(defaultConfig(), draft);
    const row = t.rows.find((r) => r.classList.contains('draft'))!;
    t.type(t.input(row, 'Model match'), 'glm-*');
    t.type(t.input(row, 'Context window'), '500000');
    t.input(row, 'Add model').fire('click');
    expect(t.state.config.profiles).toEqual({ models: [{ match: 'glm-*', contextWindow: 500000 }] });
    expect(t.state.keys).toEqual([undefined]);
    expect(draft).toEqual({});
  });

  it('does not add an invalid number or a blank match', async () => {
    const t = await build(defaultConfig());
    const row = t.rows.find((r) => r.classList.contains('draft'))!;
    const win = t.input(row, 'Context window');
    t.type(t.input(row, 'Model match'), 'glm-*');
    t.type(win, '-5');
    expect(win.classList.contains('invalid')).toBe(true);
    t.input(row, 'Add model').fire('click');
    expect(t.state.config.profiles).toBeUndefined();

    t.type(win, '1.5');
    t.input(row, 'Add model').fire('click');
    expect(t.state.config.profiles).toBeUndefined();

    const blank = await build(defaultConfig());
    const r2 = blank.rows.find((r) => r.classList.contains('draft'))!;
    blank.type(blank.input(r2, 'Context window'), '500000');
    blank.input(r2, 'Add model').fire('click');
    expect(blank.state.config.profiles).toBeUndefined();
  });

  it('edits a row, skipping invalid values', async () => {
    const t = await build(withModels([{ match: 'glm-*', contextWindow: 500000 }]));
    const row = t.rows[0]!;
    t.type(t.input(row, 'Context window'), '0');
    t.type(t.input(row, 'Model match'), '  ');
    t.type(t.input(row, 'Currency'), 'us');
    expect(t.state.keys).toEqual([]);
    t.type(t.input(row, 'Currency'), 'cny');
    t.type(t.input(row, 'Input price'), '1');
    t.type(t.input(row, 'Output price'), '2');
    t.type(t.input(row, 'Context window'), '');
    expect(t.state.config.profiles?.models).toEqual([
      { match: 'glm-*', input: 1, output: 2, currency: 'CNY' },
    ]);
    expect(t.state.keys).toEqual([
      'profiles.0.currency',
      'profiles.0.input',
      'profiles.0.output',
      'profiles.0.contextWindow',
    ]);
  });

  it('removes a row', async () => {
    const t = await build(withModels([{ match: 'a*' }, { match: 'b*' }]));
    t.input(t.rows[0]!, 'Remove a*').fire('click');
    expect(t.state.config.profiles).toEqual({ models: [{ match: 'b*' }] });
    const last = await build(withModels([{ match: 'b*' }]));
    last.input(last.rows[0]!, 'Remove b*').fire('click');
    expect(last.state.config.profiles).toBeUndefined();
  });

  it('draftOverride keeps only valid complete drafts', async () => {
    const { draftOverride } = await import('../../src/editor/web/settings.js');
    expect(draftOverride({ match: 'x*', label: 'X', input: 1, output: 2, currency: 'eur' })).toEqual({
      match: 'x*',
      label: 'X',
      input: 1,
      output: 2,
      currency: 'EUR',
    });
    expect(draftOverride({ match: 'x*', contextWindow: 2.5 })).toBeNull();
    expect(draftOverride({ match: 'x*', currency: 'EURO' })).toBeNull();
    expect(draftOverride({ label: 'X' })).toBeNull();
  });
});

describe('settings command budget', () => {
  it('clamps the typed value and clears an empty one', async () => {
    const { budgetValue } = await import('../../src/editor/web/settings.js');
    expect(budgetValue(1500)).toBe(1500);
    expect(budgetValue(50)).toBe(100);
    expect(budgetValue(99999)).toBe(60000);
    expect(budgetValue(null)).toBeUndefined();
  });
});

describe('settings update min age', () => {
  it('clamps the typed value and clears empty or zero', async () => {
    const { ageValue } = await import('../../src/editor/web/settings.js');
    expect(ageValue(24)).toBe(24);
    expect(ageValue(9999)).toBe(720);
    expect(ageValue(0)).toBeUndefined();
    expect(ageValue(null)).toBeUndefined();
  });
});
