import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LIMITS, limits, today, monthTitle, weekdays, monthGrid, day, WebApi } from '../../src/engine/amlich.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dump = JSON.parse(await readFile(join(__dirname, 'fixtures/engine-dump.json'), 'utf8'));

describe('amlich unit tests', () => {
  it('exposes supported year limits', () => {
    expect(LIMITS).toEqual({ minYear: 1900, maxYear: 2100 });
    expect(limits()).toEqual({ minYear: 1900, maxYear: 2100 });
    expect(WebApi.limits()).toBe('{"minYear":1900,"maxYear":2100}');
  });

  it('computes today across positive and negative UTC offsets at midnight boundaries', () => {
    expect(today(0, 7.0)).toEqual({ iso: '1970-01-01', weekdayIndex: 4 });
    expect(today(0, -5.0)).toEqual({ iso: '1969-12-31', weekdayIndex: 3 });
  });

  it('formats Tết, regular lunar months, and leap months accurately', () => {
    const tet = day('2026-02-17', 7.0, 'vi');
    expect(tet.fullDate).toBe('Mùng 1 Tết, năm Bính Ngọ (Ngựa)');

    const regular = day('2026-01-01', 7.0, 'vi');
    expect(regular.fullDate).toBe('Ngày 13 tháng Một năm Ất Tỵ (Rắn)');

    const leap = day('2025-07-25', 7.0, 'vi');
    expect(leap.lunarLeap).toBe(true);
    expect(leap.lunarMonthName).toBe('Tháng Nhuận Tháng 6');
    expect(leap.fullDate).toBe('Mùng 1 tháng Nhuận Tháng 6 năm Ất Tỵ (Rắn)');
  });

  it('rejects malformed and non-existent Gregorian dates with bad-date', () => {
    expect(day('not-a-date', 7.0, 'vi')).toEqual({ error: 'bad-date' });
    expect(day('2026-13-01', 7.0, 'vi')).toEqual({ error: 'bad-date' });
    expect(day('2026-02-00', 7.0, 'vi')).toEqual({ error: 'bad-date' });
    expect(day('2026-02-31', 7.0, 'vi')).toEqual({ error: 'bad-date' });
    expect(day('2025-02-29', 7.0, 'vi')).toEqual({ error: 'bad-date' });
    expect(day('2026-04-31', 7.0, 'vi')).toEqual({ error: 'bad-date' });
  });
});

describe('JVM engine reference corpus (132 answers)', () => {
  it('matches limits and badDate answers', () => {
    expect(limits()).toEqual(dump.limits);
    expect(day('not-a-date', 7.0, 'vi')).toEqual(dump.badDate);
  });

  it('matches all 6 weekday configurations', () => {
    for (const [key, expected] of Object.entries(dump.weekdays)) {
      const [language, weekStart, form] = key.split('-');
      expect(weekdays(language, Number(weekStart), form === 'long')).toEqual(expected);
    }
  });

  it('matches all 12 month titles', () => {
    for (const [key, expected] of Object.entries(dump.titles)) {
      const match = key.match(/^(\d{4})-(\d+)-(\w+)$/);
      expect(monthTitle(Number(match[1]), Number(match[2]), match[3])).toEqual(expected);
    }
  });

  it('matches all 62 month grids', () => {
    for (const [key, entry] of Object.entries(dump.months)) {
      const year = Number(key.slice(0, 4));
      const month = Number(key.slice(5, 7));
      expect(monthGrid(year, month, entry.grid.weekStart, entry.epoch, 7.0)).toEqual(entry.grid);
    }
  });

  it('matches all 50 day panels across zones, languages, Tết, leap months, and solar terms', () => {
    for (const [key, expected] of Object.entries(dump.days)) {
      const iso = key.slice(0, 10);
      const rest = key.slice(11);
      const language = rest.slice(rest.lastIndexOf('-') + 1);
      const zone = Number(rest.slice(0, rest.lastIndexOf('-')));
      expect(day(iso, zone, language)).toEqual(expected);
    }
  });
});
