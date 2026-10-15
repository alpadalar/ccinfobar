import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { resolveAppearance } from '../../src/core/renderer.js';
import { cycled, displayValue, globalFields, listEntries, widgetFields } from '../../src/tui/fields.js';
import { themeInputFromConfig } from '../../src/tui/themeio.js';
import { getWidget } from '../../src/widgets/index.js';

const field = (id: string) => globalFields().find((f) => f.id === id)!;

describe('global override fields', () => {
  it('lists theme and overrides, no powerline fields', () => {
    const ids = globalFields().map((f) => f.id);
    expect(ids.slice(0, 3)).toEqual(['theme', 'style', 'separator']);
    expect(ids).toContain('glyphs.endCap');
    expect(ids.some((i) => i.startsWith('powerline'))).toBe(false);
  });

  it('shows the theme value when unset and the override when set', () => {
    const c = defaultConfig();
    const a = resolveAppearance(c);
    expect(displayValue(field('padding'), c)).toEqual({ text: `${a.padding}  (theme)`, isDefault: true });
    const set = field('padding').set(c, 3);
    expect(c.padding).toBeUndefined();
    expect(displayValue(field('padding'), set)).toEqual({ text: '3', isDefault: false });
  });

  it('resets an override with undefined and removes the key', () => {
    let c = field('separator').set(defaultConfig(), ' // ');
    expect(c.separator).toBe(' // ');
    c = field('separator').set(c, undefined);
    expect('separator' in c).toBe(false);
    c = field('separatorColor').set(c, 'red');
    expect(c.separatorColor).toBe('red');
    expect('separatorColor' in field('separatorColor').set(c, undefined)).toBe(false);
  });

  it('keeps glyph overrides sparse', () => {
    let c = field('glyphs.thin').set(defaultConfig(), '|');
    c = field('glyphs.endCap').set(c, ')');
    expect(c.glyphs).toEqual({ thin: '|', endCap: ')' });
    c = field('glyphs.thin').set(c, undefined);
    expect(c.glyphs).toEqual({ endCap: ')' });
    c = field('glyphs.endCap').set(c, undefined);
    expect(c.glyphs).toBeUndefined();
  });

  it('style offers a theme default entry and cycles from the effective style', () => {
    const f = field('style');
    expect(listEntries(f)[0]).toEqual({ value: undefined, label: 'theme default' });
    const c = defaultConfig();
    const eff = resolveAppearance(c).style;
    expect(cycled(f, c, 1)).not.toBe(eff);
    expect(['text', 'blocks', 'powerline', 'capsule']).toContain(cycled(f, c, 1));
  });

  it('clamps padding', () => {
    expect(field('padding').set(defaultConfig(), 99).padding).toBe(4);
    expect(field('padding').set(defaultConfig(), -2).padding).toBe(0);
  });
});

describe('themeInputFromConfig', () => {
  it('merges overrides into the saved theme and extends the base', () => {
    const c = {
      ...defaultConfig(),
      style: 'blocks' as const,
      separator: '·',
      padding: 2,
      separatorColor: 'red',
      glyphs: { thin: '|' },
    };
    const input = themeInputFromConfig(c, 'mine');
    expect(input.id).toBe('mine');
    expect(input.style).toBe('blocks');
    expect(input.separator).toBe('·');
    expect(input.padding).toBe(2);
    expect(input.colors?.muted).toBe('red');
    expect(input.glyphs?.thin).toBe('|');
    expect(input.extends).toBe(resolveAppearance(c).theme.id);
  });
});

describe('panel fields', () => {
  const panelConfig = () => ({ ...defaultConfig(), style: 'tui' as const });
  const pf = (id: string) => globalFields(panelConfig()).find((f) => f.id === id)!;

  it('adds charset and auto wrap, and panel fields only for the panel style', () => {
    const base = globalFields(defaultConfig()).map((f) => f.id);
    expect(base).toContain('charset');
    expect(base).toContain('autoWrap');
    expect(base.some((i) => i.startsWith('tui.'))).toBe(false);
    const panel = globalFields(panelConfig()).map((f) => f.id);
    for (const id of [
      'tui.box',
      'tui.fitContent',
      'tui.minWidth',
      'tui.maxWidth',
      'tui.padding',
      'tui.dividers',
      'tui.title.left',
      'tui.title.right',
      'tui.footer.left',
      'tui.footer.right',
      'tui.breakpoints',
    ]) {
      expect(panel).toContain(id);
    }
    expect(globalFields({ ...defaultConfig(), theme: 'panel' }).some((f) => f.id === 'tui.box')).toBe(true);
  });

  it('style offers Panel and sets tui', () => {
    const entries = listEntries(globalFields(defaultConfig()).find((f) => f.id === 'style')!);
    expect(entries.some((e) => e.value === 'tui' && e.label === 'Panel')).toBe(true);
  });

  it('sets and resets box presets, dropping tui when empty', () => {
    let c = pf('tui.box').set(panelConfig(), 'double');
    expect(c.tui).toEqual({ box: 'double' });
    expect(cycled(pf('tui.box'), c, 1)).toBe('dashed');
    c = pf('tui.fitContent').set(c, true);
    c = pf('tui.box').set(c, undefined);
    expect(c.tui).toEqual({ fitContent: true });
    c = pf('tui.fitContent').set(c, undefined);
    expect('tui' in c).toBe(false);
  });

  it('clamps numeric cycling and validates input', () => {
    const f = pf('tui.minWidth');
    expect(f.parse('5').ok).toBe(false);
    expect(f.parse('40')).toEqual({ ok: true, value: 40 });
    expect(cycled(pf('tui.maxWidth'), panelConfig(), -1)).toBe(10);
    expect(pf('tui.padding').parse('9').ok).toBe(false);
  });

  it('handles titles, hidden right title and footers', () => {
    let c = pf('tui.title.left').set(panelConfig(), 'Hi {cwd}');
    c = pf('tui.title.right').set(c, 'off');
    expect(c.tui?.title).toEqual({ left: 'Hi {cwd}', right: false });
    expect(displayValue(pf('tui.title.right'), c).text).toBe('off');
    c = pf('tui.footer.left').set(c, 'x');
    expect(c.tui?.footer).toEqual({ left: 'x' });
    c = pf('tui.title.right').set(pf('tui.title.left').set(c, undefined), undefined);
    expect(c.tui?.title).toBeUndefined();
    c = pf('tui.footer.left').set(c, undefined);
    expect('tui' in c).toBe(false);
  });

  it('validates and stores grid breakpoints', () => {
    const f = pf('tui.breakpoints');
    expect(f.parse('{').ok).toBe(false);
    expect(f.parse('{}').ok).toBe(false);
    expect(f.parse('[{"minWidth":0}]').ok).toBe(false);
    const text =
      '[{"minWidth":0,"areas":["model cwd"]},{"minWidth":100,"areas":["model","cwd"],"columns":["1fr"]}]';
    const parsed = f.parse(text);
    expect(parsed.ok).toBe(true);
    const c = f.set(panelConfig(), parsed.ok ? parsed.value : undefined);
    expect(c.tui?.breakpoints).toHaveLength(2);
    expect(displayValue(pf('tui.breakpoints'), c).text).toContain('2 breakpoints');
    expect(JSON.parse(pf('tui.breakpoints').editValue!(c))).toHaveLength(2);
    expect('tui' in f.set(c, undefined)).toBe(false);
  });

  it('edits charset and autoWrap', () => {
    const c = defaultConfig();
    const charset = globalFields(c).find((f) => f.id === 'charset')!;
    expect(charset.set(c, 'text').charset).toBe('text');
    const wrap = globalFields(c).find((f) => f.id === 'autoWrap')!;
    expect(wrap.set(c, !c.autoWrap).autoWrap).toBe(!c.autoWrap);
  });
});

describe('conditional option fields', () => {
  const ids = (options?: Record<string, string>) => {
    const config = defaultConfig();
    config.lines = [[{ id: 'c1', type: 'context-percentage', ...(options ? { options } : {}) }]];
    return widgetFields(getWidget('context-percentage'), 'c1', config).map((f) => f.id);
  };
  it('hides reserveTokens unless basis is reserve', () => {
    expect(ids()).toContain('option:basis');
    expect(ids()).not.toContain('option:reserveTokens');
    expect(ids({ basis: 'usable' })).not.toContain('option:reserveTokens');
    expect(ids({ basis: 'reserve' })).toContain('option:reserveTokens');
  });
});

describe('budget fields', () => {
  it('sets and clears the daily budget', () => {
    const f = field('budget.daily');
    expect(f.parse('10')).toEqual({ ok: true, value: 10 });
    expect(f.parse('$2.5')).toEqual({ ok: true, value: 2.5 });
    expect(f.parse('')).toEqual({ ok: true, value: undefined });
    expect(f.parse('-3').ok).toBe(false);
    expect(f.parse('0').ok).toBe(false);
    let c = f.set(defaultConfig(), 10);
    expect(c.budget).toEqual({ daily: 10 });
    expect(displayValue(f, c)).toEqual({ text: '10', isDefault: false });
    c = field('budget.session').set(c, 2.5);
    expect(c.budget).toEqual({ daily: 10, session: 2.5 });
    c = f.set(c, undefined);
    expect(c.budget).toEqual({ session: 2.5 });
    c = field('budget.session').set(c, undefined);
    expect('budget' in c).toBe(false);
    expect(f.resettable).toBe(true);
  });

  it('shows warnAt as a percent and stores a fraction', () => {
    const f = field('budget.warnAt');
    expect(displayValue(f, defaultConfig()).text).toBe('80');
    expect(f.parse('75')).toEqual({ ok: true, value: 75 });
    expect(f.parse('2').ok).toBe(false);
    expect(f.parse('101').ok).toBe(false);
    const c = f.set(field('budget.daily').set(defaultConfig(), 10), 75);
    expect(c.budget).toEqual({ daily: 10, warnAt: 0.75 });
    expect(f.get(c)).toBe(75);
    expect(cycled(f, c, 1)).toBe(76);
    expect(f.set(c, 80).budget).toEqual({ daily: 10 });
    expect(f.set(c, undefined).budget).toEqual({ daily: 10 });
  });
});

describe('profiles field', () => {
  it('toggles the built-in model profiles', () => {
    const f = field('profiles.builtIn');
    const c = defaultConfig();
    expect(f.kind).toBe('bool');
    expect(f.help).toContain('config set profiles.models');
    expect(displayValue(f, c).text).toBe('on');
    const off = f.set(c, cycled(f, c, 1));
    expect(off.profiles).toEqual({ builtIn: false });
    expect(displayValue(f, off).text).toBe('off');
    const models = { ...off, profiles: { builtIn: false, models: [{ match: 'glm-*' }] } };
    expect(f.set(models, true).profiles).toEqual({ models: [{ match: 'glm-*' }] });
    expect('profiles' in f.set(off, true)).toBe(false);
  });
});

describe('hideEmpty default per widget', () => {
  const cfg = (extra: object = {}) => ({
    ...defaultConfig(),
    lines: [[{ id: 'r', type: 'workspace-repos', ...extra }]],
  });
  const hide = (c: ReturnType<typeof cfg>) =>
    widgetFields(getWidget('workspace-repos'), 'r', c).find((f) => f.id === 'hideEmpty')!;

  it('shows workspace-repos as hidden when empty and toggles to an explicit false', () => {
    const c = cfg();
    expect(displayValue(hide(c), c)).toEqual({ text: 'on', isDefault: true });
    expect(cycled(hide(c), c, 1)).toBe(false);
    const off = cfg({ hideEmpty: false });
    expect(cycled(hide(off), off, 1)).toBeUndefined();
  });

  it('keeps the plain toggle for other widgets', () => {
    const c = { ...defaultConfig(), lines: [[{ id: 'm', type: 'model' }]] };
    const f = widgetFields(getWidget('model'), 'm', c).find((x) => x.id === 'hideEmpty')!;
    expect(cycled(f, c, 1)).toBe(true);
    const on = { ...c, lines: [[{ id: 'm', type: 'model', hideEmpty: true }]] };
    expect(cycled(f, on, 1)).toBeUndefined();
  });
});
