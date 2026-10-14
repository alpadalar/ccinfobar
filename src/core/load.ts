import { gsdInstalled } from '../data/gsd.js';
import { type LoadResult, loadConfig, saveConfig } from './config.js';
import { configPath } from './paths.js';
import { applyGsdAutoLine, forGsd, listPresets, type Preset, starterConfig } from './presets.js';

export function loadForUse(
  file = configPath(),
  gsd: () => boolean = () => gsdInstalled(),
  opts: { persist?: boolean } = {},
): LoadResult {
  const loaded = loadConfig(file, () => starterConfig(gsd()));
  if (loaded.issue || !loaded.exists || loaded.error || !loaded.config.gsdAutoLine) return loaded;
  const next = applyGsdAutoLine(loaded.config, gsd());
  if (!next) return loaded;
  if (opts.persist) {
    try {
      saveConfig(next, file);
    } catch {}
  }
  return { ...loaded, config: next };
}

export function availablePresets(gsd: boolean): Preset[] {
  return listPresets()
    .filter((p) => gsd || p.id !== 'gsd')
    .map((p) => (p.id === 'gsd' || p.source === 'user' ? p : { ...p, build: () => forGsd(p.build(), gsd) }));
}
