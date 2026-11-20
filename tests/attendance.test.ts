import { describe, expect, it } from 'vitest';
import { attendanceStrip, computeAttendance, lessonsToRecover, nextAttendanceStatus } from '../src/domain/attendance';
import { newLesson } from '../src/domain/timetable';
import type { AttendanceStatus, Lesson } from '../src/domain/types';

const NOW = '2026-11-20T19:02';
let i = 0;
function lesson(date: string, attendance: AttendanceStatus, extra: Partial<Lesson> = {}): Lesson {
  return { ...newLesson({ courseId: 'c', ruleId: 'r', originalDate: date, date, startTime: '10:00', endTime: '12:00' }, '2026-01-01T00:00:00Z', () => `l${++i}`), attendance, ...extra };
}
/** Build N lessons with the given statuses on consecutive past days. */
const many = (statuses: AttendanceStatus[]) => statuses.map((s, k) => lesson(`2026-10-${String(k + 1).padStart(2, '0')}`, s));

describe('attendance', () => {
  it('reproduces the Fisica 2 numbers of the design: 18 present, 4 absent, 2 recovered → 75% of 24 held', () => {
    const st = computeAttendance(many([...Array(18).fill('attended'), ...Array(4).fill('absent'), ...Array(2).fill('recovered')] as AttendanceStatus[]), NOW);
    expect(st.held).toBe(24);
    expect(st.attended).toBe(18);
    expect(st.absent).toBe(4);
    expect(st.recovered).toBe(2);
    expect(st.absences).toBe(6);
    expect(st.percentage).toBe(75);
    expect(st.recoveryProgress).toBeCloseTo(2 / 6);
  });

  it('can count recovered lessons as attended (setting)', () => {
    const st = computeAttendance(many(['attended', 'attended', 'absent', 'recovered']), NOW, { recoveredCountsAsAttended: true, excludeToConfirm: true, excludeCancelled: true });
    expect(st.attended).toBe(3);
    expect(st.percentage).toBe(75);
  });

  it('keeps unconfirmed past lessons out of the percentage by default, and in when asked', () => {
    const ls = many(['attended', 'attended', 'to_confirm', 'to_confirm']);
    expect(computeAttendance(ls, NOW).percentage).toBe(100);
    expect(computeAttendance(ls, NOW).toConfirm).toBe(2);
    const strict = computeAttendance(ls, NOW, { recoveredCountsAsAttended: false, excludeToConfirm: false, excludeCancelled: true });
    expect(strict.held).toBe(4);
    expect(strict.percentage).toBe(50);
  });

  it('never counts cancelled lessons, and does not count upcoming lessons as held', () => {
    const ls = [
      lesson('2026-10-01', 'attended'),
      lesson('2026-10-02', 'absent', { cancelled: true, cancelReason: 'cancelled' }),
      lesson('2026-12-01', 'to_confirm'), // future
    ];
    const st = computeAttendance(ls, NOW);
    expect(st.held).toBe(1);
    expect(st.upcoming).toBe(1);
    expect(st.scheduled).toBe(2);
    expect(st.percentage).toBe(100);
  });

  it('returns null percentage/progress when there is nothing to measure', () => {
    const st = computeAttendance([], NOW);
    expect(st.percentage).toBeNull();
    expect(st.recoveryProgress).toBeNull();
  });

  it('lists lessons to recover, most recent first, and builds the glyph strip', () => {
    const ls = [lesson('2026-10-01', 'absent'), lesson('2026-11-12', 'absent'), lesson('2026-11-13', 'recovered'), lesson('2026-11-19', 'to_confirm'), lesson('2026-12-04', 'to_confirm')];
    expect(lessonsToRecover(ls).map((l) => l.date)).toEqual(['2026-11-12', '2026-10-01']);
    expect(attendanceStrip(ls, NOW)).toEqual(['x', 'x', 'r', 't', 'f']);
  });

  it('cycles statuses in the order of the design', () => {
    expect(nextAttendanceStatus('attended')).toBe('absent');
    expect(nextAttendanceStatus('absent')).toBe('recovered');
    expect(nextAttendanceStatus('recovered')).toBe('to_confirm');
    expect(nextAttendanceStatus('to_confirm')).toBe('attended');
  });
});
