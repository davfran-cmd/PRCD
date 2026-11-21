import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyProcedoImport, parseDays, planProcedoImport, ProcedoImportError } from '../src/db/importProcedo';
import { librettoAverages, librettoEntries } from '../src/app/queries';
import { computeAttendance } from '../src/domain/attendance';
import { buildTimeline } from '../src/app/timeline';
import { clockAt, makeRepo } from './helpers';

const example = () => JSON.parse(readFileSync(new URL('./fixtures/procedo-backup-example.json', import.meta.url), 'utf8'));
const now = clockAt(2026, 11, 21, 10, 0);

describe('Procedo backup import', () => {
  it('previews without writing anything', async () => {
    const { repo, db } = await makeRepo(now);
    const plan = planProcedoImport(example(), repo);
    expect(plan.counts).toMatchObject({ semesters: 4, courses: 5, lessons: 8, exams: 5, alreadyImported: 0 }); // +1 semester and +2 courses for exams without a course
    expect(plan.notImported.join(' ')).toMatch(/docente/);
    expect(plan.notImported.join(' ')).toMatch(/simulati/);
    expect(repo.semesters()).toHaveLength(0);
    expect(Number(db.scalar('SELECT COUNT(*) FROM lessons'))).toBe(0);
  });

  it('imports semesters, courses, lessons with attendance, and the libretto with correct averages', async () => {
    const { repo } = await makeRepo(now);
    const report = await applyProcedoImport(planProcedoImport(example(), repo), repo, { now: now() });
    expect(report).toMatchObject({ semesters: 4, courses: 5, lessons: 8, attempts: 3 });

    const sems = repo.semesters();
    expect(sems.map((s) => s.name).sort()).toEqual(['1° Semestre 2025/2026', '1° Semestre 2026/2027', '2° Semestre 2025/2026', 'Esami importati da Procedo']);
    const current = repo.currentSemester()!;
    expect(current.name).toBe('1° Semestre 2026/2027');
    expect(current.startDate).toBe('2026-09-23');
    expect(sems.find((s) => s.name === '2° Semestre 2025/2026')!.archived).toBe(true);

    const am = repo.courses({ includeArchived: true }).find((c) => c.name === 'Analisi Matematica II')!;
    expect(am).toMatchObject({ color: '#6155F5', cfu: 9, semesterId: current.id });
    const lessons = repo.lessonsForCourse(am.id).filter((l) => l.ruleId === null);
    expect(lessons.map((l) => [l.date, l.attendance])).toEqual([
      ['2026-09-23', 'attended'], ['2026-09-25', 'attended'], ['2026-09-27', 'attended'], ['2026-09-30', 'absent'], ['2026-10-02', 'to_confirm'],
    ]);
    expect(lessons.every((l) => l.timeUnknown && l.ruleId === null)).toBe(true);
    expect(lessons[0].topic).toBe('Serie numeriche: definizione e criteri');
    // Procedo had no lesson times: the course continues on its days without an invented time
    expect(repo.rules(am.id).map((x) => [x.weekday, x.timeUnknown, x.validFrom])).toEqual([[1, true, '2026-11-21'], [3, true, '2026-11-21'], [5, true, '2026-11-21']]);

    const fi = repo.courses().find((c) => c.name === 'Fisica Generale')!;
    expect(repo.lessonsForCourse(fi.id).filter((l) => l.ruleId === null).map((l) => l.attendance)).toEqual(['attended', 'recovered']);
    const stats = computeAttendance(repo.lessonsForCourse(am.id), repo.nowLocal(), repo.getSettings());
    expect(stats).toMatchObject({ held: 4, attended: 3, absent: 1, toConfirm: 1 });

    // libretto: Programmazione 30 (6 CFU), Algebra Lineare 30 e lode (6 CFU), Inglese idoneità (3 CFU)
    const entries = librettoEntries(repo);
    const alg = entries.find((e) => e.course.name === 'Algebra Lineare')!;
    expect(alg.final).toMatchObject({ grade: 30, lode: true });
    const ing = entries.find((e) => e.course.name === 'Inglese B2')!;
    expect(ing.kind).toBe('eligibility');
    expect(ing.final).toMatchObject({ grade: null, eligible: true });
    const avg = librettoAverages(repo);
    expect(avg.weighted).toBe(30);
    expect(avg.gradedCfu).toBe(12);
    expect(avg.eligibilityCfu).toBe(3);
    expect(avg.totalCfu).toBe(15);
    // todo exams stay "to take" on their courses
    expect(entries.find((e) => e.course.name === 'Analisi Matematica II')!.status).toBe('to_take');
    expect(repo.getSettings().degreeCfuTarget).toBe(180);
  });

  it('shows lessons without a time as all-day items, and an edit gives them a real time', async () => {
    const { repo } = await makeRepo(now);
    await applyProcedoImport(planProcedoImport(example(), repo), repo, { now: now() });
    const item = buildTimeline(repo, '2026-09-23', '2026-09-23').find((i) => i.kind === 'lesson')!;
    expect(item.allDay).toBe(true);
    const l = repo.lessonsInRange('2026-09-23', '2026-09-23')[0];
    repo.editLesson(l.id, 'one', { date: l.date, startTime: '10:15', endTime: '12:15' });
    expect(repo.lesson(l.id)).toMatchObject({ timeUnknown: false, startTime: '10:15', attendance: 'attended' });
  });

  it('is idempotent: importing the same backup twice adds nothing and changes nothing', async () => {
    const { repo, db } = await makeRepo(now);
    await applyProcedoImport(planProcedoImport(example(), repo), repo, { now: now() });
    const counts = () => ['semesters', 'courses', 'lessons', 'exam_attempts'].map((t) => Number(db.scalar(`SELECT COUNT(*) FROM ${t}`)));
    const before = counts();
    const plan2 = planProcedoImport(example(), repo);
    expect(plan2.counts).toMatchObject({ semesters: 0, courses: 0, lessons: 0, exams: 0 });
    const r2 = await applyProcedoImport(plan2, repo, { now: now() });
    expect(r2).toMatchObject({ semesters: 0, courses: 0, lessons: 0, attempts: 0 });
    expect(counts()).toEqual(before);
  });

  it('adds only what is new in a later backup, without touching what the user changed in PRCD', async () => {
    const { repo } = await makeRepo(now);
    await applyProcedoImport(planProcedoImport(example(), repo), repo, { now: now() });
    const fi = repo.courses().find((c) => c.name === 'Fisica Generale')!;
    const first = repo.lessonsForCourse(fi.id)[0];
    repo.setAttendance(first.id, 'absent'); // changed in PRCD after the first import
    const next = example();
    next.state.courses[1].lessons.push({ id: 'les_fi03', date: '2026-10-01', topic: 'Acustica', p: 'S', a: false, t: 1 });
    await applyProcedoImport(planProcedoImport(next, repo), repo, { now: now() });
    const ls = repo.lessonsForCourse(fi.id).filter((l) => l.ruleId === null);
    expect(ls).toHaveLength(3);
    expect(repo.lesson(first.id)!.attendance).toBe('absent'); // not overwritten
  });

  it('continues each course on its Procedo days until the end of the semester, as all-day lessons', async () => {
    const { repo } = await makeRepo(now);
    const r = await applyProcedoImport(planProcedoImport(example(), repo), repo, { now: now() });
    expect(r.slots).toBe(5); // Analisi Mon/Wed/Fri + Fisica Tue/Thu; Programmazione's semester is archived
    const am = repo.courses().find((c) => c.name === 'Analisi Matematica II')!;
    const sem = repo.semester(am.semesterId)!;
    const future = repo.lessonsForCourse(am.id).filter((l) => l.ruleId !== null);
    expect(future[0]).toMatchObject({ date: '2026-11-23', timeUnknown: true, attendance: 'to_confirm' });
    expect(future.at(-1)!.date <= sem.endDate).toBe(true);
    expect(future.every((l) => l.date > '2026-11-20')).toBe(true); // never doubles the imported days
    const items = buildTimeline(repo, '2026-11-23', '2026-11-29').filter((i) => i.kind === 'lesson');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.allDay && !i.conflict)).toBe(true);
    // a second import adds nothing more
    const again = planProcedoImport(example(), repo);
    expect(again.counts.continued).toBe(0);
    const r2 = await applyProcedoImport(again, repo, { now: now() });
    expect(r2.slots).toBe(0);
  });

  it('a re-import continues courses imported before this feature (no timetable yet)', async () => {
    const { repo, db } = await makeRepo(now);
    await applyProcedoImport(planProcedoImport(example(), repo), repo, { now: now() });
    // simulate data imported by the previous version: no rules, no generated lessons
    db.run('DELETE FROM lessons WHERE rule_id IS NOT NULL');
    db.run('DELETE FROM timetable_rules');
    const plan = planProcedoImport(example(), repo);
    expect(plan.counts).toMatchObject({ lessons: 0, continued: 2 });
    const r = await applyProcedoImport(plan, repo, { now: now() });
    expect(r).toMatchObject({ lessons: 0, slots: 5 });
  });

  it('asks the lesson times: new lessons get them, recorded ones too (attendance kept), empty days stay all-day', async () => {
    const { repo } = await makeRepo(now);
    const plan = planProcedoImport(example(), repo);
    expect(plan.timeable.map((t) => [t.name, t.weekdays])).toEqual([['Analisi Matematica II', [1, 3, 5]], ['Fisica Generale', [2, 4]]]);
    const am = plan.timeable[0].sourceId;
    const r = await applyProcedoImport(plan, repo, { now: now(), times: { [am]: { 1: { startTime: '08:30', endTime: '10:30' }, 3: { startTime: '14:30', endTime: '16:00' } } } });
    expect(r.timed).toBeGreaterThan(0);
    const course = repo.courses().find((c) => c.name === 'Analisi Matematica II')!;
    const ls = repo.lessonsForCourse(course.id);
    const mon = ls.filter((l) => l.date === '2026-11-23')[0]; // future Monday: timed
    expect(mon).toMatchObject({ startTime: '08:30', endTime: '10:30', timeUnknown: false });
    const past = ls.find((l) => l.date === '2026-09-23')!; // recorded Wednesday: gets the time, keeps attendance
    expect(past).toMatchObject({ startTime: '14:30', timeUnknown: false, attendance: 'attended', ruleId: null });
    const fri = ls.find((l) => l.date === '2026-11-27')!; // Friday left empty: still all-day
    expect(fri.timeUnknown).toBe(true);
    // Analisi now has its own timed slots: a later import does not ask for it again
    const again = planProcedoImport(example(), repo);
    expect(again.timeable.map((t) => t.name)).toEqual(['Fisica Generale']); // Analisi has timed slots now
  });

  it('keeps a snapshot of the data before importing', async () => {
    const { repo, persistence } = await makeRepo(now);
    repo.createSemester({ name: 'Mio', startDate: '2026-01-01', endDate: '2026-02-01' });
    const r = await applyProcedoImport(planProcedoImport(example(), repo), repo, { now: new Date('2026-11-21T09:00:00Z') });
    expect(r.snapshotName).toBe('pre-import-procedo-2026-11-21T09-00-00-000Z');
    expect((await persistence.listSnapshots()).map((s) => s.name)).toContain(r.snapshotName);
  });

  it('accepts the bare state object (no wrapper) and old backups with missing fields', async () => {
    const { repo } = await makeRepo(now);
    const old = {
      v: 1,
      semesters: [{ id: 's1', title: '1° Semestre', year: '2024/2025', status: 'archived' }],
      courses: [
        { id: 'c1', semId: 's1', name: 'Chimica', tint: 'red', cfu: '', days: 'Lun–Gio' }, // no lessons, cfu "", days as string, bad colour
        { id: 'c2', semId: 's1', name: 'Geometria', cfu: '6', lessons: [{ id: 'l1', date: '2024-10-01', p: 'S' }, { id: 'l2', date: 'ieri', p: 'S' }] },
      ],
      // no exams at all
    };
    const plan = planProcedoImport(old, repo);
    expect(plan.counts).toMatchObject({ semesters: 1, courses: 2, lessons: 1, exams: 0 });
    expect(plan.warnings.join(' ')).toMatch(/data non valida/);
    const c1 = plan.courses.find((c) => c.sourceId === 'c1')!;
    expect(c1).toMatchObject({ cfu: 0, days: [1, 2, 3, 4], lessons: [] });
    expect(c1.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(plan.courses.find((c) => c.sourceId === 'c2')!.cfu).toBe(6);
    const sem = plan.semesters[0];
    expect(sem.startDate).toBe('2024-10-01'); // no start: first lesson
    await applyProcedoImport(plan, repo, { now: now() });
    expect(repo.courses({ includeArchived: true })).toHaveLength(2);
  });

  it('handles exam edge cases: grade 31 = 30 e lode, missing kind = voto, invalid grades and exams without id', async () => {
    const { repo } = await makeRepo(now);
    const data = {
      semesters: [],
      courses: [],
      exams: [
        { id: 'e1', name: 'Analisi 1', cfu: 9, status: 'passed', grade: 31, date: '2025-02-01' },
        { id: 'e2', name: 'Fisica 1', cfu: 9, status: 'passed', grade: 15, date: '2025-02-01' }, // invalid for a pass
        { name: 'senza id', status: 'passed', grade: 27 },
        { id: 'e4', name: 'Futuro', cfu: 6, status: 'todo', grade: null, date: '2027-01-20' },
      ],
    };
    const plan = planProcedoImport(data, repo);
    expect(plan.exams.map((e) => e.sourceId)).toEqual(['e1', 'e4']);
    expect(plan.exams[0]).toMatchObject({ grade: 30, lode: true, outcome: 'passed' });
    expect(plan.exams[1].outcome).toBe('planned');
    expect(plan.warnings.join(' ')).toMatch(/Fisica 1.*voto non valido/);
    await applyProcedoImport(plan, repo, { now: now() });
    const entries = librettoEntries(repo);
    expect(entries.find((e) => e.course.name === 'Analisi 1')!.final).toMatchObject({ grade: 30, lode: true });
    expect(entries.find((e) => e.course.name === 'Futuro')!.status).toBe('planned');
  });

  it('refuses files that are not Procedo backups', async () => {
    const { repo } = await makeRepo(now);
    expect(() => planProcedoImport('non è json', repo)).toThrow(ProcedoImportError);
    expect(() => planProcedoImport({ app: 'altra', state: { semesters: [], courses: [] } }, repo)).toThrow(/altra app/);
    expect(() => planProcedoImport({ semesters: 'x', courses: [] }, repo)).toThrow(/semestri e corsi/);
    expect(() => planProcedoImport([1, 2], repo)).toThrow(ProcedoImportError);
    expect(() => planProcedoImport({ v: 2, semesters: [], courses: [] }, repo)).toThrow(/Versione/);
  });

  it('parses Procedo day strings', () => {
    expect(parseDays('Lun–Gio')).toEqual([1, 2, 3, 4]);
    expect(parseDays('lun, mer, ven')).toEqual([1, 3, 5]);
    expect(parseDays([1, 3, 9])).toEqual([1, 3]);
    expect(parseDays(undefined)).toEqual([]);
    expect(parseDays('Ven-Lun')).toEqual([0, 1, 5, 6]);
  });
});
