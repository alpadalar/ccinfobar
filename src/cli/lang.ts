import fs from 'node:fs';
import { inspectConfigText } from '../core/config.js';
import { type Resolved, setLanguage } from '../core/i18n/index.js';
import { asciiLower, isLanguageId, loadLanguage } from '../core/i18n/languages.js';
import { languageOf, resolveLanguage } from '../core/i18n/resolve.js';
import type { Config } from '../core/types.js';

type Env = Record<string, string | undefined>;
type LanguagePick = Pick<Config, 'language'>;

let envResult: Resolved | null = null;

// auto or a value naming no language leaves the locale chain
function ownHint(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s && asciiLower(s) !== 'auto' && languageOf(s) ? s : undefined;
}

export function envHints(env: Env = process.env): (string | undefined)[] {
  return [ownHint(env.CCINFOBAR_LANG), env.LC_ALL, env.LC_MESSAGES, env.LANG];
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

// a missing or broken config leaves the env language
export function configLanguage(file: string): LanguagePick | undefined {
  try {
    const { raw, issue } = inspectConfigText(fs.readFileSync(file, 'utf8'));
    const v = issue ? undefined : (raw as Record<string, unknown>).language;
    const id = typeof v === 'string' ? asciiLower(v) : v;
    return isLanguageId(id) ? { language: id } : undefined;
  } catch {
    return undefined;
  }
}

function settingOf(config?: LanguagePick): string {
  const v = config?.language;
  return isLanguageId(v) ? v : 'auto';
}

function resolveFor(config?: LanguagePick): Resolved {
  const v = config?.language;
  return isLanguageId(v) ? resolveLanguage(v, []) : envLanguage();
}

export function applyLanguage(config?: LanguagePick): Resolved {
  const r = resolveFor(config);
  setLanguage(r.id);
  return r;
}

// loads only the tables this language needs
export async function prepareLanguage(config?: LanguagePick): Promise<Resolved> {
  const r = resolveFor(config);
  await loadLanguage(r.id);
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
