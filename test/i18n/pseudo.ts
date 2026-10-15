import { STYLE_GROUPS } from '../../src/core/edit.js';
import { en } from '../../src/core/i18n/en/index.js';
import type {
  CatalogMeta,
  LanguageDef,
  Message,
  MetaTable,
  OptionMeta,
  WidgetMeta,
} from '../../src/core/i18n/index.js';
import { PRESETS } from '../../src/core/presets.js';
import { SCENARIOS } from '../../src/core/scenarios.js';
import { BUILTIN_THEMES, STYLES } from '../../src/core/themes.js';
import { ALL_WIDGETS, CATEGORIES } from '../../src/widgets/index.js';

export const IDEOGRAPH = '中';

const full = (s: string) => s.replace(/[A-Za-z]/g, (c) => String.fromCodePoint(c.charCodeAt(0) + 0xfee0));

function wideLine(line: string): string {
  const [, lead = '', core = '', tail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(line) ?? [];
  if (!core) return line;
  const body = core
    .split(/(\{\w+\})/)
    .map((p, i) => (i % 2 ? p : full(p)))
    .join('');
  return lead + body + IDEOGRAPH + tail;
}

// fullwidth letters, one ideograph per line, same params and whitespace
export function wide(s: string): string {
  return s.split('\n').map(wideLine).join('\n');
}

export function wideMessage(m: Message): Message {
  return typeof m === 'string' ? m && wide(m) : { one: wide(m.one), other: wide(m.other) };
}

function widgetMeta(): MetaTable['widgets'] {
  const out: Record<string, WidgetMeta> = {};
  for (const d of ALL_WIDGETS) {
    const options: Record<string, OptionMeta> = {};
    for (const o of d.options ?? []) {
      options[o.key] = {
        label: wide(o.label),
        ...(o.help !== undefined ? { help: wide(o.help) } : {}),
        ...(o.choices
          ? { choices: Object.fromEntries(o.choices.map((c) => [String(c.value), wide(c.label)])) }
          : {}),
      };
    }
    out[d.type] = {
      name: wide(d.name),
      description: wide(d.description),
      ...(d.label !== undefined ? { label: wide(d.label) } : {}),
      ...(d.sample !== undefined ? { sample: wide(d.sample) } : {}),
      options,
    };
  }
  return out;
}

function sharedOptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of ALL_WIDGETS) {
    for (const o of d.options ?? []) {
      for (const s of [o.label, o.help, ...(o.choices ?? []).map((c) => c.label)]) {
        if (s !== undefined) out[s] = wide(s);
      }
    }
  }
  return out;
}

function catalogMeta(): CatalogMeta {
  const map = <T extends { id: string }, V>(list: readonly T[], f: (x: T) => V) =>
    Object.fromEntries(list.map((x) => [x.id, f(x)]));
  return {
    themes: map(BUILTIN_THEMES, (x) => ({ description: wide(x.description) })),
    styles: map(STYLES, (x) => ({ name: wide(x.name), description: wide(x.description) })),
    presets: map(PRESETS, (x) => ({ name: wide(x.name), description: wide(x.description) })),
    scenarios: map(SCENARIOS, (x) => ({ label: wide(x.label), description: wide(x.description) })),
    styleGroups: map(STYLE_GROUPS, (x) => wide(x.name)),
  };
}

let cached: LanguageDef | undefined;

export function pseudoLanguage(): LanguageDef {
  cached ??= {
    id: 'zz',
    name: 'Pseudo',
    aliases: [],
    locale: 'en',
    messages: Object.fromEntries(Object.entries(en).map(([id, m]) => [id, wideMessage(m as Message)])),
    meta: {
      widgets: widgetMeta(),
      options: sharedOptions(),
      categories: Object.fromEntries(CATEGORIES.map((c) => [c.id, wide(c.name)])),
      catalog: catalogMeta(),
    },
  };
  return cached;
}
