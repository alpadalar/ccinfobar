import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import type { Config, WidgetItem } from '../../src/core/types.js';
import { displayValue, widgetFields } from '../../src/tui/fields.js';
import { getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

const cfgOf = (item: WidgetItem): Config => ({ ...defaultConfig(), lines: [[item]] });
const fieldOf = (config: Config, key: string) => {
  const item = config.lines[0]![0]!;
  return widgetFields(getWidget(item.type), item.id, config).find((f) => f.id === `option:${key}`)!;
};

describe('TUI option fields with aliases', () => {
  it('inverted option: label and state, fresh item', () =>
    withLang('en', () => {
      const c = cfgOf({ id: 'a', type: 'compactions' });
      const f = fieldOf(c, 'hideZero');
      expect(f.label).toBe('Hide when zero');
      expect(displayValue(f, c).text).toBe('on');
    }));

  it('inverted option: label and state, old showZero true', () =>
    withLang('en', () => {
      const c = cfgOf({ id: 'a', type: 'compactions', options: { showZero: true } });
      const f = fieldOf(c, 'hideZero');
      expect(f.label).toBe('Hide when zero');
      expect(displayValue(f, c).text).toBe('off');
      const next = f.set(c, true);
      expect(next.lines[0]![0]!.options).toEqual({ hideZero: true });
    }));

  it('shows an old display value under show and writes show', () =>
    withLang('en', () => {
      const c = cfgOf({ id: 'a', type: 'budget', options: { display: 'bar' } });
      const f = fieldOf(c, 'show');
      expect(f.get(c)).toBe('bar');
      expect(displayValue(f, c).text).toBe('Bar');
      const next = f.set(c, 'text');
      expect(next.lines[0]![0]!.options).toEqual({ show: 'text' });
    }));
});
