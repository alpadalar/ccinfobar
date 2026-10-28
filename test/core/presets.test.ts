import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { presetLabels, presetText } from '../../src/core/i18n/catalog-text.js';
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
  PRESETS,
  saveUserPreset,
  starterConfig,
} from '../../src/core/presets.js';
import { renderPreview } from '../../src/core/preview.js';
import { getWidget } from '../../src/widgets/index.js';
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

  it('refuses Windows device names', () => {
    const dir = tmp();
    expect(() => saveUserPreset({ id: 'NUL', config: {} }, dir)).toThrow(t('err.id.reserved', { id: 'NUL' }));
    expect(() => saveUserPreset({ id: 'com10', config: {} }, dir)).not.toThrow();
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

const OLD = {
  default: '598fbcf0532377c84ff5206c00df3b29f3067d037e5a07b3866a78df7d50b7aa',
  cockpit: '00ba694e8bf3b670a37ab8f34121c9ba3534d04d25802a73048d7a6d22f3245b',
  dashboard: '5cdc0f69ed694412c7874f476fa7302fb3d73c393782cd830ef5ac1c09c05f1f',
  minimal: 'b7597333fb4397315e3362d12dbe505f44b54825dad84e42ab712324f5633328',
  gsd: '1c374c226e25f16df7a9ed777940469927c14a88a49dfded6522cc735175ab73',
  powerline: '0cec9170b7433667926f8fa057cd05762d66f23e76a96cfab6ff9c791c4a3671',
  full: '5c435b838f210b9454c69f732b4b97cfb2b2bbb876843a0cb16794193d610a94',
};
const NEW = ['cost', 'limits', 'git', 'workspace', 'compact', 'two-line', 'agents', 'charts', 'session'];
const PRIVATE = ['hostname', 'username', 'memory', 'load-average', 'clock'];

describe('built-in presets', () => {
  it('keeps the existing presets byte for byte', () => {
    for (const [id, sha] of Object.entries(OLD)) {
      const p = PRESETS.find((x) => x.id === id)!;
      expect(createHash('sha256').update(JSON.stringify(p.build())).digest('hex'), id).toBe(sha);
    }
  });

  it('lists the new presets after the existing ones', () => {
    expect(PRESETS.map((p) => p.id)).toEqual([...Object.keys(OLD), ...NEW]);
  });

  it('uses only known widgets, options and choices with unique ids', () => {
    for (const p of PRESETS) {
      const items = p.build().lines.flat();
      expect(new Set(items.map((i) => i.id)).size, p.id).toBe(items.length);
      for (const item of items) {
        const def = getWidget(item.type);
        expect(def, `${p.id} ${item.type}`).toBeDefined();
        expect(PRIVATE, `${p.id} ${item.type}`).not.toContain(item.type);
        for (const [key, value] of Object.entries(item.options ?? {})) {
          const spec = def!.options?.find((o) => o.key === key);
          expect(spec, `${p.id} ${item.type}.${key}`).toBeDefined();
          if (spec!.kind === 'select') {
            expect(
              spec!.choices!.map((c) => c.value),
              `${p.id} ${item.type}.${key}`,
            ).toContain(value);
          } else expect(typeof value, `${p.id} ${item.type}.${key}`).toBe(spec!.kind);
        }
      }
    }
  });

  it.each(NEW)('%s renders a sample preview at 120 and 80 columns', (id) => {
    const config = PRESETS.find((p) => p.id === id)!.build();
    for (const width of [120, 80]) {
      const lines = renderPreview(config, 'sample', width);
      expect(lines.length, `${id} ${width}`).toBeGreaterThan(0);
      expect(
        lines.some((l) => l.trim() !== ''),
        `${id} ${width}`,
      ).toBe(true);
      for (const l of lines) expect(visibleWidth(l), `${id} ${width}`).toBeLessThanOrEqual(width);
    }
    expect(renderPreview(config, 'sample', 120).join('\n')).toContain('Opus');
  });

  it('keeps names within 16 cells in English and Turkish', () => {
    for (const p of PRESETS) {
      expect(visibleWidth(p.name), p.id).toBeLessThanOrEqual(16);
      const tr = withLang('tr', () => presetText(p, 'name'));
      expect(visibleWidth(tr), p.id).toBeLessThanOrEqual(16);
    }
    for (const id of NEW) {
      const p = PRESETS.find((x) => x.id === id)!;
      expect(
        withLang('tr', () => presetText(p, 'description')),
        id,
      ).not.toBe(p.description);
    }
    const cost = PRESETS.find((x) => x.id === 'cost')!;
    expect(withLang('tr', () => presetText(cost, 'name'))).toBe('Maliyet takibi');
  });

  it('lists every preset id in the init help row', () => {
    const help = fs.readFileSync(path.resolve(__dirname, '../fixtures/help-en.txt'), 'utf8');
    const row = help.split('\n').find((l) => l.includes('ccinfobar init [preset]'))!;
    expect(row).toContain(PRESETS.map((p) => p.id).join(', '));
  });
});

describe('reserved ids on win32', () => {
  const onWin32 = (fn: () => void) => {
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  };
  const setup = () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'con.json'), JSON.stringify({ name: 'Con', config: defaultConfig() }));
    return dir;
  };

  it('lists and deletes nothing for a device-name id', () => {
    const dir = setup();
    onWin32(() => {
      expect(listPresets(dir).some((p) => p.id === 'con')).toBe(false);
      expect(deleteUserPreset('con', dir)).toBe(false);
    });
    expect(fs.existsSync(path.join(dir, 'con.json'))).toBe(true);
  });

  it('keeps listing an existing file elsewhere', () => {
    const dir = setup();
    expect(listPresets(dir).find((p) => p.id === 'con')?.source).toBe('user');
  });
});
