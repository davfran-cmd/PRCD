/**
 * DEVELOPMENT ONLY. Loads a realistic semester (the one drawn in the approved design) so screens can be
 * checked visually. It is imported only behind `import.meta.env.DEV` and is not part of the product:
 * a production build starts empty.
 */
import type { Services } from '../app/AppContext';
import { addDays, todayISO } from '../domain/dates';
import type { AttendanceStatus } from '../domain/types';

export async function seedDevData({ repo, docs }: Services): Promise<void> {
  const today = todayISO();
  const prev = repo.createSemester({ name: '1° semestre 2025/26', startDate: '2025-09-29', endDate: '2026-01-16' });
  const sem = repo.createSemester({ name: '1° semestre 2026/27', startDate: '2026-09-28', endDate: '2027-01-15' });
  repo.updateSettings({ currentSemesterId: sem.id });

  const mk = (semesterId: string, name: string, color: string, cfu: number, slots: Array<[number, string, string]>, kind: 'graded' | 'eligibility' = 'graded') =>
    repo.createCourse({ semesterId, name, color, cfu, examKind: kind, slots: slots.map(([weekday, startTime, endTime]) => ({ weekday, startTime, endTime })) });

  const an2 = mk(sem.id, 'Analisi 2', '#6A4FB3', 8, [[1, '10:15', '12:15'], [3, '08:15', '10:15'], [5, '14:15', '16:15']]);
  const fis2 = mk(sem.id, 'Fisica 2', '#1F7A8C', 10, [[1, '14:15', '17:15'], [4, '10:15', '12:15'], [5, '08:15', '10:15']]);
  const mr = mk(sem.id, 'Meccanica razionale', '#3F7D3A', 8, [[2, '08:15', '10:15'], [4, '14:15', '16:15']]);
  const el = mk(sem.id, 'Elettrotecnica', '#B7791F', 7, [[2, '13:15', '16:15'], [3, '14:15', '16:15']]);
  const ps = mk(sem.id, 'Probabilità e statistica', '#93306E', 6, [[3, '10:30', '12:15'], [5, '10:30', '12:15']]);

  // attendance pattern per course for lessons already held (deterministic)
  const patterns: Record<string, string> = { [an2.id]: 'aaaaaaaxaaaaaraa', [fis2.id]: 'aaaxaaaraaaaxaaxaaraaxaa', [mr.id]: 'aaaaaaaaaxaaaaaa', [el.id]: 'aaaaxaaaaaxaaaxa', [ps.id]: 'aaxaaaxaaxaaaxax' };
  const map: Record<string, AttendanceStatus> = { a: 'attended', x: 'absent', r: 'recovered' };
  for (const c of [an2, fis2, mr, el, ps]) {
    const past = repo.lessonsForCourse(c.id).filter((l) => l.date < today).slice(0, patterns[c.id].length);
    past.forEach((l, i) => repo.setAttendance(l.id, map[patterns[c.id][i]] ?? 'attended'));
  }

  // previous year: finished exams (the libretto of the design)
  const old: Array<[string, number, number, boolean, string, 'graded' | 'eligibility']> = [
    ['Analisi 1', 10, 27, false, '2026-02-02', 'graded'],
    ['Geometria e algebra lineare', 8, 29, false, '2026-02-16', 'graded'],
    ['Informatica', 10, 30, true, '2026-06-22', 'graded'],
    ['Fisica 1', 12, 24, false, '2026-06-24', 'graded'],
    ['Economia e organizzazione', 6, 26, false, '2026-07-09', 'graded'],
    ['Chimica', 7, 22, false, '2026-07-20', 'graded'],
    ['Lingua inglese B2', 3, 0, false, '2026-03-03', 'eligibility'],
  ];
  for (const [name, cfu, grade, lode, date, kind] of old) {
    const c = mk(prev.id, name, '#4A4A44', cfu, [], kind);
    if (name === 'Fisica 1') repo.saveAttempt({ courseId: c.id, outcome: 'withdrawn', date: '2026-02-13' });
    if (name === 'Chimica') repo.saveAttempt({ courseId: c.id, outcome: 'failed', grade: 15, date: '2026-02-19' });
    repo.saveAttempt({ courseId: c.id, outcome: 'passed', date, grade: kind === 'eligibility' ? null : grade, lode });
  }
  repo.saveAttempt({ courseId: an2.id, outcome: 'planned', date: addDays(today, 13), isMidterm: true, label: 'Prova in itinere', booked: true });
  repo.saveAttempt({ courseId: fis2.id, outcome: 'planned', date: '2027-01-19', booked: false });

  repo.addTopic(fis2.id, 'Elettrostatica nel vuoto');
  repo.addTopic(fis2.id, 'Magnetostatica');
  repo.addTopic(fis2.id, 'Induzione elettromagnetica');
  repo.getSettings();

  repo.createEvent({ title: 'Dentista', category: 'appointment', start: `${addDays(today, 3)}T17:30`, end: `${addDays(today, 3)}T18:15` });
  const study = repo.createEvent({ title: 'Studio: esercizi di Fisica 2', category: 'study', courseId: fis2.id, start: `${addDays(today, 5)}T15:00`, end: `${addDays(today, 5)}T18:00` });
  repo.updateEvent(study.id, { completed: false });
  const past = repo.createEvent({ title: 'Ripasso Analisi 2', category: 'study', courseId: an2.id, start: `${addDays(today, -3)}T09:30`, end: `${addDays(today, -3)}T11:30` });
  repo.updateEvent(past.id, { completed: true });
  repo.createEvent({ title: 'Relazione di laboratorio, Elettrotecnica', category: 'deadline', courseId: el.id, start: `${addDays(today, 6)}T23:59`, end: `${addDays(today, 6)}T23:59` });
  repo.createEvent({ title: 'Consegna esercizi, Analisi 2', category: 'deadline', courseId: an2.id, start: `${addDays(today, 9)}T12:00`, end: `${addDays(today, 9)}T12:00` });
  repo.createEvent({ title: 'Cena da Marta', category: 'event', start: `${addDays(today, 0)}T20:30`, end: `${addDays(today, 0)}T22:30` });
  repo.createEvent({ title: 'Palestra', category: 'event', start: `${addDays(today, -4)}T18:30`, end: `${addDays(today, -4)}T20:00`, recurrence: { freq: 'weekly', interval: 1 } });

  // documents
  const f = docs.createFolder('Fisica 2', null, fis2.id);
  const appunti = docs.createFolder('Appunti', f.id);
  const enc = (s: string) => new TextEncoder().encode(s);
  await docs.addDocument({ folderId: appunti.id, courseId: fis2.id, fileName: '14 Legge di Ampère.md', data: enc('---\ntags: [lezione, da-rivedere]\ndata: 2026-11-20\n---\n# Legge di Ampère\n\nLa circuitazione del campo magnetico lungo una linea chiusa $\\gamma$ è proporzionale alla corrente concatenata.\n\n$$\\oint_\\gamma \\vec{B}\\cdot d\\vec{l} = \\mu_0 I_{conc}$$\n\nVedi anche [[13 Forza di Lorentz]] e il [[Formulario]].\n\n## Applicazioni\n\n- filo rettilineo infinito: $B = \\frac{\\mu_0 I}{2\\pi r}$\n- solenoide\n\n| grandezza | simbolo |\n|---|---|\n| campo | $B$ |\n| corrente | $I$ |\n\n```python\nmu0 = 4e-7 * 3.14159\nprint(mu0 * 1.0 / (2 * 3.14159 * 0.1))\n```\n\n![filo](img/ampere-filo.png)\n') });
  await docs.addDocument({ folderId: appunti.id, courseId: fis2.id, fileName: '13 Forza di Lorentz.md', data: enc('# Forza di Lorentz\n\nUna carica in moto in un campo magnetico subisce $F = q\\, v \\times B$.\n') });
  const form = await docs.addDocument({ folderId: f.id, courseId: fis2.id, fileName: 'Formulario.md', data: enc('# Formulario di Fisica 2\n\n$$\\varepsilon = -\\frac{d\\Phi}{dt}$$\n') });
  docs.setFavorite(form.id, true);
  docs.setTags(form.id, ['#formulario', '#esame']);
}
