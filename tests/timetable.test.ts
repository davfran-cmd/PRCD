import { describe, expect, it } from 'vitest';
import { clockAt, makeRepo, seedDesign, SEM } from './helpers';
import { planGeneration, ruleDates, shiftToWeekday, validateRuleShape, TimetableError } from '../src/domain/timetable';
import { weekdayISO } from '../src/domain/dates';
import { ValidationError } from '../src/db/repo';
import { computeAttendance } from '../src/domain/attendance';

describe('timetable generation', () => {
  it('materialises one lesson per slot date with its own permanent id (Thursday slot: 16 lessons)', async () => {
    const { repo, meccanica } = await seedDesign();
    const lessons = repo.lessonsForCourse(meccanica.id);
    const thursdays = lessons.filter((l) => weekdayISO(l.date) === 4);
    expect(thursdays).toHaveLength(16);
    expect(new Set(lessons.map((l) => l.id)).size).toBe(lessons.length);
    expect(thursdays[0].date).toBe('2026-10-01');
    expect(thursdays.at(-1)!.date).toBe('2027-01-14');
    expect(thursdays.every((l) => l.startTime === '14:15' && l.endTime === '16:15' && l.attendance === 'to_confirm' && !l.cancelled)).toBe(true);
    // Tuesday slot: 16 weeks too (Sep 29 .. Jan 12)
    expect(lessons.filter((l) => weekdayISO(l.date) === 2)).toHaveLength(16);
  });

  it('is idempotent: regenerating never duplicates or recreates occurrences', async () => {
    const { repo, meccanica } = await seedDesign();
    const rule = repo.rules(meccanica.id)[0];
    const before = repo.lessonsOfRule(rule.id);
    const again = planGeneration(rule, { existing: before, closures: [], semesterId: null, nowIso: 'x' });
    expect(again).toHaveLength(0);
    expect(repo.lessonsOfRule(rule.id).map((l) => l.id)).toEqual(before.map((l) => l.id));
  });

  it('the database refuses a second occurrence for the same (rule, slot date)', async () => {
    const { repo, db, meccanica } = await seedDesign();
    const l = repo.lessonsForCourse(meccanica.id)[0];
    expect(() =>
      db.run(
        `INSERT INTO lessons(id, course_id, rule_id, original_date, date, start_time, end_time, created_at, updated_at) VALUES('dup', ?, ?, ?, ?, '10:00', '11:00', 'x', 'x')`,
        [l.courseId, l.ruleId, l.originalDate, l.originalDate],
      ),
    ).toThrow();
  });

  it('keeps wall-clock times across daylight-saving changes', async () => {
    const { repo, meccanica } = await seedDesign();
    const around = repo.lessonsForCourse(meccanica.id).filter((l) => l.date >= '2026-10-22' && l.date <= '2026-10-30');
    expect(around.map((l) => `${l.date} ${l.startTime}`)).toEqual(['2026-10-22 14:15', '2026-10-27 08:15', '2026-10-29 14:15']);
  });

  it('marks slot dates inside a closure as cancelled (holiday) at generation time', async () => {
    const { repo, sem } = await makeRepo().then(async (c) => ({ ...c, sem: c.repo.createSemester(SEM) }));
    repo.addClosure({ semesterId: sem.id, startDate: '2026-12-24', endDate: '2027-01-06', label: 'Vacanze di Natale' });
    const c = repo.createCourse({ semesterId: sem.id, name: 'X', color: '#4A4A44', cfu: 6, slots: [{ weekday: 4, startTime: '10:00', endTime: '12:00' }] });
    const ls = repo.lessonsForCourse(c.id);
    expect(ls.filter((l) => l.cancelled).map((l) => l.date)).toEqual(['2026-12-24', '2026-12-31']);
    expect(ls.filter((l) => l.cancelled).every((l) => l.cancelReason === 'holiday')).toBe(true);
  });

  it('validates slot shape', () => {
    expect(() => validateRuleShape(0, '10:00', '11:00', '2026-01-01', '2026-02-01')).toThrow(TimetableError);
    expect(() => validateRuleShape(1, '11:00', '10:00', '2026-01-01', '2026-02-01')).toThrow(/fine/);
    expect(() => validateRuleShape(1, '25:00', '26:00', '2026-01-01', '2026-02-01')).toThrow(/Orario/);
    expect(ruleDates({ weekday: 1, validFrom: '2026-11-02', validTo: '2026-11-01' })).toEqual([]);
  });
});

describe('attendance is bound to the lesson, not to its time', () => {
  it('moving one lesson keeps id, attendance and its timestamp; it becomes an exception', async () => {
    const { repo, meccanica } = await seedDesign();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-19')!;
    repo.setAttendance(l.id, 'absent');
    const before = repo.lesson(l.id)!;
    repo.editLesson(l.id, 'one', { date: '2026-11-20', startTime: '16:30', endTime: '18:30' });
    const after = repo.lesson(l.id)!;
    expect(after.id).toBe(l.id);
    expect(after.attendance).toBe('absent');
    expect(after.attendanceAt).toBe(before.attendanceAt);
    expect(after.date).toBe('2026-11-20');
    expect(after.originalDate).toBe('2026-11-19'); // the slot it came from
    expect(after.isException).toBe(true);
    // rule untouched: the original pattern is preserved
    expect(repo.rules(meccanica.id).find((r) => r.id === l.ruleId)!.startTime).toBe('14:15');
  });

  it('moving a lesson back onto its slot clears the exception flag', async () => {
    const { repo, meccanica } = await seedDesign();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-19')!;
    repo.editLesson(l.id, 'one', { date: '2026-11-20', startTime: '16:30', endTime: '18:30' });
    repo.editLesson(l.id, 'one', { date: '2026-11-19', startTime: '14:15', endTime: '16:15' });
    expect(repo.lesson(l.id)!.isException).toBe(false);
  });

  it('cancelling keeps the row and its attendance, and excludes it from the statistics until restored', async () => {
    const { repo, meccanica } = await seedDesign();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-05')!;
    repo.setAttendance(l.id, 'attended');
    const cfg = repo.getSettings();
    const stats = () => computeAttendance(repo.lessonsForCourse(meccanica.id), repo.nowLocal(), cfg);
    expect(stats().held).toBe(1);
    repo.cancelLesson(l.id, true);
    expect(repo.lesson(l.id)).toBeDefined();
    expect(repo.lesson(l.id)!.attendance).toBe('attended');
    expect(stats().held).toBe(0);
    repo.cancelLesson(l.id, false);
    expect(stats().held).toBe(1);
  });

  it('adds an exceptional lesson without a rule, with independent attendance', async () => {
    const { repo, meccanica } = await seedDesign();
    const extra = repo.addExtraLesson(meccanica.id, { date: '2026-11-28', startTime: '09:00', endTime: '11:00', topic: 'Recupero' });
    expect(extra.kind).toBe('extra');
    expect(extra.ruleId).toBeNull();
    repo.setAttendance(extra.id, 'attended');
    expect(repo.lesson(extra.id)!.attendance).toBe('attended');
  });
});

describe('scoped schedule edits', () => {
  const NEW = { startTime: '16:30', endTime: '18:30' };

  it('"this and following": splits the rule, leaves earlier lessons alone, preserves the original pattern', async () => {
    const { repo, meccanica } = await seedDesign();
    const target = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-19')!;
    const origRule = repo.rule(target.ruleId!)!;
    const cs = repo.editLesson(target.id, 'following', { date: '2026-11-19', ...NEW });
    const ls = repo.lessonsForCourse(meccanica.id).filter((l) => weekdayISO(l.date) === 4);
    expect(ls.filter((l) => l.date < '2026-11-19').every((l) => l.startTime === '14:15')).toBe(true);
    expect(ls.filter((l) => l.date >= '2026-11-19').every((l) => l.startTime === '16:30' && l.endTime === '18:30')).toBe(true);
    expect(ls.filter((l) => l.date >= '2026-11-19')).toHaveLength(9); // 19, 26 Nov; 3,10,17,24,31 Dec; 7,14 Jan
    // pattern preserved: the old rule is end-dated, a new one starts at the pivot
    const oldRule = repo.rule(origRule.id)!;
    expect(oldRule.startTime).toBe('14:15');
    expect(oldRule.validTo).toBe('2026-11-18');
    expect(cs.rulesToInsert).toHaveLength(1);
    const newRule = repo.rule(cs.rulesToInsert[0].id)!;
    expect(newRule.startTime).toBe('16:30');
    expect(newRule.validFrom).toBe('2026-11-19');
    // lessons keep their identity
    expect(repo.lesson(target.id)!.ruleId).toBe(newRule.id);
    expect(new Set(repo.lessonsForCourse(meccanica.id).map((l) => l.id)).size).toBe(repo.lessonsForCourse(meccanica.id).length);
  });

  it('bulk edits never touch lessons with registered attendance or lessons already in the past', async () => {
    const { repo, meccanica } = await seedDesign(clockAt(2026, 11, 16, 9, 0));
    const ls = () => repo.lessonsForCourse(meccanica.id).filter((l) => weekdayISO(l.date) === 4);
    const past = ls().find((l) => l.date === '2026-11-12')!;
    const futureRegistered = ls().find((l) => l.date === '2026-12-03')!;
    repo.setAttendance(past.id, 'attended');
    repo.setAttendance(futureRegistered.id, 'absent');
    const target = ls().find((l) => l.date === '2026-11-19')!;
    repo.editLesson(target.id, 'all', { date: '2026-11-19', ...NEW }, { confirmedReplace: true });
    const after = ls();
    expect(after.find((l) => l.id === past.id)).toMatchObject({ date: '2026-11-12', startTime: '14:15', attendance: 'attended' });
    expect(after.find((l) => l.id === futureRegistered.id)).toMatchObject({ date: '2026-12-03', startTime: '14:15', attendance: 'absent' });
    expect(after.filter((l) => l.date < '2026-11-16').every((l) => l.startTime === '14:15')).toBe(true); // all past stay
    expect(after.find((l) => l.date === '2026-11-26')!.startTime).toBe('16:30');
  });

  it('"this and following" keeps single exceptions that were already planned; "whole timetable" replaces them only after confirmation', async () => {
    const { repo, meccanica } = await seedDesign(clockAt(2026, 11, 16, 9, 0));
    const ls = () => repo.lessonsForCourse(meccanica.id).filter((l) => l.kind === 'regular');
    const moved = ls().find((l) => l.originalDate === '2026-12-03')!;
    repo.editLesson(moved.id, 'one', { date: '2026-12-04', startTime: '09:00', endTime: '11:00' });
    const t = ls().find((l) => l.originalDate === '2026-11-19')!;

    repo.editLesson(t.id, 'following', { date: '2026-11-19', ...NEW });
    expect(repo.lesson(moved.id)).toMatchObject({ date: '2026-12-04', startTime: '09:00', isException: true }); // survived

    const preview = repo.previewLessonEdit(t.id, 'all', { date: '2026-11-19', startTime: '17:00', endTime: '19:00' });
    expect(preview.counts.exceptionsReplaced).toBe(1);
    expect(preview.needsConfirmation).toBe(true);
    expect(() => repo.editLesson(t.id, 'all', { date: '2026-11-19', startTime: '17:00', endTime: '19:00' })).toThrow(ValidationError);
    expect(repo.lesson(moved.id)!.startTime).toBe('09:00'); // nothing happened
    repo.editLesson(t.id, 'all', { date: '2026-11-19', startTime: '17:00', endTime: '19:00' }, { confirmedReplace: true });
    expect(repo.lesson(moved.id)).toMatchObject({ startTime: '17:00', endTime: '19:00', isException: false });
  });

  it('changing the weekday of the pattern shifts every following lesson inside its own week', async () => {
    const { repo, meccanica } = await seedDesign();
    const t = repo.lessonsForCourse(meccanica.id).find((l) => l.originalDate === '2026-11-19')!;
    repo.editLesson(t.id, 'following', { date: '2026-11-20', ...NEW }); // Thursday → Friday
    const after = repo.lessonsForCourse(meccanica.id).filter((l) => l.startTime === '16:30');
    expect(after.every((l) => weekdayISO(l.date) === 5)).toBe(true);
    expect(after.map((l) => l.date)[0]).toBe('2026-11-20');
    expect(shiftToWeekday('2026-11-19', 5)).toBe('2026-11-20');
  });

  it('never resets attendance during any scoped edit', async () => {
    const { repo, meccanica } = await seedDesign(clockAt(2026, 11, 1, 9, 0));
    const ls = repo.lessonsForCourse(meccanica.id).filter((l) => weekdayISO(l.date) === 4);
    ls.forEach((l, i) => repo.setAttendance(l.id, (['attended', 'absent', 'recovered'] as const)[i % 3]));
    const snapshot = Object.fromEntries(repo.lessonsForCourse(meccanica.id).map((l) => [l.id, [l.attendance, l.attendanceAt]]));
    const t = ls.find((l) => l.date === '2026-11-19')!;
    repo.editLesson(t.id, 'one', { date: '2026-11-20', ...NEW });
    repo.editLesson(t.id, 'following', { date: '2026-11-19', ...NEW });
    repo.editLesson(t.id, 'all', { date: '2026-11-19', startTime: '08:00', endTime: '10:00' }, { confirmedReplace: true });
    for (const l of repo.lessonsForCourse(meccanica.id)) expect([l.attendance, l.attendanceAt]).toEqual(snapshot[l.id]);
  });

  it('the preview flags each lesson (target / changed / protected / unchanged) without writing', async () => {
    const { repo, meccanica } = await seedDesign(clockAt(2026, 11, 16, 9, 0));
    const ls = repo.lessonsForCourse(meccanica.id).filter((l) => weekdayISO(l.date) === 4);
    const t = ls.find((l) => l.date === '2026-11-19')!;
    repo.setAttendance(ls.find((l) => l.date === '2026-12-10')!.id, 'attended');
    const before = JSON.stringify(repo.lessonsForCourse(meccanica.id));
    const cs = repo.previewLessonEdit(t.id, 'following', { date: '2026-11-19', ...NEW });
    const by = Object.fromEntries(cs.preview.map((p) => [p.date, p.state]));
    expect(by['2026-11-12']).toBe('unchanged');
    expect(by['2026-11-19']).toBe('target');
    expect(by['2026-11-26']).toBe('changed');
    expect(by['2026-12-10']).toBe('protected');
    expect(JSON.stringify(repo.lessonsForCourse(meccanica.id))).toBe(before);
  });

  it('holiday closure cancels only future lessons without attendance (rows are kept)', async () => {
    const { repo, sem, meccanica } = await seedDesign(clockAt(2026, 11, 16, 9, 0));
    const ls = () => repo.lessonsForCourse(meccanica.id);
    repo.setAttendance(ls().find((l) => l.date === '2026-12-24')!.id, 'attended');
    const total = ls().length;
    repo.addClosure({ semesterId: sem.id, startDate: '2026-12-22', endDate: '2027-01-06', label: 'Natale' });
    expect(ls()).toHaveLength(total);
    const cancelled = ls().filter((l) => l.cancelled).map((l) => l.date);
    expect(cancelled).toContain('2026-12-22');
    expect(cancelled).not.toContain('2026-12-24'); // attendance registered → protected
    expect(ls().filter((l) => l.date === '2026-12-24')[0].cancelled).toBe(false);
  });

  it('extending the semester fills the new weeks and never deletes anything', async () => {
    const { repo, sem, meccanica } = await seedDesign();
    const before = repo.lessonsForCourse(meccanica.id);
    repo.updateSemester(sem.id, { endDate: '2027-01-29' });
    const after = repo.lessonsForCourse(meccanica.id);
    expect(after.length).toBe(before.length + 4); // 2 Tue + 2 Thu
    for (const l of before) expect(after.find((x) => x.id === l.id)).toBeDefined();
    repo.updateSemester(sem.id, { endDate: '2026-12-31' }); // shrinking
    expect(repo.lessonsForCourse(meccanica.id).length).toBe(after.length); // nothing removed
  });
});

describe('course deletion', () => {
  it('reports impact, removes lessons/slots, and keeps the exam record when attempts exist', async () => {
    const { repo, fisica } = await seedDesign();
    const les = repo.lessonsForCourse(fisica.id);
    repo.setAttendance(les[0].id, 'attended');
    repo.saveAttempt({ courseId: fisica.id, outcome: 'passed', grade: 27, date: '2027-01-19' });
    const impact = repo.courseDeletionImpact(fisica.id);
    expect(impact.lessons).toBe(les.length);
    expect(impact.registeredAttendances).toBe(1);
    expect(impact.attempts).toBe(1);
    const res = repo.deleteCourse(fisica.id);
    expect(res.keptForLibretto).toBe(true);
    expect(repo.lessonsForCourse(fisica.id)).toHaveLength(0);
    expect(repo.courses({ includeHidden: false })).not.toContainEqual(expect.objectContaining({ id: fisica.id }));
    expect(repo.attempts(fisica.id)).toHaveLength(1);
  });

  it('fully removes a course that has no exam history', async () => {
    const { repo, meccanica } = await seedDesign();
    expect(repo.deleteCourse(meccanica.id).keptForLibretto).toBe(false);
    expect(repo.course(meccanica.id)).toBeUndefined();
  });
});
