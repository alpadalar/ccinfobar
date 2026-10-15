import { type Resolved, setLanguage } from '../core/i18n/index.js';
import { isLanguageId } from '../core/i18n/languages.js';
import { resolveLanguage } from '../core/i18n/resolve.js';
import type { Config } from '../core/types.js';

type Env = Record<string, string | undefined>;
type LanguagePick = Pick<Config, 'language'>;

let envResult: Resolved | null = null;

export function envHints(env: Env = process.env): (string | undefined)[] {
  return [env.CCINFOBAR_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG];
}

// Intl.DateTimeFormat() costs ~12 ms cold; PluralRules gives the same default in ~0.2 ms
function intlLocale(): string {
  return new Intl.PluralRules().resolvedOptions().locale;
}

export function envLanguage(env: Env = process.env, probe: () => string = intlLocale): Resolved {
  const memo = env === process.env;
  if (memo && envResult) return envResult;
  const hints = envHints(env);
  let intl: string | undefined;
  if (!hints.some((h) => h?.trim())) {
    try {
      intl = probe();
    } catch {}
  }
  const r = resolveLanguage(undefined, [...hints, intl]);
  if (memo) envResult = r;
  return r;
}

function settingOf(config?: LanguagePick): string {
  const v = config?.language;
  return isLanguageId(v) ? v : 'auto';
}

export function applyLanguage(config?: LanguagePick): Resolved {
  const v = config?.language;
  const r = isLanguageId(v) ? resolveLanguage(v, []) : envLanguage();
  setLanguage(r.id);
  return r;
}

export function reapplyLanguage(prev: LanguagePick, next: LanguagePick): boolean {
  if (settingOf(prev) === settingOf(next)) return false;
  applyLanguage(next);
  return true;
}

export function resetLanguageCache(): void {
  envResult = null;
}
