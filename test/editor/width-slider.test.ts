import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COLS_MAX, COLS_MIN } from '../../src/core/entry-keys.js';

const g = globalThis as any;
const html = fs.readFileSync(path.resolve(__dirname, '../../src/editor/web/index.html'), 'utf8');
const saved = g.localStorage;

afterEach(() => {
  g.localStorage = saved;
});

describe('editor width slider (WR-06)', () => {
  it('spans the whole cols range', () => {
    const slider = html.match(/<input id="width"[^>]*>/)?.[0] ?? '';
    expect(slider).toContain(`min="${COLS_MIN}"`);
    expect(slider).toContain(`max="${COLS_MAX}"`);
  });

  it('setWidth clamps to the cols range and remembers the width', async () => {
    const set: string[] = [];
    g.localStorage = { getItem: () => '300', setItem: (_k: string, v: string) => set.push(v) };
    const store = await import('../../src/editor/web/store.js');
    store.init({ config: {}, savedConfig: {}, categories: [], widgets: [] } as any);
    expect(store.S.width).toBe(300);
    store.setWidth(1000);
    expect(store.S.width).toBe(COLS_MAX);
    store.setWidth(1);
    expect(store.S.width).toBe(COLS_MIN);
    store.setWidth(300);
    expect(set).toEqual(['400', '40', '300']);
  });
});
