import { describe, expect, it, afterEach } from 'vitest';
import { Database, MemoryPersistence, MigrationError } from '../src/db/database';
import { LATEST_VERSION, MIGRATIONS } from '../src/db/migrations';
import { Repo, ValidationError } from '../src/db/repo';
import { clockAt, makeRepo, seedDesign, SEM } from './helpers';

afterEach(() => {
  // remove any test migration appended by a test
  while (MIGRATIONS[MIGRATIONS.length - 1].version > 1) MIGRATIONS.pop();
});

describe('database & migrations', () => {
  it('creates the schema at the latest version on a fresh database', async () => {
    const { db } = await makeRepo();
    expect(db.version).toBe(LATEST_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((t) => t.name);
    for (const t of ['semesters', 'courses', 'timetable_rules', 'lessons', 'exam_attempts', 'calendar_events', 'documents', 'folders', 'sync_map', 'apple_calendars', 'external_events']) {
      expect(tables).toContain(t);
    }
    expect(db.integrityCheck()).toBe('ok');
  });

  it('persists committed data and reloads it from the stored file', async () => {
    const p = new MemoryPersistence();
    const first = await seedDesign();
    // seedDesign uses its own persistence; build the persistence scenario explicitly:
    const { repo, db } = await makeRepo(clockAt(2026, 11, 16), p);
    const sem = repo.createSemester(SEM);
    const c = repo.createCourse({ semesterId: sem.id, name: 'Analisi 2', color: '#6A4FB3', cfu: 8, slots: [{ weekday: 1, startTime: '10:15', endTime: '12:15' }] });
    const lesson = repo.lessonsForCourse(c.id)[0];
    repo.setAttendance(lesson.id, 'attended');
    const lessonCount = repo.lessonsForCourse(c.id).length;
    await db.flush();
    expect(p.saves).toBeGreaterThan(0);
    db.close();

    const reopened = await Database.open(p);
    const repo2 = new Repo(reopened, clockAt(2026, 11, 16));
    expect(repo2.semesters()).toHaveLength(1);
    expect(repo2.courses()[0].name).toBe('Analisi 2');
    expect(repo2.lesson(lesson.id)!.attendance).toBe('attended');
    expect(repo2.lessonsForCourse(c.id)).toHaveLength(lessonCount);
    expect(first.repo.semesters()).toHaveLength(1); // separate in-memory db untouched
  });

  it('rolls back a failed transaction completely (no partial writes)', async () => {
    const { repo, db } = await makeRepo();
    const sem = repo.createSemester(SEM);
    expect(() =>
      db.transaction(() => {
        repo.createCourse({ semesterId: sem.id, name: 'A', color: '#000000', cfu: 6 });
        repo.createCourse({ semesterId: sem.id, name: 'B', color: '#000000', cfu: 6 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repo.courses()).toHaveLength(0);
    // and the database is still usable afterwards
    repo.createCourse({ semesterId: sem.id, name: 'C', color: '#000000', cfu: 6 });
    expect(repo.courses()).toHaveLength(1);
  });

  it('nested transactions behave as savepoints', async () => {
    const { repo, db } = await makeRepo();
    const sem = repo.createSemester(SEM);
    db.transaction(() => {
      repo.createCourse({ semesterId: sem.id, name: 'Outer', color: '#000000', cfu: 6 });
      expect(() => db.transaction(() => { repo.createCourse({ semesterId: sem.id, name: 'Inner', color: '#000000', cfu: 6 }); throw new Error('x'); })).toThrow('x');
    });
    expect(repo.courses().map((c) => c.name)).toEqual(['Outer']);
  });

  it('enforces foreign keys and check constraints', async () => {
    const { repo, db } = await makeRepo();
    expect(() => repo.createCourse({ semesterId: 'nope', name: 'X', color: '#000000', cfu: 6 })).toThrow(ValidationError);
    expect(() => db.run(`INSERT INTO courses(id, semester_id, name, color, cfu, created_at, updated_at) VALUES('c','missing','n','#000000',6,'x','x')`)).toThrow();
    const sem = repo.createSemester(SEM);
    expect(() => db.run(`UPDATE semesters SET end_date = '2020-01-01' WHERE id = ?`, [sem.id])).toThrow(); // CHECK end >= start
  });

  it('validates input at the repository boundary', async () => {
    const { repo } = await makeRepo();
    expect(() => repo.createSemester({ name: ' ', startDate: '2026-01-01', endDate: '2026-02-01' })).toThrow(/nome/);
    expect(() => repo.createSemester({ name: 'S', startDate: '2026-02-30', endDate: '2026-03-01' })).toThrow(/Date/);
    expect(() => repo.createSemester({ name: 'S', startDate: '2026-03-01', endDate: '2026-02-01' })).toThrow(/precede/);
    const sem = repo.createSemester(SEM);
    expect(() => repo.createCourse({ semesterId: sem.id, name: 'X', color: 'red', cfu: 6 })).toThrow(/Colore/);
    expect(() => repo.createCourse({ semesterId: sem.id, name: 'X', color: '#000000', cfu: 99 })).toThrow(/CFU/);
  });

  it('refuses a database written by a newer app version', async () => {
    const p = new MemoryPersistence();
    const { db } = await makeRepo(clockAt(2026, 11, 16), p);
    db.close();
    const bytes = (await p.load())!;
    const SQL = (await import('sql.js')).default;
    const raw = new (await SQL()).Database(bytes);
    raw.run(`PRAGMA user_version = ${LATEST_VERSION + 5}`);
    p.bytes = raw.export();
    await expect(Database.open(p)).rejects.toBeInstanceOf(MigrationError);
  });

  it('migrates an existing database forward, snapshotting it first and keeping all data', async () => {
    const p = new MemoryPersistence();
    const first = await makeRepo(clockAt(2026, 11, 16), p);
    first.repo.createSemester(SEM);
    await first.db.flush();
    first.db.close();

    MIGRATIONS.push({ version: 2, name: 'test: add column', up: ['ALTER TABLE semesters ADD COLUMN note TEXT'] });
    const db = await Database.open(p);
    expect(db.version).toBe(2);
    expect(new Repo(db).semesters()).toHaveLength(1);
    expect(await p.listSnapshots()).toEqual([{ name: 'pre-migration-v1', size: expect.any(Number) }]);
  });

  it('a failing migration rolls back, reports the error and leaves the stored database untouched', async () => {
    const p = new MemoryPersistence();
    const first = await makeRepo(clockAt(2026, 11, 16), p);
    first.repo.createSemester(SEM);
    await first.db.flush();
    first.db.close();
    const stored = new Uint8Array((await p.load())!);

    MIGRATIONS.push({ version: 2, name: 'test: broken', up: ['ALTER TABLE semesters ADD COLUMN ok TEXT', 'THIS IS NOT SQL'] });
    await expect(Database.open(p)).rejects.toThrow(/Migrazione 2/);
    expect(Array.from((await p.load())!)).toEqual(Array.from(stored));
    expect(await p.listSnapshots()).toHaveLength(1); // the pre-migration copy exists as well
    MIGRATIONS.pop();
    const ok = await Database.open(p); // and the app still opens at the old version
    expect(ok.version).toBe(1);
    expect(new Repo(ok).semesters()).toHaveLength(1);
  });

  it('serialises persistence writes and flush() waits for the last one', async () => {
    const p = new MemoryPersistence();
    const { repo, db } = await makeRepo(clockAt(2026, 11, 16), p);
    const sem = repo.createSemester(SEM);
    for (let i = 0; i < 20; i++) repo.createCourse({ semesterId: sem.id, name: `C${i}`, color: '#000000', cfu: 6 });
    await db.flush();
    const reopened = await Database.fromBytes(await p.load());
    expect(new Repo(reopened).courses()).toHaveLength(20);
  });

  it('notifies subscribers with the changed tables', async () => {
    const { repo, db } = await makeRepo();
    const seen: string[] = [];
    db.subscribe((t) => seen.push([...t].sort().join(',')));
    const sem = repo.createSemester(SEM);
    repo.createCourse({ semesterId: sem.id, name: 'A', color: '#000000', cfu: 6 });
    expect(seen.some((s) => s.includes('courses'))).toBe(true);
    expect(seen.some((s) => s.includes('semesters'))).toBe(true);
  });
});

describe('exams in the database', () => {
  it('stores attempts, rejects invalid grades and double passes, and orders history', async () => {
    const { repo, fisica } = await seedDesign();
    repo.saveAttempt({ courseId: fisica.id, outcome: 'failed', grade: 15, date: '2027-01-19' });
    repo.saveAttempt({ courseId: fisica.id, outcome: 'withdrawn', date: '2027-02-01' });
    expect(() => repo.saveAttempt({ courseId: fisica.id, outcome: 'passed', grade: 17, date: '2027-02-10' })).toThrow(/18 e 30/);
    const ok = repo.saveAttempt({ courseId: fisica.id, outcome: 'passed', grade: 24, date: '2027-02-10' });
    expect(() => repo.saveAttempt({ courseId: fisica.id, outcome: 'passed', grade: 25, date: '2027-02-20' })).toThrow(/già superato/);
    repo.saveAttempt({ ...ok, grade: 25 }); // editing the same attempt is fine
    expect(repo.attempts(fisica.id).map((a) => a.outcome)).toEqual(['failed', 'withdrawn', 'passed']);
    expect(repo.attempt(ok.id)!.grade).toBe(25);
  });

  it('eligibility exams pass without a grade', async () => {
    const { repo, sem } = await seedDesign();
    const ing = repo.createCourse({ semesterId: sem.id, name: 'Inglese B2', color: '#4A4A44', cfu: 3, examKind: 'eligibility' });
    const a = repo.saveAttempt({ courseId: ing.id, outcome: 'passed', date: '2027-02-01' });
    expect(a.eligible).toBe(true);
    expect(a.grade).toBeNull();
    expect(() => repo.saveAttempt({ courseId: ing.id, outcome: 'passed', grade: 25, date: '2027-02-01', id: 'other' })).toThrow();
  });
});

describe('personal events', () => {
  it('validates, stores and updates events', async () => {
    const { repo } = await makeRepo();
    expect(() => repo.createEvent({ title: ' ', category: 'event', start: '2026-11-24T17:30', end: '2026-11-24T18:15' })).toThrow(/titolo/);
    expect(() => repo.createEvent({ title: 'X', category: 'event', start: '2026-11-24T18:30', end: '2026-11-24T18:15' })).toThrow(/precede/);
    expect(() => repo.createEvent({ title: 'X', category: 'event', start: '2026-02-30T10:00', end: '2026-02-30T11:00' })).toThrow(/Data/);
    const e = repo.createEvent({ title: 'Dentista', category: 'appointment', start: '2026-11-24T17:30', end: '2026-11-24T18:15', recurrence: { freq: 'weekly', interval: 1 } });
    expect(repo.event(e.id)!.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    repo.updateEvent(e.id, { title: 'Dentista (Rossi)' });
    expect(repo.event(e.id)!.title).toBe('Dentista (Rossi)');
  });

  it('splits a series for "this and following"', async () => {
    const { repo } = await makeRepo();
    const e = repo.createEvent({ title: 'Studio', category: 'study', start: '2026-11-02T15:00', end: '2026-11-02T17:00', recurrence: { freq: 'weekly', interval: 1 } });
    const next = repo.splitEventSeries(e.id, '2026-11-16', { title: 'Studio intensivo', start: '2026-11-16T14:00', end: '2026-11-16T17:00' });
    expect(repo.event(e.id)!.recurrence!.until).toBe('2026-11-15');
    expect(next.title).toBe('Studio intensivo');
    expect(next.start).toBe('2026-11-16T14:00');
  });
});

describe('settings', () => {
  it('returns defaults, persists changes and validates', async () => {
    const { repo } = await makeRepo();
    expect(repo.getSettings().attendanceThreshold).toBe(80);
    repo.updateSettings({ attendanceThreshold: 75, lodeValue: 31 });
    expect(repo.getSettings()).toMatchObject({ attendanceThreshold: 75, lodeValue: 31 });
    expect(() => repo.updateSettings({ lodeValue: 29 })).toThrow(ValidationError);
    expect(() => repo.updateSettings({ attendanceThreshold: 140 })).toThrow(ValidationError);
  });
});
