import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/core/config.js';
import {
  formatWeekdays,
  nextRotationChange,
  normalizeThemeRotation,
  parseEvery,
  parseWeekdays,
  periodIndex,
  pickRotationTheme,
  rotationIds,
  withoutRotation,
} from '../../src/core/rotation.js';
import { activeThemeId, BUILTIN_THEMES, themeExists, withActiveTheme } from '../../src/core/themes.js';
import type { ThemeRotation } from '../../src/core/types.js';
import { withTz } from '../helpers.js';

const all = () => true;
const at = (d: number, h = 12, min = 0) => new Date(2026, 9, d, h, min);

describe('periodIndex', () => {
  it('keeps one index inside a period and steps by one across it', () => {
    expect(periodIndex('hour', at(12, 10, 1))).toBe(periodIndex('hour', at(12, 10, 59)));
    expect(periodIndex('hour', at(12, 11, 0)) - periodIndex('hour', at(12, 10, 59))).toBe(1);
    expect(periodIndex('day', at(12, 0, 0))).toBe(periodIndex('day', at(12, 23, 59)));
    expect(periodIndex('day', at(13, 0, 0)) - periodIndex('day', at(12, 23, 59))).toBe(1);
    expect(periodIndex(30, at(12, 10, 0))).toBe(periodIndex(30, at(12, 10, 29)));
    expect(periodIndex(30, at(12, 10, 30)) - periodIndex(30, at(12, 10, 29))).toBe(1);
  });

  it('starts weeks on Monday', () => {
    // 2026-10-12 is a Monday
    expect(at(12).getDay()).toBe(1);
    expect(periodIndex('week', at(12, 0, 0))).toBe(periodIndex('week', at(18, 23, 59)));
    expect(periodIndex('week', at(19, 0, 0)) - periodIndex('week', at(18, 23, 59))).toBe(1);
    expect(periodIndex('week', at(11, 23, 59))).toBe(periodIndex('week', at(12)) - 1);
  });

  it('gives consecutive days across DST changes', () => {
    for (const [y, m, d] of [
      [2026, 2, 29],
      [2026, 9, 25],
      [2026, 2, 8],
      [2026, 10, 1],
    ] as const) {
      const a = periodIndex('day', new Date(y, m, d - 1, 12));
      expect(periodIndex('day', new Date(y, m, d, 12))).toBe(a + 1);
      expect(periodIndex('day', new Date(y, m, d + 1, 12))).toBe(a + 2);
    }
  });
});

describe('pickRotationTheme', () => {
  it('walks the pool in order', () => {
    const rot: ThemeRotation = { themes: ['a', 'b', 'c'] };
    const seq = [12, 13, 14, 15].map((d) => pickRotationTheme(rot, at(d), all));
    const i = ['a', 'b', 'c'].indexOf(seq[0]!);
    expect(seq).toEqual([0, 1, 2, 3].map((k) => ['a', 'b', 'c'][(i + k) % 3]));
    expect(seq[0]).toBe(['a', 'b', 'c'][periodIndex('day', at(12)) % 3]);
  });

  it('switches every 30 minutes at :00 and :30', () => {
    const rot: ThemeRotation = { themes: ['a', 'b'], every: 30 };
    const x = pickRotationTheme(rot, at(12, 10, 0), all);
    expect(pickRotationTheme(rot, at(12, 10, 29), all)).toBe(x);
    expect(pickRotationTheme(rot, at(12, 10, 30), all)).not.toBe(x);
    expect(pickRotationTheme(rot, at(12, 11, 0), all)).toBe(x);
  });

  it('restarts minute periods at local midnight', () => {
    for (const tz of ['America/New_York', 'Europe/Istanbul']) {
      withTz(tz, () => {
        const last = periodIndex(7, at(12, 23, 59));
        const first = periodIndex(7, new Date(2026, 9, 13, 0, 0));
        expect(first - last).toBe(1);
        expect(periodIndex(7, new Date(2026, 9, 13, 0, 0)) % Math.ceil(1440 / 7)).toBe(0);
        expect(periodIndex(30, at(12, 12, 10))).toBe(periodIndex(30, at(12, 12, 29)));
        expect(periodIndex(30, at(12, 12, 10))).not.toBe(periodIndex(30, at(12, 12, 30)));
      });
    }
  });

  it('keeps the epoch formula above 1440 minutes', () => {
    const d = at(12, 13, 5);
    const day = Math.floor(Date.UTC(2026, 9, 12) / 86_400_000);
    expect(periodIndex(2880, d)).toBe(Math.floor((day * 1440 + 13 * 60 + 5) / 2880));
  });

  it('shuffles deterministically, once per round, without repeats', () => {
    const themes = ['a', 'b', 'c', 'd', 'e'];
    const rot: ThemeRotation = { themes, every: 'hour', order: 'shuffle' };
    const start = new Date(2026, 0, 1, 0);
    const base = periodIndex('hour', start);
    const first = base - (base % 5) + 5;
    const seq: string[] = [];
    for (let i = 0; i < 60; i++) {
      const now = new Date(2026, 0, 1, first - base + i, 15);
      const a = pickRotationTheme(rot, now, all)!;
      expect(pickRotationTheme(rot, now, all)).toBe(a);
      seq.push(a);
    }
    for (let r = 0; r < 12; r++) expect([...seq.slice(r * 5, r * 5 + 5)].sort()).toEqual(themes);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
    const other = { ...rot, themes: ['e', 'd', 'c', 'b', 'a'] };
    const seq2 = seq.map((_, i) => pickRotationTheme(other, new Date(2026, 0, 1, first - base + i, 15), all));
    expect(seq2).not.toEqual(seq);
  });

  it('alternates a two theme shuffle', () => {
    const rot: ThemeRotation = { themes: ['a', 'b'], order: 'shuffle' };
    const seq = [1, 2, 3, 4, 5, 6].map((d) => pickRotationTheme(rot, at(d), all));
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });

  it('pins weekdays and falls back to the pool', () => {
    const rot: ThemeRotation = { themes: ['dracula'], weekdays: { mon: 'nord' } };
    expect(pickRotationTheme(rot, at(12), all)).toBe('nord');
    expect(pickRotationTheme(rot, at(13), all)).toBe('dracula');
    expect(pickRotationTheme(rot, at(12), (id) => id !== 'nord')).toBe('dracula');
  });

  it('skips unknown ids and gives null for an empty pool', () => {
    const known = (id: string) => BUILTIN_THEMES.some((t) => t.id === id);
    const rot: ThemeRotation = { themes: ['ghost', 'nord'] };
    for (const d of [12, 13, 14]) expect(pickRotationTheme(rot, at(d), known)).toBe('nord');
    expect(pickRotationTheme({ themes: ['ghost'] }, at(12), known)).toBeNull();
    expect(pickRotationTheme({}, at(12), known)).toBeNull();
  });
});

describe('pickRotationTheme verification', () => {
  const counting = (ok: (id: string) => boolean) => {
    const calls: string[] = [];
    return {
      calls,
      known: (id: string) => {
        calls.push(id);
        return ok(id);
      },
    };
  };

  it('takes the next pool entry when the cycle pick is unknown, wrapping at the end', () => {
    const pool = ['a', 'b', 'c'];
    const now = at(12);
    const pos = periodIndex('day', now) % 3;
    const hit = pickRotationTheme({ themes: pool, order: 'cycle' }, now, all)!;
    expect(hit).toBe(pool[(pos + 3) % 3]);
    for (let p = 0; p < 3; p++) {
      const d = at(12 + ((p - pos + 3) % 3));
      const want = pool[p]!;
      const c = counting((id) => id !== want);
      expect(pickRotationTheme({ themes: pool, order: 'cycle' }, d, c.known)).toBe(pool[(p + 1) % 3]);
      expect(c.calls).toEqual([want, pool[(p + 1) % 3]]);
    }
  });

  it('calls known once when the pick exists and at most n times otherwise', () => {
    const pool = ['a', 'b', 'c', 'd'];
    const one = counting(() => true);
    pickRotationTheme({ themes: pool }, at(12), one.known);
    expect(one.calls).toHaveLength(1);
    const none = counting(() => false);
    expect(pickRotationTheme({ themes: pool }, at(12), none.known)).toBeNull();
    expect(none.calls).toHaveLength(4);
  });

  it('walks on from the shuffled position when that entry is unknown', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    const rot: ThemeRotation = { themes: pool, order: 'shuffle' };
    for (let d = 1; d <= 12; d++) {
      const pick = pickRotationTheme(rot, at(d), all)!;
      const pos = pool.indexOf(pick);
      const c = counting((id) => id !== pick);
      expect(pickRotationTheme(rot, at(d), c.known)).toBe(pool[(pos + 1) % 5]);
      expect(c.calls).toEqual([pick, pool[(pos + 1) % 5]]);
    }
  });

  it('verifies a known pinned weekday once and falls through when it is unknown', () => {
    const rot: ThemeRotation = { themes: ['dracula', 'nord'], weekdays: { mon: 'gruvbox' } };
    const hit = counting(() => true);
    expect(pickRotationTheme(rot, at(12), hit.known)).toBe('gruvbox');
    expect(hit.calls).toEqual(['gruvbox']);
    const miss = counting((id) => id !== 'gruvbox');
    expect(['dracula', 'nord']).toContain(pickRotationTheme(rot, at(12), miss.known));
    expect(miss.calls[0]).toBe('gruvbox');
  });
});

describe('normalizeThemeRotation', () => {
  it('cleans the block', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(
      normalizeThemeRotation({
        themes: ['nord', 'nord', '../x', 3, 'dracula', ...ids],
        every: 44.6,
        order: 'random',
        weekdays: { mon: 'nord', xyz: 'nord', tue: '../evil' },
      }),
    ).toEqual({ themes: ['nord', 'dracula', ...ids.slice(0, 30)], every: 45, weekdays: { mon: 'nord' } });
    expect(normalizeThemeRotation({ themes: ['a'], every: 0 })?.every).toBe(1);
    expect(normalizeThemeRotation({ themes: ['a'], every: 99999 })?.every).toBe(10080);
    expect(normalizeThemeRotation({ themes: ['a'], every: 'month' })).toEqual({ themes: ['a'] });
    expect(normalizeThemeRotation({ themes: ['a'], order: 'shuffle' })?.order).toBe('shuffle');
  });

  it('drops reserved device names from the pool', () => {
    expect(normalizeThemeRotation({ themes: ['nord', 'con'] })).toEqual({ themes: ['nord'] });
    expect(normalizeThemeRotation({ themes: ['con', 'Nul.json'] })).toBeUndefined();
  });

  it('drops an empty block', () => {
    expect(normalizeThemeRotation(undefined)).toBeUndefined();
    expect(normalizeThemeRotation([])).toBeUndefined();
    expect(normalizeThemeRotation({ every: 'hour' })).toBeUndefined();
    expect(normalizeThemeRotation({ themes: [], weekdays: {} })).toBeUndefined();
    expect(normalizeThemeRotation({ weekdays: { sun: 'nord' } })).toEqual({ weekdays: { sun: 'nord' } });
  });
});

describe('nextRotationChange', () => {
  it('finds the next boundary', () => {
    expect(nextRotationChange({ every: 'hour' }, at(12, 10, 20))).toEqual(at(12, 11, 0));
    expect(nextRotationChange({}, at(12, 10, 20))).toEqual(at(13, 0, 0));
    expect(nextRotationChange({ every: 'week' }, at(14, 10))).toEqual(at(19, 0, 0));
    expect(nextRotationChange({ every: 'week' }, at(12, 0, 0))).toEqual(at(19, 0, 0));
    expect(nextRotationChange({ every: 'week' }, at(18, 23))).toEqual(at(19, 0, 0));
    expect(nextRotationChange({ every: 30 }, at(12, 10, 20))).toEqual(at(12, 10, 30));
    expect(nextRotationChange({ every: 30 }, at(12, 23, 45))).toEqual(at(13, 0, 0));
    expect(nextRotationChange({ every: 30 }, at(12, 12, 10))).toEqual(at(12, 12, 30));
    expect(nextRotationChange({ every: 7 }, at(12, 23, 58))).toEqual(at(13, 0, 0));
    const day = Math.floor(Date.UTC(2026, 9, 12) / 86_400_000);
    const total = (Math.floor((day * 1440 + 13 * 60 + 5) / 2880) + 1) * 2880;
    const d2 = Math.floor(total / 1440);
    const u = new Date(d2 * 86_400_000);
    const old = new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 0, total - d2 * 1440);
    expect(nextRotationChange({ every: 2880 }, at(12, 13, 5))).toEqual(old);
  });

  it('changes at midnight with a weekday map', () => {
    expect(nextRotationChange({ every: 'week', weekdays: { mon: 'nord' } }, at(14, 10))).toEqual(
      at(15, 0, 0),
    );
    expect(nextRotationChange({ every: 'hour', weekdays: { mon: 'nord' } }, at(14, 10))).toEqual(at(14, 11));
  });
});

describe('parsers', () => {
  it('parses every', () => {
    expect(parseEvery('hourly')).toBe('hour');
    expect(parseEvery('Day')).toBe('day');
    expect(parseEvery('weekly')).toBe('week');
    expect(parseEvery('45')).toBe(45);
    expect(parseEvery('30m')).toBe(30);
    for (const bad of ['0', '0x', '10081', 'month', '', '1.5', '-3']) expect(parseEvery(bad), bad).toBeNull();
  });

  it('parses and formats weekdays', () => {
    expect(parseWeekdays('mon=nord,Friday=dracula')).toEqual({
      ok: true,
      map: { mon: 'nord', fri: 'dracula' },
    });
    expect(parseWeekdays('')).toEqual({ ok: true, map: {} });
    expect(parseWeekdays('xyz=nord')).toEqual({ ok: false, bad: 'xyz=nord' });
    expect(parseWeekdays('mon')).toEqual({ ok: false, bad: 'mon' });
    expect(parseWeekdays('mon=../x')).toEqual({ ok: false, bad: 'mon=../x' });
    expect(formatWeekdays({ sun: 'a', mon: 'b', wed: 'c' })).toBe('mon=b,wed=c,sun=a');
    expect(formatWeekdays(undefined)).toBe('');
  });

  it('lists every id once', () => {
    expect(rotationIds({ themes: ['a', 'b'], weekdays: { mon: 'b', tue: 'c' } })).toEqual(['a', 'b', 'c']);
  });
});

describe('active theme', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('keeps the same object without rotation', () => {
    const c = { ...defaultConfig(), theme: 'nord' };
    expect(withActiveTheme(c)).toBe(c);
    expect(activeThemeId(c)).toBe('nord');
    expect(withoutRotation(c)).toBe(c);
  });

  it('falls back to config.theme for an unknown pool', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-rot-'));
    const c = { ...defaultConfig(), theme: 'nord', themeRotation: { themes: ['ghost'] } };
    expect(activeThemeId(c, at(12), dir)).toBe('nord');
    expect(withActiveTheme(c, at(12), dir)).toBe(c);
    expect('themeRotation' in withoutRotation(c)).toBe(false);
  });

  it('counts a user theme as known', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccib-rot-'));
    expect(themeExists('mine', dir)).toBe(false);
    expect(themeExists('../mine', dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'mine.json'), '{}');
    expect(themeExists('mine', dir)).toBe(true);
    expect(themeExists('nord', dir)).toBe(true);
    const c = { ...defaultConfig(), theme: 'nord', themeRotation: { themes: ['mine'] } };
    expect(withActiveTheme(c, at(12), dir).theme).toBe('mine');
  });
});
