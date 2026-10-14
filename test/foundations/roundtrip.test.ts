import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeConfig, SCHEMA_URL } from '../../src/core/config.js';
import type { Config, TuiConfig, WidgetItem } from '../../src/core/types.js';

const ITEM_KEYS = [
  'id',
  'type',
  'color',
  'background',
  'bold',
  'dim',
  'italic',
  'label',
  'raw',
  'merge',
  'hideEmpty',
  'options',
] as const;

const CONFIG_KEYS = [
  '$schema',
  'version',
  'lines',
  'align',
  'lineAlign',
  'theme',
  'style',
  'separator',
  'separatorColor',
  'padding',
  'glyphs',
  'charset',
  'autoWrap',
  'update',
  'usageApi',
  'gsdAutoLine',
  'gitHardening',
  'tui',
  'colorLevel',
  'icons',
  'maxWidth',
  'widthOffset',
  'savePayload',
] as const;

const TUI_KEYS = [
  'box',
  'fitContent',
  'minWidth',
  'maxWidth',
  'padding',
  'columnGap',
  'divider',
  'dividers',
  'title',
  'borderColor',
  'footer',
  'templates',
  'breakpoints',
] as const;

// compile-time: fails typecheck unless T is never
function none<T extends never>(): T | undefined {
  return undefined;
}
none<Exclude<keyof WidgetItem, (typeof ITEM_KEYS)[number]>>();
none<Exclude<(typeof ITEM_KEYS)[number], keyof WidgetItem>>();
none<Exclude<keyof Config, (typeof CONFIG_KEYS)[number]>>();
none<Exclude<(typeof CONFIG_KEYS)[number], keyof Config>>();
none<Exclude<keyof TuiConfig, (typeof TUI_KEYS)[number]>>();
none<Exclude<(typeof TUI_KEYS)[number], keyof TuiConfig>>();

const FULL_ITEM: Required<WidgetItem> = {
  id: 'model-main',
  type: 'model',
  color: '#ff8800',
  background: 'blue',
  bold: true,
  dim: true,
  italic: true,
  label: 'Model',
  raw: true,
  merge: true,
  hideEmpty: true,
  options: { format: 'short', width: 12, compact: false },
};

const FULL_TUI: Required<TuiConfig> = {
  box: { topLeft: '+', topRight: '+', horizontal: '-' },
  fitContent: true,
  minWidth: 40,
  maxWidth: 120,
  padding: 2,
  columnGap: '  ',
  divider: '-',
  dividers: false,
  title: { left: 'ccinfobar', right: false },
  borderColor: 'magenta',
  footer: { left: 'left', right: 'right' },
  templates: { top: { items: ['model', 'cwd'], gap: 2, justify: 'between' } },
  breakpoints: [
    { minWidth: 80, areas: ['top', 'bottom'], columns: ['1fr', 'auto'], align: ['left', 'right'] },
  ],
};

const FULL_CONFIG: Required<Config> = {
  $schema: SCHEMA_URL,
  version: 1,
  lines: [[FULL_ITEM, { id: 'cwd-1', type: 'cwd' }], [{ id: 'git-1', type: 'git-branch' }], []],
  align: 'center',
  lineAlign: ['right', null, 'center'],
  theme: 'nord',
  style: 'capsule',
  separator: ' | ',
  separatorColor: 'cyan',
  padding: 2,
  glyphs: { separator: '>', thin: '|', startCap: '(', endCap: ')' },
  charset: 'unicode',
  autoWrap: false,
  update: 'notify',
  usageApi: false,
  gsdAutoLine: true,
  gitHardening: false,
  tui: FULL_TUI,
  colorLevel: 2,
  icons: 'nerd',
  maxWidth: 140,
  widthOffset: 40,
  savePayload: false,
};

const sorted = (keys: Iterable<string>) => [...keys].sort();

const schema = JSON.parse(
  fs.readFileSync(new URL('../../schema/config.schema.json', import.meta.url), 'utf8'),
) as {
  properties: Record<string, { items?: { items?: { properties?: object } }; properties?: object }>;
};

describe('config round-trip', () => {
  it('populates every key in the fixtures', () => {
    expect(sorted(Object.keys(FULL_ITEM))).toEqual(sorted(ITEM_KEYS));
    expect(sorted(Object.keys(FULL_CONFIG))).toEqual(sorted(CONFIG_KEYS));
    expect(sorted(Object.keys(FULL_TUI))).toEqual(sorted(TUI_KEYS));
  });

  it('keeps every item and config key through normalizeConfig', () => {
    const input = structuredClone(FULL_CONFIG);
    expect(normalizeConfig(input)).toEqual(FULL_CONFIG);
    expect(normalizeConfig(JSON.parse(JSON.stringify(FULL_CONFIG)))).toEqual(FULL_CONFIG);
  });

  it('is stable when normalized twice', () => {
    const once = normalizeConfig(FULL_CONFIG);
    expect(normalizeConfig(once)).toEqual(once);
  });

  it('matches the schema item property set', () => {
    const props = schema.properties.lines?.items?.items?.properties ?? {};
    expect(sorted(Object.keys(props))).toEqual(sorted(ITEM_KEYS));
  });

  it('matches the schema top-level property set', () => {
    expect(sorted(Object.keys(schema.properties))).toEqual(sorted(CONFIG_KEYS));
  });

  it('matches the schema tui property set', () => {
    expect(sorted(Object.keys(schema.properties.tui?.properties ?? {}))).toEqual(sorted(TUI_KEYS));
  });
});
