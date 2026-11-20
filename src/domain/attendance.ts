/**
 * Attendance definitions — the single place where "held", "attended", "absences" and
 * "recovery progress" are defined.
 *
 *  - A lesson is *held* when its attendance has been registered as attended, absent or recovered.
 *    "To confirm" lessons are not counted until confirmed (setting `excludeToConfirm`, default on);
 *    with the setting off, past unconfirmed lessons count as held but not attended.
 *  - Cancelled lessons never count (setting `excludeCancelled`, default on).
 *  - attended   = lessons registered "attended" (+ "recovered" when `recoveredCountsAsAttended`).
 *  - percentage = attended / held (null when nothing is held yet).
 *  - absences   = absent + recovered (every missed lesson); openAbsences = absent only.
 *  - recoveryProgress = recovered / absences (null when there are no absences).
 */
import type { LocalDateTime } from './dates';
import { lessonStart } from './timetable';
import type { AttendanceStatus, Lesson, Settings } from './types';

export type AttendanceOptions = Pick<Settings, 'recoveredCountsAsAttended' | 'excludeToConfirm' | 'excludeCancelled'>;

export const DEFAULT_ATTENDANCE_OPTIONS: AttendanceOptions = {
  recoveredCountsAsAttended: false,
  excludeToConfirm: true,
  excludeCancelled: true,
};

export interface AttendanceStats {
  scheduled: number; // lessons considered (not cancelled)
  held: number;
  attended: number;
  absent: number; // open absences
  recovered: number;
  toConfirm: number; // past lessons waiting for a confirmation
  upcoming: number; // not yet held
  absences: number; // absent + recovered
  percentage: number | null; // 0..100
  recoveryProgress: number | null; // 0..1
}

export function computeAttendance(lessons: Lesson[], nowLocal: LocalDateTime, opts: AttendanceOptions = DEFAULT_ATTENDANCE_OPTIONS): AttendanceStats {
  let scheduled = 0;
  let attended = 0;
  let absent = 0;
  let recovered = 0;
  let toConfirm = 0;
  let upcoming = 0;
  let pastUnconfirmedCounted = 0;

  for (const l of lessons) {
    if (l.cancelled && opts.excludeCancelled) continue;
    scheduled += 1;
    switch (l.attendance) {
      case 'attended':
        attended += 1;
        break;
      case 'absent':
        absent += 1;
        break;
      case 'recovered':
        recovered += 1;
        break;
      case 'to_confirm':
        if (lessonStart(l) < nowLocal) {
          toConfirm += 1;
          if (!opts.excludeToConfirm) pastUnconfirmedCounted += 1;
        } else upcoming += 1;
        break;
    }
  }

  const attendedCount = attended + (opts.recoveredCountsAsAttended ? recovered : 0);
  const held = attended + absent + recovered + pastUnconfirmedCounted;
  const absences = absent + recovered;
  return {
    scheduled,
    held,
    attended: attendedCount,
    absent,
    recovered,
    toConfirm,
    upcoming,
    absences,
    percentage: held > 0 ? (attendedCount / held) * 100 : null,
    recoveryProgress: absences > 0 ? recovered / absences : null,
  };
}

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  attended: 'Presente',
  absent: 'Assente',
  recovered: 'Recuperata',
  to_confirm: 'Da confermare',
};

export const ATTENDANCE_ORDER: AttendanceStatus[] = ['attended', 'absent', 'recovered', 'to_confirm'];

export function nextAttendanceStatus(s: AttendanceStatus): AttendanceStatus {
  return ATTENDANCE_ORDER[(ATTENDANCE_ORDER.indexOf(s) + 1) % ATTENDANCE_ORDER.length];
}

/** Lessons whose absence is still open (to recover), most recent first. */
export function lessonsToRecover(lessons: Lesson[]): Lesson[] {
  return lessons
    .filter((l) => l.attendance === 'absent' && !l.cancelled)
    .sort((a, b) => lessonStart(b).localeCompare(lessonStart(a)));
}

/** Past lessons that still wait for a confirmation, oldest first. */
export function lessonsToConfirm(lessons: Lesson[], nowLocal: LocalDateTime): Lesson[] {
  return lessons
    .filter((l) => !l.cancelled && l.attendance === 'to_confirm' && lessonStart(l) < nowLocal)
    .sort((a, b) => lessonStart(a).localeCompare(lessonStart(b)));
}

/** Strip glyph state for the course strip: chronological, last `n` lessons plus upcoming placeholders. */
export type StripGlyph = 'a' | 'x' | 'r' | 't' | 'f';
export function attendanceStrip(lessons: Lesson[], nowLocal: LocalDateTime): StripGlyph[] {
  return [...lessons]
    .filter((l) => !l.cancelled)
    .sort((a, b) => lessonStart(a).localeCompare(lessonStart(b)))
    .map((l): StripGlyph => {
      if (l.attendance === 'attended') return 'a';
      if (l.attendance === 'absent') return 'x';
      if (l.attendance === 'recovered') return 'r';
      return lessonStart(l) < nowLocal ? 't' : 'f';
    });
}
