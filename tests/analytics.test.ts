import { describe, expect, it } from 'vitest';
import { absencesByWeekday, attendanceGradeInsight, attendanceTrend, pearson, weeklyAttendance } from '../src/domain/analytics';
import { newLesson } from '../src/domain/timetable';
import type { AttendanceStatus, Lesson } from '../src/domain/types';

let i = 0;
const lesson = (date: string, attendance: AttendanceStatus): Lesson => ({ ...newLesson({ courseId: 'c', ruleId: 'r', originalDate: date, date, startTime: '10:00', endTime: '12:00' }, 'x', () => `l${++i}`), attendance });

describe('analytics', () => {
  const design = [
    ['Analisi 1', 88, 27], ['Geometria', 92, 29], ['Informatica', 79, 30], ['Fisica 1', 61, 24], ['Economia', 70, 26], ['Chimica', 54, 22],
  ] as const;
  const pts = design.map(([name, attendance, grade], k) => ({ courseId: `c${k}`, name, attendance, grade, lode: name === 'Informatica' }));

  it('computes the Pearson correlation of the design data (r ≈ 0,86 as printed in the approved design)', () => {
    const r = pearson(pts.map((p) => p.attendance), pts.map((p) => p.grade))!;
    expect(r).toBeGreaterThan(0.84);
    expect(r).toBeLessThan(0.88);
  });

  it('describes the association objectively and never claims causation', () => {
    const ins = attendanceGradeInsight(pts);
    expect(ins.n).toBe(6);
    expect(ins.text).toMatch(/associazione/);
    expect(ins.text).toMatch(/non una causa|non è una relazione di causa/);
    expect(ins.text).not.toMatch(/\bperché\b|\bcausa(ta|to)? da\b|\bgrazie\b|motiv/i);
    expect(ins.text).toMatch(/Informatica/); // the outlier is named
  });

  it('refuses to over-interpret tiny samples', () => {
    expect(attendanceGradeInsight(pts.slice(0, 2)).r).toBeNull();
    expect(attendanceGradeInsight([]).text).toMatch(/Servono/);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull(); // no variance
  });

  it('computes weekly attendance and a trend, with the threshold stated', () => {
    const lessons: Lesson[] = [];
    // 3 weeks fully attended, then 5 weeks at 50%
    for (let w = 0; w < 8; w++) {
      const monday = new Date(Date.UTC(2026, 8, 28 + w * 7));
      const d = (n: number) => new Date(monday.getTime() + n * 86400000).toISOString().slice(0, 10);
      lessons.push(lesson(d(0), 'attended'), lesson(d(3), w < 3 ? 'attended' : 'absent'));
    }
    const pts2 = weeklyAttendance(lessons);
    expect(pts2).toHaveLength(8);
    expect(pts2[0].pct).toBe(100);
    expect(pts2[7].pct).toBe(50);
    const t = attendanceTrend(pts2, 80);
    expect(t.first).toBe(100);
    expect(t.last).toBe(50);
    expect(t.text).toMatch(/scesa/);
    expect(t.text).toMatch(/soglia del 80%/);
    expect(attendanceTrend(pts2.slice(0, 3), 80).text).toMatch(/Servono/);
  });

  it('counts absences per weekday', () => {
    const ls = [lesson('2026-11-20', 'absent'), lesson('2026-11-13', 'absent'), lesson('2026-11-16', 'recovered'), lesson('2026-11-17', 'attended')];
    expect(absencesByWeekday(ls)).toEqual([1, 0, 0, 0, 2, 0, 0]);
  });
});
