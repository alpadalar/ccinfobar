import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripAnsi, visibleWidth } from '../../src/core/ansi.js';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { foldText, NARROW, resolveGlyphMode, widthModeFor } from '../../src/core/glyphs.js';
import { effectiveIcons, finalizeLine, render, resolveCharset } from '../../src/core/renderer.js';
import { samplePayload } from '../../src/core/sample.js';
import { SCENARIO_NOW, SCENARIOS, scenarioConfig, scenarioEnv } from '../../src/core/scenarios.js';
import type { Config, StatusPayload, WidgetItem } from '../../src/core/types.js';
import { NORMAL_WIDTH, visibleWidthIn, type WidthMode, widthMode } from '../../src/core/width.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW } from '../helpers.js';

const W = 120;
const text = (t: string, id: string): WidgetItem => ({ id, type: 'text', options: { text: t } });
const model: WidgetItem = { id: 'm', type: 'model' };

const CASES: Record<string, { config: Partial<Config>; payload?: Partial<StatusPayload> }> = {
  emoji: { config: { lines: [[text('\u{1F600} hi', 'e'), model]] } },
  icons: {
    config: {
      icons: 'emoji',
      lines: [[model, { id: 'c', type: 'cost' }, { id: 's', type: 'session-name' }]],
    },
  },
  fullwidth: {
    config: { lines: [[{ id: 's', type: 'session-name' }]] },
    payload: { session_name: '\uFF21\uFF22\uFF23\u3000\uFF44\uFF01' },
  },
  vs16: { config: { lines: [[text('\u2764\uFE0F ok \u2705', 'v')]] } },
  cjk: { config: { lines: [[text('\u4E2D\u6587', 'c')]] } },
  powerline: {
    config: {
      theme: 'powerline',
      charset: 'nerd',
      icons: 'nerd',
      lines: [
        [
          model,
          { id: 'l', type: 'link', options: { text: 'docs', url: 'https://example.com/docs' } },
          text('a b', 't'),
        ],
      ],
    },
  },
  ambiguous: {
    config: { theme: 'powerline', charset: 'nerd', lines: [[text('\u2502 \u25CF x', 'a'), model]] },
  },
  capsule: {
    config: { theme: 'catppuccin', charset: 'nerd', icons: 'emoji', lines: [[model, text('b', 'b')]] },
  },
  panel: { config: { theme: 'panel', icons: 'emoji', lines: [[model, text('\u{1F600}', 'e')]] } },
};

function runCase(name: string, extra: Partial<Config> = {}, env: NodeJS.ProcessEnv = {}): string[] {
  const c = CASES[name]!;
  return render(
    ctxWith({
      config: { colorLevel: 3, ...c.config, ...extra },
      payload: { ...samplePayload(NOW.getTime()), ...c.payload },
      width: W,
      env,
    }),
  );
}

function runScenario(id: string, extra: Partial<Config> = {}): string[] {
  const bundle = SCENARIOS.find((s) => s.id === id)!.build(SCENARIO_NOW);
  return render(
    createContext({
      payload: bundle.payload,
      config: scenarioConfig({ ...defaultConfig(), colorLevel: 3, ...extra }, bundle),
      env: scenarioEnv({}, bundle.env),
      now: new Date(SCENARIO_NOW),
      preview: true,
      terminalWidth: W,
      data: bundle.data,
    }),
  );
}

function snapshotAll(extra: Partial<Config> = {}) {
  return {
    cases: Object.fromEntries(Object.keys(CASES).map((k) => [k, runCase(k, extra)])),
    scenarios: Object.fromEntries(SCENARIOS.map((s) => [s.id, runScenario(s.id, extra)])),
    powerline: Object.fromEntries(
      SCENARIOS.map((s) => [s.id, runScenario(s.id, { ...extra, theme: 'powerline', charset: 'nerd' })]),
    ),
  };
}

const plain = (lines: string[]) => lines.map(stripAnsi).join('\n');
const lead = (line: string) => stripAnsi(line).length - stripAnsi(line).trimStart().length;
const PUA = /[\uE000-\uF8FF]|[\u{F0000}-\u{10FFFF}]/u;
const JB: WidthMode = { emoji: 1, ambiguous: 1 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveGlyphMode', () => {
  it('auto picks jetbrains only in a JetBrains terminal', () => {
    expect(resolveGlyphMode({ glyphMode: 'auto' }, { TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).toBe(
      'jetbrains',
    );
    expect(resolveGlyphMode({ glyphMode: 'auto' }, {})).toBe('normal');
    expect(resolveGlyphMode({}, { TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).toBe('normal');
    expect(resolveGlyphMode({ glyphMode: 'paste-safe' }, {})).toBe('paste-safe');
  });

  it('maps modes to width modes', () => {
    expect(widthModeFor('normal', undefined)).toEqual(NORMAL_WIDTH);
    expect(widthModeFor('jetbrains', undefined)).toEqual(JB);
    expect(widthModeFor('single-width', 2)).toEqual({ emoji: 2, ambiguous: 2 });
    expect(widthModeFor('paste-safe', 1)).toEqual(NORMAL_WIDTH);
  });

  it('feeds charset and icons', () => {
    const cfg = { ...defaultConfig(), charset: 'nerd' as const, icons: 'emoji' as const };
    expect(resolveCharset({ ...cfg, glyphMode: 'paste-safe' }, {})).toBe('text');
    expect(resolveCharset({ ...cfg, glyphMode: 'single-width' }, {})).toBe('nerd');
    expect(effectiveIcons({ ...cfg, glyphMode: 'single-width' }, {})).toBe('text');
    expect(effectiveIcons({ ...cfg, glyphMode: 'jetbrains' }, {})).toBe('emoji');
    expect(effectiveIcons({ ...cfg, icons: 'nerd', glyphMode: 'single-width' }, {})).toBe('nerd');
  });
});

describe('foldText', () => {
  it('is the identity outside single-width and paste-safe', () => {
    const s = '\uFF21\u2764\uFE0F\u2705';
    expect(foldText(s, 'normal')).toBe(s);
    expect(foldText(s, 'jetbrains')).toBe(s);
  });

  it('folds fullwidth, VS16 and known emoji', () => {
    for (const m of ['single-width', 'paste-safe'] as const) {
      expect(foldText('\uFF21\uFF5A\uFF01\uFF5E\u3000x', m)).toBe('Az!~ x');
      expect(foldText('\u2764\uFE0F \u26A0\uFE0F', m)).toBe('\u2764 \u26A0');
      expect(foldText('\u2705 done', m)).toBe('\u2714 done');
      expect(foldText('\u4E2D\u6587 \uFF5F 1\uFE0F\u20E3', m)).toBe('\u4E2D\u6587 \uFF5F 1\uFE0F\u20E3');
    }
    expect(NARROW.get('\u2705')).toBe('\u2714');
    for (const [k, v] of NARROW) expect(visibleWidthIn(v, NORMAL_WIDTH), k).toBe(1);
  });

  it('keeps VS16 inside ZWJ sequences and keycaps (WR-07)', () => {
    const seqs = [
      '\u{1F3F3}\uFE0F\u200D\u{1F308}',
      '\u2764\uFE0F\u200D\u{1F525}',
      '\u{1F3F3}\uFE0F\u200D\u26A7\uFE0F',
      '\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F',
      '#\uFE0F\u20E3',
    ];
    for (const m of ['single-width', 'paste-safe'] as const) {
      for (const s of seqs) {
        expect(foldText(s, m), s).toBe(s);
        expect(visibleWidthIn(foldText(s, m), widthModeFor(m, 1)), s).toBe(2);
      }
      expect(foldText(`\u2764\uFE0F ${seqs[0]} \u26A0\uFE0F`, m)).toBe(`\u2764 ${seqs[0]} \u26A0`);
    }
  });

  it('never produces control characters', () => {
    let all = '';
    for (let c = 0xff01; c <= 0xff5e; c++) all += String.fromCharCode(c);
    expect(foldText(all, 'single-width')).toMatch(/^[\x21-\x7e]+$/);
  });
});

describe('jetbrains', () => {
  it('counts emoji as one column', () => {
    const normal = runCase('emoji', { maxWidth: 40, align: 'right' });
    const jb = runCase('emoji', { maxWidth: 40, align: 'right', glyphMode: 'jetbrains' });
    expect(lead(jb[0]!)).toBe(lead(normal[0]!) + 1);
    expect(visibleWidthIn(jb[0]!, JB)).toBe(40);
    expect(visibleWidthIn(normal[0]!, JB)).toBe(visibleWidthIn(normal[0]!, NORMAL_WIDTH) - 1);
  });

  it('auto uses the env', () => {
    const env = { TERMINAL_EMULATOR: 'JetBrains-JediTerm' };
    const auto = runCase('emoji', { maxWidth: 40, align: 'right', glyphMode: 'auto' }, env);
    const jb = runCase('emoji', { maxWidth: 40, align: 'right', glyphMode: 'jetbrains' });
    expect(auto).toEqual(jb);
  });

  it('does not fold text', () => {
    expect(plain(runCase('fullwidth', { glyphMode: 'jetbrains' }))).toContain('\uFF21\uFF22\uFF23');
  });

  it('restores the width mode after render, also when it throws', () => {
    const before = widthMode();
    runCase('emoji', { glyphMode: 'jetbrains', ambiguousWidth: 2 });
    expect(widthMode()).toBe(before);

    vi.spyOn(getWidget('model')!, 'render').mockImplementation(() => {
      throw new Error('widget');
    });
    runCase('emoji', { glyphMode: 'jetbrains' });
    expect(widthMode()).toBe(before);

    let inside: WidthMode | undefined;
    const config = { ...defaultConfig(), glyphMode: 'jetbrains', ambiguousWidth: 2 } as Config;
    Object.defineProperty(config, 'lines', {
      get() {
        inside = widthMode();
        throw new Error('boom');
      },
    });
    expect(() => render({ ...ctxWith(), config })).toThrow('boom');
    expect(inside).toEqual({ emoji: 1, ambiguous: 2 });
    expect(widthMode()).toBe(before);
  });
});

describe('single-width', () => {
  const sw = { glyphMode: 'single-width' as const };

  it('shows icons as text', () => {
    const out = runCase('icons', sw);
    expect(out).toEqual(runCase('icons', { icons: 'text' }));
    expect(plain(out)).not.toMatch(/\p{Emoji_Presentation}/u);
  });

  it('folds fullwidth and VS16 data', () => {
    expect(plain(runCase('fullwidth', sw))).toBe('ABC d!');
    expect(plain(runCase('vs16', sw))).toBe('\u2764 ok \u2714');
  });

  it('keeps CJK and measures it as 2', () => {
    const line = plain(runCase('cjk', sw));
    expect(line).toBe('\u4E2D\u6587');
    expect(visibleWidth(line)).toBe(4);
  });

  it('keeps nerd glyphs and separators', () => {
    expect(plain(runCase('powerline', sw))).toMatch(PUA);
  });
});

describe('paste-safe', () => {
  const ps = { glyphMode: 'paste-safe' as const };

  it('drops Nerd Font glyphs, links and NBSP but keeps colors', () => {
    for (const name of ['powerline', 'ambiguous', 'capsule', 'panel', 'icons', 'vs16']) {
      const out = runCase(name, ps).join('\n');
      expect(out, name).not.toMatch(PUA);
      expect(out, name).not.toContain('\u001b]8;');
      if (name !== 'panel') expect(out, name).not.toMatch(/\p{Emoji_Presentation}/u);
    }
    const panel = plain(runCase('panel', ps));
    expect(panel).toContain('\u{1F600}');
    expect(panel).not.toContain('\u{1F916}');
    const out = runCase('powerline', { ...ps, theme: 'tokyo-night' });
    expect(plain(out)).toContain('docs');
    expect(out.join('')).toContain('\u001b[38;');
    const fin = out.map((l) => finalizeLine(l, { pasteSafe: true }));
    expect(fin.join('')).not.toContain('\u00A0');
    expect(fin.join('')).not.toContain('\u001b]8;');
    expect(fin.join('')).toContain('\u001b[38;');
  });

  it('strips nerd glyphs from data and an explicit separator', () => {
    const out = runCase('ambiguous', {
      ...ps,
      separator: ' \uE0B1 ',
      theme: 'classic',
      lines: [[text('\uF418 main', 'g'), model]],
    });
    expect(plain(out)).not.toMatch(PUA);
    expect(plain(out)).toContain('main');
  });

  it('finalizeLine keeps link text and plain spaces', () => {
    const link =
      '\u001b]8;;https://example.com\u001b\\x y\u001b]8;;\u001b\\ \u001b]8;;https://example.com\u0007z\u001b]8;;\u0007';
    expect(finalizeLine(link, { pasteSafe: true })).toBe('\u001b[0mx y z');
    expect(finalizeLine('a b')).toBe('\u001b[0ma\u00A0b');
    expect(finalizeLine('a b', {})).toBe('\u001b[0ma\u00A0b');
  });
});

describe('ambiguousWidth', () => {
  it('counts ambiguous characters as 2 but not Nerd Font glyphs', () => {
    const one = runCase('ambiguous', { maxWidth: 40, align: 'right' });
    const two = runCase('ambiguous', { maxWidth: 40, align: 'right', ambiguousWidth: 2 });
    expect(plain(one)).toMatch(PUA);
    expect(lead(two[0]!)).toBe(lead(one[0]!) - 2);
    expect(stripAnsi(two[0]!).trimStart()).toBe(stripAnsi(one[0]!).trimStart());
  });
});

describe('defaults (D-01)', () => {
  const fixture = JSON.parse(
    fs.readFileSync(new URL('../fixtures/glyph-default.json', import.meta.url), 'utf8'),
  );

  it('glyphMode absent, normal and ambiguousWidth 1 match the baseline', () => {
    expect(snapshotAll()).toEqual(fixture);
    expect(snapshotAll({ glyphMode: 'normal' })).toEqual(fixture);
    expect(snapshotAll({ glyphMode: 'normal', ambiguousWidth: 1 })).toEqual(fixture);
  });
});
