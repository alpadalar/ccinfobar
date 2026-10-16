import { en } from './en/index.js';
import type { LanguageDef, LanguageTables, MetaTable } from './types.js';

export const EN = {
  id: 'en',
  name: 'English',
  aliases: [],
  locale: 'en',
  messages: en,
  lazy: undefined as LanguageDef['lazy'],
} satisfies LanguageDef;

// tables arrive through loadLanguage or installTables
export const TR = {
  id: 'tr' as const,
  name: 'Türkçe',
  aliases: ['tur'] as readonly string[],
  locale: 'tr',
  messages: {} as LanguageDef['messages'],
  meta: undefined as MetaTable | undefined,
  lazy: undefined as LanguageDef['lazy'],
} satisfies LanguageDef;

// dynamic, so an English render never parses other tables
const LOADERS: Record<string, () => Promise<LanguageTables>> = {
  tr: () => import('./tr/tables.js').then((m) => m.tables),
};

export const LANGUAGES = [EN, TR] as const;

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

const installed = new Set<string>(['en']);

export function installTables(id: string, tables: LanguageTables): void {
  const def = languageDef(id);
  if (!def || def === EN) return;
  def.messages = tables.messages;
  def.meta = tables.meta;
  installed.add(id);
}

export function installLazy(id: string, table: LanguageDef['lazy']): void {
  const def = languageDef(id);
  if (def) def.lazy = table;
}

export function hasTables(id: string): boolean {
  return installed.has(id);
}

export async function loadLanguage(id: string): Promise<void> {
  if (installed.has(id) || !Object.hasOwn(LOADERS, id)) return;
  try {
    installTables(id, await LOADERS[id]!());
  } catch {}
}

export async function loadLanguages(): Promise<void> {
  await Promise.all(LANGUAGE_IDS.map(loadLanguage));
}
