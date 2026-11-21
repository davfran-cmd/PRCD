/**
 * Repository: all reads/writes of the university + calendar domain. Every multi-row change runs
 * in a transaction. Nothing here deletes user data silently: destructive calls are explicit and
 * return what they removed so the UI can confirm first.
 */
import type { Database } from './database';
import { fromRow, insertRow, selectAll, selectOne, updateRow, type RowSpec } from './rows';
import { addDays, isISODate, localNow, weekdayISO, type ISODate, type HM } from '../domain/dates';
import { newId } from '../domain/ids';
import { DEFAULT_SETTINGS } from '../domain/settings';
import {
  applyChangeSet,
  isProtectedLesson,
  newLesson,
  planCancel,
  planClosure,
  planGeneration,
  planLessonEdit,
  validateRuleShape,
  TimetableError,
  type ChangeScope,
  type LessonEdit,
  type TimetableChangeSet,
} from '../domain/timetable';
import { validateGrade } from '../domain/grades';
import type {
  AttendanceStatus,
  CalendarEvent,
  Course,
  EventException,
  ExamAttempt,
  Lesson,
  Semester,
  SemesterClosure,
  Settings,
  StudyTopic,
  TimetableRule,
} from '../domain/types';

export class ValidationError extends Error {}

const SEM: RowSpec = { bool: ['archived'] };
const COURSE: RowSpec = { bool: ['archived', 'hidden'] };
const LESSON: RowSpec = { bool: ['cancelled', 'isException', 'timeUnknown'] };
const RULE: RowSpec = { bool: ['timeUnknown'] };
const ATTEMPT: RowSpec = { bool: ['isMidterm', 'lode', 'eligible', 'booked'] };
const EVENT: RowSpec = { bool: ['allDay', 'completed'], json: ['recurrence'] };
const EXCEPTION: RowSpec = { bool: ['cancelled'] };

export type Clock = () => Date;

export class Repo {
  constructor(readonly db: Database, private clock: Clock = () => new Date()) {}

  private nowIso(): string {
    return this.clock().toISOString();
  }
  nowLocal(): string {
    return localNow(this.clock());
  }

  // ================================================================== settings

  getSettings(): Settings {
    const stored = this.db.getJson<Partial<Settings>>('settings', 'app') ?? {};
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.getSettings(), ...patch };
    if (next.attendanceThreshold < 0 || next.attendanceThreshold > 100) throw new ValidationError('La soglia deve essere tra 0 e 100');
    if (![30, 31].includes(next.lodeValue)) throw new ValidationError('La lode può valere 30 o 31');
    this.db.setJson('settings', 'app', next);
    return next;
  }

  // ================================================================== semesters

  semesters(includeArchived = true): Semester[] {
    return selectAll<Semester>(this.db, `SELECT * FROM semesters ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY start_date DESC`, [], SEM);
  }

  semester(id: string): Semester | undefined {
    return selectOne<Semester>(this.db, 'SELECT * FROM semesters WHERE id = ?', [id], SEM);
  }

  createSemester(input: { name: string; startDate: ISODate; endDate: ISODate }): Semester {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Dai un nome al semestre');
    if (!isISODate(input.startDate) || !isISODate(input.endDate)) throw new ValidationError('Date non valide');
    if (input.endDate < input.startDate) throw new ValidationError('La fine del semestre precede l’inizio');
    const now = this.nowIso();
    const s: Semester = { id: newId(), name, startDate: input.startDate, endDate: input.endDate, archived: false, createdAt: now, updatedAt: now };
    this.db.transaction(() => {
      insertRow(this.db, 'semesters', s, SEM);
      if (!this.getSettings().currentSemesterId) this.updateSettings({ currentSemesterId: s.id });
    });
    return s;
  }

  updateSemester(id: string, patch: Partial<Pick<Semester, 'name' | 'startDate' | 'endDate' | 'archived'>>): void {
    const cur = this.semester(id);
    if (!cur) throw new ValidationError('Semestre non trovato');
    const merged = { ...cur, ...patch };
    if (merged.endDate < merged.startDate) throw new ValidationError('La fine del semestre precede l’inizio');
    if (!merged.name.trim()) throw new ValidationError('Dai un nome al semestre');
    this.db.transaction(() => {
      updateRow(this.db, 'semesters', 'id', id, { ...patch, updatedAt: this.nowIso() }, SEM);
      // Extending the semester fills the new weeks; shrinking never deletes lessons.
      if (patch.startDate || patch.endDate) this.extendRulesToSemester(id);
    });
  }

  currentSemester(): Semester | undefined {
    const id = this.getSettings().currentSemesterId;
    return (id ? this.semester(id) : undefined) ?? this.semesters(false)[0];
  }

  // ================================================================== courses

  courses(opts: { semesterId?: string; includeArchived?: boolean; includeHidden?: boolean } = {}): Course[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.semesterId) {
      where.push('semester_id = ?');
      params.push(opts.semesterId);
    }
    if (!opts.includeArchived) where.push('archived = 0');
    if (!opts.includeHidden) where.push('hidden = 0');
    return selectAll<Course>(this.db, `SELECT * FROM courses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE`, params, COURSE);
  }

  course(id: string): Course | undefined {
    return selectOne<Course>(this.db, 'SELECT * FROM courses WHERE id = ?', [id], COURSE);
  }

  createCourse(input: {
    semesterId: string;
    name: string;
    color: string;
    cfu: number;
    examKind?: Course['examKind'];
    slots?: Array<{ weekday: number; startTime: HM; endTime: HM }>;
  }): Course {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Dai un nome al corso');
    if (!Number.isInteger(input.cfu) || input.cfu < 0 || input.cfu > 60) throw new ValidationError('I CFU devono essere un intero tra 0 e 60');
    if (!/^#[0-9a-fA-F]{6}$/.test(input.color)) throw new ValidationError('Colore non valido');
    if (!this.semester(input.semesterId)) throw new ValidationError('Semestre non trovato');
    const now = this.nowIso();
    const c: Course = {
      id: newId(),
      semesterId: input.semesterId,
      name,
      color: input.color,
      cfu: input.cfu,
      examKind: input.examKind ?? 'graded',
      archived: false,
      hidden: false,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      insertRow(this.db, 'courses', c, COURSE);
      for (const s of input.slots ?? []) this.addSlot(c.id, s);
    });
    return c;
  }

  updateCourse(id: string, patch: Partial<Pick<Course, 'name' | 'color' | 'cfu' | 'examKind' | 'archived' | 'semesterId'>>): void {
    if (patch.name !== undefined && !patch.name.trim()) throw new ValidationError('Dai un nome al corso');
    if (patch.cfu !== undefined && (!Number.isInteger(patch.cfu) || patch.cfu < 0 || patch.cfu > 60)) throw new ValidationError('I CFU devono essere un intero tra 0 e 60');
    updateRow(this.db, 'courses', 'id', id, { ...patch, name: patch.name?.trim(), updatedAt: this.nowIso() }, COURSE);
  }

  /** What deleting a course would remove — shown in the confirmation dialog. */
  courseDeletionImpact(id: string): { lessons: number; registeredAttendances: number; attempts: number; documents: number } {
    const c = (sql: string) => Number(this.db.scalar(sql, [id]) ?? 0);
    return {
      lessons: c('SELECT COUNT(*) FROM lessons WHERE course_id = ?'),
      registeredAttendances: c("SELECT COUNT(*) FROM lessons WHERE course_id = ? AND attendance <> 'to_confirm'"),
      attempts: c('SELECT COUNT(*) FROM exam_attempts WHERE course_id = ?'),
      documents: c('SELECT COUNT(*) FROM documents WHERE course_id = ?'),
    };
  }

  /**
   * Deletes lessons, slots and study topics of a course. The exam record and linked documents stay:
   * if the course has exam attempts it is kept hidden so the libretto stays intact.
   */
  deleteCourse(id: string): { keptForLibretto: boolean } {
    const impact = this.courseDeletionImpact(id);
    return this.db.transaction(() => {
      this.db.run('DELETE FROM lessons WHERE course_id = ?', [id]);
      this.db.run('DELETE FROM timetable_rules WHERE course_id = ?', [id]);
      this.db.run('DELETE FROM study_topics WHERE course_id = ?', [id]);
      this.db.run('UPDATE calendar_events SET course_id = NULL WHERE course_id = ?', [id]);
      this.db.run('UPDATE documents SET course_id = NULL WHERE course_id = ?', [id]);
      this.db.run("DELETE FROM sync_map WHERE local_kind = 'lesson' AND local_id NOT IN (SELECT id FROM lessons)");
      if (impact.attempts > 0) {
        this.db.run('UPDATE courses SET hidden = 1, archived = 1, updated_at = ? WHERE id = ?', [this.nowIso(), id]);
        return { keptForLibretto: true };
      }
      this.db.run('DELETE FROM courses WHERE id = ?', [id]);
      return { keptForLibretto: false };
    });
  }

  // ================================================================== timetable rules

  rules(courseId?: string): TimetableRule[] {
    return selectAll<TimetableRule>(this.db, `SELECT * FROM timetable_rules ${courseId ? 'WHERE course_id = ?' : ''} ORDER BY weekday, start_time, valid_from`, courseId ? [courseId] : [], RULE);
  }

  rule(id: string): TimetableRule | undefined {
    return selectOne<TimetableRule>(this.db, 'SELECT * FROM timetable_rules WHERE id = ?', [id], RULE);
  }

  /** Every rule created from the same original slot (splits keep the `slotId`). */
  lineage(slotId: string): TimetableRule[] {
    return selectAll<TimetableRule>(this.db, 'SELECT * FROM timetable_rules WHERE slot_id = ? ORDER BY valid_from', [slotId], RULE);
  }

  /** Rules currently producing slots: non-empty validity that has not ended before `date`. */
  currentRules(courseId: string, date: ISODate): TimetableRule[] {
    return this.rules(courseId).filter((r) => r.validTo >= r.validFrom && r.validTo >= date);
  }

  /** Active rules (not superseded) of a course at `date`. */
  activeRules(courseId: string, date: ISODate): TimetableRule[] {
    return this.rules(courseId).filter((r) => r.validFrom <= date && r.validTo >= date);
  }

  closures(semesterId?: string): SemesterClosure[] {
    return selectAll<SemesterClosure>(this.db, 'SELECT * FROM semester_closures ' + (semesterId ? 'WHERE semester_id IS NULL OR semester_id = ?' : ''), semesterId ? [semesterId] : []);
  }

  /** Create a weekly slot for the whole semester and materialise one lesson per occurrence. */
  addSlot(courseId: string, slot: { weekday: number; startTime: HM; endTime: HM }): TimetableRule {
    const course = this.course(courseId);
    if (!course) throw new ValidationError('Corso non trovato');
    const sem = this.semester(course.semesterId);
    if (!sem) throw new ValidationError('Semestre non trovato');
    validateRuleShape(slot.weekday, slot.startTime, slot.endTime, sem.startDate, sem.endDate);
    const now = this.nowIso();
    const ruleId = newId();
    const rule: TimetableRule = {
      id: ruleId,
      slotId: ruleId,
      courseId,
      weekday: slot.weekday,
      startTime: slot.startTime,
      endTime: slot.endTime,
      validFrom: sem.startDate,
      validTo: sem.endDate,
      createdAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      insertRow(this.db, 'timetable_rules', rule, RULE);
      this.generateForRule(rule, sem.id);
    });
    return rule;
  }

  /**
   * Day-only weekly slot from `fromDate` to the end of the semester: lessons are all-day items without a
   * time (used to continue courses imported from Procedo, which never recorded times).
   */
  addDayOnlySlot(courseId: string, weekday: number, fromDate: ISODate, time?: { startTime: HM; endTime: HM }): TimetableRule | null {
    const course = this.course(courseId);
    if (!course) throw new ValidationError('Corso non trovato');
    const sem = this.semester(course.semesterId);
    if (!sem) throw new ValidationError('Semestre non trovato');
    const validFrom = fromDate > sem.startDate ? fromDate : sem.startDate;
    if (validFrom > sem.endDate || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
    const now = this.nowIso();
    const id = newId();
    if (time) validateRuleShape(weekday, time.startTime, time.endTime, validFrom, sem.endDate);
    const rule: TimetableRule = { id, slotId: id, courseId, weekday, startTime: time?.startTime ?? '00:00', endTime: time?.endTime ?? '23:59', validFrom, validTo: sem.endDate, timeUnknown: !time, createdAt: now, updatedAt: now };
    this.db.transaction(() => {
      insertRow(this.db, 'timetable_rules', rule, RULE);
      this.generateForRule(rule, sem.id);
    });
    return rule;
  }

  private generateForRule(rule: TimetableRule, semesterId: string | null): number {
    const existing = this.lessonsOfRule(rule.id);
    const created = planGeneration(rule, { existing, closures: this.closures(semesterId ?? undefined), semesterId, nowIso: this.nowIso() });
    for (const l of created) insertRow(this.db, 'lessons', l, LESSON);
    return created.length;
  }

  private extendRulesToSemester(semesterId: string): void {
    const sem = this.semester(semesterId);
    if (!sem) return;
    for (const c of this.courses({ semesterId, includeArchived: true, includeHidden: true })) {
      const rules = this.rules(c.id);
      // Only the rules that reached the old boundaries follow the semester.
      const lastEnd = rules.reduce((m, r) => (r.validTo > m ? r.validTo : m), '');
      const firstStart = rules.reduce((m, r) => (m === '' || r.validFrom < m ? r.validFrom : m), '');
      for (const r of rules) {
        const next = { ...r, validFrom: r.validFrom === firstStart ? sem.startDate : r.validFrom, validTo: r.validTo === lastEnd ? sem.endDate : r.validTo };
        if (next.validFrom !== r.validFrom || next.validTo !== r.validTo) {
          updateRow(this.db, 'timetable_rules', 'id', r.id, { validFrom: next.validFrom, validTo: next.validTo, updatedAt: this.nowIso() });
          this.generateForRule(next, sem.id);
        }
      }
    }
  }

  /**
   * Stop a weekly slot from `fromDate` on. Future lessons without attendance are cancelled
   * (kept as rows), past lessons and registered attendance are untouched.
   */
  endSlot(ruleId: string, fromDate: ISODate): { cancelled: number } {
    const rule = this.rule(ruleId);
    if (!rule) throw new ValidationError('Orario non trovato');
    const nowLocal = this.nowLocal();
    return this.db.transaction(() => {
      let cancelled = 0;
      for (const l of this.lessonsOfRule(ruleId)) {
        if (l.date >= fromDate && !l.cancelled && !isProtectedLesson(l, nowLocal)) {
          this.patchLesson(l.id, planCancel(l, true).set);
          cancelled += 1;
        }
      }
      updateRow(this.db, 'timetable_rules', 'id', ruleId, { validTo: addDays(fromDate, -1) < rule.validFrom ? rule.validFrom : addDays(fromDate, -1), updatedAt: this.nowIso() });
      return { cancelled };
    });
  }

  // ================================================================== lessons

  lesson(id: string): Lesson | undefined {
    return selectOne<Lesson>(this.db, 'SELECT * FROM lessons WHERE id = ?', [id], LESSON);
  }

  lessonsOfRule(ruleId: string): Lesson[] {
    return selectAll<Lesson>(this.db, 'SELECT * FROM lessons WHERE rule_id = ? ORDER BY date, start_time', [ruleId], LESSON);
  }

  lessonsForCourse(courseId: string): Lesson[] {
    return selectAll<Lesson>(this.db, 'SELECT * FROM lessons WHERE course_id = ? ORDER BY date, start_time', [courseId], LESSON);
  }

  lessonsInRange(from: ISODate, to: ISODate, courseIds?: string[]): Lesson[] {
    const rows = selectAll<Lesson>(this.db, 'SELECT * FROM lessons WHERE date >= ? AND date <= ? ORDER BY date, start_time', [from, to], LESSON);
    return courseIds ? rows.filter((l) => courseIds.includes(l.courseId)) : rows;
  }

  lessonsForSemester(semesterId: string): Lesson[] {
    return selectAll<Lesson>(this.db, 'SELECT l.* FROM lessons l JOIN courses c ON c.id = l.course_id WHERE c.semester_id = ? ORDER BY l.date, l.start_time', [semesterId], LESSON);
  }

  allLessons(): Lesson[] {
    return selectAll<Lesson>(this.db, 'SELECT * FROM lessons ORDER BY date, start_time', [], LESSON);
  }

  /**
   * Gives a time to a day-only slot and to its lessons that still have no time (identity and attendance
   * unchanged), and to the course's lessons without a slot (imported from Procedo) on the same weekday.
   */
  setDayTime(courseId: string, weekday: number, startTime: HM, endTime: HM): number {
    validateRuleShape(weekday, startTime, endTime, '2000-01-01', '2000-01-01');
    let n = 0;
    this.db.transaction(() => {
      for (const r of this.rules(courseId)) {
        if (r.weekday !== weekday || !r.timeUnknown) continue;
        updateRow(this.db, 'timetable_rules', 'id', r.id, { startTime, endTime, timeUnknown: false, updatedAt: this.nowIso() }, RULE);
      }
      for (const l of this.lessonsForCourse(courseId)) {
        if (!l.timeUnknown || weekdayISO(l.date) !== weekday) continue;
        const rule = l.ruleId ? this.rule(l.ruleId) : null;
        if (l.ruleId && (!rule || rule.weekday !== weekday)) continue;
        this.patchLesson(l.id, { startTime, endTime, timeUnknown: false });
        n += 1;
      }
    });
    return n;
  }

  private patchLesson(id: string, set: object): void {
    updateRow(this.db, 'lessons', 'id', id, { ...set, updatedAt: this.nowIso() }, LESSON);
  }

  /** Register attendance. Only the status changes — never date, time or identity. */
  setAttendance(lessonId: string, status: AttendanceStatus): void {
    const l = this.lesson(lessonId);
    if (!l) throw new ValidationError('Lezione non trovata');
    if (l.attendance === status) return;
    updateRow(this.db, 'lessons', 'id', lessonId, { attendance: status, attendanceAt: this.nowIso(), updatedAt: this.nowIso() }, LESSON);
  }

  setAttendanceBulk(lessonIds: string[], status: AttendanceStatus): void {
    this.db.transaction(() => lessonIds.forEach((id) => this.setAttendance(id, status)));
  }

  updateLessonText(lessonId: string, patch: { topic?: string; note?: string }): void {
    this.patchLesson(lessonId, patch);
  }

  cancelLesson(lessonId: string, cancelled: boolean, reason: 'cancelled' | 'holiday' = 'cancelled'): void {
    const l = this.lesson(lessonId);
    if (!l) throw new ValidationError('Lezione non trovata');
    this.patchLesson(lessonId, planCancel(l, cancelled, reason).set);
  }

  addExtraLesson(courseId: string, input: { date: ISODate; startTime: HM; endTime: HM; topic?: string }): Lesson {
    if (!this.course(courseId)) throw new ValidationError('Corso non trovato');
    validateRuleShape(1, input.startTime, input.endTime, input.date, input.date);
    if (!isISODate(input.date)) throw new ValidationError('Data non valida');
    const l = newLesson({ courseId, ruleId: null, originalDate: null, date: input.date, startTime: input.startTime, endTime: input.endTime, kind: 'extra', topic: input.topic }, this.nowIso());
    insertRow(this.db, 'lessons', l, LESSON);
    return l;
  }

  /** Dry-run of a scoped edit: nothing is written. */
  previewLessonEdit(lessonId: string, scope: ChangeScope, edit: LessonEdit): TimetableChangeSet {
    const lesson = this.lesson(lessonId);
    if (!lesson) throw new ValidationError('Lezione non trovata');
    const rule = lesson.ruleId ? this.rule(lesson.ruleId) ?? null : null;
    const lineage = rule ? this.lineage(rule.slotId) : [];
    const ruleLessons = rule ? lineage.flatMap((r) => this.lessonsOfRule(r.id)) : [lesson];
    return planLessonEdit({
      scope,
      lesson,
      rule,
      lineage,
      ruleLessons,
      edit,
      nowLocal: this.nowLocal(),
      nowIso: this.nowIso(),
    });
  }

  /**
   * Apply a scoped edit atomically. Attendance of every lesson is carried over untouched:
   * the change set contains no attendance fields (asserted by tests).
   */
  editLesson(lessonId: string, scope: ChangeScope, edit: LessonEdit, opts: { confirmedReplace?: boolean } = {}): TimetableChangeSet {
    const cs = this.previewLessonEdit(lessonId, scope, edit);
    if (cs.needsConfirmation && !opts.confirmedReplace) {
      throw new ValidationError('Questa modifica sostituisce spostamenti singoli già previsti: serve una conferma.');
    }
    this.db.transaction(() => {
      for (const p of cs.rulesToUpdate) updateRow(this.db, 'timetable_rules', 'id', p.id, { ...p.set, updatedAt: this.nowIso() });
      for (const r of cs.rulesToInsert) insertRow(this.db, 'timetable_rules', r, RULE);
      // Any explicit date/time edit gives the lesson a real time.
      for (const p of cs.lessonsToUpdate) this.patchLesson(p.id, { ...p.set, timeUnknown: false });
      for (const l of cs.lessonsToInsert) insertRow(this.db, 'lessons', l, LESSON);
      // Housekeeping: a superseded rule with an empty validity and no lesson left is just an artefact.
      this.db.run('DELETE FROM timetable_rules WHERE valid_to < valid_from AND id NOT IN (SELECT rule_id FROM lessons WHERE rule_id IS NOT NULL)');
    });
    return cs;
  }

  /** Mark a date range as holiday/suspension: unprotected lessons are cancelled (kept as rows). */
  addClosure(input: { startDate: ISODate; endDate: ISODate; label: string; semesterId: string | null }): SemesterClosure {
    if (input.endDate < input.startDate) throw new ValidationError('Il periodo non è valido');
    const closure: SemesterClosure = { id: newId(), semesterId: input.semesterId, startDate: input.startDate, endDate: input.endDate, label: input.label.trim() || 'Sospensione' };
    this.db.transaction(() => {
      insertRow(this.db, 'semester_closures', closure);
      const lessons = input.semesterId ? this.lessonsForSemester(input.semesterId) : this.allLessons();
      for (const p of planClosure(lessons, input.startDate, input.endDate, this.nowLocal())) this.patchLesson(p.id, p.set);
    });
    return closure;
  }

  /** In-memory preview of what a timetable looks like after a change set (used by tests). */
  static simulate(rules: TimetableRule[], lessons: Lesson[], cs: TimetableChangeSet, nowIso: string) {
    return applyChangeSet(rules, lessons, cs, nowIso);
  }

  // ================================================================== exams

  attempts(courseId?: string): ExamAttempt[] {
    return selectAll<ExamAttempt>(this.db, `SELECT * FROM exam_attempts ${courseId ? 'WHERE course_id = ?' : ''} ORDER BY COALESCE(date, '9999'), created_at`, courseId ? [courseId] : [], ATTEMPT);
  }

  attempt(id: string): ExamAttempt | undefined {
    return selectOne<ExamAttempt>(this.db, 'SELECT * FROM exam_attempts WHERE id = ?', [id], ATTEMPT);
  }

  private validateAttempt(a: Pick<ExamAttempt, 'outcome' | 'grade' | 'lode' | 'eligible' | 'isMidterm'>, courseKind: Course['examKind']): void {
    if (a.outcome === 'passed' || a.outcome === 'rejected') {
      if (courseKind === 'eligibility' && !a.isMidterm) {
        if (a.outcome === 'passed' && a.grade !== null) throw new ValidationError('Un’idoneità non ha voto');
      } else {
        const err = validateGrade(a.grade, a.lode);
        if (err) throw new ValidationError(err);
      }
    } else if (a.outcome === 'failed') {
      if (a.grade !== null && (a.grade < 0 || a.grade > 17)) throw new ValidationError('Un esame non superato ha un voto sotto il 18 (o nessun voto)');
    }
    if (a.outcome === 'planned' && (a.grade !== null || a.lode)) throw new ValidationError('Un esame in programma non ha ancora un voto');
  }

  saveAttempt(input: Partial<ExamAttempt> & { courseId: string; outcome: ExamAttempt['outcome'] }): ExamAttempt {
    const course = this.course(input.courseId);
    if (!course) throw new ValidationError('Corso non trovato');
    const base: ExamAttempt = {
      id: input.id ?? newId(),
      courseId: input.courseId,
      date: input.date ?? null,
      time: input.time ?? null,
      component: input.component ?? 'written',
      isMidterm: input.isMidterm ?? false,
      outcome: input.outcome,
      grade: input.grade ?? null,
      lode: input.lode ?? false,
      eligible: input.eligible ?? course.examKind === 'eligibility',
      booked: input.booked ?? false,
      label: input.label ?? '',
      note: input.note ?? '',
      createdAt: input.createdAt ?? this.nowIso(),
      updatedAt: this.nowIso(),
    };
    if (base.date && !isISODate(base.date)) throw new ValidationError('Data non valida');
    this.validateAttempt(base, course.examKind);
    // At most one accepted (passed, non-midterm) final attempt per course.
    if (base.outcome === 'passed' && !base.isMidterm) {
      const other = this.attempts(base.courseId).find((a) => a.id !== base.id && a.outcome === 'passed' && !a.isMidterm);
      if (other) throw new ValidationError('Questo esame risulta già superato: modifica o elimina il tentativo precedente');
    }
    const exists = this.attempt(base.id);
    if (exists) {
      const { id: _id, createdAt: _c, ...rest } = base;
      updateRow(this.db, 'exam_attempts', 'id', base.id, rest, ATTEMPT);
    } else insertRow(this.db, 'exam_attempts', base, ATTEMPT);
    return base;
  }

  deleteAttempt(id: string): void {
    this.db.run('DELETE FROM exam_attempts WHERE id = ?', [id]);
  }

  // ================================================================== study topics

  topics(courseId: string): StudyTopic[] {
    return selectAll<StudyTopic>(this.db, 'SELECT * FROM study_topics WHERE course_id = ? ORDER BY position', [courseId]);
  }

  addTopic(courseId: string, title: string): StudyTopic {
    if (!title.trim()) throw new ValidationError('Scrivi il nome dell’argomento');
    const pos = Number(this.db.scalar('SELECT COALESCE(MAX(position), -1) + 1 FROM study_topics WHERE course_id = ?', [courseId]) ?? 0);
    const t: StudyTopic = { id: newId(), courseId, title: title.trim(), progress: 0, position: pos };
    insertRow(this.db, 'study_topics', t);
    return t;
  }

  setTopicProgress(id: string, progress: number): void {
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new ValidationError('Il progresso va da 0 a 100');
    this.db.run('UPDATE study_topics SET progress = ? WHERE id = ?', [progress, id]);
  }

  deleteTopic(id: string): void {
    this.db.run('DELETE FROM study_topics WHERE id = ?', [id]);
  }

  // ================================================================== personal calendar events

  events(): CalendarEvent[] {
    return selectAll<CalendarEvent>(this.db, 'SELECT * FROM calendar_events ORDER BY starts_at', [], EVENT).map(mapEvent);
  }

  /** Events that may have an occurrence in the range (recurring masters included). */
  eventsMaybeIn(from: ISODate, to: ISODate): CalendarEvent[] {
    return selectAll<CalendarEvent>(
      this.db,
      `SELECT * FROM calendar_events WHERE (recurrence IS NULL AND substr(starts_at,1,10) <= ? AND substr(ends_at,1,10) >= ?) OR (recurrence IS NOT NULL AND substr(starts_at,1,10) <= ?)`,
      [to, from, to],
      EVENT,
    ).map(mapEvent);
  }

  event(id: string): CalendarEvent | undefined {
    const e = selectOne<CalendarEvent>(this.db, 'SELECT * FROM calendar_events WHERE id = ?', [id], EVENT);
    return e ? mapEvent(e) : undefined;
  }

  eventExceptions(eventId?: string): EventException[] {
    return selectAll<EventException>(this.db, `SELECT * FROM event_exceptions ${eventId ? 'WHERE event_id = ?' : ''}`, eventId ? [eventId] : [], EXCEPTION);
  }

  private validateEvent(e: CalendarEvent) {
    if (!e.title.trim()) throw new ValidationError('Scrivi un titolo');
    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    if (!re.test(e.start) || !re.test(e.end)) throw new ValidationError('Data o ora non valida');
    if (!isISODate(e.start.slice(0, 10)) || !isISODate(e.end.slice(0, 10))) throw new ValidationError('Data non valida');
    if (e.end < e.start) throw new ValidationError('La fine precede l’inizio');
    if (e.recurrence && (e.recurrence.interval < 1 || !Number.isInteger(e.recurrence.interval))) throw new ValidationError('Ripetizione non valida');
    if (e.recurrence?.until && e.recurrence.until < e.start.slice(0, 10)) throw new ValidationError('La ripetizione finisce prima di iniziare');
  }

  createEvent(input: Partial<CalendarEvent> & Pick<CalendarEvent, 'title' | 'category' | 'start' | 'end'>): CalendarEvent {
    const now = this.nowIso();
    const e: CalendarEvent = {
      id: input.id ?? newId(),
      category: input.category,
      title: input.title.trim(),
      description: input.description ?? '',
      courseId: input.courseId ?? null,
      allDay: input.allDay ?? false,
      start: input.start,
      end: input.end,
      recurrence: input.recurrence ?? null,
      reminderMinutes: input.reminderMinutes ?? null,
      color: input.color ?? null,
      completed: input.completed ?? false,
      appleCalendarId: input.appleCalendarId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.validateEvent(e);
    insertRow(this.db, 'calendar_events', e, EVENT);
    return e;
  }

  updateEvent(id: string, patch: Partial<Omit<CalendarEvent, 'id' | 'createdAt'>>): CalendarEvent {
    const cur = this.event(id);
    if (!cur) throw new ValidationError('Evento non trovato');
    const next = { ...cur, ...patch, title: (patch.title ?? cur.title).trim(), updatedAt: this.nowIso() };
    this.validateEvent(next);
    const { id: _i, createdAt: _c, ...rest } = next;
    updateRow(this.db, 'calendar_events', 'id', id, rest, EVENT);
    return next;
  }

  /** Delete an event and its series (explicit). Sync mapping is removed by the sync layer. */
  deleteEvent(id: string): void {
    this.db.run('DELETE FROM calendar_events WHERE id = ?', [id]);
  }

  /** Cancel or override a single occurrence of a recurring event. */
  setEventException(eventId: string, originalDate: ISODate, ex: { cancelled?: boolean; start?: string | null; end?: string | null; title?: string | null }): EventException {
    const cur = this.db.get<{ id: string }>('SELECT id FROM event_exceptions WHERE event_id = ? AND original_date = ?', [eventId, originalDate]);
    const row: EventException = {
      id: cur?.id ?? newId(),
      eventId,
      originalDate,
      cancelled: ex.cancelled ?? false,
      start: ex.start ?? null,
      end: ex.end ?? null,
      title: ex.title ?? null,
    };
    insertRow(this.db, 'event_exceptions', row, EXCEPTION, true);
    return row;
  }

  /** "This and following": end the old series the day before and start a new one with the changes. */
  splitEventSeries(eventId: string, fromDate: ISODate, changes: Partial<Omit<CalendarEvent, 'id' | 'createdAt'>>): CalendarEvent {
    const cur = this.event(eventId);
    if (!cur || !cur.recurrence) throw new ValidationError('Evento ricorrente non trovato');
    return this.db.transaction(() => {
      this.updateEvent(eventId, { recurrence: { ...cur.recurrence!, until: addDays(fromDate, -1), count: null } });
      const spanStart = cur.start.slice(11);
      const spanEnd = cur.end.slice(11);
      const dayShift = Math.round((Date.parse(cur.end.slice(0, 10)) - Date.parse(cur.start.slice(0, 10))) / 86_400_000);
      const startIso = `${fromDate}T${spanStart}`;
      const endIso = `${addDays(fromDate, dayShift)}T${spanEnd}`;
      return this.createEvent({ ...cur, id: undefined, start: startIso, end: endIso, appleCalendarId: cur.appleCalendarId, ...changes, recurrence: changes.recurrence === undefined ? { ...cur.recurrence!, until: cur.recurrence!.until ?? null } : changes.recurrence });
    });
  }
}

function mapEvent(e: CalendarEvent): CalendarEvent {
  return { ...e, recurrence: e.recurrence ?? null };
}

export { fromRow, TimetableError };
