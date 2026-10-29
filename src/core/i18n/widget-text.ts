import { activeLanguage, languageLocale } from './index.js';
import type { OptionMeta, WidgetMeta } from './types.js';

export type DefLike = { type: string; name: string; description: string; label?: string; sample?: string };
export type SpecLike = { key: string; label: string; help?: string; aliases?: readonly string[] };
export type ChoiceLike = { value: unknown; label: string };
type TypeLike = { type: string };

function own<T>(rec: Record<string, T> | undefined, key: string): T | undefined {
  return rec && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

function widgetMeta(type: string): WidgetMeta | undefined {
  return own(activeLanguage().meta?.widgets, type);
}

function optionMeta(def: TypeLike, spec: SpecLike): OptionMeta | undefined {
  const options = widgetMeta(def.type)?.options;
  let found = own(options, spec.key);
  for (const a of spec.aliases ?? []) found ??= own(options, a);
  return found;
}

function shared(english: string): string | undefined {
  return own(activeLanguage().meta?.options, english);
}

function lower(s: string, locale: string): string {
  try {
    return s.toLocaleLowerCase(locale);
  } catch {
    return s.toLowerCase();
  }
}

export function widgetText(def: DefLike, field: 'name' | 'description' | 'label' | 'sample'): string {
  return widgetMeta(def.type)?.[field] ?? def[field] ?? '';
}

export function widgetHint(def: DefLike): string {
  const hint = widgetMeta(def.type)?.hint;
  if (hint !== undefined) return hint;
  return lower(widgetText(def, 'name').replace(/^(GSD|Git)\s+/i, ''), languageLocale());
}

export function optionLabel(def: TypeLike, spec: SpecLike): string {
  return optionMeta(def, spec)?.label ?? shared(spec.label) ?? spec.label;
}

export function optionHelp(def: TypeLike, spec: SpecLike): string | undefined {
  if (spec.help === undefined) return undefined;
  return optionMeta(def, spec)?.help ?? shared(spec.help) ?? spec.help;
}

export function choiceLabel(def: TypeLike, spec: SpecLike, choice: ChoiceLike): string {
  return own(optionMeta(def, spec)?.choices, String(choice.value)) ?? shared(choice.label) ?? choice.label;
}

export function categoryText(id: string, english: string): string {
  return own(activeLanguage().meta?.categories, id) ?? english;
}
