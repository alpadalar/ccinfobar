import { describe, expect, it } from 'vitest';
import { slug } from '../../src/editor/web/presets.js';

describe('preset and theme id slug', () => {
  it.each([
    ['Çalışma Düzeni', 'calisma-duzeni'],
    ['İŞ AKIŞI', 'is-akisi'],
    ['Göz ağrısı ÖZEL', 'goz-agrisi-ozel'],
    ['şğüöçıİ', 'sguocii'],
  ])('folds Turkish letters: %s', (name, id) => {
    expect(slug(name)).toBe(id);
  });

  it.each([
    ['My Layout', 'my-layout'],
    ['  dev.v2_final  ', 'dev.v2_final'],
    ['a / b', 'a-b'],
    ['***', ''],
  ])('keeps English ids: %s', (name, id) => {
    expect(slug(name)).toBe(id);
  });
});
