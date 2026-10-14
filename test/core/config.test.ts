import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig, normalizeConfig, saveConfig } from '../../src/core/config.js';

describe('config', () => {
  it('falls back to defaults for garbage', () => {
    expect(normalizeConfig(null)).toEqual(defaultConfig());
    expect(normalizeConfig({ lines: 'x', padding: -1 }).padding).toBe(defaultConfig().padding);
  });

  it('drops invalid items and dedupes ids', () => {
    const cfg = normalizeConfig({
      lines: [
        [{ type: 'model', id: 'a' }, { nope: 1 }, { type: 'cwd', id: 'a', bold: true, options: { x: {} } }],
      ],
    });
    expect(cfg.lines[0]!.map((i) => i.id)).toEqual(['a', 'a-2']);
    expect(cfg.lines[0]![1]).toEqual({ id: 'a-2', type: 'cwd', bold: true, options: {} });
  });

  it('round-trips through disk', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-')), 'c.json');
    expect(loadConfig(file).exists).toBe(false);
    const cfg = { ...defaultConfig(), separator: ' / ' };
    saveConfig(cfg, file);
    const loaded = loadConfig(file);
    expect(loaded.exists).toBe(true);
    expect(loaded.config.separator).toBe(' / ');
  });

  it('keeps a valid budget and clamps warnAt', () => {
    expect(normalizeConfig({ budget: { daily: 10, session: 2.5, warnAt: 0.75 } }).budget).toEqual({
      daily: 10,
      session: 2.5,
      warnAt: 0.75,
    });
    expect(normalizeConfig({ budget: { daily: 1.234, warnAt: 2 } }).budget).toEqual({
      daily: 1.234,
      warnAt: 1,
    });
    expect(normalizeConfig({ budget: { session: 3, warnAt: 0.01 } }).budget).toEqual({
      session: 3,
      warnAt: 0.05,
    });
  });

  it('drops invalid budget values and unknown budget keys', () => {
    for (const daily of [0, -1, Number.NaN, '10', Number.POSITIVE_INFINITY, null]) {
      expect(normalizeConfig({ budget: { daily, session: 2 } }).budget).toEqual({ session: 2 });
    }
    expect(normalizeConfig({ budget: { daily: 5, weekly: 50 } }).budget).toEqual({ daily: 5 });
    expect(normalizeConfig({ budget: { warnAt: Number.NaN, daily: 5 } }).budget).toEqual({ daily: 5 });
    for (const budget of [{}, { daily: 0, session: -2 }, { weekly: 3 }, 'x', 10, null, []]) {
      expect('budget' in normalizeConfig({ budget })).toBe(false);
    }
    expect('budget' in normalizeConfig({})).toBe(false);
  });

  it('never copies prototype keys into the budget', () => {
    const budget = normalizeConfig(JSON.parse('{"budget":{"__proto__":{"daily":1},"session":4}}')).budget;
    expect(budget).toEqual({ session: 4 });
    expect(Object.getPrototypeOf(budget)).toBe(Object.prototype);
  });

  it('reports parse errors without throwing', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-')), 'c.json');
    fs.writeFileSync(file, '{oops');
    const loaded = loadConfig(file);
    expect(loaded.error).toBeTruthy();
    expect(loaded.config).toEqual(defaultConfig());
  });
});
