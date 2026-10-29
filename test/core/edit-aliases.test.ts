import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import {
  applyStyle,
  lookKeys,
  optionShown,
  optionValue,
  setOption,
  takeStyle,
  upgradeOptions,
} from '../../src/core/edit.js';
import type { Config, OptionSpec, WidgetItem } from '../../src/core/types.js';

const cfg = (...items: WidgetItem[]): Config => ({ ...defaultConfig(), lines: [items] });
const first = (c: Config) => c.lines[0]![0]!;

describe('optionValue', () => {
  it('reads canonical, then alias, inverting where marked', () => {
    expect(optionValue({ id: 'a', type: 'jj-bookmarks', options: { maxBookmarks: 7 } }, 'maxItems')).toBe(7);
    expect(optionValue({ id: 'a', type: 'compactions', options: { showZero: true } }, 'hideZero')).toBe(
      false,
    );
    expect(
      optionValue({ id: 'a', type: 'jj-bookmarks', options: { maxItems: 2, maxBookmarks: 7 } }, 'maxItems'),
    ).toBe(2);
    expect(optionValue({ id: 'a', type: 'jj-bookmarks' }, 'maxItems')).toBeUndefined();
  });
});

describe('setOption with aliases', () => {
  it('drops the aliases of the written key', () => {
    const c = cfg({ id: 'a', type: 'jj-bookmarks', options: { maxBookmarks: 7, other: 1 } });
    expect(first(setOption(c, 'a', 'maxItems', 2)).options).toEqual({ maxItems: 2, other: 1 });
    expect(first(setOption(c, 'a', 'maxItems', undefined)).options).toEqual({ other: 1 });
    const only = cfg({ id: 'a', type: 'jj-bookmarks', options: { maxBookmarks: 7 } });
    expect(first(setOption(only, 'a', 'maxItems', undefined)).options).toEqual({});
  });

  it('leaves non-aliased keys alone', () => {
    const c = cfg({ id: 'a', type: 'compactions', options: { foo: 'x' } });
    expect(first(setOption(c, 'a', 'bar', 1)).options).toEqual({ foo: 'x', bar: 1 });
  });
});

describe('optionShown with aliases', () => {
  const specs: OptionSpec[] = [
    { key: 'style', label: 'Style', kind: 'select', default: 'text' } as OptionSpec,
    {
      key: 'x',
      label: 'X',
      kind: 'boolean',
      default: false,
      showWhen: { key: 'style', values: ['badge'] },
    } as OptionSpec,
  ];
  it('resolves showWhen keys through aliases', () => {
    expect(optionShown(specs[1]!, specs, { style: 'badge' }, 'performance')).toBe(true);
    expect(optionShown(specs[1]!, specs, { display: 'badge' }, 'performance')).toBe(true);
    expect(optionShown(specs[1]!, specs, { display: 'badge' })).toBe(false);
  });
});

describe('look keys and copy style', () => {
  it('derives per-type look keys', () => {
    expect(lookKeys('budget')).toContain('show');
    expect(lookKeys('budget')).not.toContain('display');
    expect(lookKeys('cache-miss-cause')).not.toContain('show');
    expect(lookKeys('performance')).toContain('style');
    expect(lookKeys('context-bar')).toContain('display');
  });

  it('takeStyle stores canonical keys', () => {
    expect(takeStyle({ id: 'a', type: 'budget', options: { display: 'bar' } })).toEqual({
      options: { show: 'bar' },
    });
  });

  it('applyStyle maps alias keys of old snapshots', () => {
    const c = cfg({ id: 't', type: 'weekly-usage', options: { display: 'text' } });
    const out = first(applyStyle(c, ['t'], { options: { display: 'bar' } }, ['bars']));
    expect(out.options).toEqual({ show: 'bar' });
  });

  it('does not copy a data show option', () => {
    const c = cfg({ id: 't', type: 'cache-miss-cause', options: { show: 'cause' } });
    const out = first(applyStyle(c, ['t'], { options: { show: 'list' } }, ['bars']));
    expect(out.options).toEqual({ show: 'cause' });
  });

  it('supported list is alias-aware', () => {
    const c = cfg({ id: 't', type: 'weekly-usage' });
    const out = first(
      applyStyle(c, ['t'], { options: { show: 'bar' } }, ['bars'], () => ['display', 'width']),
    );
    expect(out.options).toEqual({ show: 'bar' });
  });
});

describe('upgradeOptions', () => {
  it('leaves old-name configs alone', () => {
    const c = cfg(
      { id: 'a', type: 'compactions', options: { showZero: true } },
      { id: 'b', type: 'budget', options: { display: 'bar' } },
    );
    expect(upgradeOptions(c)).toEqual(c);
  });
});
