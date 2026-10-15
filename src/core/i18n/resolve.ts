import { asciiLower, isLanguageId, type LanguageId, matchLanguage } from './languages.js';

export const HINT_ORDER = ['CCINFOBAR_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'Intl'] as const;

export type LanguageSource = 'config' | (typeof HINT_ORDER)[number] | 'default';

export interface Resolved {
  id: LanguageId;
  source: LanguageSource;
}

const MAX_TAG = 64;

export function languageOf(tag: string): string | null {
  const base = tag.trim().slice(0, MAX_TAG).split(/[.@]/)[0]!.replace(/_/g, '-');
  if (/^(c|posix)$/i.test(base)) return 'C';
  const m = /^([A-Za-z]{2,3})(?:-|$)/.exec(base);
  if (m) return asciiLower(m[1]!);
  if (!base) return null;
  try {
    return new Intl.Locale(base).language;
  } catch {
    return null;
  }
}

function supported(tag: string): LanguageId | null {
  const lang = languageOf(tag);
  return lang && lang !== 'C' ? matchLanguage(lang) : null;
}

export function resolveLanguage(setting: unknown, hints: readonly (string | undefined)[]): Resolved {
  if (isLanguageId(setting)) return { id: setting, source: 'config' };
  for (let i = 0; i < HINT_ORDER.length; i++) {
    const h = hints[i];
    if (typeof h !== 'string' || !h.trim()) continue;
    return { id: supported(h) ?? 'en', source: HINT_ORDER[i]! };
  }
  return { id: 'en', source: 'default' };
}

export function pickUiLanguage(
  setting: unknown,
  autoId: string | undefined,
  fallbackTags: readonly string[],
): LanguageId {
  if (isLanguageId(setting)) return setting;
  if (isLanguageId(autoId)) return autoId;
  for (const tag of fallbackTags) {
    const id = typeof tag === 'string' ? supported(tag) : null;
    if (id) return id;
  }
  return 'en';
}
