import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hasTables, LANGUAGE_IDS, LANGUAGES } from '../../src/core/i18n/languages.js';

const root = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

async function fresh() {
  vi.resetModules();
  const langs = await import('../../src/core/i18n/languages.js');
  const i18n = await import('../../src/core/i18n/index.js');
  const lang = await import('../../src/cli/lang.js');
  return { langs, i18n, lang };
}

describe('language tables (D-25)', () => {
  it('test setup and the browser bundle install every language', () => {
    for (const id of LANGUAGE_IDS) expect(hasTables(id), id).toBe(true);
    expect(read('src/editor/web/app.ts')).toMatch(/^installBundled\(\);$/m);
    for (const l of LANGUAGES) {
      if (l.id !== 'en') expect(read('src/core/i18n/bundled.ts'), l.id).toContain(`installTables('${l.id}'`);
    }
  });

  it('only English is parsed until a language is loaded', async () => {
    const { langs, i18n } = await fresh();
    expect(langs.hasTables('en')).toBe(true);
    expect(langs.hasTables('tr')).toBe(false);
    expect(Object.keys(langs.TR.messages)).toEqual([]);
    expect(langs.TR.meta).toBeUndefined();
    i18n.setLanguage('tr');
    expect(i18n.t('cli.invalidJson')).toBe('ccinfobar: invalid JSON on stdin');
    await langs.loadLanguage('tr');
    expect(langs.hasTables('tr')).toBe(true);
    expect(i18n.t('cli.invalidJson')).toBe("ccinfobar: stdin'den gelen JSON geçersiz");
    expect(langs.TR.meta?.widgets.model?.name).toBeTruthy();
    i18n.setLanguage('en');
  });

  it('prepareLanguage loads only the language it picks', async () => {
    const { langs, i18n, lang } = await fresh();
    expect(await lang.prepareLanguage({ language: 'en' })).toEqual({ id: 'en', source: 'config' });
    expect(await lang.prepareLanguage({})).toEqual({ id: 'en', source: 'LC_ALL' });
    expect(langs.hasTables('tr')).toBe(false);
    expect(i18n.language()).toBe('en');
    await lang.prepareLanguage({ language: 'tr' });
    expect(langs.hasTables('tr')).toBe(true);
    expect(i18n.language()).toBe('tr');
    i18n.setLanguage('en');
  });

  it('loadLanguages loads every registered language', async () => {
    const { langs } = await fresh();
    await langs.loadLanguages();
    for (const id of langs.LANGUAGE_IDS) expect(langs.hasTables(id), id).toBe(true);
  });

  it('ignores unknown and prototype ids', async () => {
    const { langs } = await fresh();
    for (const id of ['xx', '__proto__', 'constructor', 'toString', '']) {
      await expect(langs.loadLanguage(id)).resolves.toBeUndefined();
      expect(langs.hasTables(id)).toBe(false);
    }
    langs.installTables('en', { messages: {} });
    expect(Object.keys(langs.EN.messages).length).toBeGreaterThan(100);
  });

  it('keeps the tables out of the English render', () => {
    expect(read('src/core/i18n/languages.ts')).toContain("import('./tr/tables.js')");
    expect(read('src/core/i18n/languages.ts')).not.toMatch(/from '\.\/tr\//);
    expect(read('src/cli/render.ts')).toContain('await prepareLanguage(config)');
  });
});
