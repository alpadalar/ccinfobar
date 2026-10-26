import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLS_MAX, COLS_MIN } from '../../src/core/entry-keys.js';
import * as store from '../../src/editor/web/store.js';
import { colsFor, initTermResize } from '../../src/editor/web/term-resize.js';
import { FakeEl } from '../i18n/fake-dom.js';

const g = globalThis as any;
const saved = { localStorage: g.localStorage, document: g.document };
let set: string[];
let handle: FakeEl;
let body: FakeEl;

beforeAll(() => {
  g.localStorage = { getItem: () => null, setItem: (_k: string, v: string) => set.push(v) };
});

afterAll(() => {
  g.localStorage = saved.localStorage;
  g.document = saved.document;
});

beforeEach(() => {
  set = [];
  body = new FakeEl('BODY');
  g.document = { body, createElement: (tag: string) => new FakeEl(tag.toUpperCase()) };
  store.init({ config: { lines: [] }, savedConfig: {}, categories: [], widgets: [] } as any);
  handle = new FakeEl('DIV');
  initTermResize(handle as any, new FakeEl('DIV') as any, () => 8);
});

const ev = (clientX: number, extra: Record<string, unknown> = {}) => ({
  button: 0,
  clientX,
  pointerId: 1,
  preventDefault() {},
  ...extra,
});

describe('colsFor', () => {
  it('turns pixels into columns', () => {
    expect(colsFor(130, 80, 8)).toBe(140);
    expect(colsFor(130, -1000, 8)).toBe(5);
    expect(colsFor(130, 50, 0)).toBe(130);
    expect(colsFor(130, 50, Number.NaN)).toBe(130);
  });
});

describe('preview edge drag', () => {
  it('drags the width and remembers it', () => {
    expect(store.S.width).toBe(store.DEFAULT_WIDTH);
    handle.dispatch('pointerdown', ev(100));
    expect(body.classList.contains('resizing-term')).toBe(true);
    handle.dispatch('pointermove', ev(180));
    handle.dispatch('pointerup', ev(180));
    expect(store.S.width).toBe(140);
    expect(set.at(-1)).toBe('140');
    expect(body.classList.contains('resizing-term')).toBe(false);
  });

  it('clamps to the cols range', () => {
    handle.dispatch('pointerdown', ev(100));
    handle.dispatch('pointermove', ev(100000));
    expect(store.S.width).toBe(COLS_MAX);
    handle.dispatch('pointermove', ev(-100000));
    expect(store.S.width).toBe(COLS_MIN);
    handle.dispatch('pointercancel', ev(0));
  });

  it('ignores moves outside a drag and other buttons', () => {
    handle.dispatch('pointermove', ev(500));
    expect(store.S.width).toBe(130);
    handle.dispatch('pointerdown', ev(100, { button: 2 }));
    handle.dispatch('pointermove', ev(500));
    expect(store.S.width).toBe(130);
    handle.dispatch('pointerdown', ev(100));
    handle.dispatch('pointerup', ev(100));
    handle.dispatch('pointermove', ev(500));
    expect(store.S.width).toBe(130);
    expect(set).toEqual([]);
  });

  it('double-click resets the width', () => {
    store.setWidth(300);
    handle.dispatch('dblclick', ev(0));
    expect(store.S.width).toBe(store.DEFAULT_WIDTH);
    expect(store.DEFAULT_WIDTH).toBe(130);
  });
});
