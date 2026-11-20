/**
 * Course-level and career-level analytics. Everything is computed from local records.
 *
 * Wording rule: correlations are presented as *associations in a small sample*, never as causes.
 * No motivational messages — each insight states numbers and the size of the sample.
 */
import { isoWeekKey, weekdayISO, formatNumberIT, type ISODate, type LocalDateTime } from './dates';
import { computeAttendance, type AttendanceOptions, DEFAULT_ATTENDANCE_OPTIONS } from './attendance';
import { lessonStart } from './timetable';
import type { Lesson } from './types';

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3 || n !== ys.length) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export interface AttendanceGradePoint {
  courseId: string;
  name: string;
  attendance: number; // %
  grade: number; // 18..30 (lode mapped)
  lode: boolean;
}

export interface CorrelationInsight {
  r: number | null;
  n: number;
  enough: boolean; // fewer than 5 points is flagged as too little data
  text: string;
  exceptions: AttendanceGradePoint[];
}

/** Courses whose grade is far from what a straight-line fit on attendance would predict. */
function outliers(points: AttendanceGradePoint[]): AttendanceGradePoint[] {
  if (points.length < 4) return [];
  const xs = points.map((p) => p.attendance);
  const ys = points.map((p) => p.grade);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) return [];
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  const res = points.map((p) => p.grade - (my + slope * (p.attendance - mx)));
  const sd = Math.sqrt(res.reduce((a, r) => a + r * r, 0) / res.length);
  if (sd === 0) return [];
  return points.filter((_, i) => Math.abs(res[i]) > 1.2 * sd);
}

export function attendanceGradeInsight(points: AttendanceGradePoint[], threshold = 80): CorrelationInsight {
  const r = pearson(points.map((p) => p.attendance), points.map((p) => p.grade));
  const n = points.length;
  const ex = outliers(points);
  if (r === null || n < 3) {
    return { r: null, n, enough: false, exceptions: [], text: n === 0 ? 'Servono esami superati con presenze registrate per confrontare presenza e voti.' : `Con ${n} ${n === 1 ? 'esame' : 'esami'} non c’è abbastanza materiale per un confronto.` };
  }
  const strength = Math.abs(r) >= 0.7 ? 'forte' : Math.abs(r) >= 0.4 ? 'moderata' : 'debole';
  const direction = r >= 0 ? 'i voti più alti tendono a stare dove la presenza è più alta' : 'i voti più alti tendono a stare dove la presenza è più bassa';
  const lowHigh = points.filter((p) => p.attendance < threshold);
  const highHigh = points.filter((p) => p.attendance >= threshold);
  const avg = (a: AttendanceGradePoint[]) => a.reduce((s, p) => s + p.grade, 0) / a.length;
  let text = `Su ${n} esami, ${direction} (associazione ${strength}, r = ${formatNumberIT(r)}).`;
  if (lowHigh.length && highHigh.length) {
    text += ` Con presenza sotto il ${threshold}% la media dei voti è ${formatNumberIT(avg(lowHigh), 1)} (${lowHigh.length} ${lowHigh.length === 1 ? 'corso' : 'corsi'}), sopra è ${formatNumberIT(avg(highHigh), 1)} (${highHigh.length}).`;
  }
  if (ex.length) text += ` Fuori tendenza: ${ex.map((p) => `${p.name} (${p.lode ? '30L' : p.grade} con ${Math.round(p.attendance)}%)`).join(', ')}.`;
  text += n < 8 ? ' Sono pochi dati e contano anche difficoltà del corso e ore di studio: è una tendenza, non una causa.' : ' Contano anche difficoltà del corso e ore di studio: non è una relazione di causa.';
  return { r, n, enough: n >= 5, text, exceptions: ex };
}

export interface WeekPoint {
  week: string; // 2026-W47
  held: number;
  attended: number;
  pct: number | null;
}

/** Attendance per ISO week over `lessons` (only registered lessons count). */
export function weeklyAttendance(lessons: Lesson[], opts: AttendanceOptions = DEFAULT_ATTENDANCE_OPTIONS, now: LocalDateTime = '9999-12-31T00:00'): WeekPoint[] {
  const byWeek = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const k = isoWeekKey(l.date);
    byWeek.set(k, [...(byWeek.get(k) ?? []), l]);
  }
  return [...byWeek.keys()].sort().map((week) => {
    const st = computeAttendance(byWeek.get(week)!, now, opts);
    return { week, held: st.held, attended: st.attended, pct: st.percentage };
  });
}

export interface TrendInsight {
  text: string;
  first: number | null;
  last: number | null;
}

export function attendanceTrend(points: WeekPoint[], threshold = 80, head = 3, tail = 5): TrendInsight {
  const measured = points.filter((p) => p.held > 0);
  if (measured.length < head + 2) return { text: 'Servono almeno cinque settimane di presenze registrate per vedere un andamento.', first: null, last: null };
  const pool = (arr: WeekPoint[]) => {
    const held = arr.reduce((a, p) => a + p.held, 0);
    return held ? (arr.reduce((a, p) => a + p.attended, 0) / held) * 100 : null;
  };
  const first = pool(measured.slice(0, head));
  const last = pool(measured.slice(-Math.min(tail, measured.length - head)));
  if (first === null || last === null) return { text: '', first, last };
  const diff = last - first;
  const verb = Math.abs(diff) < 3 ? 'è stabile' : diff < 0 ? 'è scesa' : 'è salita';
  return {
    first,
    last,
    text: `La presenza ${verb}: ${Math.round(first)}% nelle prime ${head} settimane, ${Math.round(last)}% nelle ultime ${Math.min(tail, measured.length - head)}.${last < threshold ? ` Siamo sotto la soglia del ${threshold}%.` : ''}`,
  };
}

/** Number of absences per ISO weekday (1..7). */
export function absencesByWeekday(lessons: Lesson[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const l of lessons) if ((l.attendance === 'absent' || l.attendance === 'recovered') && !l.cancelled) out[weekdayISO(l.date) - 1] += 1;
  return out;
}

export function studyHours(durationsMinutes: number[]): number {
  return durationsMinutes.reduce((a, b) => a + b, 0) / 60;
}

export function overallAttendance(lessons: Lesson[], opts: AttendanceOptions, now: LocalDateTime): number | null {
  return computeAttendance(lessons, now, opts).percentage;
}

export function pastLessons(lessons: Lesson[], now: LocalDateTime): Lesson[] {
  return lessons.filter((l) => lessonStart(l) < now);
}

export function isoDateRange(lessons: Lesson[]): { from: ISODate; to: ISODate } | null {
  if (!lessons.length) return null;
  const ds = lessons.map((l) => l.date).sort();
  return { from: ds[0], to: ds[ds.length - 1] };
}
