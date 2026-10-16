import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentFromConfig, hasAppearanceOverrides, themeFromConfig } from '../../src/catalog/snapshot.js';
import { defaultConfig, normalizeConfig } from '../../src/core/config.js';
import { applyCatalogContent, LAYOUT_KEYS, PERSONAL_KEYS } from '../../src/core/edit.js';
import { resolveAppearance } from '../../src/core/renderer.js';
import {
  parseThemeInput,
  resolveTheme,
  resolveThemeInput,
  saveUserTheme,
  type ThemeInput,
  themeToInput,
} from '../../src/core/themes.js';
import type { Config } from '../../src/core/types.js';

// the POST /api/themes fromConfig block before 11-07
function oldServerBlock(fromConfig: unknown, theme: unknown): ThemeInput {
  let input = parseThemeInput(theme);
  const a = resolveAppearance(normalizeConfig(fromConfig));
  const base = themeToInput(a.theme, input.id!, a.theme.id === input.id ? undefined : a.theme.id);
  input = parseThemeInput({
    ...base,
    name: input.name ?? input.id,
    description: input.description ?? '',
    author: '',
    style: a.style,
    separator: a.separator,
    padding: a.padding,
    glyphs: a.glyphs,
    colors: { ...a.theme.colors, muted: a.separatorColor },
  });
  input.id = base.id;
  if (base.extends) input.extends = base.extends;
  return input;
}

function serverCall(fromConfig: unknown, theme: unknown): ThemeInput {
  const input = parseThemeInput(theme);
  return themeFromConfig(normalizeConfig(fromConfig), input.id!, {
    name: input.name ?? input.id,
    description: input.description ?? '',
  });
}

let dir = '';
let prev: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccinfobar-snapshot-'));
  prev = process.env.CCINFOBAR_CONFIG_DIR;
  process.env.CCINFOBAR_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.CCINFOBAR_CONFIG_DIR;
  else process.env.CCINFOBAR_CONFIG_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

const themes = () => path.join(dir, 'themes');

function saveMine(): void {
  saveUserTheme({ id: 'mine', extends: 'dracula', padding: 2, colors: { fg: '#123456' } }, themes());
}

function cases(): [string, Config][] {
  return [
    ['classic default', defaultConfig()],
    ['nord + separator', { ...defaultConfig(), theme: 'nord', separator: ' @@ ' }],
    ['user theme extending dracula', { ...defaultConfig(), theme: 'mine' }],
    ['panel with style tui', { ...defaultConfig(), theme: 'panel', style: 'tui' }],
    ['mono with padding', { ...defaultConfig(), theme: 'mono', padding: 3 }],
  ];
}

describe('themeFromConfig', () => {
  it('matches the old server block byte for byte', () => {
    saveMine();
    for (const [label, config] of cases()) {
      for (const theme of [
        { id: 'from-cfg', name: 'From cfg' },
        { id: 'from-cfg', description: 'd' },
        { id: config.theme },
      ]) {
        const want = oldServerBlock(config, theme);
        const got = serverCall(config, theme);
        expect(got, label).toStrictEqual(want);
        expect(JSON.stringify(got), label).toBe(JSON.stringify(want));
      }
    }
  });

  it('keeps the base name and description without meta', () => {
    const t = themeFromConfig({ ...defaultConfig(), theme: 'nord' }, 'nord');
    expect(t.name).toBe(resolveTheme('nord').name);
    expect(t.description).toBe(resolveTheme('nord').description);
    expect(t.extends).toBeUndefined();
    expect(themeFromConfig(defaultConfig(), 'copy').extends).toBe('classic');
  });
});

describe('hasAppearanceOverrides', () => {
  it('sees any of the five override keys', () => {
    expect(hasAppearanceOverrides(defaultConfig())).toBe(false);
    for (const extra of [
      { style: 'capsule' },
      { separator: ' | ' },
      { separatorColor: 'red' },
      { padding: 0 },
      { glyphs: {} },
    ] as Partial<Config>[]) {
      expect(hasAppearanceOverrides({ ...defaultConfig(), ...extra }), JSON.stringify(extra)).toBe(true);
    }
  });
});

describe('contentFromConfig', () => {
  it('stores a plain built-in theme as a reference', () => {
    const config = { ...defaultConfig(), theme: 'nord' };
    expect(contentFromConfig(config, 'theme')).toStrictEqual({ appearance: { theme: 'nord' } });
    const bundle = contentFromConfig(config, 'bundle');
    expect(bundle.appearance).toStrictEqual({ theme: 'nord' });
    expect('theme' in bundle).toBe(false);
  });

  it('embeds a self-contained user theme', () => {
    saveMine();
    const config: Config = { ...defaultConfig(), theme: 'mine', charset: 'nerd' };
    const before = resolveTheme('mine');
    const content = contentFromConfig(config, 'theme');
    const stored = JSON.stringify(content);
    expect(content.appearance).toStrictEqual({ theme: 'mine' });
    expect(content.theme?.id).toBe('mine');
    expect(content.theme && 'extends' in content.theme).toBe(false);
    expect(content.theme?.padding).toBe(2);
    expect(content.theme?.colors?.fg).toBe('#123456');
    expect(content.theme?.colors?.categories).toStrictEqual(before.colors.categories);

    fs.rmSync(path.join(themes(), 'mine.json'));
    expect(JSON.stringify(content)).toBe(stored);
    expect(JSON.stringify(contentFromConfig(config, 'theme'))).not.toBe(stored);
    expect(resolveThemeInput(content.theme!)).toStrictEqual(before);
  });

  it('folds overrides into the embedded theme and renders the same', () => {
    saveMine();
    const configs: Config[] = [
      { ...defaultConfig(), theme: 'nord', separator: ' @@ ', charset: 'nerd' },
      { ...defaultConfig(), theme: 'panel', style: 'tui', charset: 'nerd' },
      { ...defaultConfig(), theme: 'mono', padding: 3, separatorColor: 'red', charset: 'nerd' },
      { ...defaultConfig(), theme: 'mine', style: 'capsule', glyphs: { startCap: '(' }, charset: 'nerd' },
    ];
    for (const config of configs) {
      const content = contentFromConfig(config, 'theme');
      expect(content.appearance, config.theme).toStrictEqual({ theme: config.theme });
      expect(content.theme?.id, config.theme).toBe(config.theme);
      expect(content.theme && 'extends' in content.theme, config.theme).toBe(false);
      const applied = applyCatalogContent(config, content, 'theme');
      for (const k of ['style', 'separator', 'separatorColor', 'padding', 'glyphs'] as const) {
        expect(applied[k], `${config.theme} ${k}`).toBeUndefined();
      }
      const theme = resolveThemeInput(content.theme!);
      const want = resolveAppearance(config);
      const got = resolveAppearance(applied, theme);
      expect({ ...got, theme: undefined }, config.theme).toStrictEqual({ ...want, theme: undefined });
      expect(got.theme.colors, config.theme).toStrictEqual({
        ...want.theme.colors,
        muted: want.separatorColor,
      });
    }
  });

  it('embeds the theme glyphs whatever the saver charset', () => {
    const nerd = contentFromConfig(
      { ...defaultConfig(), theme: 'nord', padding: 2, charset: 'nerd' },
      'theme',
    );
    for (const extra of [{ charset: 'text' }, { glyphMode: 'paste-safe' }, { charset: 'unicode' }] as const) {
      const c = contentFromConfig({ ...defaultConfig(), theme: 'nord', padding: 2, ...extra }, 'theme');
      expect(c, JSON.stringify(extra)).toStrictEqual(nerd);
    }
  });

  it('embeds a user theme that shadows a built-in id', () => {
    saveUserTheme({ id: 'nord', padding: 4 }, themes());
    const content = contentFromConfig({ ...defaultConfig(), theme: 'nord' }, 'theme');
    expect(content.theme?.padding).toBe(4);
  });

  it('embeds a missing theme without extends', () => {
    const content = contentFromConfig({ ...defaultConfig(), theme: 'gone' }, 'theme');
    expect(content.appearance).toStrictEqual({ theme: 'gone' });
    expect(content.theme?.id).toBe('gone');
    expect(content.theme && 'extends' in content.theme).toBe(false);
  });

  it('never stores personal keys', () => {
    const config: Config = {
      ...defaultConfig(),
      theme: 'nord',
      separator: ' / ',
      budget: { daily: 5, session: 2 },
      profiles: { builtIn: false, models: [{ match: 'x', input: 1 }] },
      language: 'tr',
      icons: 'emoji',
      colorLevel: 1,
      maxWidth: 90,
      glyphMode: 'jetbrains',
      gsdAutoLine: false,
      progress: { enabled: true } as Config['progress'],
    };
    for (const kind of ['preset', 'theme', 'bundle'] as const) {
      const content = contentFromConfig(config, kind);
      for (const part of [content.layout ?? {}, content.appearance ?? {}]) {
        for (const k of PERSONAL_KEYS) expect(Object.hasOwn(part, k), `${kind} ${k}`).toBe(false);
      }
      expect(JSON.stringify(content), kind).not.toContain('budget');
      expect(JSON.stringify(content), kind).not.toContain('profiles');
    }
  });

  it('preset kind holds only the layout', () => {
    const config: Config = { ...defaultConfig(), theme: 'mine', align: 'right', separator: ' | ' };
    const content = contentFromConfig(config, 'preset');
    expect(Object.keys(content)).toStrictEqual(['layout']);
    expect(Object.keys(content.layout!).every((k) => (LAYOUT_KEYS as readonly string[]).includes(k))).toBe(
      true,
    );
    expect(content.layout?.lines).toStrictEqual(config.lines);
    expect(content.layout?.align).toBe('right');
    expect(content.layout?.lines).not.toBe(config.lines);
  });

  it('bundle holds layout and appearance', () => {
    saveMine();
    const config: Config = { ...defaultConfig(), theme: 'mine' };
    const content = contentFromConfig(config, 'bundle');
    expect(Object.keys(content).sort()).toStrictEqual(['appearance', 'layout', 'theme']);
    expect(content.layout).toStrictEqual(contentFromConfig(config, 'preset').layout);
    expect(content.theme).toStrictEqual(contentFromConfig(config, 'theme').theme);
  });
});
