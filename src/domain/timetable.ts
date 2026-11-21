/**
 * Recurring timetable → individual lesson occurrences.
 *
 * Invariants (enforced here, tested in tests/timetable.test.ts):
 *  - Every occurrence is a row with its own permanent id; generation is idempotent and keyed on
 *    (ruleId, originalDate), so regenerating never duplicates or recreates a lesson.
 *  - Attendance hangs on the lesson id. No operation in this module touches `attendance`.
 *  - Lessons are never deleted: cancelling sets a flag.
 *  - A superseded rule is end-dated (validTo), not rewritten: the original pattern survives.
 *    Rules created by a split share the `slotId` of the original ("slot lineage").
 *  - Bulk edits ("this and following" / "whole timetable") never touch past lessons or lessons with
 *    registered attendance; "whole timetable" is the only scope that replaces single exceptions.
 */
import {
  addDays,
  eachDay,
  hmToMin,
  isHM,
  localToDate,
  startOfWeek,
  toLocalDateTime,
  weekdayISO,
  type HM,
  type ISODate,
  type LocalDateTime,
} from './dates';
import { newId } from './ids';
import type { Lesson, SemesterClosure, TimetableRule } from './types';

export class TimetableError extends Error {}

export function validateRuleShape(weekday: number, startTime: HM, endTime: HM, validFrom: ISODate, validTo: ISODate): void {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new TimetableError('Giorno della settimana non valido');
  if (!isHM(startTime) || !isHM(endTime)) throw new TimetableError('Orario non valido');
  if (hmToMin(endTime) <= hmToMin(startTime)) throw new TimetableError("L'ora di fine deve seguire quella di inizio");
  if (validTo < validFrom) throw new TimetableError('Il periodo di validità non è valido');
}

export function lessonStart(l: Pick<Lesson, 'date' | 'startTime'>): LocalDateTime {
  return toLocalDateTime(l.date, l.startTime);
}

export function lessonEnd(l: Pick<Lesson, 'date' | 'endTime'>): LocalDateTime {
  return toLocalDateTime(l.date, l.endTime);
}

/** A lesson that bulk operations must leave untouched: already started, or with attendance registered. */
export function isProtectedLesson(l: Lesson, nowLocal: LocalDateTime): boolean {
  return l.attendance !== 'to_confirm' || lessonStart(l) < nowLocal;
}

export function closureFor(date: ISODate, closures: SemesterClosure[], semesterId: string | null): SemesterClosure | undefined {
  return closures.find((c) => (c.semesterId === null || c.semesterId === semesterId) && date >= c.startDate && date <= c.endDate);
}

export interface GenerationContext {
  /** All existing lessons of this rule (any state). */
  existing: Lesson[];
  closures: SemesterClosure[];
  semesterId: string | null;
  nowIso: string;
  makeId?: () => string;
  /** Slot dates that must not be generated. */
  skipDates?: Set<ISODate>;
}

export function newLesson(
  base: {
    courseId: string;
    ruleId: string | null;
    originalDate: ISODate | null;
    date: ISODate;
    startTime: HM;
    endTime: HM;
    kind?: Lesson['kind'];
    topic?: string;
  },
  nowIso: string,
  makeId: () => string = newId,
): Lesson {
  return {
    id: makeId(),
    courseId: base.courseId,
    ruleId: base.ruleId,
    originalDate: base.originalDate,
    date: base.date,
    startTime: base.startTime,
    endTime: base.endTime,
    kind: base.kind ?? 'regular',
    cancelled: false,
    cancelReason: null,
    isException: false,
    timeUnknown: false,
    topic: base.topic ?? '',
    attendance: 'to_confirm',
    attendanceAt: null,
    note: '',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** Dates on which a rule produces a slot. */
export function ruleDates(rule: Pick<TimetableRule, 'weekday' | 'validFrom' | 'validTo'>): ISODate[] {
  if (rule.validTo < rule.validFrom) return [];
  return eachDay(rule.validFrom, rule.validTo).filter((d) => weekdayISO(d) === rule.weekday);
}

/**
 * Lessons that must be created for `rule` so that every slot date has an occurrence.
 * Idempotent: dates that already have a lesson (by originalDate) are skipped.
 * Slot dates inside a closure (holiday/suspension) are created as cancelled with reason "holiday".
 */
export function planGeneration(rule: TimetableRule, ctx: GenerationContext): Lesson[] {
  if (rule.validTo < rule.validFrom) return [];
  validateRuleShape(rule.weekday, rule.startTime, rule.endTime, rule.validFrom, rule.validTo);
  const have = new Set(ctx.existing.filter((l) => l.ruleId === rule.id && l.originalDate).map((l) => l.originalDate as ISODate));
  const out: Lesson[] = [];
  for (const date of ruleDates(rule)) {
    if (have.has(date) || ctx.skipDates?.has(date)) continue;
    const lesson = newLesson({ courseId: rule.courseId, ruleId: rule.id, originalDate: date, date, startTime: rule.startTime, endTime: rule.endTime }, ctx.nowIso, ctx.makeId);
    if (rule.timeUnknown) lesson.timeUnknown = true;
    if (closureFor(date, ctx.closures, ctx.semesterId)) {
      lesson.cancelled = true;
      lesson.cancelReason = 'holiday';
    }
    out.push(lesson);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Scoped edits
// ---------------------------------------------------------------------------------------------

export type ChangeScope = 'one' | 'following' | 'all';

export interface LessonEdit {
  date: ISODate;
  startTime: HM;
  endTime: HM;
}

export type PreviewState =
  | 'target' // the lesson the user is editing
  | 'changed' // will move to the new slot
  | 'unchanged' // before the change point, stays as is
  | 'protected' // past or with registered attendance: never touched
  | 'exception_kept' // single exception that survives a "following" change
  | 'exception_replaced'; // single exception replaced by "whole timetable" (needs confirmation)

export interface LessonPatch {
  id: string;
  set: Partial<Pick<Lesson, 'date' | 'startTime' | 'endTime' | 'ruleId' | 'originalDate' | 'isException' | 'cancelled' | 'cancelReason'>>;
}

export interface RulePatch {
  id: string;
  set: Partial<Pick<TimetableRule, 'validTo' | 'validFrom' | 'weekday' | 'startTime' | 'endTime'>>;
}

export interface TimetableChangeSet {
  scope: ChangeScope;
  rulesToUpdate: RulePatch[];
  rulesToInsert: TimetableRule[];
  lessonsToUpdate: LessonPatch[];
  lessonsToInsert: Lesson[];
  preview: Array<{ lessonId: string; date: ISODate; state: PreviewState }>;
  counts: { changed: number; protectedCount: number; exceptionsKept: number; exceptionsReplaced: number };
  /** True when the operation overwrites single-lesson exceptions: the UI must ask for confirmation. */
  needsConfirmation: boolean;
}

export interface PlanEditInput {
  scope: ChangeScope;
  lesson: Lesson;
  /** Every lesson of the target's slot lineage (all rules sharing its `slotId`), including `lesson`. */
  ruleLessons: Lesson[];
  /** The rule `lesson` belongs to; null for extra lessons. */
  rule: TimetableRule | null;
  /** Every rule of the slot lineage (including `rule`). Defaults to `[rule]`. */
  lineage?: TimetableRule[];
  edit: LessonEdit;
  nowLocal: LocalDateTime;
  nowIso: string;
  makeId?: () => string;
}

function sameSlotAsRule(rule: TimetableRule, lesson: Lesson, edit: LessonEdit): boolean {
  return lesson.originalDate === edit.date && rule.startTime === edit.startTime && rule.endTime === edit.endTime;
}

/** Shift a slot date to `weekday` inside the same ISO week. */
export function shiftToWeekday(date: ISODate, weekday: number): ISODate {
  return addDays(startOfWeek(date), weekday - 1);
}

/** A single exception: moved lesson or lesson cancelled by hand (holiday closures are not exceptions). */
function isSingleException(l: Lesson): boolean {
  return l.isException || (l.cancelled && l.cancelReason !== 'holiday');
}

export function planLessonEdit(input: PlanEditInput): TimetableChangeSet {
  const { scope, lesson, rule, edit, nowLocal } = input;
  if (!isHM(edit.startTime) || !isHM(edit.endTime)) throw new TimetableError('Orario non valido');
  if (hmToMin(edit.endTime) <= hmToMin(edit.startTime)) throw new TimetableError("L'ora di fine deve seguire quella di inizio");
  localToDate(`${edit.date}T00:00`); // throws on impossible dates

  const base: TimetableChangeSet = {
    scope,
    rulesToUpdate: [],
    rulesToInsert: [],
    lessonsToUpdate: [],
    lessonsToInsert: [],
    preview: [],
    counts: { changed: 0, protectedCount: 0, exceptionsKept: 0, exceptionsReplaced: 0 },
    needsConfirmation: false,
  };

  // --- single occurrence (also the only possibility for extra lessons) -----------------------
  if (scope === 'one' || !rule || lesson.kind === 'extra') {
    const backToSlot = rule && lesson.kind === 'regular' ? sameSlotAsRule(rule, lesson, edit) : false;
    base.lessonsToUpdate.push({
      id: lesson.id,
      set: { date: edit.date, startTime: edit.startTime, endTime: edit.endTime, isException: lesson.kind === 'extra' ? false : !backToSlot },
    });
    base.counts.changed = 1;
    base.preview = input.ruleLessons
      .map((l) => ({ lessonId: l.id, date: l.date, state: (l.id === lesson.id ? 'target' : 'unchanged') as PreviewState }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!base.preview.some((p) => p.lessonId === lesson.id)) base.preview.push({ lessonId: lesson.id, date: lesson.date, state: 'target' });
    return base;
  }

  // --- pattern change: this & following / whole timetable ------------------------------------
  const lineage = input.lineage?.length ? input.lineage : [rule];
  const newWeekday = weekdayISO(edit.date);
  const slotDate = lesson.originalDate as ISODate;
  const replaceExceptions = scope === 'all';
  const makeId = input.makeId ?? newId;

  const sorted = input.ruleLessons.filter((l) => l.originalDate).sort((a, b) => (a.originalDate as string).localeCompare(b.originalDate as string));

  // Pivot: the first slot date the new pattern applies to.
  let pivot: ISODate = slotDate;
  if (scope === 'all') {
    // From the first lesson that can still change (not past, no attendance registered).
    const first = sorted.find((l) => !isProtectedLesson(l, nowLocal));
    if (first && (first.originalDate as ISODate) < pivot) pivot = first.originalDate as ISODate;
  }

  const preview: TimetableChangeSet['preview'] = [];
  const lessonPatches: LessonPatch[] = [];
  const counts = { changed: 0, protectedCount: 0, exceptionsKept: 0, exceptionsReplaced: 0 };
  const convertedDates: ISODate[] = [];
  const newRuleId = makeId();

  for (const l of sorted) {
    const od = l.originalDate as ISODate;
    if (od < pivot) {
      preview.push({ lessonId: l.id, date: l.date, state: 'unchanged' });
      continue;
    }
    const isTarget = l.id === lesson.id;
    const exc = isSingleException(l);
    let state: PreviewState;
    let convert = false;
    if (isTarget) {
      state = 'target';
      convert = true;
    } else if (isProtectedLesson(l, nowLocal)) {
      state = 'protected';
      counts.protectedCount += 1;
    } else if (exc && !replaceExceptions) {
      state = 'exception_kept';
      counts.exceptionsKept += 1;
    } else if (exc) {
      state = 'exception_replaced';
      counts.exceptionsReplaced += 1;
      convert = true;
    } else {
      state = 'changed';
      convert = true;
    }
    preview.push({ lessonId: l.id, date: l.date, state });
    if (!convert) continue;
    counts.changed += 1;
    const newSlot = shiftToWeekday(od, newWeekday);
    convertedDates.push(newSlot);
    lessonPatches.push({
      id: l.id,
      set: {
        ruleId: newRuleId,
        originalDate: newSlot,
        date: newSlot,
        startTime: edit.startTime,
        endTime: edit.endTime,
        isException: false,
        // Replacing a hand-made cancellation restores the slot; holiday closures stay cancelled.
        ...(exc && !isTarget && l.cancelReason !== 'holiday' ? { cancelled: false, cancelReason: null } : {}),
      },
    });
  }

  const changeSet: TimetableChangeSet = { ...base, scope, preview, lessonsToUpdate: lessonPatches, counts, needsConfirmation: counts.exceptionsReplaced > 0 };

  // Existing rules: shorten the one that spans the pivot, empty the ones that start after it.
  for (const r of lineage) {
    if (r.validTo < pivot) continue;
    changeSet.rulesToUpdate.push({ id: r.id, set: { validTo: r.validFrom < pivot ? addDays(pivot, -1) : addDays(r.validFrom, -1) } });
  }

  const sortedConverted = [...convertedDates].sort();
  const lineageEnd = lineage.reduce((m, r) => (r.validTo > m ? r.validTo : m), rule.validTo);
  const lastConverted = sortedConverted.at(-1) ?? lineageEnd;
  changeSet.rulesToInsert.push({
    id: newRuleId,
    slotId: rule.slotId,
    courseId: rule.courseId,
    weekday: newWeekday,
    startTime: edit.startTime,
    endTime: edit.endTime,
    timeUnknown: false,
    // May precede `pivot` by < 7 days when the new weekday falls earlier in the same week.
    validFrom: sortedConverted[0] ?? shiftToWeekday(pivot, newWeekday),
    validTo: lastConverted > lineageEnd ? lastConverted : lineageEnd,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  });
  return changeSet;
}

/** Apply a change set to in-memory arrays (used by tests and previews). */
export function applyChangeSet(rules: TimetableRule[], lessons: Lesson[], cs: TimetableChangeSet, nowIso: string): { rules: TimetableRule[]; lessons: Lesson[] } {
  const rulePatch = new Map(cs.rulesToUpdate.map((p) => [p.id, p.set]));
  const lessonPatch = new Map(cs.lessonsToUpdate.map((p) => [p.id, p.set]));
  return {
    rules: [...rules.map((r) => (rulePatch.has(r.id) ? { ...r, ...rulePatch.get(r.id)!, updatedAt: nowIso } : r)), ...cs.rulesToInsert],
    lessons: [...lessons.map((l) => (lessonPatch.has(l.id) ? { ...l, ...lessonPatch.get(l.id)!, updatedAt: nowIso } : l)), ...cs.lessonsToInsert],
  };
}

/** Cancel (or restore) one occurrence. Attendance is untouched. */
export function planCancel(lesson: Lesson, cancelled: boolean, reason: Lesson['cancelReason'] = 'cancelled'): LessonPatch {
  return { id: lesson.id, set: { cancelled, cancelReason: cancelled ? reason ?? 'cancelled' : null } };
}

/** Closures: cancel the (unprotected) lessons falling in the range. Returns patches. */
export function planClosure(lessons: Lesson[], start: ISODate, end: ISODate, nowLocal: LocalDateTime): LessonPatch[] {
  return lessons
    .filter((l) => l.date >= start && l.date <= end && !l.cancelled && l.attendance === 'to_confirm' && lessonStart(l) >= nowLocal)
    .map((l) => ({ id: l.id, set: { cancelled: true, cancelReason: 'holiday' as const } }));
}
