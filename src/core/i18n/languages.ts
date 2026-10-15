import { en } from './en/index.js';
import type { LanguageDef } from './types.js';

export const EN = {
  id: 'en',
  name: 'English',
  aliases: [],
  locale: 'en',
  messages: en,
} as const satisfies LanguageDef;

export const LANGUAGES = [EN] as const;

export type LanguageId = (typeof LANGUAGES)[number]['id'];
export type LanguageSetting = 'auto' | LanguageId;

export const LANGUAGE_IDS: readonly LanguageId[] = LANGUAGES.map((l) => l.id);
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ['auto', ...LANGUAGE_IDS];

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function isLanguageId(v: unknown): v is LanguageId {
  return typeof v === 'string' && (LANGUAGE_IDS as readonly string[]).includes(v);
}

export function languageDef(id: string): LanguageDef | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

export function nativeName(id: string): string {
  return languageDef(id)?.name ?? id;
}

export function matchLanguage(subtag: string): LanguageId | null {
  const s = asciiLower(subtag);
  for (const l of LANGUAGES) {
    if (l.id === s || (l.aliases as readonly string[]).includes(s)) return l.id;
  }
  return null;
}
