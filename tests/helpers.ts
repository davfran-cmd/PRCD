import { Database, MemoryPersistence } from '../src/db/database';
import { Repo } from '../src/db/repo';

/** A clock frozen at a local wall-clock time. */
export const clockAt = (y: number, m: number, d: number, hh = 12, mm = 0) => () => new Date(y, m - 1, d, hh, mm, 0, 0);

export async function makeRepo(now = clockAt(2026, 11, 16, 9, 0), persistence = new MemoryPersistence()) {
  const db = await Database.open(persistence);
  const repo = new Repo(db, now);
  return { db, repo, persistence };
}

export const SEM = { name: '1° semestre 2026/27', startDate: '2026-09-28', endDate: '2027-01-15' };

/** Semester + three of the design's courses (timetable included). */
export async function seedDesign(now = clockAt(2026, 11, 16, 9, 0)) {
  const ctx = await makeRepo(now);
  const sem = ctx.repo.createSemester(SEM);
  const mk = (name: string, color: string, cfu: number, slots: Array<[number, string, string]>) =>
    ctx.repo.createCourse({ semesterId: sem.id, name, color, cfu, slots: slots.map(([weekday, startTime, endTime]) => ({ weekday, startTime, endTime })) });
  const analisi = mk('Analisi 2', '#6A4FB3', 8, [[1, '10:15', '12:15'], [3, '08:15', '10:15'], [5, '14:15', '16:15']]);
  const fisica = mk('Fisica 2', '#1F7A8C', 10, [[1, '14:15', '17:15'], [4, '10:15', '12:15'], [5, '08:15', '10:15']]);
  const meccanica = mk('Meccanica razionale', '#3F7D3A', 8, [[2, '08:15', '10:15'], [4, '14:15', '16:15']]);
  return { ...ctx, sem, analisi, fisica, meccanica };
}
