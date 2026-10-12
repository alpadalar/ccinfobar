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

  it('reports parse errors without throwing', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-')), 'c.json');
    fs.writeFileSync(file, '{oops');
    const loaded = loadConfig(file);
    expect(loaded.error).toBeTruthy();
    expect(loaded.config).toEqual(defaultConfig());
  });
});
