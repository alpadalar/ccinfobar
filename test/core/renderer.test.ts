import { describe, expect, it, vi } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { type LanguageDef, language, type MetaTable, setLanguage } from '../../src/core/i18n/index.js';
import { finalizeLine, render, renderValue, workspaceMode } from '../../src/core/renderer.js';
import { samplePayload } from '../../src/core/sample.js';
import type { StatusPayload, WidgetDef, WidgetItem, WidgetResult } from '../../src/core/types.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, withLang } from '../helpers.js';

const text = (t: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({
  id: t,
  type: 'text',
  options: { text: t },
  ...extra,
});

describe('renderer', () => {
  it('joins widgets with the separator and skips empty lines', () => {
    const ctx = ctxWith({ config: { lines: [[text('a'), text('b')], [], [{ id: 'x', type: 'unknown' }]] } });
    expect(render(ctx)).toEqual(['a │ b']);
  });

  it('merges widgets without separator', () => {
    const ctx = ctxWith({ config: { lines: [[text('a', { merge: true }), text('b'), text('c')]] } });
    expect(render(ctx)).toEqual(['ab │ c']);
  });

  it('applies labels, raw and custom labels', () => {
    const ctx = ctxWith({
      config: {
        lines: [
          [
            { id: 'm', type: 'model', label: 'M: ' },
            { id: 'n', type: 'model', raw: true },
          ],
        ],
      },
    });
    expect(render(ctx)).toEqual(['M: Opus 5.5 │ Opus 5.5']);
  });

  it('adds a space after custom labels that lack one', () => {
    const ctx = ctxWith({ config: { lines: [[{ id: 'm', type: 'model', label: 'M:' }]] } });
    expect(render(ctx)).toEqual(['M: Opus 5.5']);
  });

  it('pushes widgets right with flex', () => {
    const ctx = ctxWith({
      width: 30,
      config: { widthOffset: 0, lines: [[text('left'), { id: 'f', type: 'flex' }, text('right')]] },
    });
    const [line] = render(ctx);
    expect(visibleWidth(line!)).toBe(30);
    expect(line!.startsWith('left')).toBe(true);
    expect(line!.endsWith('right')).toBe(true);
  });

  it('truncates to the available width', () => {
    const ctx = ctxWith({
      width: 20,
      config: { widthOffset: 0, autoWrap: false, lines: [[text('abcdefghijklmn'), text('opqrstuv')]] },
    });
    expect(stripAnsi(render(ctx)[0]!)).toBe('abcdefghijklmn │ op…');
  });

  it('renders powerline segments with theme colors', () => {
    const ctx = ctxWith({
      config: {
        colorLevel: 2,
        theme: 'powerline',
        glyphs: { separator: '>', endCap: '>' },
        lines: [[text('a'), text('b')]],
      },
    });
    const line = render(ctx)[0]!;
    expect(stripAnsi(line)).toBe(' a > b >');
    expect(line).toContain('\x1b[44m');
  });

  it('keeps widget colors on blocks only when they stay readable', () => {
    const line = (item: Partial<WidgetItem>) =>
      render(ctxWith({ config: { colorLevel: 3, theme: 'nord', lines: [[text('a', item)]] } }))[0]!;
    expect(line({ color: 'blue' })).toContain('\x1b[38;2;236;239;244m');
    expect(line({ color: '#ffffff' })).toContain('\x1b[38;2;255;255;255m');
    expect(line({ color: 'blue', background: 'blue' })).toContain('\x1b[34m\x1b[44m');
  });

  it('shows a placeholder for widgets without data unless hideEmpty is set', () => {
    const ctx = ctxWith({
      payload: {},
      config: {
        lines: [
          [{ id: 'm', type: 'model' }, { id: 'c', type: 'context-percentage' }, text('ok')],
          [{ id: 'm2', type: 'model', hideEmpty: true }, text('ok')],
          [{ id: 'g', type: 'git-branch', hideEmpty: true }],
        ],
      },
      git: () => null,
    });
    expect(render(ctx)).toEqual(['model — │ Ctx — │ ok', 'ok']);
  });

  it('finalizes with reset and non-breaking spaces', () => {
    expect(finalizeLine('a b')).toBe('\x1b[0ma b');
  });
});

describe('alignment', () => {
  it('moves lines right or to the center, per line or for all', () => {
    const lines = [
      [{ id: 'a', type: 'text', options: { text: 'ab' } }],
      [{ id: 'b', type: 'text', options: { text: 'cd' } }],
    ];
    const base = { ...defaultConfig(), colorLevel: 0 as const, maxWidth: 10, lines };
    expect(render(ctxWith({ config: { ...base, align: 'right' } })).map(stripAnsi)).toEqual([
      '        ab',
      '        cd',
    ]);
    expect(render(ctxWith({ config: { ...base, lineAlign: ['center', null] } })).map(stripAnsi)).toEqual([
      '    ab',
      'cd',
    ]);
  });
});

describe('renderValue guard', () => {
  const def = (render: () => WidgetResult): WidgetDef => ({
    type: 'bad',
    name: 'Bad',
    category: 'session',
    description: 'bad widget',
    color: 'white',
    render,
  });
  const item: WidgetItem = { id: 'bad', type: 'bad' };
  const ctx = ctxWith();

  it('returns null for non-string text', () => {
    const bad = (v: unknown) =>
      renderValue(
        ctx,
        def(() => v as WidgetResult),
        item,
      );
    expect(bad({ text: { causes: [] } })).toBeNull();
    expect(bad({ text: 42 })).toBeNull();
    expect(bad({ causes: ['x'] })).toBeNull();
  });

  it('returns null when render throws', () => {
    const throws = def(() => {
      throw new Error('boom');
    });
    expect(renderValue(ctx, throws, item)).toBeNull();
  });

  it('keeps the other widgets when the miss cause is an object', () => {
    const payload = samplePayload(NOW.getTime()) as StatusPayload;
    payload.prompt_cache = {
      ...payload.prompt_cache,
      last_miss_cause: { causes: ['tools_changed'], tools_added: 2, tools_removed: 0 },
    } as unknown as StatusPayload['prompt_cache'];
    const lines = [
      [
        { id: 'm', type: 'model' },
        { id: 'c', type: 'cache-miss-cause' },
      ],
    ];
    const out = render(ctxWith({ config: { lines }, payload }));
    expect(out[0]).toContain('Opus 5.5');
  });
});

describe('workspace mode', () => {
  const repos = () => ({
    root: '/w',
    total: 3,
    repos: ['api', 'web', 'infra'].map((name) => ({
      name,
      branch: 'main',
      detached: false,
      activity: null,
      hidden: false,
    })),
  });
  const layout = (opts: WidgetItem['options'] = {}): WidgetItem[][] => [
    [
      { id: 'b', type: 'git-branch' },
      { id: 'r', type: 'workspace-repos', options: opts },
    ],
  ];

  it('hides empty git widgets when workspace-repos shows repos', () => {
    const out = render(ctxWith({ git: () => null, repos, config: { lines: layout() } }));
    expect(out[0]).toContain('repos: api (main)');
    expect(out[0]).not.toContain('—');
  });

  it('keeps placeholders with hideGitPlaceholders off', () => {
    const out = render(
      ctxWith({ git: () => null, repos, config: { lines: layout({ hideGitPlaceholders: false }) } }),
    );
    expect(out[0]).toContain('—');
    expect(out[0]).toContain('repos: api (main)');
    const str = { lines: layout({ hideGitPlaceholders: 'false' }) };
    expect(render(ctxWith({ git: () => null, repos, config: str }))[0]).toContain('—');
  });

  it('keeps placeholders inside a repo or without workspace-repos', () => {
    expect(render(ctxWith({ git: () => null, config: { lines: layout() } }))[0]).toContain('—');
    const plain = [[{ id: 'b', type: 'git-branch' }]];
    expect(render(ctxWith({ git: () => null, repos, config: { lines: plain } }))[0]).toContain('—');
  });

  it('applies to the tui panel too', () => {
    const out = render(ctxWith({ git: () => null, repos, config: { style: 'tui', lines: layout() } }));
    expect(out.join('\n')).toContain('api (main)');
    expect(out.join('\n')).not.toContain('—');
  });

  it('hides an empty workspace-repos unless hideEmpty is false', () => {
    const lines = [
      [
        { id: 'm', type: 'model' },
        { id: 'r', type: 'workspace-repos' },
      ],
    ];
    const inside = render(ctxWith({ git: () => null, repos: () => null, config: { lines } }));
    expect(inside[0]).not.toContain('repos');
    expect(inside[0]).not.toContain('—');
    const shown = [[{ id: 'r', type: 'workspace-repos', hideEmpty: false }]];
    expect(render(ctxWith({ git: () => null, repos: () => null, config: { lines: shown } }))[0]).toContain(
      'repos: —',
    );
  });

  it('exports the pre-pass', () => {
    expect(workspaceMode(ctxWith({ git: () => null, repos, config: { lines: layout() } }))).toBe(true);
    expect(workspaceMode(ctxWith({ git: () => null, config: { lines: layout() } }))).toBe(false);
  });
});

describe('render language', () => {
  const eta = (language?: 'auto' | 'en' | 'tr') =>
    ctxWith({
      config: { lines: [[{ id: 'w', type: 'limit-eta' }]], ...(language ? { language } : {}) },
    });

  it('renders with the config language and restores the previous one', () => {
    expect(stripAnsi(render(eta('tr'))[0]!)).toContain('güvenli');
    expect(language()).toBe('en');
    withLang('tr', () => {
      expect(stripAnsi(render(eta('en'))[0]!)).toContain('safe');
      expect(language()).toBe('tr');
    });
  });

  it('keeps the edge language for auto and an absent key', () => {
    withLang('tr', () => {
      expect(stripAnsi(render(eta('auto'))[0]!)).toContain('güvenli');
      expect(stripAnsi(render(eta())[0]!)).toContain('güvenli');
      expect(language()).toBe('tr');
    });
    expect(stripAnsi(render(eta())[0]!)).toContain('safe');
  });

  it('sets the language for widgets and restores it when render throws', () => {
    const seen: string[] = [];
    const spy = vi.spyOn(getWidget('model')!, 'render').mockImplementation(() => {
      seen.push(language());
      throw new Error('widget');
    });
    try {
      render(ctxWith({ config: { lines: [[{ id: 'm', type: 'model' }]], language: 'tr' } }));
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(['tr']);
    expect(language()).toBe('en');
    const broken = ctxWith({ config: { language: 'tr', lines: null as never } });
    expect(() => render(broken)).toThrow();
    expect(language()).toBe('en');
    setLanguage('en');
  });
});

describe('render widget metadata', () => {
  const meta: MetaTable = {
    widgets: {
      'context-percentage': { name: 'Bağlam yüzdesi', description: 'D', label: 'Bağlam ' },
      model: { name: 'İstatistik', description: 'D' },
    },
    options: {},
    categories: {},
    catalog: {},
  };
  const zz: LanguageDef = { id: 'zz', name: 'Test', aliases: [], locale: 'tr', messages: {}, meta };

  it('translates the default label and keeps a user label', () => {
    const ctx = ctxWith({
      config: {
        lines: [
          [
            { id: 'c', type: 'context-percentage' },
            { id: 'd', type: 'context-percentage', label: 'Ctx' },
          ],
        ],
      },
    });
    const en = stripAnsi(render(ctx)[0]!);
    const out = withLang(zz, () => stripAnsi(render(ctx)[0]!));
    expect(en).toMatch(/^Ctx \S+ │ Ctx \S+$/);
    expect(out).toBe(en.replace(/^Ctx /, 'Bağlam '));
  });

  it('translates the empty hint with the language locale', () => {
    const spy = vi.spyOn(getWidget('model')!, 'render').mockReturnValue(null);
    try {
      const ctx = ctxWith({ config: { lines: [[{ id: 'm', type: 'model' }]] } });
      expect(stripAnsi(render(ctx)[0]!)).toBe('model —');
      expect(withLang(zz, () => stripAnsi(render(ctx)[0]!))).toBe('istatistik —');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('render Turkish default labels', () => {
  const ctx = (icons?: 'nerd') =>
    ctxWith({
      config: {
        ...(icons ? { icons } : {}),
        lines: [
          [
            { id: 'c', type: 'context-percentage' },
            { id: 'i', type: 'tokens-input' },
            { id: 'a', type: 'api-duration' },
            { id: 'b', type: 'budget' },
          ],
        ],
        budget: { daily: 10 },
      },
    });

  it('shows the Turkish labels and keeps compact units', () => {
    const en = stripAnsi(render(ctx())[0]!);
    const tr = withLang('tr', () => stripAnsi(render(ctx())[0]!));
    expect(en).toMatch(/^Ctx \S+ │ In \S+ │ API \S+ │ Budget \S+$/);
    expect(tr).toBe(
      en.replace(/^Ctx /, 'Bağlam ').replace('│ In ', '│ Girdi ').replace('│ Budget ', '│ Bütçe '),
    );
  });

  it('uses the icon instead of the label', () => {
    const en = stripAnsi(render(ctx('nerd'))[0]!);
    expect(withLang('tr', () => stripAnsi(render(ctx('nerd'))[0]!))).toBe(en);
    expect(en).not.toMatch(/Ctx|Bağlam /);
  });
});
