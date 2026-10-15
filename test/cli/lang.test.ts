import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLanguage,
  envHints,
  envLanguage,
  reapplyLanguage,
  resetLanguageCache,
} from '../../src/cli/lang.js';
import { language } from '../../src/core/i18n/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('envHints', () => {
  it('reads the four variables in order', () => {
    const env = { LANG: 'd', LC_MESSAGES: 'c', LC_ALL: 'b', CCINFOBAR_LANG: 'tr', OTHER: 'x' };
    expect(envHints(env)).toEqual(['tr', 'b', 'c', 'd']);
  });

  it.each(['auto', 'AUTO', ' Auto ', '', '  ', '!!', 'a'])('treats CCINFOBAR_LANG=%j as unset', (v) => {
    expect(envHints({ CCINFOBAR_LANG: v, LANG: 'tr_TR.UTF-8' })[0]).toBeUndefined();
    expect(envLanguage({ CCINFOBAR_LANG: v, LANG: 'tr_TR.UTF-8' })).toEqual({ id: 'tr', source: 'LANG' });
  });

  it('keeps an explicit language or C in CCINFOBAR_LANG', () => {
    expect(envLanguage({ CCINFOBAR_LANG: 'C', LANG: 'tr_TR.UTF-8' })).toEqual({
      id: 'en',
      source: 'CCINFOBAR_LANG',
    });
    expect(envLanguage({ CCINFOBAR_LANG: 'de', LANG: 'tr_TR.UTF-8' })).toEqual({
      id: 'en',
      source: 'CCINFOBAR_LANG',
    });
  });
});

describe('envLanguage', () => {
  const never = () => {
    throw new Error('probe ran');
  };

  it.each([
    [{ LANG: 'tr_TR.UTF-8' }, 'tr', 'LANG'],
    [{ LC_ALL: 'C', LANG: 'tr_TR.UTF-8' }, 'en', 'LC_ALL'],
    [{ CCINFOBAR_LANG: 'tr', LC_ALL: 'en_US.UTF-8' }, 'tr', 'CCINFOBAR_LANG'],
    [{ LC_ALL: '', LANG: 'tr_TR' }, 'tr', 'LANG'],
    [{ LC_ALL: '  ', LC_MESSAGES: 'tr_TR.UTF-8', LANG: 'C' }, 'tr', 'LC_MESSAGES'],
    [{ LANG: 'de_DE.UTF-8' }, 'en', 'LANG'],
  ])('%j gives %s from %s without the probe', (env, id, source) => {
    const probe = vi.fn(never);
    expect(envLanguage(env, probe)).toEqual({ id, source });
    expect(probe).not.toHaveBeenCalled();
  });

  it('probes the Intl default only when every hint is empty', () => {
    const probe = vi.fn(() => 'tr-TR');
    expect(envLanguage({}, probe)).toEqual({ id: 'tr', source: 'Intl' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(envLanguage({ LANG: ' ', LC_ALL: '' }, () => 'und')).toEqual({ id: 'en', source: 'Intl' });
  });

  it('survives a throwing probe', () => {
    expect(envLanguage({}, never)).toEqual({ id: 'en', source: 'default' });
  });

  it('uses PluralRules for the default probe', () => {
    const spy = vi.spyOn(Intl, 'PluralRules');
    try {
      envLanguage({});
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('memoizes the process.env answer until reset', () => {
    const first = envLanguage();
    expect(first).toEqual({ id: 'en', source: 'LC_ALL' });
    vi.stubEnv('CCINFOBAR_LANG', 'tr');
    expect(envLanguage()).toBe(first);
    resetLanguageCache();
    expect(envLanguage()).toEqual({ id: 'tr', source: 'CCINFOBAR_LANG' });
  });

  it('does not memoize other env objects', () => {
    const env: Record<string, string> = { LANG: 'tr_TR.UTF-8' };
    expect(envLanguage(env).id).toBe('tr');
    env.LANG = 'C';
    expect(envLanguage(env).id).toBe('en');
  });
});

describe('applyLanguage', () => {
  it('lets an explicit setting win over the env', () => {
    vi.stubEnv('CCINFOBAR_LANG', 'en');
    expect(applyLanguage({ language: 'tr' })).toEqual({ id: 'tr', source: 'config' });
    expect(language()).toBe('tr');
    expect(applyLanguage({ language: 'en' })).toEqual({ id: 'en', source: 'config' });
    expect(language()).toBe('en');
  });

  it('uses the env for auto, an absent key and no config', () => {
    vi.stubEnv('CCINFOBAR_LANG', 'tr');
    expect(applyLanguage({ language: 'auto' })).toEqual({ id: 'tr', source: 'CCINFOBAR_LANG' });
    applyLanguage({ language: 'en' });
    expect(applyLanguage({}).id).toBe('tr');
    applyLanguage({ language: 'en' });
    expect(applyLanguage().id).toBe('tr');
    expect(language()).toBe('tr');
  });

  it('treats junk as auto', () => {
    expect(applyLanguage({ language: '__proto__' as never })).toEqual({ id: 'en', source: 'LC_ALL' });
  });
});

describe('reapplyLanguage', () => {
  it('re-applies only when the setting changes', () => {
    expect(reapplyLanguage({ language: 'en' }, { language: 'en' })).toBe(false);
    expect(reapplyLanguage({}, { language: 'auto' })).toBe(false);
    expect(language()).toBe('en');
    expect(reapplyLanguage({}, { language: 'tr' })).toBe(true);
    expect(language()).toBe('tr');
    expect(reapplyLanguage({ language: 'tr' }, {})).toBe(true);
    expect(language()).toBe('en');
  });
});
