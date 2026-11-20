import { describe, expect, it } from 'vitest';
import { averagesFromEntries, buildLibrettoEntry, computeAverages, simulateAverages, validateGrade, formatGrade, gradeValue } from '../src/domain/grades';
import type { Course, ExamAttempt } from '../src/domain/types';
import { roundTo } from '../src/domain/dates';

let n = 0;
const course = (name: string, cfu: number, examKind: Course['examKind'] = 'graded'): Course => ({
  id: `c${++n}`, semesterId: 's', name, color: '#000000', cfu, examKind, archived: false, hidden: false, createdAt: '', updatedAt: '',
});
const attempt = (c: Course, p: Partial<ExamAttempt>): ExamAttempt => ({
  id: `a${++n}`, courseId: c.id, date: '2026-01-01', time: null, component: 'written', isMidterm: false, outcome: 'passed', grade: 27, lode: false,
  eligible: false, booked: false, label: '', note: '', createdAt: '', updatedAt: '', ...p,
});

/** The libretto shown in the approved design: 26,42 weighted, 26,33 arithmetic, 96,9 on 110, 56 CFU. */
function designLibretto() {
  const rows: Array<[string, number, number, boolean?]> = [
    ['Analisi 1', 10, 27], ['Geometria', 8, 29], ['Informatica', 10, 30, true], ['Fisica 1', 12, 24], ['Economia', 6, 26], ['Chimica', 7, 22],
  ];
  const entries = rows.map(([name, cfu, grade, lode]) => {
    const c = course(name, cfu);
    return buildLibrettoEntry(c, [attempt(c, { grade, lode: !!lode })]);
  });
  const ing = course('Lingua inglese B2', 3, 'eligibility');
  entries.push(buildLibrettoEntry(ing, [attempt(ing, { grade: null, eligible: true })]));
  return entries;
}

describe('grade calculations', () => {
  it('matches the approved design numbers (weighted, arithmetic, graduation base, CFU)', () => {
    const avg = averagesFromEntries(designLibretto());
    expect(roundTo(avg.weighted!, 2)).toBe(26.42); // 1400 / 53
    expect(avg.weighted).toBeCloseTo(1400 / 53, 10);
    expect(roundTo(avg.arithmetic!, 2)).toBe(26.33); // 158 / 6
    expect(roundTo(avg.graduationBase!, 1)).toBe(96.9);
    expect(avg.gradedCfu).toBe(53);
    expect(avg.eligibilityCfu).toBe(3);
    expect(avg.totalCfu).toBe(56);
    expect(avg.gradedExams).toBe(6);
  });

  it('keeps eligibility-only, failed, rejected, withdrawn, planned and mid-term attempts out of the averages', () => {
    const c = course('Fisica', 12);
    const entry = buildLibrettoEntry(c, [
      attempt(c, { outcome: 'failed', grade: 15, date: '2026-02-01' }),
      attempt(c, { outcome: 'withdrawn', grade: null, date: '2026-03-01' }),
      attempt(c, { outcome: 'rejected', grade: 19, date: '2026-04-01' }),
      attempt(c, { outcome: 'passed', isMidterm: true, grade: 30, date: '2026-05-01' }),
      attempt(c, { outcome: 'planned', grade: null, date: '2027-01-01' }),
    ]);
    expect(entry.final).toBeNull();
    expect(entry.attemptCount).toBe(3); // failed + withdrawn + rejected (mid-term and planned excluded)
    expect(entry.status).toBe('planned');
    expect(averagesFromEntries([entry]).weighted).toBeNull();
  });

  it('counts "lode" as the configured value (30 default, 31 optional)', () => {
    const c = course('Inf', 10);
    const e = buildLibrettoEntry(c, [attempt(c, { grade: 30, lode: true })]);
    expect(averagesFromEntries([e]).weighted).toBe(30);
    expect(averagesFromEntries([e], { lodeValue: 31, graduationScale: 110 }).weighted).toBe(31);
    expect(gradeValue({ grade: 30, lode: true }, { lodeValue: 31, graduationScale: 110 })).toBe(31);
    expect(formatGrade({ grade: 30, lode: true, eligible: false })).toBe('30L');
  });

  it('validates grades', () => {
    expect(validateGrade(17, false)).toMatch(/18 e 30/);
    expect(validateGrade(31, false)).toMatch(/18 e 30/);
    expect(validateGrade(27.5, false)).toMatch(/intero/);
    expect(validateGrade(29, true)).toMatch(/solo con 30/);
    expect(validateGrade(30, true)).toBeNull();
    expect(validateGrade(null, false)).toMatch(/voto/);
  });

  it('simulates future grades without storing anything', () => {
    const entries = designLibretto();
    const sim = simulateAverages(entries, [
      { courseId: 'x1', cfu: 8, grade: 26 }, { courseId: 'x2', cfu: 10, grade: 25 }, { courseId: 'x3', cfu: 8, grade: 28 }, { courseId: 'x4', cfu: 7, grade: 27 }, { courseId: 'x5', cfu: 6, grade: 26 },
    ]);
    // (1400 + 26*8 + 25*10 + 28*8 + 27*7 + 26*6) / (53 + 39) = 2427 / 92
    expect(sim.weighted).toBeCloseTo(2427 / 92, 10);
    expect(roundTo(sim.arithmetic!, 2)).toBe(roundTo((158 + 26 + 25 + 28 + 27 + 26) / 11, 2));
    expect(sim.deltaWeighted).toBeCloseTo(2427 / 92 - 1400 / 53, 10);
    expect(averagesFromEntries(entries).weighted).toBeCloseTo(1400 / 53, 10); // base untouched
  });

  it('clamps simulated grades to 18..30', () => {
    const sim = simulateAverages([], [{ courseId: 'a', cfu: 6, grade: 12 }, { courseId: 'b', cfu: 6, grade: 99 }]);
    expect(sim.weighted).toBe(24);
  });

  it('handles empty input', () => {
    const avg = computeAverages([], 0);
    expect(avg.weighted).toBeNull();
    expect(avg.arithmetic).toBeNull();
    expect(avg.graduationBase).toBeNull();
  });
});
