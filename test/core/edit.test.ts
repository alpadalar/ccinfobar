import { describe, expect, it } from 'vitest';
import { defaultConfig, normalizeConfig } from '../../src/core/config.js';
import {
  addLine,
  addProfileOverride,
  applyStyle,
  clearColors,
  hasOwnColors,
  insertItem,
  moveItem,
  moveLine,
  needsRefresh,
  REFRESH_SUGGEST,
  RULE_PRESETS,
  recordStyles,
  refreshReasons,
  removeItem,
  removeLine,
  removeProfileOverride,
  ruleFromText,
  ruleQuickState,
  ruleToText,
  setBudget,
  setItemRule,
  setLineAlign,
  setOption,
  setProfilesBuiltIn,
  setRuleQuick,
  takeStyle,
  timeRuleFeed,
  updateItem,
  updateProfileOverride,
  upgradeOptions,
} from '../../src/core/edit.js';
import type { Config, WidgetItem } from '../../src/core/types.js';

const base = (): Config => ({
  ...defaultConfig(),
  lines: [
    [
      { id: 'a', type: 'text' },
      { id: 'b', type: 'text' },
      { id: 'c', type: 'text' },
    ],
    [{ id: 'd', type: 'text' }],
  ],
});
const ids = (c: Config) => c.lines.map((l) => l.map((i) => i.id));

describe('edit ops', () => {
  it('moves within a line in both directions', () => {
    expect(ids(moveItem(base(), 'a', { line: 0, index: 3 }))).toEqual([['b', 'c', 'a'], ['d']]);
    expect(ids(moveItem(base(), 'c', { line: 0, index: 0 }))).toEqual([['c', 'a', 'b'], ['d']]);
    expect(ids(moveItem(base(), 'a', { line: 0, index: 1 }))).toEqual([['a', 'b', 'c'], ['d']]);
  });

  it('moves across lines and creates missing lines', () => {
    expect(ids(moveItem(base(), 'b', { line: 1, index: 0 }))).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
    expect(ids(moveItem(base(), 'd', { line: 2, index: 0 }))).toEqual([['a', 'b', 'c'], [], ['d']]);
  });

  it('inserts with unique ids and removes', () => {
    const c = insertItem(
      insertItem(base(), { type: 'model' }, { line: 1, index: 9 }),
      { type: 'model' },
      { line: 1, index: 0 },
    );
    expect(ids(c)[1]).toEqual(['model-2', 'd', 'model-1']);
    expect(ids(removeItem(c, 'd'))[1]).toEqual(['model-2', 'model-1']);
  });

  it('updates items and clears undefined keys', () => {
    const c = updateItem(base(), 'a', { color: 'red', bold: true });
    expect(c.lines[0]![0]).toEqual({ id: 'a', type: 'text', color: 'red', bold: true });
    expect(updateItem(c, 'a', { color: undefined }).lines[0]![0]).toEqual({
      id: 'a',
      type: 'text',
      bold: true,
    });
    expect(setOption(c, 'a', 'text', 'hi').lines[0]![0]!.options).toEqual({ text: 'hi' });
  });

  it('manages lines without mutating input', () => {
    const b = base();
    expect(ids(addLine(b, 0))).toEqual([[], ['a', 'b', 'c'], ['d']]);
    expect(ids(removeLine(b, 0))).toEqual([['d']]);
    expect(ids(moveLine(b, 1, 0))).toEqual([['d'], ['a', 'b', 'c']]);
    expect(ids(b)).toEqual([['a', 'b', 'c'], ['d']]);
  });
});

describe('styles', () => {
  const cfg = (): Config => ({
    ...defaultConfig(),
    lines: [
      [
        {
          id: 'a',
          type: 'context-bar',
          color: 'red',
          bold: true,
          raw: true,
          options: { style: 'dots', width: 6 },
        },
        { id: 'b', type: 'model', color: 'blue', italic: true },
        { id: 'c', type: 'five-hour-usage', options: { display: 'bar' } },
      ],
    ],
  });

  it('copies the chosen groups exactly', () => {
    const c = cfg();
    const snap = takeStyle(c.lines[0]![0]!);
    const colors = applyStyle(c, ['b'], snap, ['colors']).lines[0]![1]!;
    expect(colors).toMatchObject({ color: 'red', italic: true });
    const text = applyStyle(c, ['b'], snap, ['text']).lines[0]![1]!;
    expect(text.bold).toBe(true);
    expect(text.italic).toBeUndefined();
    const bars = applyStyle(c, ['c'], snap, ['bars'], () => ['display', 'style', 'width']).lines[0]![2]!;
    expect(bars.options).toEqual({ style: 'dots', width: 6 });
    expect(applyStyle(c, ['b'], snap, ['label']).lines[0]![1]!.raw).toBe(true);
  });

  it('clears own colors for a theme', () => {
    const c = cfg();
    expect(hasOwnColors(c)).toBe(true);
    const plain = clearColors(c);
    expect(hasOwnColors(plain)).toBe(false);
    expect(plain.lines[0]![0]!.bold).toBe(true);
  });

  it('keeps the last three previous styles per widget', () => {
    let c = cfg();
    let history = {};
    for (const color of ['green', 'yellow', 'cyan', 'magenta']) {
      const next = updateItem(c, 'b', { color });
      history = recordStyles(history, c, next);
      c = next;
    }
    const list = (history as Record<string, { color?: string }[]>).b!;
    expect(list.map((s) => s.color)).toEqual(['cyan', 'yellow', 'green']);
    expect(recordStyles(history, c, c)).toEqual(history);
  });
});

describe('line alignment', () => {
  it('follows its line when lines are added, moved and removed', () => {
    const base = { ...defaultConfig(), lines: [[], [], []] as WidgetItem[][] };
    let c = setLineAlign(base, 1, 'right');
    expect(c.lineAlign).toEqual([null, 'right']);
    c = addLine(c, 0);
    expect(c.lineAlign).toEqual([null, null, 'right']);
    c = moveLine(c, 2, 0);
    expect(c.lineAlign).toEqual(['right']);
    c = removeLine(c, 0);
    expect(c.lineAlign).toBeUndefined();
  });
});

describe('upgradeOptions', () => {
  const withItems = (...items: WidgetItem[]): Config => ({ ...defaultConfig(), lines: [items] });
  const opts = (c: Config) => c.lines[0]!.map((i) => i.options);

  it('maps legacy usable to basis without mutating the input', () => {
    const cfg = withItems({ id: 'p', type: 'context-percentage', options: { usable: true } });
    const before = JSON.stringify(cfg);
    expect(opts(upgradeOptions(cfg))).toEqual([{ basis: 'usable' }]);
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it('keeps an existing basis and drops usable false', () => {
    const cfg = withItems(
      { id: 'a', type: 'context-bar', options: { basis: 'reserve', usable: true, width: 8 } },
      { id: 'b', type: 'context-percentage', options: { usable: false, mode: 'remaining' } },
      { id: 'c', type: 'context-percentage', options: { usable: true, basis: 'bogus' } },
      { id: 'd', type: 'text', options: { usable: true } },
    );
    expect(opts(upgradeOptions(cfg))).toEqual([
      { basis: 'reserve', width: 8 },
      { mode: 'remaining' },
      { basis: 'usable' },
      { usable: true },
    ]);
  });

  it('leaves configs without usable unchanged', () => {
    const cfg = withItems(
      { id: 'p', type: 'context-percentage', options: { basis: 'raw' } },
      { id: 't', type: 'text' },
    );
    expect(upgradeOptions(cfg)).toEqual(cfg);
  });

  it('round-trips through normalizeConfig', () => {
    const cfg = withItems({ id: 'p', type: 'context-percentage', options: { usable: true } });
    expect(normalizeConfig(cfg).lines[0]![0]!.options).toEqual({ usable: true });
    expect(normalizeConfig(upgradeOptions(cfg)).lines[0]![0]!.options).toEqual({ basis: 'usable' });
  });
});

describe('setBudget', () => {
  const base = defaultConfig();

  it('sets, clamps and removes budget values', () => {
    let c = setBudget(base, 'daily', 10);
    expect(c.budget).toEqual({ daily: 10 });
    expect(base.budget).toBeUndefined();
    c = setBudget(c, 'session', 2.5);
    c = setBudget(c, 'warnAt', 0.75);
    expect(c.budget).toEqual({ daily: 10, session: 2.5, warnAt: 0.75 });
    expect(setBudget(c, 'warnAt', 3).budget?.warnAt).toBe(1);
    expect(setBudget(c, 'warnAt', 0).budget?.warnAt).toBe(0.05);
    expect(setBudget(c, 'warnAt', 0.8).budget).toEqual({ daily: 10, session: 2.5 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(setBudget(c, 'daily', bad).budget).toEqual({ session: 2.5, warnAt: 0.75 });
    }
  });

  it('removes the key when nothing is left', () => {
    const c = setBudget(setBudget(base, 'daily', 5), 'daily', undefined);
    expect('budget' in c).toBe(false);
    expect('budget' in setBudget(base, 'warnAt', 0.8)).toBe(false);
  });
});

describe('needsRefresh', () => {
  const timed = new Set(['turn-timer', 'clock', 'cache-timer']);
  const isTimed = (t: string) => timed.has(t);
  const cfg = (lines: string[][]): Config => ({
    ...defaultConfig(),
    lines: lines.map((l) => l.map((type, i) => ({ id: `${type}-${i}`, type }))),
  });

  it('lists the flagged types on the layout, sorted and once', () => {
    const c = cfg([
      ['model', 'turn-timer'],
      ['clock', 'turn-timer'],
    ]);
    expect(needsRefresh(c, isTimed)).toEqual(['clock', 'turn-timer']);
    expect(needsRefresh(c, isTimed, ['cache-timer', 'model'])).toEqual([
      'cache-timer',
      'clock',
      'turn-timer',
    ]);
    expect(needsRefresh(cfg([]), isTimed)).toEqual([]);
    expect(needsRefresh(cfg([['model']]), isTimed, new Set(['git-branch']))).toEqual([]);
    expect(REFRESH_SUGGEST).toBe(5);
  });

  it('refreshReasons lists widgets and fed rules', () => {
    const c = cfg([['model', 'turn-timer']]);
    expect(refreshReasons(c, isTimed)).toEqual({ widgets: ['turn-timer'], rules: [] });
    expect(refreshReasons(c, isTimed, [() => ['rule b', 'rule a'], () => ['rule a']])).toEqual({
      widgets: ['turn-timer'],
      rules: ['rule a', 'rule b'],
    });
    expect(refreshReasons(cfg([]), isTimed)).toEqual({ widgets: [], rules: [] });
    expect(refreshReasons(cfg([['model']]), isTimed, [], ['clock'])).toEqual({
      widgets: ['clock'],
      rules: [],
    });
  });

  it('timeRuleFeed lists items whose valid rules read the time', () => {
    const c: Config = {
      ...defaultConfig(),
      lines: [
        [
          { id: 'g1', type: 'git-branch', hideWhen: '!git' },
          { id: 'clk2', type: 'model', showWhen: 'time.hour in 9..18' },
          { id: 'bad', type: 'model', showWhen: 'time.hour in 9..' },
        ],
        [
          { id: 'wk', type: 'cwd', hideWhen: ['git', 'time.weekday in sat,sun'] },
          { id: 'clk2', type: 'model', showWhen: 'time.hour >= 9' },
          { id: 'm', type: 'model' },
        ],
      ],
    };
    expect(timeRuleFeed(c)).toEqual(['clk2', 'wk']);
    expect(timeRuleFeed(cfg([['model']]))).toEqual([]);
    expect(refreshReasons(c, isTimed, [timeRuleFeed])).toEqual({ widgets: [], rules: ['clk2', 'wk'] });
  });
});

describe('profile edits', () => {
  const base = defaultConfig();

  it('toggles builtIn and removes the key at the default', () => {
    const off = setProfilesBuiltIn(base, false);
    expect(off.profiles).toEqual({ builtIn: false });
    expect(base.profiles).toBeUndefined();
    expect(setProfilesBuiltIn(off, true).profiles).toBeUndefined();
  });

  it('adds, updates and removes overrides', () => {
    let c = addProfileOverride(base, { match: 'glm-*', contextWindow: 500000, input: -1, currency: 'cny' });
    expect(c.profiles).toEqual({ models: [{ match: 'glm-*', contextWindow: 500000, currency: 'CNY' }] });
    expect(addProfileOverride(c, { match: '' })).toBe(c);
    c = addProfileOverride(c, { match: 'kimi-*', label: 'Kimi' });
    c = updateProfileOverride(c, 0, { input: 1, output: 2, contextWindow: undefined });
    expect(c.profiles?.models?.[0]).toEqual({ match: 'glm-*', input: 1, output: 2, currency: 'CNY' });
    c = updateProfileOverride(c, 0, { match: '', output: 0 });
    expect(c.profiles?.models?.[0]).toEqual({ match: 'glm-*', input: 1, currency: 'CNY' });
    expect(updateProfileOverride(c, 5, { label: 'x' })).toBe(c);
    c = removeProfileOverride(c, 0);
    expect(c.profiles).toEqual({ models: [{ match: 'kimi-*', label: 'Kimi' }] });
    expect(removeProfileOverride(c, 0).profiles).toBeUndefined();
    const off = removeProfileOverride(setProfilesBuiltIn(c, false), 0);
    expect(off.profiles).toEqual({ builtIn: false });
  });

  it('caps the override list', () => {
    let c = base;
    for (let i = 0; i < 101; i++) c = addProfileOverride(c, { match: `m${i}` });
    expect(c.profiles?.models).toHaveLength(100);
  });
});

describe('rule edits', () => {
  const withItem = (extra: Partial<WidgetItem>): Config => ({
    ...defaultConfig(),
    lines: [[{ id: 'w', type: 'text', ...extra }]],
  });
  const item = (c: Config) => c.lines[0]![0]!;
  const quick = (extra: Partial<WidgetItem>) => ruleQuickState(item(withItem(extra)));

  it('reads owned clauses back', () => {
    const s = quick({ showWhen: ['git', 'context.pct >= 70'] });
    expect(s.quick.git).toBe(true);
    expect(s.quick.context).toEqual({ mode: 'show', at: 70 });
    expect(s.custom).toEqual({ showWhen: false, hideWhen: false });
    expect(s.invalid).toEqual({ showWhen: null, hideWhen: null });
  });

  it('reads hidden providers, hours and hide thresholds', () => {
    expect(quick({ hideWhen: 'provider in bedrock,vertex' }).quick.hideProviders).toEqual([
      'bedrock',
      'vertex',
    ]);
    expect(quick({ hideWhen: 'provider == vertex' }).quick.hideProviders).toEqual(['vertex']);
    expect(quick({ showWhen: 'time.hour in 9..18' }).quick.hours).toEqual({ from: 9, to: 18 });
    expect(quick({ hideWhen: 'usage.5h >= 80' }).quick.usage5h).toEqual({ mode: 'hide', at: 80 });
  });

  it('marks clauses it cannot represent as custom', () => {
    const s = quick({ showWhen: 'usage.5h >= 80 || usage.7d >= 90' });
    expect(s.custom.showWhen).toBe(true);
    expect(s.quick.usage5h).toBeNull();
    expect(quick({ showWhen: '!git' }).custom.showWhen).toBe(true);
    expect(quick({ showWhen: 'usage.5h >= 80 ~5' }).custom.showWhen).toBe(true);
    expect(quick({ showWhen: ['git', 'git'] }).custom.showWhen).toBe(true);
  });

  it('reports an invalid rule and gives no quick values for it', () => {
    const s = quick({ showWhen: 'contxt > 1' });
    expect(s.invalid.showWhen).toBe('unknown metric "contxt"');
    expect(s.custom.showWhen).toBe(false);
  });

  it('writes and removes quick clauses', () => {
    let c = setRuleQuick(withItem({}), 'w', { git: true });
    expect(item(c).showWhen).toBe('git');
    c = setRuleQuick(c, 'w', { context: { mode: 'show', at: 70 } });
    expect(item(c).showWhen).toEqual(['git', 'context.pct >= 70']);
    c = setRuleQuick(c, 'w', { git: false, context: null });
    expect('showWhen' in item(c)).toBe(false);
  });

  it('keeps custom clauses verbatim after the owned ones', () => {
    const c = setRuleQuick(withItem({ showWhen: ['usage.5h >= 80   ||  usage.7d >= 90'] }), 'w', {
      git: true,
    });
    expect(item(c).showWhen).toEqual(['git', 'usage.5h >= 80   ||  usage.7d >= 90']);
  });

  it('leaves an invalid key byte-identical', () => {
    const start = withItem({ showWhen: 'contxt > 1' });
    const c = setRuleQuick(start, 'w', { git: true });
    expect(item(c).showWhen).toBe('contxt > 1');
    expect(c).toEqual(start);
  });

  it('does not rewrite a key the patch does not change', () => {
    const c = setRuleQuick(withItem({ showWhen: '  git ', hideWhen: 'gsd' }), 'w', {
      hideProviders: ['bedrock'],
    });
    expect(item(c).showWhen).toBe('  git ');
    expect(item(c).hideWhen).toEqual(['provider in bedrock', 'gsd']);
  });

  it('writes hide thresholds, providers and hours', () => {
    let c = setRuleQuick(withItem({}), 'w', { context: { mode: 'hide', at: 90 } });
    expect(item(c).hideWhen).toBe('context.pct >= 90');
    expect('showWhen' in item(c)).toBe(false);
    c = setRuleQuick(c, 'w', { context: { mode: 'show', at: 90 }, hours: { from: 9, to: 18 } });
    expect(item(c).showWhen).toEqual(['context.pct >= 90', 'time.hour in 9..18']);
    expect('hideWhen' in item(c)).toBe(false);
    c = setRuleQuick(c, 'w', { hideProviders: ['bedrock', 'vertex'] });
    expect(item(c).hideWhen).toBe('provider in bedrock,vertex');
  });

  it('round-trips through formatRule', () => {
    const c = setRuleQuick(withItem({}), 'w', {
      git: true,
      gsd: true,
      agents: true,
      context: { mode: 'show', at: 70 },
      usage5h: { mode: 'hide', at: 80 },
      hideProviders: ['vertex'],
      hours: { from: 22, to: 6 },
    });
    const s = ruleQuickState(item(c));
    expect(s.quick).toEqual({
      git: true,
      gsd: true,
      agents: true,
      context: { mode: 'show', at: 70 },
      usage5h: { mode: 'hide', at: 80 },
      hideProviders: ['vertex'],
      hours: { from: 22, to: 6 },
    });
    expect(s.custom).toEqual({ showWhen: false, hideWhen: false });
  });

  it('stores raw rule text only when it parses', () => {
    const start = withItem({ hideWhen: 'gsd' });
    const ok = setItemRule(start, 'w', 'showWhen', 'context.pct  >= 70');
    expect(ok.ok && item(ok.config).showWhen).toBe('context.pct  >= 70');
    const list = setItemRule(start, 'w', 'showWhen', ['git', 'gsd']);
    expect(list.ok && item(list.config).showWhen).toEqual(['git', 'gsd']);
    const bad = setItemRule(start, 'w', 'showWhen', 'contxt > 1');
    expect(bad).toEqual({ ok: false, error: 'unknown metric "contxt"' });
    expect(start).toEqual(withItem({ hideWhen: 'gsd' }));
    for (const empty of ['', '  ', [], undefined]) {
      const r = setItemRule(start, 'w', 'hideWhen', empty);
      expect(r.ok && 'hideWhen' in item(r.config)).toBe(false);
    }
  });

  it('converts rule text to entries and back', () => {
    expect(ruleFromText('git;  context.pct >= 70 ;')).toEqual(['git', 'context.pct >= 70']);
    expect(ruleFromText(' git ')).toBe('git');
    expect(ruleFromText(' ; ')).toBeUndefined();
    expect(ruleToText(['git', 'gsd'])).toBe('git; gsd');
    expect(ruleToText('git')).toBe('git');
    expect(ruleToText(undefined)).toBe('');
  });

  it('presets are valid canonical rules', () => {
    expect(RULE_PRESETS.map((p) => p.id)).toEqual(['none', 'git', 'gsd', 'agents', 'context70', 'usage80']);
    for (const p of RULE_PRESETS) {
      if (p.rule === null) continue;
      const r = setItemRule(withItem({}), 'w', 'showWhen', p.rule);
      expect(r.ok).toBe(true);
    }
  });
});
