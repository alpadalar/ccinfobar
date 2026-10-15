import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareIds,
  foldSearch,
  formatDateTime,
  formatMonthDay,
  formatWeekday,
} from '../../src/core/i18n/format.js';

const OCT_12 = new Date(2026, 9, 12, 12, 0);
const WED = new Date(2026, 9, 14, 9, 5);

describe('dates', () => {
  it('month and day', () => {
    expect(formatMonthDay(OCT_12, 'en')).toBe('Oct 12');
    expect(formatMonthDay(OCT_12, 'tr')).toBe('12 Eki');
  });

  it('weekday', () => {
    expect(formatWeekday(WED, 'en')).toBe('Wed');
    expect(formatWeekday(WED, 'tr')).toBe('Çar');
  });

  it('date and 24-hour time', () => {
    expect(formatDateTime(new Date(2026, 9, 14, 21, 7), 'en')).toBe('Oct 14, 2026, 21:07');
    expect(formatDateTime(WED, 'en')).toMatch(/09:05$/);
    expect(formatDateTime(new Date(2026, 9, 14, 0, 30), 'tr')).toBe('14 Eki 2026 00:30');
  });

  it('bad input never throws', () => {
    expect(formatMonthDay(new Date(Number.NaN), 'en')).toBe('');
    expect(formatMonthDay(OCT_12, '!!')).toBe('Oct 12');
  });
});

describe('foldSearch', () => {
  it('folds Turkish dotted and dotless i', () => {
    const want = foldSearch('istatistik', 'tr');
    expect(want).toBe('istatistik');
    expect(foldSearch('İstatistik', 'tr')).toBe(want);
    expect(foldSearch('Istatistik', 'tr')).toBe(want);
    expect(foldSearch('kullanım', 'tr')).toBe('kullanim');
  });

  it('strips marks and keeps ids', () => {
    expect(foldSearch('Önizleme', 'tr')).toBe('onizleme');
    expect(foldSearch('limit-risk', 'tr')).toBe('limit-risk');
    expect(foldSearch('Context', 'en')).toBe('context');
    expect(foldSearch('X', '!!')).toBe('x');
  });
});

describe('compareIds', () => {
  it('sorts by code unit', () => {
    expect(['b', 'a', 'B'].sort(compareIds)).toEqual(['B', 'a', 'b']);
    expect(compareIds('a', 'a')).toBe(0);
    expect(compareIds('i', 'ı')).toBeLessThan(0);
  });
});

describe('i18n sources', () => {
  it('pass explicit locales', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/i18n/format.ts'), 'utf8');
    expect(src).not.toMatch(/toLocale(Upper|Lower)Case\(\s*\)/);
    expect(src).not.toMatch(/new Intl\.\w+\(\s*(undefined)?\s*[,)]/);
  });
});
