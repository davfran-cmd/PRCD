/**
 * Import of backups from the previous app, **Procedo** (`procedo-backup-AAAA-MM-GG.json`).
 *
 * Two steps, so the user sees what will happen before anything is written:
 *  1. `planProcedoImport(raw, repo)` — parses, normalises (Procedo's own `migrate()` rules), validates and
 *     maps everything to PRCD entities. Pure read: nothing is written.
 *  2. `applyProcedoImport(plan, repo)` — snapshot of the current database, then ONE transaction:
 *     all or nothing. Nothing existing is ever overwritten; re-importing the same file adds only what is new
 *     (every Procedo id is recorded in `import_map`).
 *
 * Mapping (Procedo → PRCD), see docs/IMPORT_PROCEDO.md:
 *   semester  title + year → name; start (or first lesson) → start; end = last lesson/autoUntil, ≥ 16 weeks
 *   course    name, tint → colour, cfu ("" → 0); prof and code are NOT imported (no teacher fields in PRCD)
 *   lesson    date, topic; p: S → attended, M → absent (to recover), R → recovered; chk → to confirm.
 *             Procedo has no lesson times → imported as "time unknown" (all-day) lessons, no weekly rule.
 *   exam      passed + grade (31 = 30 e lode) → accepted attempt; idoneita → eligibility course;
 *             todo with a date → planned attempt. Exams without an existing course get their own course
 *             in a semester "Esami importati da Procedo".
 *   settings  degreeCfu → CFU target. Theme, reminders, auto-lessons, target average and `sim` are not used by PRCD.
 */
import type { Repo } from './repo';
import { insertRow } from './rows';
import { addDays, isISODate, todayISO } from '../domain/dates';
import { newId } from '../domain/ids';
import { newLesson } from '../domain/timetable';
import { COURSE_COLORS } from '../domain/settings';
import type { AttendanceStatus, Lesson } from '../domain/types';

export const SOURCE = 'procedo';

export class ProcedoImportError extends Error {}

// ------------------------------------------------------------------------------------- raw shapes

interface PSemester { id?: unknown; title?: unknown; year?: unknown; start?: unknown; status?: unknown; createdAt?: unknown }
interface PLesson { id?: unknown; date?: unknown; topic?: unknown; p?: unknown; a?: unknown; study?: unknown; t?: unknown; auto?: unknown; chk?: unknown }
interface PCourse { id?: unknown; semId?: unknown; name?: unknown; code?: unknown; tint?: unknown; prof?: unknown; cfu?: unknown; days?: unknown; lessons?: unknown; createdAt?: unknown; autoUntil?: unknown }
interface PExam { id?: unknown; name?: unknown; cfu?: unknown; status?: unknown; kind?: unknown; grade?: unknown; date?: unknown; sim?: unknown; courseId?: unknown; tint?: unknown; code?: unknown; createdAt?: unknown }

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const dateFromMs = (v: unknown): string | null => {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Procedo's parseDays: "Lun–Gio", "lun, mer, ven", [1,3] → [1..] with 0=Sun … 6=Sat (Procedo's convention). */
export function parseDays(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  if (typeof v !== 'string') return [];
  const names = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const idx = (t: string) => names.indexOf(t.trim().toLowerCase().slice(0, 3));
  const out = new Set<number>();
  for (const part of v.split(/[,;/]+/)) {
    const range = part.split(/[–—-]/).map((x) => x.trim()).filter(Boolean);
    if (range.length === 2 && idx(range[0]) >= 0 && idx(range[1]) >= 0) {
      for (let i = idx(range[0]); ; i = (i + 1) % 7) {
        out.add(i);
        if (i === idx(range[1])) break;
      }
    } else if (range.length === 1 && idx(range[0]) >= 0) out.add(idx(range[0]));
  }
  return [...out].sort((a, b) => a - b);
}

const DAY_NAMES = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const isHex = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

// ------------------------------------------------------------------------------------- plan

export interface PlannedSemester { sourceId: string; name: string; startDate: string; endDate: string; archived: boolean; current: boolean; existingId: string | null }
export interface PlannedLesson { sourceId: string; date: string; topic: string; attendance: AttendanceStatus }
export interface PlannedCourse { sourceId: string; semesterSource: string; name: string; color: string; cfu: number; examKind: 'graded' | 'eligibility'; days: number[]; lessons: PlannedLesson[]; existingId: string | null }
export interface PlannedExam {
  sourceId: string;
  courseSource: string; // a Procedo course id, or a synthetic "exam:<id>" course
  name: string;
  outcome: 'passed' | 'planned' | 'none';
  grade: number | null;
  lode: boolean;
  date: string | null;
  existingId: string | null;
}

export interface ProcedoPlan {
  exportedAt: string | null;
  semesters: PlannedSemester[];
  courses: PlannedCourse[];
  exams: PlannedExam[];
  degreeCfu: number | null;
  counts: { semesters: number; courses: number; lessons: number; exams: number; alreadyImported: number };
  warnings: string[];
  notImported: string[];
}

const EXAMS_SEMESTER = 'procedo:exams-only';

function mapStatus(p: unknown, chk: unknown): AttendanceStatus {
  if (chk === true) return 'to_confirm';
  if (p === 'S') return 'attended';
  if (p === 'M') return 'absent';
  if (p === 'R') return 'recovered';
  return 'to_confirm';
}

/** Read-only: parses and maps a Procedo backup. Throws ProcedoImportError for files that are not Procedo backups. */
export function planProcedoImport(raw: unknown, repo: Repo): ProcedoPlan {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ProcedoImportError('Il file non è un JSON valido.');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ProcedoImportError('Il file non contiene un backup di Procedo.');
  const wrapper = obj as Record<string, unknown>;
  if (wrapper.app !== undefined && wrapper.app !== 'procedo') throw new ProcedoImportError(`Il file viene da un'altra app («${str(wrapper.app)}»), non da Procedo.`);
  const st = (wrapper.state && typeof wrapper.state === 'object' ? wrapper.state : wrapper) as Record<string, unknown>;
  if (!Array.isArray(st.semesters) || !Array.isArray(st.courses)) throw new ProcedoImportError('Backup non valido: mancano gli elenchi di semestri e corsi.');
  const version = num(st.v) ?? 1;
  if (version > 1) throw new ProcedoImportError(`Versione del backup non supportata (${version}).`);

  const warnings: string[] = [];
  const notImported = new Set<string>();
  const already = (kind: string, id: string) => repo.db.get<{ local_id: string }>('SELECT local_id FROM import_map WHERE source = ? AND source_kind = ? AND source_id = ?', [SOURCE, kind, id])?.local_id ?? null;
  let alreadyImported = 0;

  if (st.theme !== undefined) notImported.add('tema dell’app');
  if (st.remind !== undefined || st.remindDays !== undefined) notImported.add('promemoria per gli appunti');
  if (st.auto !== undefined || st.autoP !== undefined) notImported.add('aggiunta automatica delle lezioni (in PRCD le lezioni nascono dall’orario)');
  if (st.target !== undefined && st.target !== '') notImported.add('media obiettivo (in PRCD si imposta nel libretto, senza salvarla)');

  // ---- courses first (semester dates depend on their lessons)
  const courses: PlannedCourse[] = [];
  const seenCourses = new Set<string>();
  const lessonDatesBySem = new Map<string, string[]>();
  let lessonCount = 0;
  let usedColor = 0;
  const semIds = new Set((st.semesters as PSemester[]).map((s) => str(s?.id)).filter(Boolean));
  for (const c of st.courses as PCourse[]) {
    if (!c || typeof c !== 'object') continue;
    const id = str(c.id);
    const name = str(c.name).trim();
    if (!id || !name) {
      warnings.push('Un corso senza nome o identificativo è stato saltato.');
      continue;
    }
    if (seenCourses.has(id)) {
      warnings.push(`Il corso «${name}» compare due volte: importato una sola volta.`);
      continue;
    }
    seenCourses.add(id);
    const semesterSource = semIds.has(str(c.semId)) ? str(c.semId) : EXAMS_SEMESTER;
    if (semesterSource === EXAMS_SEMESTER) warnings.push(`Il corso «${name}» non ha un semestre valido: va in «Esami importati da Procedo».`);
    const tint = str(c.tint);
    const color = isHex(tint) ? tint.toUpperCase() : COURSE_COLORS[usedColor++ % COURSE_COLORS.length].hex;
    const cfuRaw = num(c.cfu);
    const cfu = cfuRaw !== null && Number.isInteger(cfuRaw) && cfuRaw >= 0 && cfuRaw <= 60 ? cfuRaw : 0;
    if (c.cfu !== undefined && c.cfu !== '' && cfu === 0 && cfuRaw !== 0) warnings.push(`CFU non validi per «${name}» (${str(c.cfu)}): impostati a 0.`);
    if (str(c.prof)) notImported.add('nome del docente (PRCD non registra docenti né aule)');
    const lessons: PlannedLesson[] = [];
    const seenLessons = new Set<string>();
    const rawLessons = Array.isArray(c.lessons) ? (c.lessons as PLesson[]) : [];
    for (const l of rawLessons) {
      if (!l || typeof l !== 'object') continue;
      const lid = str(l.id) || `${id}:${str(l.date)}:${str(l.t)}`;
      const date = str(l.date);
      if (!isISODate(date)) {
        warnings.push(`Una lezione di «${name}» ha una data non valida («${date}»): saltata.`);
        continue;
      }
      if (seenLessons.has(lid)) continue;
      seenLessons.add(lid);
      if (l.a !== undefined || l.study !== undefined) notImported.add('segni “appunti sistemati” e “studiata” delle lezioni');
      lessons.push({ sourceId: lid, date, topic: str(l.topic).trim(), attendance: mapStatus(l.p, l.chk) });
      lessonDatesBySem.set(semesterSource, [...(lessonDatesBySem.get(semesterSource) ?? []), date]);
    }
    const autoUntil = str(c.autoUntil);
    if (isISODate(autoUntil)) lessonDatesBySem.set(semesterSource, [...(lessonDatesBySem.get(semesterSource) ?? []), autoUntil]);
    lessons.sort((a, b) => a.date.localeCompare(b.date));
    const existingId = already('course', id);
    if (existingId) alreadyImported += 1;
    lessonCount += lessons.filter((l) => !already('lesson', l.sourceId)).length;
    courses.push({ sourceId: id, semesterSource, name, color, cfu, examKind: 'graded', days: parseDays(c.days), lessons, existingId });
  }

  // ---- exams
  const exams: PlannedExam[] = [];
  const rawExams = Array.isArray(st.exams) ? (st.exams as PExam[]).filter((e) => e && typeof e === 'object' && str(e.id)) : [];
  if (st.exams !== undefined && !Array.isArray(st.exams)) warnings.push('L’elenco degli esami non è leggibile: ignorato.');
  const passedByCourse = new Set<string>();
  const examDates: string[] = [];
  for (const e of rawExams) {
    const id = str(e.id);
    const name = str(e.name).trim() || 'Esame senza nome';
    const kind = e.kind === 'idoneita' ? 'eligibility' : 'graded';
    const cfuRaw = num(e.cfu);
    const cfu = cfuRaw !== null && Number.isInteger(cfuRaw) && cfuRaw >= 0 && cfuRaw <= 60 ? cfuRaw : 0;
    let courseSource = str(e.courseId);
    let course = courses.find((c) => c.sourceId === courseSource);
    if (!course) {
      // No (existing) course: the exam gets its own course so it can live in the libretto.
      courseSource = `exam:${id}`;
      const tint = str(e.tint);
      course = { sourceId: courseSource, semesterSource: EXAMS_SEMESTER, name, color: isHex(tint) ? tint.toUpperCase() : COURSE_COLORS[usedColor++ % COURSE_COLORS.length].hex, cfu, examKind: kind, days: [], lessons: [], existingId: already('course', courseSource) };
      courses.push(course);
    } else {
      // The libretto uses the exam's CFU and kind: Procedo stored them on the exam.
      if (cfu && course.cfu !== cfu) {
        if (course.cfu) warnings.push(`«${course.name}»: CFU diversi tra corso (${course.cfu}) ed esame (${cfu}); uso quelli dell’esame.`);
        course.cfu = cfu;
      }
      if (kind === 'eligibility') course.examKind = 'eligibility';
    }
    const date = isISODate(str(e.date)) ? str(e.date) : null;
    if (date) examDates.push(date);
    let outcome: PlannedExam['outcome'] = 'none';
    let grade: number | null = null;
    let lode = false;
    if (e.status === 'passed') {
      if (passedByCourse.has(courseSource)) {
        warnings.push(`«${name}» risulta superato due volte per lo stesso corso: importato una volta sola.`);
        continue;
      }
      if (kind === 'graded') {
        const g = num(e.grade);
        if (g === null || !Number.isInteger(g) || g < 18 || g > 31) {
          warnings.push(`«${name}»: voto non valido («${str(e.grade)}»), esame non importato.`);
          continue;
        }
        grade = g === 31 ? 30 : g;
        lode = g === 31; // Procedo: 31 = 30 e lode
      }
      outcome = 'passed';
      passedByCourse.add(courseSource);
    } else if (date && date >= todayISO()) outcome = 'planned';
    if (e.sim !== undefined && e.sim !== null) notImported.add('voti simulati (in PRCD la simulazione non si salva)');
    const existingId = already('exam', id);
    if (existingId) alreadyImported += 1;
    exams.push({ sourceId: id, courseSource, name, outcome, grade, lode, date, existingId });
  }

  // ---- semesters
  const semesters: PlannedSemester[] = [];
  let currentSet = false;
  for (const s of st.semesters as PSemester[]) {
    if (!s || typeof s !== 'object') continue;
    const id = str(s.id);
    if (!id) {
      warnings.push('Un semestre senza identificativo è stato saltato.');
      continue;
    }
    const dates = (lessonDatesBySem.get(id) ?? []).sort();
    const start = isISODate(str(s.start)) ? str(s.start) : dates[0] ?? dateFromMs(s.createdAt) ?? todayISO();
    const last = dates.at(-1) ?? start;
    // Procedo has no end date: the semester covers its lessons and lasts at least 16 weeks.
    const minEnd = addDays(start, 16 * 7 - 1);
    const endDate = last > minEnd ? last : minEnd;
    const title = str(s.title).trim() || 'Semestre';
    const year = str(s.year).trim();
    const current = s.status === 'current' && !currentSet;
    if (current) currentSet = true;
    const existingId = already('semester', id);
    if (existingId) alreadyImported += 1;
    semesters.push({ sourceId: id, name: year ? `${title} ${year}` : title, startDate: start < endDate ? start : endDate, endDate, archived: s.status === 'archived', current, existingId });
  }
  if (courses.some((c) => c.semesterSource === EXAMS_SEMESTER)) {
    const dates = [...examDates, ...(lessonDatesBySem.get(EXAMS_SEMESTER) ?? [])].sort();
    const start = dates[0] ?? todayISO();
    semesters.push({ sourceId: EXAMS_SEMESTER, name: 'Esami importati da Procedo', startDate: start, endDate: dates.at(-1) && dates.at(-1)! > start ? dates.at(-1)! : start, archived: true, current: false, existingId: already('semester', EXAMS_SEMESTER) });
  }

  for (const c of courses) {
    if (c.days.length && c.lessons.length) {
      notImported.add('giorni di lezione settimanali (Procedo non registra gli orari: le lezioni arrivano senza ora, l’orario settimanale si aggiunge dal corso)');
    }
  }
  const degree = num(st.degreeCfu);
  return {
    exportedAt: str(wrapper.exportedAt) || null,
    semesters,
    courses,
    exams,
    degreeCfu: degree !== null && Number.isInteger(degree) && degree >= 30 && degree <= 360 ? degree : null,
    counts: {
      semesters: semesters.filter((s) => !s.existingId).length,
      courses: courses.filter((c) => !c.existingId).length,
      lessons: lessonCount,
      exams: exams.filter((e) => !e.existingId).length,
      alreadyImported,
    },
    warnings,
    notImported: [...notImported],
  };
}

export function daysLabel(days: number[]): string {
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

// ------------------------------------------------------------------------------------- apply

export interface ProcedoImportReport {
  semesters: number;
  courses: number;
  lessons: number;
  attempts: number;
  skipped: number;
  snapshotName: string;
}

/** Writes the plan in one transaction after a snapshot. Never modifies records that already exist. */
export async function applyProcedoImport(plan: ProcedoPlan, repo: Repo, opts: { now?: Date } = {}): Promise<ProcedoImportReport> {
  const db = repo.db;
  const stamp = (opts.now ?? new Date()).toISOString();
  const snapshotName = `pre-import-procedo-${stamp.replace(/[:.]/g, '-')}`;
  await db.flush();
  await db.snapshot(snapshotName);
  const report: ProcedoImportReport = { semesters: 0, courses: 0, lessons: 0, attempts: 0, skipped: 0, snapshotName };
  const remember = (kind: string, sourceId: string, localId: string) =>
    db.run('INSERT INTO import_map(source, source_kind, source_id, local_id, imported_at) VALUES(?,?,?,?,?)', [SOURCE, kind, sourceId, localId, stamp]);
  const known = (kind: string, sourceId: string) => db.get<{ local_id: string }>('SELECT local_id FROM import_map WHERE source = ? AND source_kind = ? AND source_id = ?', [SOURCE, kind, sourceId])?.local_id ?? null;

  db.transaction(() => {
    const semIds = new Map<string, string>();
    let currentId: string | null = null;
    for (const s of plan.semesters) {
      const existing = known('semester', s.sourceId);
      if (existing && repo.semester(existing)) {
        semIds.set(s.sourceId, existing);
        continue;
      }
      const created = repo.createSemester({ name: s.name, startDate: s.startDate, endDate: s.endDate });
      if (s.archived) repo.updateSemester(created.id, { archived: true });
      if (s.current) currentId = created.id;
      remember('semester', s.sourceId, created.id);
      semIds.set(s.sourceId, created.id);
      report.semesters += 1;
    }

    const courseIds = new Map<string, string>();
    for (const c of plan.courses) {
      const existing = known('course', c.sourceId);
      let courseId = existing && repo.course(existing) ? existing : null;
      if (!courseId) {
        const semesterId = semIds.get(c.semesterSource);
        if (!semesterId) throw new ProcedoImportError(`Semestre mancante per il corso «${c.name}».`);
        courseId = repo.createCourse({ semesterId, name: c.name, color: c.color, cfu: c.cfu, examKind: c.examKind }).id;
        remember('course', c.sourceId, courseId);
        report.courses += 1;
      }
      courseIds.set(c.sourceId, courseId);
      for (const l of c.lessons) {
        if (known('lesson', l.sourceId)) {
          report.skipped += 1;
          continue;
        }
        const lesson: Lesson = {
          ...newLesson({ courseId, ruleId: null, originalDate: null, date: l.date, startTime: '00:00', endTime: '23:59', topic: l.topic }, stamp),
          timeUnknown: true,
          attendance: l.attendance,
          attendanceAt: l.attendance === 'to_confirm' ? null : stamp,
        };
        insertRow(db, 'lessons', lesson, { bool: ['cancelled', 'isException', 'timeUnknown'] });
        remember('lesson', l.sourceId, lesson.id);
        report.lessons += 1;
      }
    }

    for (const e of plan.exams) {
      if (known('exam', e.sourceId)) {
        report.skipped += 1;
        continue;
      }
      const courseId = courseIds.get(e.courseSource);
      if (!courseId) continue;
      if (e.outcome === 'none') {
        remember('exam', e.sourceId, courseId);
        continue;
      }
      if (e.outcome === 'passed' && repo.attempts(courseId).some((a) => a.outcome === 'passed' && !a.isMidterm)) {
        // An accepted result already exists in PRCD: never overwrite it.
        remember('exam', e.sourceId, courseId);
        report.skipped += 1;
        continue;
      }
      const course = repo.course(courseId);
      const attempt = repo.saveAttempt({
        courseId,
        outcome: e.outcome,
        date: e.date,
        grade: e.outcome === 'passed' && course?.examKind === 'graded' ? e.grade : null,
        lode: e.outcome === 'passed' && e.lode,
        eligible: course?.examKind === 'eligibility',
        note: 'Importato da Procedo',
      });
      remember('exam', e.sourceId, attempt.id);
      report.attempts += 1;
    }

    const settingsPatch: Parameters<Repo['updateSettings']>[0] = {};
    if (plan.degreeCfu) settingsPatch.degreeCfuTarget = plan.degreeCfu;
    if (currentId) settingsPatch.currentSemesterId = currentId;
    if (Object.keys(settingsPatch).length) repo.updateSettings(settingsPatch);
  });
  void newId;
  return report;
}
