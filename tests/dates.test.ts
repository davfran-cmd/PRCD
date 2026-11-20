import { describe, expect, it } from 'vitest';
import { addDays, addMonths, diffDays, formatDayLong, formatNumberIT, isISODate, isoWeekKey, roundTo, startOfWeek, weekdayISO, eachDay, hmToMin, minToHM } from '../src/domain/dates';

describe('dates', () => {
  it('computes ISO weekdays', () => {
    expect(weekdayISO('2026-11-20')).toBe(5); // Friday
    expect(weekdayISO('2026-11-22')).toBe(7); // Sunday
    expect(weekdayISO('1970-01-01')).toBe(4); // Thursday
  });
  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2027-01-15', '2026-09-28')).toBe(109);
  });
  it('is immune to DST (spring forward / fall back weeks)', () => {
    expect(eachDay('2026-03-27', '2026-03-30')).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30']);
    expect(eachDay('2026-10-24', '2026-10-27')).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });
  it('validates ISO dates strictly', () => {
    expect(isISODate('2026-02-29')).toBe(false);
    expect(isISODate('2028-02-29')).toBe(true);
    expect(isISODate('2026-13-01')).toBe(false);
    expect(isISODate('26-1-1')).toBe(false);
  });
  it('finds the Monday of a week and ISO week keys', () => {
    expect(startOfWeek('2026-11-22')).toBe('2026-11-16');
    expect(isoWeekKey('2026-11-16')).toBe('2026-W47');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
  });
  it('adds months clamping the day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });
  it('formats in Italian', () => {
    expect(formatDayLong('2026-11-20')).toBe('Venerdì 20 novembre');
    expect(formatNumberIT(26.4151, 2)).toBe('26,42');
  });
  it('rounds half away from zero without float artefacts', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
  });
  it('converts times', () => {
    expect(hmToMin('14:15')).toBe(855);
    expect(minToHM(855)).toBe('14:15');
    expect(minToHM(1500)).toBe('01:00');
  });
});
