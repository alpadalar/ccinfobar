import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { benchMessages } from '../../src/core/i18n/en/bench.js';
import { configMessages } from '../../src/core/i18n/en/config.js';
import { displayMessages } from '../../src/core/i18n/en/display.js';
import { doctorMessages } from '../../src/core/i18n/en/doctor.js';
import { explainMessages } from '../../src/core/i18n/en/explain.js';
import { funMessages } from '../../src/core/i18n/en/fun.js';
import { hookMessages } from '../../src/core/i18n/en/hooks.js';
import { en } from '../../src/core/i18n/en/index.js';
import { installMessages } from '../../src/core/i18n/en/install.js';
import { jobsMessages } from '../../src/core/i18n/en/jobs.js';
import { previewMessages } from '../../src/core/i18n/en/preview.js';
import { widgetMessages } from '../../src/core/i18n/en/widgets.js';
import {
  activeLanguage,
  type LanguageDef,
  language,
  languageLocale,
  setLanguage,
  t,
  withLanguage,
} from '../../src/core/i18n/index.js';
import {
  EN,
  isLanguageId,
  LANGUAGE_IDS,
  LANGUAGE_SETTINGS,
  LANGUAGES,
  languageDef,
  matchLanguage,
  nativeName,
} from '../../src/core/i18n/languages.js';

const dir = path.resolve(__dirname, '../../src/core/i18n');

function sources(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('t()', () => {
  it('fills placeholders', () => {
    expect(t('install.installing', { version: '1.2.3' })).toBe('Installing ccinfobar 1.2.3');
    expect(t('safe.line', { line: 12 })).toBe('ccinfobar: config error at line 12, run ccinfobar doctor');
  });

  it('keeps placeholders without a param', () => {
    expect(t('install.installing')).toBe('Installing ccinfobar {version}');
    expect(t('install.wrote', { command: 'x' })).toBe('✓ statusLine set to "x" in {file}');
  });

  it('returns plain messages', () => {
    expect(t('loading.default')).toBe('loading…');
  });

  it('returns the id for unknown or prototype ids', () => {
    expect(t('no.such.id' as never)).toBe('no.such.id');
    expect(t('__proto__' as never)).toBe('__proto__');
    expect(t('constructor' as never)).toBe('constructor');
  });
});

const XX: LanguageDef = {
  id: 'xx',
  name: 'Test',
  aliases: [],
  locale: 'en',
  messages: { 'loading.default': 'xx loading', 'install.installing': 'xx {version}' },
};

function plural(locale: string): LanguageDef {
  return {
    id: 'pl-test',
    name: 'Plural',
    aliases: [],
    locale,
    messages: { 'loading.default': { one: '{count} file', other: '{count} files' } },
  };
}

describe('active language', () => {
  it('uses the active table, then English, then the id', () => {
    withLanguage(XX, () => {
      expect(language()).toBe('xx');
      expect(t('loading.default')).toBe('xx loading');
      expect(t('install.installing', { version: '1.2.3' })).toBe('xx 1.2.3');
      expect(t('safe.line', { line: 3 })).toBe('ccinfobar: config error at line 3, run ccinfobar doctor');
      expect(t('no.such.id' as never)).toBe('no.such.id');
    });
    expect(language()).toBe('en');
    expect(t('loading.default')).toBe('loading…');
  });

  it('setLanguage returns the previous def', () => {
    const prev = setLanguage(XX);
    expect(prev).toBe(EN);
    expect(activeLanguage()).toBe(XX);
    expect(setLanguage('en')).toBe(XX);
    expect(activeLanguage()).toBe(EN);
  });

  it('withLanguage restores when fn throws', () => {
    expect(() =>
      withLanguage(XX, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(language()).toBe('en');
  });

  it('nests and returns the value', () => {
    const v = withLanguage(XX, () => withLanguage('en', () => language()) + language());
    expect(v).toBe('enxx');
    expect(language()).toBe('en');
  });

  it('unknown ids give English', () => {
    setLanguage(XX);
    setLanguage('zz' as never);
    expect(activeLanguage()).toBe(EN);
    setLanguage('__proto__' as never);
    expect(activeLanguage()).toBe(EN);
    expect(languageLocale()).toBe('en');
  });
});

describe('plural forms', () => {
  it('picks one and other in English', () => {
    withLanguage(plural('en'), () => {
      expect(t('loading.default', { count: 1 })).toBe('1 file');
      expect(t('loading.default', { count: 2 })).toBe('2 files');
      expect(t('loading.default', { count: 0 })).toBe('0 files');
      expect(t('loading.default', { count: '1' })).toBe('1 file');
    });
  });

  it('uses the language locale', () => {
    withLanguage(plural('tr'), () => {
      expect(t('loading.default', { count: 1 })).toBe('1 file');
      expect(t('loading.default', { count: 3 })).toBe('3 files');
    });
  });

  it('maps few and many to other', () => {
    withLanguage(plural('ru'), () => {
      expect(t('loading.default', { count: 1 })).toBe('1 file');
      expect(t('loading.default', { count: 2 })).toBe('2 files');
      expect(t('loading.default', { count: 5 })).toBe('5 files');
    });
  });

  it('missing or non-finite count gives other', () => {
    withLanguage(plural('en'), () => {
      expect(t('loading.default')).toBe('{count} files');
      expect(t('loading.default', { n: 1 })).toBe('{count} files');
      expect(t('loading.default', { count: 'x' })).toBe('x files');
      expect(t('loading.default', { count: Number.POSITIVE_INFINITY })).toBe('Infinity files');
    });
  });

  it('a bad locale never throws', () => {
    withLanguage(plural('!!'), () => {
      expect(t('loading.default', { count: 1 })).toBe('1 file');
    });
  });
});

describe('registry', () => {
  it('lists English first', () => {
    expect(LANGUAGES[0]).toBe(EN);
    expect(LANGUAGE_IDS[0]).toBe('en');
    expect(LANGUAGE_SETTINGS[0]).toBe('auto');
    expect(LANGUAGE_SETTINGS.slice(1)).toEqual(LANGUAGE_IDS);
    expect(EN.messages).toBe(en);
  });

  it('every language has a unique id, name and locale', () => {
    expect(new Set(LANGUAGE_IDS).size).toBe(LANGUAGES.length);
    for (const l of LANGUAGES) {
      expect(l.name.length, l.id).toBeGreaterThan(0);
      expect(() => new Intl.PluralRules(l.locale), l.id).not.toThrow();
      expect(languageDef(l.id)).toBe(l);
      expect(nativeName(l.id)).toBe(l.name);
      expect(matchLanguage(l.id.toUpperCase())).toBe(l.id);
    }
  });

  it('checks ids without the prototype', () => {
    expect(isLanguageId('en')).toBe(true);
    expect(isLanguageId('EN')).toBe(false);
    expect(isLanguageId('auto')).toBe(false);
    expect(isLanguageId('__proto__')).toBe(false);
    expect(isLanguageId('constructor')).toBe(false);
    expect(isLanguageId(undefined)).toBe(false);
    expect(isLanguageId(1)).toBe(false);
    expect(languageDef('constructor')).toBeUndefined();
    expect(nativeName('zz')).toBe('zz');
    expect(matchLanguage('zz')).toBeNull();
  });
});

describe('en table', () => {
  it('has non-empty strings or plural forms only', () => {
    for (const [id, msg] of Object.entries(en) as [string, unknown][]) {
      const forms =
        typeof msg === 'string' ? [msg] : [(msg as { one: unknown }).one, (msg as { other: unknown }).other];
      for (const text of forms) {
        expect(typeof text, id).toBe('string');
        expect((text as string).length, id).toBeGreaterThan(0);
      }
    }
  });

  it('has no id in two area tables', () => {
    const areas = [
      installMessages,
      configMessages,
      doctorMessages,
      explainMessages,
      previewMessages,
      benchMessages,
      widgetMessages,
      hookMessages,
      jobsMessages,
      displayMessages,
      funMessages,
    ];
    const sum = areas.reduce((n, a) => n + Object.keys(a).length, 0);
    expect(Object.keys(en).length).toBe(sum);
  });

  it('hook messages take versions as params and every hook id is used', () => {
    const src = sources(path.resolve(dir, '..', '..'))
      .filter((f) => !f.startsWith(dir))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    for (const [id, text] of Object.entries(hookMessages)) {
      expect(text, id).not.toMatch(/\d+\.\d+\.\d+/);
      expect(src.includes(`'${id}'`), id).toBe(true);
    }
  });

  it('is browser-safe', () => {
    const files = sources(dir);
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from ['"]node:/);
      expect(src, f).not.toMatch(/\bprocess\./);
    }
  });
});
