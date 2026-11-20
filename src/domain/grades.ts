/**
 * Exam results and averages.
 *
 *  - Only *graded* exams with a passed final attempt count in both averages.
 *  - Eligibility-only exams (idoneità) give CFU but never enter an average.
 *  - Failed, rejected and withdrawn attempts, mid-terms and planned attempts never enter an average.
 *  - A "lode" counts as `lodeValue` (30 by default, configurable to 31).
 *  - weighted   = Σ(grade × CFU) / Σ CFU     arithmetic = Σ grade / n
 *  - graduation base = weighted × scale / 30  (scale = 110)
 */
import type { Course, ExamAttempt, ExamKind } from './types';
import { roundTo } from './dates';

export interface GradeSettings {
  lodeValue: number;
  graduationScale: number;
}
export const DEFAULT_GRADE_SETTINGS: GradeSettings = { lodeValue: 30, graduationScale: 110 };

export const PASS_MIN = 18;
export const GRADE_MAX = 30;

export interface GradedItem {
  courseId: string;
  cfu: number;
  grade: number; // 18..30 (lode already mapped by gradeValue)
}

export function validateGrade(grade: number | null, lode: boolean): string | null {
  if (grade === null) return 'Inserisci un voto';
  if (!Number.isInteger(grade)) return 'Il voto deve essere un numero intero';
  if (grade < PASS_MIN || grade > GRADE_MAX) return 'Il voto deve essere tra 18 e 30';
  if (lode && grade !== GRADE_MAX) return 'La lode è possibile solo con 30';
  return null;
}

export function gradeValue(a: Pick<ExamAttempt, 'grade' | 'lode'>, s: GradeSettings): number | null {
  if (a.grade === null) return null;
  return a.lode && a.grade === GRADE_MAX ? s.lodeValue : a.grade;
}

export function formatGrade(a: Pick<ExamAttempt, 'grade' | 'lode' | 'eligible'>): string {
  if (a.eligible && a.grade === null) return 'idoneo';
  if (a.grade === null) return '–';
  return a.lode ? '30L' : String(a.grade);
}

/** The accepted final attempt of a course exam, if any. */
export function finalAttempt(attempts: ExamAttempt[]): ExamAttempt | null {
  const passed = attempts.filter((a) => !a.isMidterm && a.outcome === 'passed');
  if (!passed.length) return null;
  return [...passed].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
}

export type ExamStatus = 'passed' | 'eligible' | 'planned' | 'booked' | 'to_take';

export interface LibrettoEntry {
  course: Course;
  kind: ExamKind;
  cfu: number;
  status: ExamStatus;
  final: ExamAttempt | null;
  /** Real attempts (planned and mid-terms excluded). */
  attemptCount: number;
  history: ExamAttempt[]; // chronological, mid-terms and planned included
  next: ExamAttempt | null; // upcoming planned attempt
}

export function buildLibrettoEntry(course: Course, attempts: ExamAttempt[]): LibrettoEntry {
  const mine = attempts.filter((a) => a.courseId === course.id).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const final = finalAttempt(mine);
  const real = mine.filter((a) => !a.isMidterm && a.outcome !== 'planned');
  const planned = mine.filter((a) => !a.isMidterm && a.outcome === 'planned');
  let status: ExamStatus = 'to_take';
  if (final) status = final.eligible && course.examKind === 'eligibility' ? 'eligible' : 'passed';
  else if (planned.some((p) => p.booked)) status = 'booked';
  else if (planned.length) status = 'planned';
  return { course, kind: course.examKind, cfu: course.cfu, status, final, attemptCount: real.length, history: mine, next: planned[0] ?? null };
}

export interface AverageResult {
  weighted: number | null;
  arithmetic: number | null;
  graduationBase: number | null;
  gradedExams: number;
  gradedCfu: number;
  /** CFU of passed eligibility-only exams (idoneità). */
  eligibilityCfu: number;
  totalCfu: number; // gradedCfu + eligibilityCfu
}

export function computeAverages(items: GradedItem[], eligibilityCfu: number, s: GradeSettings = DEFAULT_GRADE_SETTINGS): AverageResult {
  const gradedCfu = items.reduce((a, i) => a + i.cfu, 0);
  const weightedSum = items.reduce((a, i) => a + i.grade * i.cfu, 0);
  const weighted = gradedCfu > 0 ? weightedSum / gradedCfu : null;
  const arithmetic = items.length ? items.reduce((a, i) => a + i.grade, 0) / items.length : null;
  return {
    weighted,
    arithmetic,
    graduationBase: weighted === null ? null : (weighted * s.graduationScale) / GRADE_MAX,
    gradedExams: items.length,
    gradedCfu,
    eligibilityCfu,
    totalCfu: gradedCfu + eligibilityCfu,
  };
}

export function averagesFromEntries(entries: LibrettoEntry[], s: GradeSettings = DEFAULT_GRADE_SETTINGS): AverageResult {
  const items: GradedItem[] = [];
  let eligibilityCfu = 0;
  for (const e of entries) {
    if (!e.final) continue;
    if (e.kind === 'eligibility') {
      eligibilityCfu += e.cfu;
      continue;
    }
    const v = gradeValue(e.final, s);
    if (v !== null) items.push({ courseId: e.course.id, cfu: e.cfu, grade: v });
  }
  return computeAverages(items, eligibilityCfu, s);
}

export interface SimulatedExam {
  courseId: string;
  cfu: number;
  grade: number; // simulated, 18..30
}

/** Averages if the given hypothetical exams were passed with the given grades. Nothing is stored. */
export function simulateAverages(entries: LibrettoEntry[], planned: SimulatedExam[], s: GradeSettings = DEFAULT_GRADE_SETTINGS): AverageResult & { deltaWeighted: number | null } {
  const base = averagesFromEntries(entries, s);
  const items: GradedItem[] = [];
  for (const e of entries) {
    if (e.final && e.kind === 'graded') {
      const v = gradeValue(e.final, s);
      if (v !== null) items.push({ courseId: e.course.id, cfu: e.cfu, grade: v });
    }
  }
  for (const p of planned) {
    const g = Math.max(PASS_MIN, Math.min(GRADE_MAX, Math.round(p.grade)));
    items.push({ courseId: p.courseId, cfu: p.cfu, grade: g });
  }
  const res = computeAverages(items, base.eligibilityCfu, s);
  return { ...res, deltaWeighted: res.weighted !== null && base.weighted !== null ? res.weighted - base.weighted : null };
}

/** Minimum average grade needed on remaining CFU to reach a target weighted average. */
export function requiredAverageForTarget(currentWeightedSum: number, currentCfu: number, remainingCfu: number, target: number): number | null {
  if (remainingCfu <= 0) return null;
  return (target * (currentCfu + remainingCfu) - currentWeightedSum) / remainingCfu;
}

export function roundGrade(x: number | null, decimals = 2): number | null {
  return x === null ? null : roundTo(x, decimals);
}
