import { describe, expect, it, vi } from 'vitest';
import { pick, stripPersonal } from '../../src/catalog/model.js';
import { findSystem, SYSTEM_BUNDLES, systemEntries } from '../../src/catalog/system.js';
import { visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { applyCatalogContent, LAYOUT_KEYS } from '../../src/core/edit.js';
import { availablePresets } from '../../src/core/load.js';
import { PRESETS } from '../../src/core/presets.js';
import { renderPreview } from '../../src/core/preview.js';
import { scenarioList } from '../../src/core/scenarios.js';
import { BUILTIN_THEMES } from '../../src/core/themes.js';
import { withoutSideEffects } from '../helpers.js';

const count = (kind: string, gsd = true) => systemEntries({ gsd }).filter((e) => e.kind === kind).length;

describe('system catalog', () => {
  it('ships 10 to 15 bundles (D-12)', () => {
    expect(SYSTEM_BUNDLES.length).toBeGreaterThanOrEqual(10);
    expect(SYSTEM_BUNDLES.length).toBeLessThanOrEqual(15);
    expect(SYSTEM_BUNDLES).toHaveLength(15);
    expect(new Set(SYSTEM_BUNDLES.map((b) => b.id)).size).toBe(SYSTEM_BUNDLES.length);
  });

  it('every bundle preset, theme and scenario exists', () => {
    const presets = PRESETS.map((p) => p.id);
    const themes = BUILTIN_THEMES.map((t) => t.id);
    const scenarios = scenarioList().map((s) => s.id);
    for (const b of SYSTEM_BUNDLES) {
      expect(presets, b.id).toContain(b.preset);
      expect(themes, b.id).toContain(b.theme);
      if (b.scenario !== undefined) expect(scenarios, b.id).toContain(b.scenario);
      expect(b.name.trim(), b.id).not.toBe('');
      expect(b.description.trim(), b.id).not.toBe('');
      expect(visibleWidth(b.name), b.id).toBeLessThanOrEqual(16);
    }
  });

  it('refs are kind-qualified and unique', () => {
    const all = systemEntries({ gsd: true });
    expect(all).toHaveLength(61);
    expect(new Set(all.map((e) => e.ref)).size).toBe(all.length);
    for (const e of all) {
      expect(e.ref).toBe(`${e.kind}/${e.id}`);
      expect(e.source).toBe('system');
      expect(e.author).toBe('ccinfobar');
      expect(e.version).toBe(1);
    }
    expect(all.map((e) => e.ref)).toEqual(
      expect.arrayContaining(['bundle/nord-minimal', 'preset/minimal', 'theme/minimal']),
    );
    expect(findSystem('bundle/catppuccin-cockpit', { gsd: true })?.kind).toBe('bundle');
    expect(findSystem('minimal', { gsd: true })).toBeNull();
    expect(findSystem('bundle/solarized-gsd', { gsd: false })).toBeNull();
  });

  it('preset-only entries for every PRESETS id and theme-only entries for every built-in theme', () => {
    expect([count('bundle'), count('preset'), count('theme')]).toEqual([15, 16, 30]);
    const all = systemEntries({ gsd: true });
    const presets = all.filter((e) => e.kind === 'preset');
    expect(presets.map((e) => e.id)).toEqual(PRESETS.map((p) => p.id));
    for (const p of presets) {
      expect(Object.keys(p.content)).toEqual(['layout']);
      expect(p.name).toBe(PRESETS.find((x) => x.id === p.id)!.name);
    }
    const themes = all.filter((e) => e.kind === 'theme');
    expect(themes.map((e) => e.id)).toEqual(BUILTIN_THEMES.map((t) => t.id));
    for (const t of themes) expect(t.content).toEqual({ appearance: { theme: t.id } });
    const nord = findSystem('bundle/nord-minimal', { gsd: true })!;
    expect(nord.content.appearance).toEqual({ theme: 'nord' });
    expect(nord.content.layout).toEqual(pick(PRESETS.find((p) => p.id === 'minimal')!.build(), LAYOUT_KEYS));
    expect(nord.name).toBe('Nord minimal');
  });

  it('every system entry renders a non-empty sample preview at 120 and 80', () => {
    for (const e of systemEntries({ gsd: true })) {
      const config = applyCatalogContent(defaultConfig(), e.content, e.kind);
      const source = e.scenario ? { scenario: e.scenario } : 'sample';
      for (const width of [120, 80]) {
        const lines = withoutSideEffects(() => renderPreview(config, source, width));
        expect(
          lines.some((l) => l.trim() !== ''),
          `${e.ref} ${width}`,
        ).toBe(true);
      }
    }
  });

  it('keeps the boxed look only in the panel-dashboard bundle (D-23)', () => {
    const base = defaultConfig();
    const bundle = findSystem('bundle/panel-dashboard', { gsd: true })!;
    expect(applyCatalogContent(base, bundle.content, 'bundle').style).toBe('tui');
    const preset = findSystem('preset/dashboard', { gsd: true })!;
    expect(applyCatalogContent(base, preset.content, 'preset').style).toBe(base.style);
    const boxed = renderPreview(applyCatalogContent(base, bundle.content, 'bundle'), 'sample', 120);
    expect(boxed.join('\n')).toMatch(/[╭┌]/);
  });

  it('holds no personal keys', () => {
    for (const e of systemEntries({ gsd: false })) {
      if (e.content.layout) expect(stripPersonal(e.content.layout), e.ref).toEqual(e.content.layout);
      if (e.content.appearance)
        expect(stripPersonal(e.content.appearance), e.ref).toEqual(e.content.appearance);
    }
  });

  it('non-GSD users get forGsd-wrapped presets and no gsd preset', () => {
    const plain = systemEntries({ gsd: false });
    const refs = plain.map((e) => e.ref);
    expect(refs).not.toContain('preset/gsd');
    expect(refs).not.toContain('bundle/solarized-gsd');
    expect(plain).toHaveLength(59);
    for (const e of plain)
      for (const l of e.content.layout?.lines ?? [])
        for (const i of l) expect(i.type.startsWith('gsd-'), e.ref).toBe(false);
    const want = availablePresets(false).filter((p) => p.source !== 'user');
    expect(plain.filter((e) => e.kind === 'preset').map((e) => e.content.layout)).toEqual(
      want.map((p) => pick(p.build(), LAYOUT_KEYS)),
    );
  });

  it('builds nothing at import time', async () => {
    vi.resetModules();
    const presets = await import('../../src/core/presets.js');
    const spies = presets.PRESETS.map((p) => vi.spyOn(p, 'build'));
    const system = await import('../../src/catalog/system.js');
    expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
    system.systemEntries({ gsd: true });
    expect(spies.every((s) => s.mock.calls.length > 0)).toBe(true);
    for (const s of spies) s.mockRestore();
  });

  it('returns fresh copies', () => {
    const a = findSystem('bundle/nord-minimal', { gsd: true })!;
    a.content.layout!.lines!.length = 0;
    expect(findSystem('bundle/nord-minimal', { gsd: true })!.content.layout!.lines!.length).toBeGreaterThan(
      0,
    );
  });
});
