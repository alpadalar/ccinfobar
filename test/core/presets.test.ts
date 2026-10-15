import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { presetLabels } from '../../src/core/i18n/catalog-text.js';
import { t } from '../../src/core/i18n/index.js';
import { loadForUse } from '../../src/core/load.js';
import {
  applyGsdAutoLine,
  cockpitConfig,
  deleteUserPreset,
  forGsd,
  getPreset,
  hasGsd,
  listPresets,
  saveUserPreset,
  starterConfig,
} from '../../src/core/presets.js';
import { withLang } from '../helpers.js';

const types = (lines: { type: string }[][]) => lines.map((l) => l.map((i) => i.type));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-presets-'));

describe('gsd-aware layouts', () => {
  it('drops GSD from the starter config until GSD is installed', () => {
    expect(hasGsd(starterConfig(true))).toBe(true);
    const plain = starterConfig(false);
    expect(hasGsd(plain)).toBe(false);
    expect(plain.gsdAutoLine).toBe(true);
    expect(plain.lines).toHaveLength(defaultConfig().lines.length - 1);
  });

  it('adds the GSD line second once, keeping the rest of the layout', () => {
    const plain = forGsd(cockpitConfig(), false);
    expect(applyGsdAutoLine(plain, false)).toBeNull();
    const next = applyGsdAutoLine(plain, true)!;
    expect(next.gsdAutoLine).toBeUndefined();
    expect(types(next.lines)[0]).toEqual(types(plain.lines)[0]);
    expect(next.lines[1]!.every((i) => i.type.startsWith('gsd-'))).toBe(true);
    expect(types(next.lines.slice(2))).toEqual(types(plain.lines.slice(1)));
    expect(applyGsdAutoLine(next, true)).toBeNull();
  });

  it('only clears the flag when the user already added GSD widgets', () => {
    const c = { ...defaultConfig(), gsdAutoLine: true };
    expect(applyGsdAutoLine(c, true)).toEqual(defaultConfig());
  });

  it('saves the new line once through loadForUse with persist', () => {
    const file = path.join(tmp(), 'config.json');
    saveConfig(starterConfig(false), file);
    const loaded = loadForUse(file, () => true, { persist: true });
    expect(hasGsd(loaded.config)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).gsdAutoLine).toBeUndefined();
    expect(hasGsd(loadForUse(path.join(tmp(), 'none.json'), () => false).config)).toBe(false);
  });
});

describe('user presets', () => {
  it('saves, lists, overrides and deletes', () => {
    const dir = tmp();
    saveUserPreset({ id: 'mine', name: 'Mine', description: 'd', config: cockpitConfig() }, dir);
    const mine = getPreset('mine', dir)!;
    expect(mine.source).toBe('user');
    expect(mine.name).toBe('Mine');
    expect(types(mine.build().lines)).toEqual(types(cockpitConfig().lines));
    expect(listPresets(dir).filter((p) => p.source === 'user')).toHaveLength(1);
    expect(() => saveUserPreset({ id: '../x', config: {} }, dir)).toThrow(t('err.server.presetIdRule'));
    const tr = withLang('tr', () => t('err.server.presetIdRule'));
    expect(() => withLang('tr', () => saveUserPreset({ id: '../x', config: {} }, dir))).toThrow(tr);
    expect(deleteUserPreset('mine', dir)).toBe(true);
    expect(getPreset('mine', dir)).toBeUndefined();
  });
});

describe('preset labels', () => {
  const labels = (c: { lines: { label?: string }[][] }) =>
    c.lines.flat().flatMap((i) => (i.label !== undefined && /\p{L}/u.test(i.label) ? [i.label] : []));
  const builtin = () => listPresets().filter((p) => p.source !== 'user');

  it('keeps the English cockpit labels', () => {
    expect(labels(cockpitConfig())).toEqual(['Elapsed: ', '5h Limit: ', 'Weekly Limit: ']);
  });

  it('builds every built-in preset label in the display language', () => {
    for (const p of builtin()) {
      const en = labels(p.build());
      const tr = withLang('tr', () => labels(p.build()));
      expect(tr).toHaveLength(en.length);
      for (const [i, l] of tr.entries()) expect(l, `${p.id} ${l}`).not.toBe(en[i]);
    }
    expect(withLang('tr', () => labels(cockpitConfig()))).toEqual([
      'Süre: ',
      '5h limiti: ',
      'Haftalık limit: ',
    ]);
  });

  it('translates English built-in labels on the wire and leaves other labels alone', () => {
    const wire = cockpitConfig();
    wire.lines[0]![0]!.label = 'Mine: ';
    const out = withLang('tr', () => presetLabels(wire));
    expect(labels(out)).toEqual(['Mine: ', 'Süre: ', '5h limiti: ', 'Haftalık limit: ']);
    expect(labels(wire)).toEqual(['Mine: ', 'Elapsed: ', '5h Limit: ', 'Weekly Limit: ']);
    expect(presetLabels(cockpitConfig())).toEqual(cockpitConfig());
  });
});
