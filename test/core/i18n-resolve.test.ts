import { describe, expect, it } from 'vitest';
import { HINT_ORDER, languageOf, pickUiLanguage, resolveLanguage } from '../../src/core/i18n/resolve.js';

type Hints = Partial<Record<(typeof HINT_ORDER)[number], string>>;

function hints(h: Hints): (string | undefined)[] {
  return HINT_ORDER.map((k) => h[k]);
}

describe('languageOf', () => {
  it.each([
    ['tr_TR.UTF-8', 'tr'],
    ['tr_TR@euro', 'tr'],
    ['tr_TR.UTF-8@euro', 'tr'],
    ['TR-tr', 'tr'],
    ['tr', 'tr'],
    ['  en_US.UTF-8 ', 'en'],
    ['de_DE.UTF-8', 'de'],
    ['zh-Hans-CN', 'zh'],
    ['und', 'und'],
    ['C', 'C'],
    ['c', 'C'],
    ['C.UTF-8', 'C'],
    ['POSIX', 'C'],
  ])('%s gives %s', (tag, lang) => {
    expect(languageOf(tag)).toBe(lang);
  });

  it('returns null for junk without throwing', () => {
    expect(languageOf('')).toBeNull();
    expect(languageOf('English_United States.1252')).toBeNull();
    expect(languageOf('x'.repeat(200))).toBeNull();
    expect(languageOf('!!!')).toBeNull();
  });
});

describe('resolveLanguage', () => {
  it('config wins over every hint', () => {
    expect(resolveLanguage('en', hints({ CCINFOBAR_LANG: 'tr', LC_ALL: 'tr_TR.UTF-8' }))).toEqual({
      id: 'en',
      source: 'config',
    });
    expect(resolveLanguage('tr', hints({ CCINFOBAR_LANG: 'en', LC_ALL: 'en_US.UTF-8' }))).toEqual({
      id: 'tr',
      source: 'config',
    });
  });

  it('auto, undefined and junk settings fall through', () => {
    for (const s of ['auto', undefined, 'xx', 'EN', 'TR', 5, null, {}]) {
      expect(resolveLanguage(s, hints({ LC_ALL: 'en_US.UTF-8' })), String(s)).toEqual({
        id: 'en',
        source: 'LC_ALL',
      });
    }
  });

  it('follows the hint order', () => {
    const all: Hints = {
      CCINFOBAR_LANG: 'en',
      LC_ALL: 'en_US',
      LC_MESSAGES: 'en_GB',
      LANG: 'en_AU',
      Intl: 'en-US',
    };
    expect(resolveLanguage(undefined, hints(all)).source).toBe('CCINFOBAR_LANG');
    expect(resolveLanguage(undefined, hints({ ...all, CCINFOBAR_LANG: undefined })).source).toBe('LC_ALL');
    expect(resolveLanguage(undefined, hints({ LC_MESSAGES: 'en_GB', LANG: 'en_AU' })).source).toBe(
      'LC_MESSAGES',
    );
    expect(resolveLanguage(undefined, hints({ LANG: 'en_AU', Intl: 'en' })).source).toBe('LANG');
  });

  it('skips empty and blank hints', () => {
    expect(resolveLanguage(undefined, hints({ CCINFOBAR_LANG: '', LC_ALL: '  ', LANG: 'en_US' }))).toEqual({
      id: 'en',
      source: 'LANG',
    });
  });

  it('an unsupported language decides and stops', () => {
    expect(resolveLanguage(undefined, hints({ LC_ALL: 'de_DE.UTF-8', LANG: 'tr_TR.UTF-8' }))).toEqual({
      id: 'en',
      source: 'LC_ALL',
    });
  });

  it.each(['C', 'C.UTF-8', 'POSIX'])('%s gives English and stops', (tag) => {
    expect(resolveLanguage(undefined, hints({ LC_ALL: tag, LANG: 'tr_TR.UTF-8' }))).toEqual({
      id: 'en',
      source: 'LC_ALL',
    });
  });

  it.each(['tr_TR.UTF-8', 'tr_TR@euro', 'TR-tr', 'tr', 'tur'])('%s resolves from its source', (tag) => {
    expect(resolveLanguage(undefined, hints({ LANG: tag }))).toEqual({ id: 'tr', source: 'LANG' });
  });

  it('Turkish from LC_ALL', () => {
    expect(resolveLanguage(undefined, [undefined, 'tr_TR.UTF-8'])).toEqual({ id: 'tr', source: 'LC_ALL' });
    expect(resolveLanguage('auto', hints({ CCINFOBAR_LANG: 'tr', LANG: 'en_US' }))).toEqual({
      id: 'tr',
      source: 'CCINFOBAR_LANG',
    });
    expect(resolveLanguage(undefined, hints({ Intl: 'tr-TR' }))).toEqual({ id: 'tr', source: 'Intl' });
  });

  it('und and junk give English without throwing', () => {
    expect(resolveLanguage(undefined, hints({ Intl: 'und' }))).toEqual({ id: 'en', source: 'Intl' });
    expect(resolveLanguage(undefined, hints({ LANG: 'q'.repeat(200) }))).toEqual({
      id: 'en',
      source: 'LANG',
    });
  });

  it('uses Intl only when the env hints are empty', () => {
    expect(resolveLanguage(undefined, hints({ Intl: 'en-US' }))).toEqual({ id: 'en', source: 'Intl' });
    expect(resolveLanguage(undefined, hints({ LANG: 'en_US', Intl: 'tr-TR' })).source).toBe('LANG');
  });

  it('nothing gives the default', () => {
    expect(resolveLanguage(undefined, [])).toEqual({ id: 'en', source: 'default' });
    expect(resolveLanguage('auto', hints({}))).toEqual({ id: 'en', source: 'default' });
  });
});

describe('pickUiLanguage', () => {
  it('explicit setting wins', () => {
    expect(pickUiLanguage('en', 'xx', ['de'])).toBe('en');
  });

  it('then a registered auto id', () => {
    expect(pickUiLanguage('auto', 'en', ['de'])).toBe('en');
    expect(pickUiLanguage(undefined, '__proto__', ['en-US'])).toBe('en');
  });

  it('picks Turkish', () => {
    expect(pickUiLanguage('tr', 'en', ['en-US'])).toBe('tr');
    expect(pickUiLanguage('auto', 'tr', ['en-US'])).toBe('tr');
    expect(pickUiLanguage('auto', undefined, ['de-DE', 'tr-TR', 'en'])).toBe('tr');
  });

  it('then the first matching tag, then English', () => {
    expect(pickUiLanguage('auto', undefined, ['de-DE', 'en-GB'])).toBe('en');
    expect(pickUiLanguage('auto', undefined, ['de-DE', 'fr'])).toBe('en');
    expect(pickUiLanguage(undefined, undefined, [])).toBe('en');
  });
});
