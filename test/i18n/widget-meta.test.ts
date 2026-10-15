import { describe, expect, it } from 'vitest';
import type { LanguageDef, MetaFile, MetaTable } from '../../src/core/i18n/index.js';
import { TR } from '../../src/core/i18n/languages.js';
import { byCategory, sharedOptions, trMeta } from '../../src/core/i18n/tr/meta/index.js';
import {
  categoryText,
  choiceLabel,
  optionHelp,
  optionLabel,
  widgetHint,
  widgetText,
} from '../../src/core/i18n/widget-text.js';
import type { OptionSpec } from '../../src/core/types.js';
import { ALL_WIDGETS, CATEGORIES, getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

type Def = { type: string; name: string; label?: string; options?: OptionSpec[] };

// choice labels kept as they are, with the reason
const EXEMPT_CHOICES = new Map<string, string>([]);

const exemptChoice = (label: string) => !/\p{L}{2,}/u.test(label) || EXEMPT_CHOICES.has(label);

const edges = (s: string) => [/^\s*/.exec(s)![0], /\s*$/.exec(s)![0]];

function cleanText(s: string): boolean {
  return s === s.normalize('NFC') && !/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/.test(s);
}

function optionTexts(defs: Def[]): Set<string> {
  const out = new Set<string>();
  for (const d of defs) {
    for (const o of d.options ?? []) {
      out.add(o.label);
      if (o.help) out.add(o.help);
      for (const c of o.choices ?? []) out.add(c.label);
    }
  }
  return out;
}

function strings(file: MetaFile): string[] {
  const out = Object.values(file.options ?? {});
  for (const m of Object.values(file.widgets)) {
    out.push(m.name, m.description);
    for (const v of [m.label, m.hint, m.sample]) if (v !== undefined) out.push(v);
    for (const o of Object.values(m.options ?? {})) {
      for (const v of [o.label, o.help]) if (v !== undefined) out.push(v);
      out.push(...Object.values(o.choices ?? {}));
    }
  }
  return out;
}

function problems(defs: Def[], file: MetaFile, shared: Record<string, string> = {}): string[] {
  const out: string[] = [];
  const text = { ...shared, ...file.options };
  const has = (s: string) => Object.hasOwn(text, s);
  const types = new Set(defs.map((d) => d.type));
  for (const type of Object.keys(file.widgets)) if (!types.has(type)) out.push(`${type}: unknown type`);
  for (const d of defs) {
    const m = Object.hasOwn(file.widgets, d.type) ? file.widgets[d.type] : undefined;
    if (!m) {
      out.push(`${d.type}: no meta`);
      continue;
    }
    if (!m.name) out.push(`${d.type}: no name`);
    if (!m.description) out.push(`${d.type}: no description`);
    if (d.label && m.label === undefined) out.push(`${d.type}: no label`);
    if (!d.label && m.label !== undefined) out.push(`${d.type}: label without an English label`);
    if (d.label && m.label !== undefined) {
      if (!m.label.trim()) out.push(`${d.type}: empty label`);
      if (edges(m.label).join('|') !== edges(d.label).join('|')) out.push(`${d.type}: label whitespace`);
    }
    const specs = new Map((d.options ?? []).map((o) => [o.key, o]));
    for (const [key, o] of Object.entries(m.options ?? {})) {
      const spec = specs.get(key);
      if (!spec) {
        out.push(`${d.type}.${key}: unknown option`);
        continue;
      }
      for (const v of Object.keys(o.choices ?? {})) {
        if (!spec.choices?.some((c) => c.value === v)) out.push(`${d.type}.${key}=${v}: unknown choice`);
      }
    }
    for (const spec of specs.values()) {
      const o = m.options?.[spec.key];
      if (o?.label === undefined && !has(spec.label))
        out.push(`${d.type}.${spec.key}: label "${spec.label}"`);
      if (spec.help && o?.help === undefined && !has(spec.help)) out.push(`${d.type}.${spec.key}: help`);
      for (const c of spec.choices ?? []) {
        if (exemptChoice(c.label)) continue;
        if (o?.choices?.[c.value] === undefined && !has(c.label)) {
          out.push(`${d.type}.${spec.key}=${c.value}: choice "${c.label}"`);
        }
      }
    }
  }
  const used = optionTexts(defs);
  for (const s of Object.keys(file.options ?? {})) if (!used.has(s)) out.push(`option text "${s}" is unused`);
  for (const s of strings(file)) if (!s || !cleanText(s)) out.push(`bad text ${JSON.stringify(s)}`);
  return out;
}

const fixtureDefs: Def[] = [
  {
    type: 'a',
    name: 'Alpha',
    label: 'A ',
    options: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        default: 'x',
        help: 'Pick one',
        choices: [
          { value: 'x', label: 'Used' },
          { value: 'y', label: '1h 12m' },
        ],
      },
    ],
  },
  { type: 'b', name: 'Beta' },
];

const good: MetaFile = {
  widgets: {
    a: { name: 'Alfa', description: 'Açıklama', label: 'Al ', options: { mode: { label: 'Kip' } } },
    b: { name: 'Beta', description: 'Açıklama' },
  },
  options: { 'Pick one': 'Birini seçin', Used: 'Kullanılan' },
};

describe('widget-meta rule runner', () => {
  it('passes a complete file', () => {
    expect(problems(fixtureDefs, good)).toEqual([]);
  });

  it('uses shared texts', () => {
    const file: MetaFile = { widgets: good.widgets, options: { Used: 'Kullanılan' } };
    expect(problems(fixtureDefs, file, { 'Pick one': 'Birini seçin' })).toEqual([]);
  });

  it('flags missing meta, labels and option texts', () => {
    const file: MetaFile = { widgets: { a: { name: 'Alfa', description: 'Açıklama' } } };
    expect(problems(fixtureDefs, file)).toEqual([
      'a: no label',
      'a.mode: label "Mode"',
      'a.mode: help',
      'a.mode=x: choice "Used"',
      'b: no meta',
    ]);
  });

  it('flags labels without an English label and whitespace changes', () => {
    const file: MetaFile = {
      widgets: { a: { ...good.widgets.a!, label: 'Al' }, b: { ...good.widgets.b!, label: 'B ' } },
      options: good.options,
    };
    expect(problems(fixtureDefs, file)).toEqual(['a: label whitespace', 'b: label without an English label']);
  });

  it('flags unknown types, options, choices and unused texts', () => {
    const file: MetaFile = {
      widgets: {
        ...good.widgets,
        a: { ...good.widgets.a!, options: { mode: { label: 'Kip', choices: { z: 'Zet' } }, nope: {} } },
        zz: { name: 'Z', description: 'Z' },
      },
      options: { ...good.options, Gone: 'Yok' },
    };
    expect(problems(fixtureDefs, file)).toEqual([
      'zz: unknown type',
      'a.mode=z: unknown choice',
      'a.nope: unknown option',
      'option text "Gone" is unused',
    ]);
  });

  it('flags empty, non-NFC and control text', () => {
    const file: MetaFile = {
      widgets: { ...good.widgets, b: { name: '', description: 'ç' } },
      options: { ...good.options, Used: 'a‮b' },
    };
    expect(problems(fixtureDefs, file)).toEqual([
      'b: no name',
      'bad text "a‮b"',
      'bad text ""',
      'bad text "ç"',
    ]);
  });

  it('exempts example choices', () => {
    for (const s of ['1h 12m', '01:12:00', '2026-10-12', '~$4.10/$10', '41%'])
      expect(exemptChoice(s), s).toBe(true);
    for (const s of ['Used', 'Oct 12', 'blocks']) expect(exemptChoice(s), s).toBe(false);
    for (const label of EXEMPT_CHOICES.keys()) {
      expect(ALL_WIDGETS.some((w) => w.options?.some((o) => o.choices?.some((c) => c.label === label)))).toBe(
        true,
      );
    }
  });
});

describe('Turkish widget metadata', () => {
  it('every category file passes the rules', () => {
    for (const [cat, file] of Object.entries(byCategory)) {
      const defs = ALL_WIDGETS.filter((w) => w.category === cat);
      expect(problems(defs, file!, sharedOptions), cat).toEqual([]);
    }
  });

  it('only known categories have files', () => {
    const ids = CATEGORIES.map((c) => c.id as string);
    for (const cat of Object.keys(byCategory)) expect(ids).toContain(cat);
  });

  it('a text in two files has one translation', () => {
    const seen = new Map<string, string>(Object.entries(sharedOptions));
    for (const [cat, file] of Object.entries(byCategory)) {
      for (const [k, v] of Object.entries(file!.options ?? {})) {
        if (seen.has(k)) expect(v, `${cat}: ${k}`).toBe(seen.get(k));
        seen.set(k, v);
      }
    }
  });

  it('shared texts are used and clean', () => {
    const used = optionTexts(ALL_WIDGETS);
    for (const [k, v] of Object.entries(sharedOptions)) {
      expect(used.has(k), k).toBe(true);
      expect(v && cleanText(v), k).toBeTruthy();
    }
  });

  it('merges every file into trMeta', () => {
    expect(TR.meta).toBe(trMeta);
    for (const file of Object.values(byCategory)) {
      for (const type of Object.keys(file!.widgets)) expect(trMeta.widgets[type]).toBe(file!.widgets[type]);
    }
  });
});

describe('Turkish category names', () => {
  it('cover every category with clean text', () => {
    expect(Object.keys(trMeta.categories).sort()).toEqual(CATEGORIES.map((c) => c.id).sort());
    for (const c of CATEGORIES) {
      const name = trMeta.categories[c.id]!;
      expect(name.trim(), c.id).toBe(name);
      expect(name && cleanText(name), c.id).toBeTruthy();
    }
  });

  it('show under Turkish and fall back for unknown ids', () => {
    withLang('tr', () => {
      expect(categoryText('context', 'Context window')).toBe('Bağlam penceresi');
      expect(categoryText('gsd', 'GSD')).toBe('GSD');
      expect(categoryText('nope', 'Nope')).toBe('Nope');
      expect(categoryText('__proto__', 'Proto')).toBe('Proto');
    });
    expect(categoryText('context', 'Context window')).toBe('Context window');
  });
});

describe('widget text helpers in English', () => {
  it('return the WidgetDef English', () => {
    for (const w of ALL_WIDGETS) {
      expect(widgetText(w, 'name')).toBe(w.name);
      expect(widgetText(w, 'description')).toBe(w.description);
      expect(widgetText(w, 'label')).toBe(w.label ?? '');
      expect(widgetText(w, 'sample')).toBe(w.sample ?? '');
      expect(widgetHint(w)).toBe(w.name.replace(/^(GSD|Git)\s+/i, '').toLowerCase());
      for (const o of w.options ?? []) {
        expect(optionLabel(w, o)).toBe(o.label);
        expect(optionHelp(w, o)).toBe(o.help);
        for (const c of o.choices ?? []) expect(choiceLabel(w, o, c)).toBe(c.label);
      }
    }
    for (const c of CATEGORIES) expect(categoryText(c.id, c.name)).toBe(c.name);
  });
});

const meta: MetaTable = {
  widgets: {
    'context-percentage': {
      name: 'İstatistik',
      description: 'Bağlam yüzdesi',
      label: 'Bğl ',
      sample: '%34',
      options: { mode: { label: 'Kip', choices: { used: 'Kullanılan' } } },
    },
    'git-branch': { name: 'Git Dalı', description: 'Dal', hint: 'dal yok' },
  },
  options: { Mode: 'Mod', Remaining: 'Kalan', 'Color by threshold': 'Eşiğe göre renk' },
  categories: { context: 'Bağlam' },
  catalog: {},
};
const zz: LanguageDef = { id: 'zz', name: 'Test', aliases: [], locale: 'tr', messages: {}, meta };

describe('widget text helpers with metadata', () => {
  const def = getWidget('context-percentage')!;
  const spec = (key: string) => def.options!.find((o) => o.key === key)!;

  it('translate widget fields and fall back to English', () => {
    withLang(zz, () => {
      expect(widgetText(def, 'name')).toBe('İstatistik');
      expect(widgetText(def, 'description')).toBe('Bağlam yüzdesi');
      expect(widgetText(def, 'label')).toBe('Bğl ');
      expect(widgetText(def, 'sample')).toBe('%34');
      const other = getWidget('model')!;
      expect(widgetText(other, 'name')).toBe(other.name);
      expect(widgetText(other, 'label')).toBe(other.label ?? '');
    });
  });

  it('translate options with the per-widget override first', () => {
    withLang(zz, () => {
      const mode = spec('mode');
      expect(optionLabel(def, mode)).toBe('Kip');
      expect(choiceLabel(def, mode, mode.choices![0]!)).toBe('Kullanılan');
      expect(choiceLabel(def, mode, mode.choices![1]!)).toBe('Kalan');
      const th = spec('thresholdColors');
      expect(optionLabel(def, th)).toBe('Eşiğe göre renk');
      expect(optionHelp(def, th)).toBe(th.help);
      expect(optionLabel(getWidget('model')!, { key: 'mode', label: 'Mode' })).toBe('Mod');
      expect(optionHelp(def, { key: 'mode', label: 'Mode' })).toBeUndefined();
    });
  });

  it('ignore prototype keys', () => {
    withLang(zz, () => {
      const proto = { type: '__proto__', name: 'Proto', description: 'P' };
      expect(widgetText(proto, 'name')).toBe('Proto');
      expect(widgetText(proto, 'label')).toBe('');
      expect(optionLabel(proto, { key: '__proto__', label: 'constructor' })).toBe('constructor');
      expect(choiceLabel(def, spec('mode'), { value: '__proto__', label: 'toString' })).toBe('toString');
      expect(categoryText('constructor', 'C')).toBe('C');
    });
  });

  it('builds the hint from the translated name with the locale', () => {
    withLang(zz, () => {
      expect(widgetHint(def)).toBe('istatistik');
      expect(widgetHint(getWidget('git-branch')!)).toBe('dal yok');
    });
    const plain: LanguageDef = {
      ...zz,
      meta: { ...meta, widgets: { 'git-branch': { name: 'Git Dalı', description: 'D' } } },
    };
    withLang(plain, () => expect(widgetHint(getWidget('git-branch')!)).toBe('dalı'));
  });
});
