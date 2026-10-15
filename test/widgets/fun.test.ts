import cp from 'node:child_process';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import { createContext } from '../../src/core/context.js';
import { en } from '../../src/core/i18n/en/index.js';
import { LANGUAGES, TR } from '../../src/core/i18n/languages.js';
import { PRESETS, starterConfig } from '../../src/core/presets.js';
import { colorsFor, type Part, resolveAppearance } from '../../src/core/renderer.js';
import { sampleTranscript } from '../../src/core/sample.js';
import { getScenario, SCENARIO_NOW, SCENARIOS, scenarioConfig } from '../../src/core/scenarios.js';
import { BUILTIN_THEMES, type Theme } from '../../src/core/themes.js';
import type { RenderContext, StatusPayload, WidgetItem } from '../../src/core/types.js';
import { NORMAL_WIDTH, visibleWidthIn, type WidthMode } from '../../src/core/width.js';
import { FACES, fnv1a, moodTier, PETS } from '../../src/widgets/fun.js';
import { getWidget } from '../../src/widgets/index.js';
import { ctxWith, NOW, renderWidget, withLang, withoutSideEffects } from '../helpers.js';

const MIN = 60_000;
const t0 = NOW.getTime();
const FUN = ['pet', 'kaomoji', 'quip'] as const;
const JETBRAINS: WidthMode = { emoji: 1, ambiguous: 1 };

afterEach(() => {
  vi.restoreAllMocks();
  module.syncBuiltinESMExports();
});

function payload(over: Partial<StatusPayload> = {}): StatusPayload {
  return {
    session_id: 'fun-session',
    context_window: { context_window_size: 1_000_000, used_percentage: 40 },
    rate_limits: { five_hour: { used_percentage: 20, resets_at: null } },
    ...over,
  };
}

const idle = () => ({
  ...sampleTranscript(t0),
  lastAssistantAt: t0 - 60_000,
  turnStart: t0 - 90_000,
  turnEnd: t0 - 50_000,
});

function ctx(
  opts: {
    payload?: StatusPayload;
    at?: number;
    transcript?: RenderContext['data']['transcript'];
    charset?: 'text';
  } = {},
): RenderContext {
  const base = ctxWith({
    payload: opts.payload ?? payload(),
    transcript: opts.transcript ?? idle,
    hooks: () => null,
    limits: () => null,
    config: opts.charset ? { charset: opts.charset } : {},
  });
  return opts.at === undefined ? base : { ...base, now: new Date(opts.at) };
}

const out = (type: string, c: RenderContext, options: WidgetItem['options'] = {}) =>
  renderWidget(type, c, { options });

describe('fnv1a', () => {
  it('matches the FNV-1a 32 reference', () => {
    expect(fnv1a('abc')).toBe(0x1a47e90b);
    expect(fnv1a('')).toBe(0x811c9dc5);
  });
});

describe('moodTier', () => {
  it('is full at 90% context or more', () => {
    const p = payload({ context_window: { context_window_size: 1_000_000, used_percentage: 92 } });
    expect(moodTier(ctx({ payload: p }))).toBe('full');
  });

  it('is tired at 80% 5h usage', () => {
    const p = payload({ rate_limits: { five_hour: { used_percentage: 85, resets_at: null } } });
    expect(moodTier(ctx({ payload: p }))).toBe('tired');
  });

  it('is asleep after 30 minutes without an assistant turn', () => {
    const tr = () => ({ ...idle(), turnStart: t0 - 50 * MIN, lastAssistantAt: t0 - 45 * MIN });
    expect(moodTier(ctx({ transcript: tr }))).toBe('asleep');
    const p = payload({ context_window: { context_window_size: 1_000_000, used_percentage: 95 } });
    expect(moodTier(ctx({ payload: p, transcript: tr }))).toBe('asleep');
  });

  it('wakes up for a new turn after a long idle (IN-07)', () => {
    const woke = () => ({ ...idle(), turnStart: t0 - 3_000, lastAssistantAt: t0 - 45 * MIN });
    expect(moodTier(ctx({ transcript: woke }))).toBe('busy');
    const p = payload({ context_window: { context_window_size: 1_000_000, used_percentage: 95 } });
    expect(moodTier(ctx({ payload: p, transcript: woke }))).toBe('full');
  });

  it('is busy while a turn runs', () => {
    const tr = () => ({ ...idle(), promptStart: t0 - 20_000, turnEnd: null, lastAssistantAt: t0 - 5_000 });
    expect(moodTier(ctx({ transcript: tr }))).toBe('busy');
    const pending = () => ({ ...idle(), turnStart: t0 - 2_000, lastAssistantAt: t0 - 10_000 });
    expect(moodTier(ctx({ transcript: pending }))).toBe('busy');
  });

  it('is happy otherwise', () => {
    expect(moodTier(ctx())).toBe('happy');
  });

  it('is null without context and transcript', () => {
    expect(moodTier(ctx({ payload: {}, transcript: () => null }))).toBeNull();
  });
});

describe('determinism', () => {
  const bucketStart = Math.floor(t0 / MIN) * MIN;

  it.each(['pet', 'kaomoji'])('%s is stable inside a minute and changes across minutes', (type) => {
    const a = out(type, ctx({ at: bucketStart }));
    expect(a).not.toBeNull();
    expect(out(type, ctx({ at: bucketStart + 59_000 }))).toBe(a);
    const seen = new Set<string | null>();
    for (let i = 0; i < 40; i++) seen.add(out(type, ctx({ at: bucketStart + i * MIN })));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('quip is stable inside 30 minutes', () => {
    const start = Math.floor(t0 / (30 * MIN)) * 30 * MIN;
    const a = out('quip', ctx({ at: start }));
    expect(a).not.toBeNull();
    expect(out('quip', ctx({ at: start + 29 * MIN + 59_000 }))).toBe(a);
    const seen = new Set<string | null>();
    for (let i = 0; i < 40; i++) seen.add(out('quip', ctx({ at: start + i * 30 * MIN })));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('depends only on session, tier and bucket', () => {
    for (const type of FUN) {
      const seen = new Set<string | null>();
      for (let i = 0; i < 30; i++) {
        const p = payload({ session_id: `s-${i}` });
        const one = out(type, ctx({ payload: p }));
        expect(out(type, ctx({ payload: p })), type).toBe(one);
        seen.add(one);
      }
      expect(seen.size, type).toBeGreaterThan(1);
    }
  });

  it('kaomoji follows personality and pet follows species', () => {
    const c = ctx();
    const faces = (p: string) => out('kaomoji', c, { personality: p });
    expect(FACES.grumpy.happy.unicode).toContain(faces('grumpy'));
    expect(FACES.stoic.happy.unicode).toContain(faces('stoic'));
    expect(PETS.ghost.happy.unicode).toContain(out('pet', c, { species: 'ghost' }));
    expect(PETS.blob.happy.unicode).toContain(out('pet', c, { species: 'blob' }));
    expect(PETS.cat.happy.unicode).toContain(out('pet', c, { species: 'nope' }));
  });

  it('quip follows its basis tier', () => {
    const hot = payload({
      context_window: { context_window_size: 1_000_000, used_percentage: 85 },
      rate_limits: { five_hour: { used_percentage: 97, resets_at: null } },
    });
    const c = ctx({ payload: hot });
    const q = out('quip', c)!;
    expect(q.length).toBeGreaterThan(0);
    expect(out('quip', c, { basis: 'usage' })).not.toBeNull();
    expect(out('quip', ctx({ payload: payload({ rate_limits: {} }) }), { basis: 'usage' })).toBeNull();
    expect(out('quip', c, { maxLength: 6 })!.length).toBeLessThanOrEqual(6);
  });

  it.each(LANGUAGES.map((l) => [l.id, l] as const))('%s quips fit 32 columns', (_id, l) => {
    const ids = Object.keys(en).filter((k) => k.startsWith('fun.quip.'));
    expect(ids.length).toBe(24);
    const table = l.messages as Record<string, unknown>;
    for (const id of ids) {
      const q = table[id];
      expect(typeof q, id).toBe('string');
      expect(visibleWidthIn(q as string, NORMAL_WIDTH), id).toBeLessThanOrEqual(32);
      expect(q, id).not.toContain('!');
    }
  });

  it('quips follow the language', () => {
    const c = ctx({ payload: payload() });
    const q = withLang('tr', () => out('quip', c))!;
    expect(Object.values(TR.messages)).toContain(q);
    expect(q).not.toBe(out('quip', c));
  });
});

describe('glyphs', () => {
  it('uses ASCII only under charset text', () => {
    const moods = [
      payload(),
      payload({ context_window: { context_window_size: 1_000_000, used_percentage: 95 } }),
      payload({ rate_limits: { five_hour: { used_percentage: 99, resets_at: null } } }),
    ];
    for (const p of moods) {
      for (let i = 0; i < 10; i++) {
        const c = ctx({ payload: p, charset: 'text', at: t0 + i * 30 * MIN });
        for (const [type, key, values] of [
          ['pet', 'species', ['cat', 'blob', 'ghost']],
          ['kaomoji', 'personality', ['cheerful', 'grumpy', 'stoic']],
          ['quip', 'basis', ['context', 'usage']],
        ] as const) {
          for (const v of values)
            expect(out(type, c, { [key]: v }), `${type} ${v}`).toMatch(/^[\x20-\x7e]+$/);
        }
      }
    }
  });

  it('has narrow frames and faces only', () => {
    const all = [
      ...Object.values(PETS).flatMap((s) => Object.values(s).flatMap((f) => [...f.unicode, ...f.text])),
      ...Object.values(FACES).flatMap((s) => Object.values(s).flatMap((f) => [...f.unicode, ...f.text])),
    ];
    expect(all.length).toBeGreaterThan(100);
    for (const s of all) {
      const n = [...s].length;
      expect(visibleWidthIn(s, NORMAL_WIDTH), s).toBe(n);
      expect(visibleWidthIn(s, JETBRAINS), s).toBe(n);
    }
    for (const sp of Object.values(PETS)) {
      for (const f of Object.values(sp)) {
        expect(f.unicode).toHaveLength(2);
        expect(f.text).toHaveLength(2);
      }
    }
    for (const p of Object.values(FACES)) {
      for (const f of Object.values(p)) {
        expect(f.unicode).toHaveLength(3);
        expect(f.text).toHaveLength(3);
      }
    }
  });
});

describe('no data', () => {
  it('each returns null with an empty payload and no transcript', () => {
    const c = ctxWith({ payload: {}, transcript: () => null, hooks: () => null, limits: () => null });
    for (const type of FUN) expect(out(type, c), type).toBeNull();
  });
});

function watch() {
  const writes: string[] = [];
  const rec = (p: unknown) => writes.push(String(p));
  const w = fs.writeFileSync;
  const a = fs.appendFileSync;
  const r = fs.renameSync;
  const m = fs.mkdirSync;
  const o = fs.openSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((...x: Parameters<typeof w>) => {
    rec(x[0]);
    return w(...x);
  });
  vi.spyOn(fs, 'appendFileSync').mockImplementation((...x: Parameters<typeof a>) => {
    rec(x[0]);
    return a(...x);
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((...x: Parameters<typeof r>) => {
    rec(x[1]);
    return r(...x);
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(((...x: Parameters<typeof m>) => {
    rec(x[0]);
    return m(...x);
  }) as typeof m);
  vi.spyOn(fs, 'openSync').mockImplementation((...x: Parameters<typeof o>) => {
    const flags = x[1] ?? 'r';
    if (typeof flags === 'number' ? flags !== fs.constants.O_RDONLY : /[wa+]/.test(String(flags))) rec(x[0]);
    return o(...x);
  });
  const spawn = vi.spyOn(cp, 'spawn');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  module.syncBuiltinESMExports();
  return { writes, spawn, fetchSpy };
}

describe('scenarios', () => {
  function ctxFor(id: string): RenderContext {
    const b = getScenario(id)!.build(SCENARIO_NOW);
    return createContext({
      payload: b.payload,
      config: scenarioConfig({ ...defaultConfig(), colorLevel: 0 }, b),
      env: { ...b.env },
      now: new Date(SCENARIO_NOW),
      preview: true,
      terminalWidth: 140,
      data: b.data,
    });
  }

  it('render under every scenario with no writes, spawns or fetches', () => {
    const w = watch();
    for (const s of SCENARIOS) {
      for (const type of FUN) {
        for (const charset of ['nerd', 'text'] as const) {
          const c = ctxFor(s.id);
          c.config.charset = charset;
          const r = withoutSideEffects(() => getWidget(type)!.render(c, { id: type, type }));
          expect(r === null || typeof r === 'string', `${s.id} ${type}`).toBe(true);
        }
      }
    }
    expect(w.writes).toEqual([]);
    expect(w.spawn).not.toHaveBeenCalled();
    expect(w.fetchSpy).not.toHaveBeenCalled();
  });
});

describe('registry', () => {
  it('puts the three in the fun category, with pet and kaomoji time based', () => {
    for (const type of FUN) expect(getWidget(type)?.category, type).toBe('fun');
    expect(getWidget('pet')?.timeBased).toBe(true);
    expect(getWidget('kaomoji')?.timeBased).toBe(true);
    expect(getWidget('quip')?.timeBased).toBeUndefined();
  });

  it('are in no preset and no default layout', () => {
    const configs = [
      defaultConfig(),
      starterConfig(true),
      starterConfig(false),
      ...PRESETS.map((p) => p.build()),
    ];
    for (const c of configs) {
      const text = JSON.stringify(c);
      for (const type of FUN) expect(text, type).not.toContain(`"${type}"`);
    }
  });

  it('fun.ts imports no Node module', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/widgets/fun.ts'), 'utf8');
    expect(src).not.toMatch(/from 'node:/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});

describe('fun category colors', () => {
  const part = (category: 'fun' | 'custom'): Part => {
    const def = { ...getWidget('pet')!, category };
    const item = { id: 'p', type: 'pet' };
    return { item, def, text: 'x', label: '', value: 'x', status: undefined, bg: undefined, flex: false };
  };

  it('falls back to the custom swatch in every category theme', () => {
    const themes = BUILTIN_THEMES.filter((t) => t.colors.mode === 'category');
    expect(themes.length).toBeGreaterThan(5);
    for (const t of themes) {
      expect(t.colors.categories.fun, t.id).toBeUndefined();
      const a = resolveAppearance({ ...defaultConfig(), theme: t.id }, t, {});
      expect(colorsFor(a, part('fun'), 0), t.id).toEqual(colorsFor(a, part('custom'), 0));
    }
  });

  it('uses a fun swatch when the theme has one', () => {
    const base = BUILTIN_THEMES.find((t) => t.colors.mode === 'category' && t.style === 'powerline')!;
    const t: Theme = {
      ...base,
      colors: {
        ...base.colors,
        categories: { ...base.colors.categories, fun: { bg: '#123456', fg: '#ffffff' } },
      },
    };
    const a = resolveAppearance({ ...defaultConfig(), theme: t.id }, t, {});
    expect(colorsFor(a, part('fun'), 0).bg).toBe('#123456');
  });

  it('is in the theme schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(new URL('../../schema/theme.schema.json', import.meta.url), 'utf8'),
    );
    expect(schema.properties.colors.properties.categories.properties.fun).toBeDefined();
  });
});
