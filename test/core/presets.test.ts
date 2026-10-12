import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
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

  it('saves the new line once through loadForUse', () => {
    const file = path.join(tmp(), 'config.json');
    saveConfig(starterConfig(false), file);
    const loaded = loadForUse(file, () => true);
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
    expect(() => saveUserPreset({ id: '../x', config: {} }, dir)).toThrow();
    expect(deleteUserPreset('mine', dir)).toBe(true);
    expect(getPreset('mine', dir)).toBeUndefined();
  });
});
