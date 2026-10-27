import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeConfig, SCHEMA_URL } from '../../src/core/config.js';
import type { Config, ProgressConfig, TuiConfig, WidgetItem } from '../../src/core/types.js';
import { SUBAGENT_FIELDS } from '../../src/widgets/shared.js';

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
  'showWhen',
  'hideWhen',
  'priority',
] as const;

const CONFIG_KEYS = [
  '$schema',
  'version',
  'lines',
  'align',
  'lineAlign',
  'theme',
  'themeRotation',
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
  'loadingText',
  'budget',
  'profiles',
  'tui',
  'colorLevel',
  'icons',
  'maxWidth',
  'widthOffset',
  'savePayload',
  'overflow',
  'glyphMode',
  'ambiguousWidth',
  'progress',
  'subagentLine',
  'language',
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

const PROGRESS_KEYS = [
  'enabled',
  'source',
  'scaleTo',
  'warnAt',
  'errorAt',
  'channel',
  'tmuxPassthrough',
  'terminals',
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
none<Exclude<keyof ProgressConfig, (typeof PROGRESS_KEYS)[number]>>();
none<Exclude<(typeof PROGRESS_KEYS)[number], keyof ProgressConfig>>();

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
  showWhen: 'context.pct >= 70',
  hideWhen: ['!git', 'contxt.pct > 5'],
  priority: 80,
};

const HTTP_ITEM: WidgetItem = {
  id: 'http-1',
  type: 'http',
  options: {
    url: 'https://relay.example.com/v1/balance?key=${RELAY_KEY}',
    path: "$.data['balance']",
    format: '${value}',
    interval: 300,
    timeout: 5000,
    headers: 'Authorization=Bearer $RELAY_TOKEN',
    decimals: 2,
    maxLength: 40,
  },
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

const FULL_PROGRESS: Required<ProgressConfig> = {
  enabled: true,
  source: 'usage5h',
  scaleTo: 'autocompact',
  warnAt: 60,
  errorAt: 90,
  channel: 'hook',
  tmuxPassthrough: true,
  terminals: 'always',
};

const FULL_CONFIG: Required<Config> = {
  $schema: SCHEMA_URL,
  version: 1,
  lines: [[FULL_ITEM, { id: 'cwd-1', type: 'cwd' }], [{ id: 'git-1', type: 'git-branch' }, HTTP_ITEM], []],
  align: 'center',
  lineAlign: ['right', null, 'center'],
  theme: 'nord',
  themeRotation: { themes: ['nord', 'dracula'], every: 45, order: 'shuffle', weekdays: { mon: 'nord' } },
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
  loadingText: 'wait',
  budget: { daily: 10, session: 3, warnAt: 0.75 },
  profiles: {
    builtIn: false,
    models: [
      {
        match: 'glm-5.3*',
        label: 'GLM',
        contextWindow: 500000,
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 1.5,
        currency: 'CNY',
      },
      { match: 'My Model' },
    ],
  },
  tui: FULL_TUI,
  colorLevel: 2,
  icons: 'nerd',
  maxWidth: 140,
  widthOffset: 40,
  savePayload: false,
  overflow: 'priority',
  glyphMode: 'paste-safe',
  ambiguousWidth: 2,
  progress: FULL_PROGRESS,
  subagentLine: { fields: [...SUBAGENT_FIELDS] },
  language: 'tr',
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
    expect(sorted(Object.keys(FULL_PROGRESS))).toEqual(sorted(PROGRESS_KEYS));
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

  it('matches the schema progress property set', () => {
    expect(sorted(Object.keys(schema.properties.progress?.properties ?? {}))).toEqual(sorted(PROGRESS_KEYS));
  });

  it('matches the schema subagentLine property set', () => {
    expect(sorted(Object.keys(schema.properties.subagentLine?.properties ?? {}))).toEqual(['fields']);
  });
});
