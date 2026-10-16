import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { resolveAppearance } from '../../src/core/renderer.js';
import type { Config } from '../../src/core/types.js';
import {
  cycled,
  displayValue,
  type Field,
  globalFields,
  listEntries,
  widgetFields,
} from '../../src/tui/fields.js';
import { themeInputFromConfig } from '../../src/tui/themeio.js';
import { getWidget } from '../../src/widgets/index.js';
import { withLang } from '../helpers.js';

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

  it('adds charset and overflow, and panel fields only for the panel style', () => {
    const base = globalFields(defaultConfig()).map((f) => f.id);
    expect(base).toContain('charset');
    expect(base).toContain('overflow');
    expect(base).not.toContain('autoWrap');
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

  it('edits charset and overflow', () => {
    const c = defaultConfig();
    const charset = globalFields(c).find((f) => f.id === 'charset')!;
    expect(charset.set(c, 'text').charset).toBe('text');
    const over = globalFields(c).find((f) => f.id === 'overflow')!;
    expect(over.kind).toBe('select');
    expect(over.choices?.map((x) => x.value)).toEqual(['truncate', 'wrap', 'priority']);
    expect(over.get(c)).toBe('wrap');
    expect(over.get({ ...c, autoWrap: false })).toBe('truncate');
    const p = over.set(c, 'priority');
    expect(p).toMatchObject({ overflow: 'priority', autoWrap: false });
    expect(over.get(p)).toBe('priority');
    expect(displayValue(over, p).text).toBe('Drop by priority');
    expect(cycled(over, p, 1)).toBe('truncate');
    expect(over.set(p, 'wrap')).toMatchObject({ overflow: 'wrap', autoWrap: true });
  });

  it('edits glyph mode and ambiguous width', () => {
    const c = defaultConfig();
    const glyph = globalFields(c).find((f) => f.id === 'glyphMode')!;
    expect(glyph.kind).toBe('select');
    expect(glyph.choices?.map((x) => x.value)).toEqual([
      'normal',
      'single-width',
      'paste-safe',
      'jetbrains',
      'auto',
    ]);
    expect(glyph.get(c)).toBe('normal');
    const j = glyph.set(c, 'jetbrains');
    expect(j.glyphMode).toBe('jetbrains');
    expect('glyphMode' in glyph.set(j, 'normal')).toBe(false);
    const amb = globalFields(c).find((f) => f.id === 'ambiguousWidth')!;
    expect(amb.kind).toBe('select');
    expect(amb.get(c)).toBe('1');
    const two = amb.set(c, '2');
    expect(two.ambiguousWidth).toBe(2);
    expect(amb.get(two)).toBe('2');
    expect('ambiguousWidth' in amb.set(two, '1')).toBe(false);
  });
});

describe('priority field', () => {
  const setup = (type: string, priority?: number) => {
    const config = defaultConfig();
    config.lines = [[{ id: 'w', type, ...(priority === undefined ? {} : { priority }) }]];
    const f = widgetFields(getWidget(type), 'w', config).find((x) => x.id === 'priority');
    return { config, f };
  };

  it('is a 0-100 number with the category default as fallback', () => {
    const { config, f } = setup('context-percentage');
    expect(f?.kind).toBe('number');
    expect(f?.range).toEqual([0, 100]);
    expect(f?.fallback).toBe(70);
    expect(displayValue(f!, config)).toEqual({ text: '70', isDefault: true });
    expect(setup('git-branch').f?.fallback).toBe(50);
    expect(setup('gsd-phase').f?.fallback).toBe(30);
    expect(setup('separator').f).toBeUndefined();
  });

  it('sets, clamps by range and clears the key', () => {
    const { config, f } = setup('model', 90);
    expect(f!.get(config)).toBe(90);
    expect(cycled(f!, config, 1)).toBe(91);
    expect(cycled(f!, setup('model', 100).config, 1)).toBe(100);
    expect(f!.parse('101')).toMatchObject({ ok: false });
    expect(f!.parse('')).toEqual({ ok: true, value: undefined });
    expect(f!.parse('55')).toEqual({ ok: true, value: 55 });
    const set = f!.set(config, 55);
    expect(set.lines[0]![0]!.priority).toBe(55);
    expect('priority' in f!.set(set, undefined).lines[0]![0]!).toBe(false);
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

describe('progress fields', () => {
  it('lists every progress key with the right kind', () => {
    const kinds = Object.fromEntries(
      globalFields()
        .filter((f) => f.id.startsWith('progress.'))
        .map((f) => [f.id, f.kind]),
    );
    expect(kinds).toEqual({
      'progress.enabled': 'bool',
      'progress.source': 'select',
      'progress.scaleTo': 'select',
      'progress.warnAt': 'number',
      'progress.errorAt': 'number',
      'progress.channel': 'select',
      'progress.terminals': 'select',
      'progress.tmuxPassthrough': 'bool',
    });
    expect(field('progress.enabled').help).toContain('ccinfobar install --progress');
    expect(field('progress.warnAt').range).toEqual([1, 100]);
    expect(field('progress.errorAt').range).toEqual([1, 100]);
  });

  it('sets through setProgress and stays sparse', () => {
    let c = field('progress.enabled').set(defaultConfig(), true);
    expect(c.progress).toEqual({ enabled: true });
    c = field('progress.source').set(c, 'usage5h');
    c = field('progress.warnAt').set(c, 60);
    c = field('progress.tmuxPassthrough').set(c, true);
    expect(c.progress).toEqual({ enabled: true, source: 'usage5h', warnAt: 60, tmuxPassthrough: true });
    expect(field('progress.warnAt').set(c, 50).progress?.warnAt).toBeUndefined();
    expect(field('progress.warnAt').set(c, undefined).progress?.warnAt).toBeUndefined();
    c = field('progress.source').set(c, 'context');
    c = field('progress.warnAt').set(c, undefined);
    c = field('progress.tmuxPassthrough').set(c, false);
    expect(field('progress.enabled').set(c, false).progress).toEqual({ enabled: false });
  });

  it('shows defaults and cycles the selects', () => {
    const c = defaultConfig();
    const ch = field('progress.channel');
    expect(displayValue(ch, c)).toEqual({ text: 'Auto', isDefault: true });
    expect(cycled(ch, c, 1)).toBe('hook');
    expect(displayValue(field('progress.errorAt'), c)).toEqual({ text: '80', isDefault: true });
    expect(field('progress.warnAt').parse('0').ok).toBe(false);
    expect(field('progress.warnAt').parse('101').ok).toBe(false);
    expect(field('progress.warnAt').parse('70')).toEqual({ ok: true, value: 70 });
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

describe('visibility fields', () => {
  const cfg = (extra: object = {}): Config => ({
    ...defaultConfig(),
    lines: [[{ id: 'm', type: 'model', ...extra }]],
  });
  const vis = (c: Config, id: string) => widgetFields(getWidget('model'), 'm', c).find((f) => f.id === id)!;
  const item = (c: Config) => c.lines[0]![0]!;

  it('come right after the base fields', () => {
    const ids = widgetFields(getWidget('model'), 'm', cfg()).map((f) => f.id);
    const at = ids.indexOf('hideEmpty');
    expect(ids.slice(at + 1, at + 4)).toEqual(['vis.preset', 'vis.showWhen', 'vis.hideWhen']);
    expect(vis(cfg(), 'vis.preset').kind).toBe('select');
    expect(vis(cfg(), 'vis.showWhen').kind).toBe('text');
    expect(vis(cfg(), 'vis.preset').label).toBe('Visibility: Show only');
  });

  it('cycles the presets through showWhen and leaves hideWhen alone', () => {
    let c = cfg({ hideWhen: 'gsd' });
    expect(displayValue(vis(c, 'vis.preset'), c)).toEqual({ text: 'always', isDefault: true });
    const seen: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const f = vis(c, 'vis.preset');
      c = f.set(c, cycled(f, c, 1));
      seen.push(item(c).showWhen);
      expect(item(c).hideWhen).toBe('gsd');
    }
    expect(seen).toEqual(['git', 'gsd', 'agents', 'context.pct >= 70', 'usage.5h >= 80', undefined]);
    expect('showWhen' in item(c)).toBe(false);
    expect(displayValue(vis(cfg({ showWhen: 'gsd' }), 'vis.preset'), cfg({ showWhen: 'gsd' })).text).toBe(
      'in GSD projects',
    );
  });

  it('shows a custom rule as custom and never replaces it', () => {
    for (const showWhen of [['git', 'context.pct >= 70'], 'contxt > 1']) {
      const c = cfg({ showWhen });
      const f = vis(c, 'vis.preset');
      expect(displayValue(f, c).text).toBe('custom');
      expect(cycled(f, c, 1)).toBe('custom');
      expect(cycled(f, c, -1)).toBe('custom');
      expect(f.set(c, cycled(f, c, 1))).toEqual(c);
      expect(f.set(c, 'git')).toEqual(c);
      expect(f.set(c, undefined)).toEqual(c);
      expect(listEntries(f).at(-1)).toEqual({ value: 'custom', label: 'custom' });
    }
  });

  it('validates typed rules inline and stores them', () => {
    const c = cfg();
    const f = vis(c, 'vis.showWhen');
    expect(f.parse('contxt > 1')).toEqual({ ok: false, error: 'unknown metric "contxt"' });
    expect(f.parse('git')).toEqual({ ok: true, value: 'git' });
    expect(f.parse('  ')).toEqual({ ok: true, value: undefined });
    let next = f.set(c, 'git; context.pct >= 70');
    expect(item(next).showWhen).toEqual(['git', 'context.pct >= 70']);
    expect(displayValue(f, next).text).toBe('git; context.pct >= 70');
    next = vis(next, 'vis.hideWhen').set(next, 'provider in bedrock');
    expect(item(next).hideWhen).toBe('provider in bedrock');
    expect(f.set(next, 'contxt > 1')).toEqual(next);
    expect('showWhen' in item(f.set(next, undefined))).toBe(false);
    expect(f.resettable).toBe(true);
  });

  it('explains the grammar and a stored problem in the help', () => {
    expect(vis(cfg(), 'vis.showWhen').help).toContain('context.pct >= 70, !git, time.hour in 9..18');
    expect(vis(cfg({ hideWhen: 'contxt > 1' }), 'vis.hideWhen').help).toContain(
      'Ignored: unknown metric "contxt"',
    );
  });

  it('strips control characters from stored rule text', () => {
    const c = cfg({ showWhen: 'git\u001b[31m' });
    expect(displayValue(vis(c, 'vis.showWhen'), c).text).not.toContain('\u001b');
  });
});

describe('language field', () => {
  const lang = (auto?: 'en' | 'tr') => globalFields(defaultConfig(), auto).find((f) => f.id === 'language')!;

  it('sits after glyphMode and lists Auto, English and Türkçe', () => {
    const ids = globalFields().map((f) => f.id);
    expect(ids.indexOf('language')).toBe(ids.indexOf('glyphMode') + 1);
    expect(lang('tr').choices).toEqual([
      { value: 'auto', label: 'Auto (Türkçe)' },
      { value: 'en', label: 'English' },
      { value: 'tr', label: 'Türkçe' },
    ]);
    expect(lang().choices![0]!.label).toBe('Auto (English)');
    expect(withLang('tr', () => lang('en').choices!.map((c) => c.label))).toEqual([
      'Otomatik (English)',
      'English',
      'Türkçe',
    ]);
  });

  it('writes the key and removes it for auto', () => {
    const f = lang();
    const c = f.set(defaultConfig(), 'tr');
    expect(c.language).toBe('tr');
    expect(f.get(c)).toBe('tr');
    expect(displayValue(f, c).text).toBe('Türkçe');
    const back = f.set(c, 'auto');
    expect('language' in back).toBe(false);
    expect(f.get(back)).toBe('auto');
    expect('language' in f.set(c, 'klingon')).toBe(false);
    expect(cycled(f, c, 1)).toBe('auto');
  });
});

describe('Turkish field text', () => {
  const panel = () => ({ ...defaultConfig(), style: 'tui' as const });

  it('translates labels, help and parse errors, ids unchanged', () => {
    const en = globalFields(panel());
    const tr = withLang('tr', () => globalFields(panel()));
    expect(tr.map((f) => f.id)).toEqual(en.map((f) => f.id));
    const byId = (list: typeof tr, id: string) => list.find((f) => f.id === id)!;
    expect(byId(tr, 'theme').label).toBe('Tema');
    expect(byId(tr, 'theme').help).toBe('Enter tema seçiciyi açar');
    expect(byId(tr, 'usageApi').label).toBe("Claude'dan kullanım");
    expect(byId(tr, 'tui.box').label).toBe('Panel: çerçeve');
    expect(byId(tr, 'language').label).toBe('Dil');
    expect(byId(en, 'theme').label).toBe('Theme');
    expect(byId(en, 'tui.box').label).toBe('Panel: box');
    const same = (a: Field[], b: Field[]) =>
      a.filter((f, i) => f.label === b[i]!.label || (f.help !== undefined && f.help === b[i]!.help));
    expect(same(tr, en).map((f) => f.id)).toEqual([]);
    const w = (): Field[] => widgetFields(getWidget('model'), 'x');
    expect(same(withLang('tr', w), w()).map((f) => f.id)).toEqual([]);
    withLang('tr', () => {
      expect(byId(tr, 'padding').parse('x')).toEqual({ ok: false, error: 'Bir sayı girin' });
      expect(byId(tr, 'separatorColor').parse('nope')).toEqual({
        ok: false,
        error: 'Bir renk adı, #rrggbb ya da ansi256:N kullanın',
      });
      expect(byId(tr, 'separatorColor').parse('varsayılan')).toEqual({ ok: true, value: undefined });
      expect(byId(tr, 'budget.warnAt').parse('1')).toEqual({
        ok: false,
        error: '5 ile 100 arasında bir tam sayı girin',
      });
      expect(byId(tr, 'maxWidth').parse('-1')).toEqual({
        ok: false,
        error: "'auto' ya da pozitif bir sayı girin",
      });
      expect(byId(tr, 'tui.breakpoints').parse('{}')).toEqual({
        ok: false,
        error: 'Kırılma noktalarından oluşan bir JSON dizisi bekleniyordu',
      });
    });
    expect(byId(en, 'padding').parse('x')).toEqual({ ok: false, error: 'Enter a number' });
  });

  it('shows Turkish values and style names', () => {
    const c = defaultConfig();
    withLang('tr', () => {
      const fields = globalFields(c);
      const usage = fields.find((f) => f.id === 'usageApi')!;
      expect(displayValue(usage, { ...c, usageApi: true }).text).toBe('açık');
      expect(displayValue(usage, { ...c, usageApi: false }).text).toBe('kapalı');
      const pad = fields.find((f) => f.id === 'padding')!;
      expect(displayValue(pad, c).text).toMatch(/ {2}\(tema\)$/);
      const style = listEntries(fields.find((f) => f.id === 'style')!);
      expect(style[0]!.label).toBe('tema varsayılanı');
      expect(style.find((e) => e.value === 'blocks')!.label).toBe('Bloklar');
      const color = listEntries(widgetFields(getWidget('model'), 'x').find((f) => f.id === 'color')!);
      expect(color[0]!.label).toBe('varsayılan');
      expect(color.at(-1)!.label).toBe('özel…');
    });
    const grid = globalFields(panelCfg()).find((f) => f.id === 'tui.breakpoints')!;
    const one = { ...panelCfg(), tui: { breakpoints: [{ minWidth: 0, areas: ['model'] }] } } as Config;
    expect(displayValue(grid, one).text).toBe('1 breakpoint');
    expect(withLang('tr', () => displayValue(grid, one).text)).toBe('1 kırılma noktası');
  });
});

const panelCfg = (): Config => ({ ...defaultConfig(), style: 'tui' });

describe('updates field on a Homebrew copy', () => {
  const help = (brew: boolean) =>
    globalFields(undefined, undefined, brew).find((f) => f.id === 'update')!.help;

  it('says Homebrew updates it instead of promising installs', () => {
    expect(help(false)).toBe(
      'auto installs new releases in the background, notify shows a note, off never checks',
    );
    expect(help(true)).toBe(
      'Homebrew updates this copy: run brew upgrade ccinfobar. auto acts like notify and shows a note, off never checks',
    );
    expect(withLang('tr', () => help(true))).toBe(
      'Bu kopyayı Homebrew güncelliyor: brew upgrade ccinfobar çalıştırın. auto, notify gibi bir not gösterir, off hiç denetlemez',
    );
  });
});
