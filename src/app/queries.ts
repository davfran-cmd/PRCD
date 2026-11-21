/** Read-model builders used by the screens. Pure compositions over the repository: no hardcoded values. */
import type { Repo } from '../db/repo';
import { attendanceStrip, computeAttendance, lessonsToConfirm, lessonsToRecover, type AttendanceStats, type StripGlyph } from '../domain/attendance';
import { addDays, diffDays, formatDayShort, hmToMin, startOfWeek, weekdayISO, type ISODate, type LocalDateTime } from '../domain/dates';
import { averagesFromEntries, buildLibrettoEntry, type AverageResult, type LibrettoEntry } from '../domain/grades';
import { attendanceGradeInsight, type AttendanceGradePoint } from '../domain/analytics';
import { lessonStart } from '../domain/timetable';
import type { Course, ExamAttempt, Lesson, Semester, TimetableRule } from '../domain/types';
import { gradeValue } from '../domain/grades';

export interface CourseSummary {
  course: Course;
  stats: AttendanceStats;
  strip: StripGlyph[];
  slots: Array<{ weekday: number; startTime: string; endTime: string; timeUnknown: boolean }>;
  weekdays: number[]; // ISO weekdays with a lesson
  nextExam: ExamAttempt | null;
  toRecover: Lesson[];
  lessonCount: number;
}

/** Slots currently producing lessons, collapsed to the latest pattern per slot lineage. */
export function currentSlots(rules: TimetableRule[], today: ISODate): Array<{ weekday: number; startTime: string; endTime: string; timeUnknown: boolean }> {
  const byLineage = new Map<string, TimetableRule>();
  for (const r of rules) {
    if (r.validTo < r.validFrom || r.validTo < today) continue;
    const cur = byLineage.get(r.slotId);
    if (!cur || r.validFrom > cur.validFrom) byLineage.set(r.slotId, r);
  }
  return [...byLineage.values()]
    .map((r) => ({ weekday: r.weekday, startTime: r.startTime, endTime: r.endTime, timeUnknown: Boolean(r.timeUnknown) }))
    .sort((a, b) => a.weekday - b.weekday || hmToMin(a.startTime) - hmToMin(b.startTime));
}

export function courseSummary(repo: Repo, course: Course, nowLocal: LocalDateTime): CourseSummary {
  const settings = repo.getSettings();
  const lessons = repo.lessonsForCourse(course.id);
  const today = nowLocal.slice(0, 10);
  const slots = currentSlots(repo.rules(course.id), today);
  const attempts = repo.attempts(course.id);
  const next = attempts.filter((a) => a.outcome === 'planned' && a.date && a.date >= today).sort((a, b) => (a.date as string).localeCompare(b.date as string))[0] ?? null;
  return {
    course,
    stats: computeAttendance(lessons, nowLocal, settings),
    strip: attendanceStrip(lessons, nowLocal),
    slots,
    weekdays: [...new Set(slots.map((s) => s.weekday))],
    nextExam: next,
    toRecover: lessonsToRecover(lessons),
    lessonCount: lessons.filter((l) => !l.cancelled).length,
  };
}

export function semesterSummaries(repo: Repo, semesterId: string, nowLocal: LocalDateTime): CourseSummary[] {
  return repo.courses({ semesterId }).map((c) => courseSummary(repo, c, nowLocal));
}

export function librettoEntries(repo: Repo): LibrettoEntry[] {
  const attempts = repo.attempts();
  return repo.courses({ includeArchived: true, includeHidden: true }).map((c) => buildLibrettoEntry(c, attempts)).filter((e) => e.history.length > 0 || !e.course.hidden);
}

export function librettoAverages(repo: Repo, entries = librettoEntries(repo)): AverageResult {
  const s = repo.getSettings();
  return averagesFromEntries(entries, { lodeValue: s.lodeValue, graduationScale: s.graduationScale });
}

export interface Dashboard {
  semester: Semester | undefined;
  weekNumber: { current: number; total: number } | null;
  summaries: CourseSummary[];
  toConfirmToday: Lesson[];
  toConfirmAll: Lesson[];
  toRecover: Array<Lesson & { courseName: string; color: string }>;
  recoveryDone: number;
  recoveryTotal: number;
  nextExam: { attempt: ExamAttempt; course: Course; days: number } | null;
  averages: AverageResult;
  inProgressCfu: number;
}

export function dashboard(repo: Repo, nowLocal: LocalDateTime): Dashboard {
  const today = nowLocal.slice(0, 10);
  const semester = repo.currentSemester();
  const summaries = semester ? semesterSummaries(repo, semester.id, nowLocal) : [];
  const lessons = semester ? repo.lessonsForSemester(semester.id) : [];
  const byCourse = new Map(summaries.map((s) => [s.course.id, s.course]));
  const toRecover = lessonsToRecover(lessons).map((l) => ({ ...l, courseName: byCourse.get(l.courseId)?.name ?? '', color: byCourse.get(l.courseId)?.color ?? '#000' }));
  const recoveredCount = lessons.filter((l) => l.attendance === 'recovered' && !l.cancelled).length;
  const planned = repo.attempts().filter((a) => a.outcome === 'planned' && a.date && a.date >= today);
  const nextAttempt = planned.sort((a, b) => (a.date as string).localeCompare(b.date as string))[0];
  const nextCourse = nextAttempt ? repo.course(nextAttempt.courseId) : undefined;
  const entries = librettoEntries(repo);
  const inProgress = semester ? summaries.filter((s) => !entries.find((e) => e.course.id === s.course.id)?.final).reduce((a, s) => a + s.course.cfu, 0) : 0;
  let weekNumber: Dashboard['weekNumber'] = null;
  if (semester) {
    const total = Math.floor(diffDays(semester.endDate, startOfWeek(semester.startDate)) / 7) + 1;
    const current = Math.min(total, Math.max(1, Math.floor(diffDays(today, startOfWeek(semester.startDate)) / 7) + 1));
    weekNumber = today < semester.startDate ? null : { current, total };
  }
  return {
    semester,
    weekNumber,
    summaries,
    toConfirmToday: lessonsToConfirm(lessons, nowLocal).filter((l) => l.date === today),
    toConfirmAll: lessonsToConfirm(lessons, nowLocal),
    toRecover,
    recoveryDone: recoveredCount,
    recoveryTotal: recoveredCount + toRecover.length,
    nextExam: nextAttempt && nextCourse ? { attempt: nextAttempt, course: nextCourse, days: diffDays(nextAttempt.date as string, today) } : null,
    averages: librettoAverages(repo, entries),
    inProgressCfu: inProgress,
  };
}

export function attendanceGradePoints(repo: Repo, nowLocal: LocalDateTime): AttendanceGradePoint[] {
  const settings = repo.getSettings();
  const out: AttendanceGradePoint[] = [];
  for (const e of librettoEntries(repo)) {
    if (!e.final || e.kind !== 'graded') continue;
    const lessons = repo.lessonsForCourse(e.course.id);
    const st = computeAttendance(lessons, nowLocal, settings);
    const v = gradeValue(e.final, { lodeValue: settings.lodeValue, graduationScale: settings.graduationScale });
    if (st.percentage === null || v === null) continue;
    out.push({ courseId: e.course.id, name: e.course.name, attendance: st.percentage, grade: e.final.lode ? 30 : (e.final.grade as number), lode: e.final.lode });
  }
  return out;
}

export { attendanceGradeInsight };

/** Human label such as "lun 14:15–17:15". */
export function slotLabel(s: { weekday: number; startTime: string; endTime: string }): string {
  return `${['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'][s.weekday - 1]} ${s.startTime}–${s.endTime}`;
}

export function whenLabel(date: ISODate, today: ISODate): string {
  const d = diffDays(date, today);
  if (d === 0) return 'oggi';
  if (d === 1) return 'domani';
  if (d > 1 && d < 7) return ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'][weekdayISO(date) - 1];
  return formatDayShort(date);
}

export function nextLessons(lessons: Lesson[], nowLocal: LocalDateTime, n: number): Lesson[] {
  return lessons.filter((l) => !l.cancelled && lessonStart(l) >= nowLocal).slice(0, n);
}

export function weekRange(date: ISODate): [ISODate, ISODate] {
  const mon = startOfWeek(date);
  return [mon, addDays(mon, 6)];
}

export { weekdayISO };
