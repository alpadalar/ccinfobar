import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { benchMessages } from '../../src/core/i18n/en/bench.js';
import { cliMessages } from '../../src/core/i18n/en/cli.js';
import { commandsMessages } from '../../src/core/i18n/en/commands.js';
import { configMessages } from '../../src/core/i18n/en/config.js';
import { displayMessages } from '../../src/core/i18n/en/display.js';
import { doctorMessages } from '../../src/core/i18n/en/doctor.js';
import { errorMessages } from '../../src/core/i18n/en/errors.js';
import { explainMessages } from '../../src/core/i18n/en/explain.js';
import { funMessages } from '../../src/core/i18n/en/fun.js';
import { hookMessages } from '../../src/core/i18n/en/hooks.js';
import { en } from '../../src/core/i18n/en/index.js';
import { inspectorMessages } from '../../src/core/i18n/en/inspector.js';
import { installMessages } from '../../src/core/i18n/en/install.js';
import { jobsMessages } from '../../src/core/i18n/en/jobs.js';
import { previewMessages } from '../../src/core/i18n/en/preview.js';
import { widgetMessages } from '../../src/core/i18n/en/widgets.js';
import {
  activeLanguage,
  type LanguageDef,
  language,
  languageLocale,
  type Message,
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
  TR,
} from '../../src/core/i18n/languages.js';
import { benchMessages as trBench } from '../../src/core/i18n/tr/bench.js';
import { cliMessages as trCli } from '../../src/core/i18n/tr/cli.js';
import { commandsMessages as trCommands } from '../../src/core/i18n/tr/commands.js';
import { configMessages as trConfig } from '../../src/core/i18n/tr/config.js';
import { displayMessages as trDisplay } from '../../src/core/i18n/tr/display.js';
import { doctorMessages as trDoctor } from '../../src/core/i18n/tr/doctor.js';
import { errorMessages as trErrors } from '../../src/core/i18n/tr/errors.js';
import { explainMessages as trExplain } from '../../src/core/i18n/tr/explain.js';
import { funMessages as trFun } from '../../src/core/i18n/tr/fun.js';
import { hookMessages as trHooks } from '../../src/core/i18n/tr/hooks.js';
import { tr } from '../../src/core/i18n/tr/index.js';
import { inspectorMessages as trInspector } from '../../src/core/i18n/tr/inspector.js';
import { installMessages as trInstall } from '../../src/core/i18n/tr/install.js';
import { jobsMessages as trJobs } from '../../src/core/i18n/tr/jobs.js';
import { previewMessages as trPreview } from '../../src/core/i18n/tr/preview.js';
import { widgetMessages as trWidgets } from '../../src/core/i18n/tr/widgets.js';
import { renderPreview } from '../../src/core/preview.js';
import { saveUserTheme, type ThemeInput } from '../../src/core/themes.js';
import { withLang } from '../helpers.js';

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

describe('Turkish', () => {
  it('translates with params', () => {
    const text = withLang('tr', () => t('install.installing', { version: '1.2.3' }));
    expect(text).toContain('1.2.3');
    expect(text).not.toBe(t('install.installing', { version: '1.2.3' }));
  });

  it('install project counts are plural', () => {
    expect(t('install.dryRunProjects', { count: 1 })).toBe(
      "Would also replace GSD's status line in 1 project:",
    );
    expect(t('install.dryRunProjects', { count: 2 })).toBe(
      "Would also replace GSD's status line in 2 projects:",
    );
    expect(t('install.projectsTaken', { count: 1 })).toBe("✓ Also replaced GSD's status line in 1 project:");
    expect(t('install.projectsTaken', { count: 3 })).toBe("✓ Also replaced GSD's status line in 3 projects:");
    withLang('tr', () => {
      expect(t('install.dryRunProjects', { count: 1 })).toContain('1 projede');
      expect(t('install.projectsTaken', { count: 3 })).toContain('3 projede');
    });
  });
});

type Table = Record<string, Message>;

const AREA_PAIRS: [string, Table, Table][] = [
  ['install', installMessages, trInstall],
  ['config', configMessages, trConfig],
  ['doctor', doctorMessages, trDoctor],
  ['hooks', hookMessages, trHooks],
  ['jobs', jobsMessages, trJobs],
  ['bench', benchMessages, trBench],
  ['preview', previewMessages, trPreview],
  ['explain', explainMessages, trExplain],
  ['display', displayMessages, trDisplay],
  ['widgets', widgetMessages, trWidgets],
  ['fun', funMessages, trFun],
  ['cli', cliMessages, trCli],
  ['commands', commandsMessages, trCommands],
  ['errors', errorMessages, trErrors],
  ['inspector', inspectorMessages, trInspector],
];

function forms(m: Message): string[] {
  return typeof m === 'string' ? [m] : [m.one, m.other];
}

function params(m: Message): string[] {
  return [...new Set(forms(m).flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!)))].sort();
}

function edges(f: string): [string, string, string] {
  return [/^\s*/.exec(f)![0], /\s*$/.exec(f)![0], /[~:]?$/.exec(f.trimEnd())![0]];
}

function literals(m: Message): string[] {
  const text = forms(m).join('\n');
  return [
    ...text.matchAll(
      /`[^`]+`|\b[a-z][\w-]*\.[a-z0-9][\w.-]*|\b[a-z]+[A-Z]\w*|--[a-z][\w-]*|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+/g,
    ),
  ]
    .map((x) => x[0])
    .filter((x) => !/^(e\.g|i\.e)\.?$/.test(x));
}

const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('tr table', () => {
  it('merges every area without overlap', () => {
    const sum = AREA_PAIRS.reduce((n, [, , a]) => n + Object.keys(a).length, 0);
    expect(Object.keys(tr).length).toBe(sum);
    expect(TR.messages).toBe(tr);
  });

  it('keeps compact units and acronyms in widget words', () => {
    expect(trWidgets['widget.provider.anthropicAws']).toBe('AWS');
    expect(trWidgets['widget.provider.apiKey']).toMatch(/^API /);
    expect(trWidgets['widget.status.ok'].startsWith('✓ ')).toBe(true);
    expect(trExplain['explain.ageShort.minutes']).toBe('{n}m');
  });

  it('hook messages take versions as params', () => {
    for (const [id, msg] of Object.entries(trHooks)) {
      for (const f of forms(msg)) expect(f, id).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });
});

describe.each(AREA_PAIRS)('tr %s table', (_name, enArea, trArea) => {
  it('has the same ids', () => {
    expect(Object.keys(trArea).sort()).toEqual(Object.keys(enArea).sort());
  });

  it('keeps params, plural shape and edges', () => {
    for (const [id, msg] of Object.entries(trArea)) {
      const base = enArea[id]!;
      expect(typeof msg, id).toBe(typeof base);
      expect(params(msg), id).toEqual(params(base));
      const [a, b] = [forms(msg), forms(base)];
      for (let i = 0; i < a.length; i++) expect(edges(a[i]!), id).toEqual(edges(b[i]!));
    }
  });

  it('keeps code, keys and metric names literal', () => {
    for (const [id, msg] of Object.entries(trArea)) {
      const text = forms(msg).join('\n');
      for (const tok of literals(enArea[id]!)) expect(text, `${id} ${tok}`).toContain(tok);
    }
  });

  it('is clean text', () => {
    for (const [id, msg] of Object.entries(trArea)) {
      for (const f of forms(msg)) {
        expect(f.trim().length, id).toBeGreaterThan(0);
        expect(f, id).toBe(f.normalize('NFC'));
        expect(f, id).not.toMatch(CONTROL);
      }
    }
  });
});

describe.each(LANGUAGES.map((l) => [l.id, l] as const))('%s messages', (_id, l) => {
  it('have every English id and no other', () => {
    expect(Object.keys(l.messages).sort()).toEqual(Object.keys(en).sort());
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

  it('registers Turkish', () => {
    expect(LANGUAGE_IDS).toEqual(['en', 'tr']);
    expect(LANGUAGE_SETTINGS).toEqual(['auto', 'en', 'tr']);
    expect(nativeName('tr')).toBe('Türkçe');
    expect(languageDef('tr')).toBe(TR);
    expect(matchLanguage('tur')).toBe('tr');
    expect(matchLanguage('TR')).toBe('tr');
  });

  it('checks ids without the prototype', () => {
    expect(isLanguageId('en')).toBe(true);
    expect(isLanguageId('tr')).toBe(true);
    expect(isLanguageId('EN')).toBe(false);
    expect(isLanguageId('TR')).toBe(false);
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
      cliMessages,
      commandsMessages,
      errorMessages,
      inspectorMessages,
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

describe('test pins', () => {
  it('pin the process locale to C', () => {
    expect(process.env.LANG).toBe('C');
    expect(process.env.LC_ALL).toBe('C');
    expect(process.env.LC_MESSAGES).toBeUndefined();
    expect(process.env.CCINFOBAR_LANG).toBeUndefined();
  });

  it('leave a language active for the next test', () => {
    setLanguage({ id: 'xx', name: 'Test', aliases: [], locale: 'en', messages: {} });
    expect(language()).toBe('xx');
  });

  it('start every test in English', () => {
    expect(language()).toBe('en');
  });

  it('withLang restores the language', () => {
    expect(withLang({ id: 'yy', name: 'Y', aliases: [], locale: 'en', messages: {} }, () => language())).toBe(
      'yy',
    );
    expect(language()).toBe('en');
  });
});

describe('core errors', () => {
  it('follow the active language', () => {
    const bad = { id: '../x' } as ThemeInput;
    expect(() => saveUserTheme(bad, '/nonexistent')).toThrow(
      'Theme id must be letters, numbers, dot, dash or underscore',
    );
    expect(() => withLang('tr', () => saveUserTheme(bad, '/nonexistent'))).toThrow(
      'Tema kimliği yalnızca harf, rakam, nokta, tire veya alt çizgi içerebilir',
    );
    expect(() => withLang('tr', () => renderPreview(defaultConfig(), { scenario: 'nope' }, 80))).toThrow(
      'bilinmeyen senaryo',
    );
  });
});
