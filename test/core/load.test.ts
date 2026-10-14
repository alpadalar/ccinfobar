import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '../../src/core/config.js';
import { loadForUse } from '../../src/core/load.js';
import { hasGsd, starterConfig } from '../../src/core/presets.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-load-'));

function starter(): string {
  const file = path.join(tmp(), 'config.json');
  config.saveConfig(starterConfig(false), file);
  return file;
}

afterEach(() => vi.restoreAllMocks());

describe('loadForUse', () => {
  it('migrates the GSD line in memory only', () => {
    const file = starter();
    const before = fs.readFileSync(file);
    const loaded = loadForUse(file, () => true);
    expect(hasGsd(loaded.config)).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('persists the migration when asked', () => {
    const file = starter();
    const spy = vi.spyOn(config, 'saveConfig');
    loadForUse(file, () => true, { persist: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.gsdAutoLine).toBeUndefined();
    expect(hasGsd(config.loadConfig(file).config)).toBe(true);
  });

  it('returns the issue of a broken file without saving', () => {
    const file = path.join(tmp(), 'config.json');
    fs.writeFileSync(file, '{"gsdAutoLine": true,}');
    const spy = vi.spyOn(config, 'saveConfig');
    const loaded = loadForUse(file, () => true, { persist: true });
    expect(loaded.issue?.kind).toBe('parse');
    expect(spy).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"gsdAutoLine": true,}');
  });
});
