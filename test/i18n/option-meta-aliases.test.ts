import { describe, expect, it } from 'vitest';
import type { LanguageDef, MetaTable } from '../../src/core/i18n/index.js';
import { optionHelp, optionLabel } from '../../src/core/i18n/widget-text.js';
import { getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const meta: MetaTable = {
  widgets: {
    'fast-mode': {
      name: 'Hızlı',
      description: 'Hızlı kip',
      options: { showOff: { label: 'Kapalıyken göster', help: 'H' } },
    },
    budget: {
      name: 'Bütçe',
      description: 'Bütçe',
      options: { display: { label: 'Gösterim' } },
    },
    'jj-workspace': {
      name: 'JJ',
      description: 'JJ',
      options: { hideDefault: { label: 'Varsayılanı gizle' } },
    },
  },
  options: {},
  categories: {},
  catalog: {},
};
const zz: LanguageDef = { id: 'zz', name: 'Test', aliases: [], locale: 'tr', messages: {}, meta };

const spec = (type: string, key: string) => getWidget(type)!.options!.find((o) => o.key === key)!;

describe('option meta aliases', () => {
  it('an inverted alias does not lend its label or help', () => {
    withLang(zz, () => {
      const def = getWidget('fast-mode')!;
      const hide = spec('fast-mode', 'hideOff');
      expect(optionLabel(def, hide)).not.toBe('Kapalıyken göster');
      expect(optionLabel(def, hide)).toBe(hide.label);
      expect(optionHelp(def, hide)).not.toBe('H');
    });
  });

  it('a same-value alias still lends its label', () => {
    withLang(zz, () => {
      expect(optionLabel(getWidget('budget')!, spec('budget', 'show'))).toBe('Gösterim');
      expect(optionLabel(getWidget('jj-workspace')!, spec('jj-workspace', 'hideZero'))).toBe(
        'Varsayılanı gizle',
      );
    });
  });
});
