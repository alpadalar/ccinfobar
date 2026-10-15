import type { en } from './en/index.js';
import { EN, type LanguageId, languageDef } from './languages.js';
import type { LanguageDef, Message, Params, Plural } from './types.js';

export type MessageId = keyof typeof en;
export type { LanguageId, LanguageSetting } from './languages.js';
export type { LanguageSource, Resolved } from './resolve.js';
export type { LanguageDef, Message, MetaTable, Params, Plural } from './types.js';

let active: LanguageDef = EN;
const rules = new Map<string, Intl.PluralRules>();

function defOf(lang: LanguageId | LanguageDef): LanguageDef {
  if (typeof lang === 'string') return languageDef(lang) ?? EN;
  return lang && typeof lang === 'object' && lang.messages && typeof lang.messages === 'object' ? lang : EN;
}

export function setLanguage(lang: LanguageId | LanguageDef): LanguageDef {
  const prev = active;
  active = defOf(lang);
  return prev;
}

export function withLanguage<T>(lang: LanguageId | LanguageDef, fn: () => T): T {
  const prev = setLanguage(lang);
  try {
    return fn();
  } finally {
    active = prev;
  }
}

export function language(): string {
  return active.id;
}

export function activeLanguage(): LanguageDef {
  return active;
}

export function languageLocale(): string {
  return active.locale;
}

function pluralRules(locale: string): Intl.PluralRules {
  let pr = rules.get(locale);
  if (!pr) {
    try {
      pr = new Intl.PluralRules(locale);
    } catch {
      pr = new Intl.PluralRules('en');
    }
    rules.set(locale, pr);
  }
  return pr;
}

function pick(msg: Plural, locale: string, params?: Params): string {
  const n = Number(params?.count);
  return Number.isFinite(n) && pluralRules(locale).select(n) === 'one' ? msg.one : msg.other;
}

function lookup(def: LanguageDef, id: string): Message | undefined {
  return Object.hasOwn(def.messages, id)
    ? (def.messages as Record<string, Message | undefined>)[id]
    : undefined;
}

export function t(id: MessageId, params?: Params): string {
  let def = active;
  let msg = lookup(def, id);
  if (msg === undefined && def !== EN) {
    def = EN;
    msg = lookup(def, id);
  }
  if (msg === undefined) return id;
  const text = typeof msg === 'string' ? msg : pick(msg, def.locale, params);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}
