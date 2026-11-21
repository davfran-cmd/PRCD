import { describe, expect, it } from 'vitest';
import { attendanceCsv, calendarIcs, csvField, examsCsv, toCsv } from '../src/db/exporters';
import { DocsRepo } from '../src/documents/docsRepo';
import { MemoryFileStore } from '../src/storage/fileStore';
import { seedDesign } from './helpers';

describe('exports', () => {
  it('escapes CSV fields (RFC 4180) and neutralises spreadsheet formulas', () => {
    expect(csvField('semplice')).toBe('semplice');
    expect(csvField('con, virgola')).toBe('"con, virgola"');
    expect(csvField('virgolette "x"')).toBe('"virgolette ""x"""');
    expect(csvField('riga\nnuova')).toBe('"riga\nnuova"');
    expect(csvField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvField('+1')).toBe("'+1");
    expect(csvField(27)).toBe('27'); // numbers are not mangled
    expect(csvField(null)).toBe('');
    expect(toCsv([['a', 'b'], [1, 'x']]).startsWith('﻿a,b\r\n1,x')).toBe(true);
  });

  it('exports attendance and exams with one row per record', async () => {
    const { repo, fisica } = await seedDesign();
    const lessons = repo.lessonsForCourse(fisica.id);
    repo.setAttendance(lessons[0].id, 'attended');
    repo.saveAttempt({ courseId: fisica.id, outcome: 'passed', grade: 28, date: '2027-01-19' });
    const att = attendanceCsv(repo).trim().split('\r\n');
    expect(att[0]).toContain('Corso,Data');
    expect(att.length).toBe(1 + repo.allLessons().length);
    expect(att.some((r) => r.includes('Fisica 2') && r.includes('Presente'))).toBe(true);
    const ex = examsCsv(repo).trim().split('\r\n');
    expect(ex).toHaveLength(2);
    expect(ex[1]).toContain('Fisica 2');
    expect(ex[1]).toContain('28');
  });

  it('exports an iCalendar file with floating times, skipping cancelled lessons', async () => {
    const { repo, meccanica } = await seedDesign();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-19')!;
    repo.cancelLesson(l.id, true);
    repo.createEvent({ title: 'Cena, da Marta; ore 20', category: 'event', start: '2026-11-21T20:00', end: '2026-11-21T22:00' });
    const ics = calendarIcs(repo, { from: '2026-11-16', to: '2026-11-22', now: new Date('2026-11-20T10:00:00Z') });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('DTSTART:20261117T081500'); // Tuesday lesson, floating (no Z, no TZID)
    expect(ics).not.toContain('DTSTART:20261119T141500'); // the cancelled one
    expect(ics).toContain('SUMMARY:Cena\\, da Marta\\; ore 20');
    expect(ics).not.toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics.split('BEGIN:VEVENT').length - 1).toBe(ics.split('END:VEVENT').length - 1);
  });
});

describe('in-app notes', () => {
  it('can be edited, while imported documents are refused (originals stay intact)', async () => {
    const ctx = await seedDesign();
    const docs = new DocsRepo(ctx.repo, new MemoryFileStore());
    const note = await docs.createNote('Appunti di oggi', null, null, '# Prima');
    expect(note.editable).toBe(true);
    expect(note.fileName).toBe('Appunti di oggi.md');
    await docs.updateNoteText(note.id, '# Dopo\nparola-unica');
    expect(await docs.getText(note.id)).toBe('# Dopo\nparola-unica');
    expect(docs.search('parola-unica').map((r) => r.doc.id)).toEqual([note.id]); // index updated
    const imported = await docs.addDocument({ data: new TextEncoder().encode('# Originale'), fileName: 'orig.md', folderId: null });
    expect(imported.editable).toBe(false);
    await expect(docs.updateNoteText(imported.id, 'x')).rejects.toThrow(/importati/);
    expect(await docs.getText(imported.id)).toBe('# Originale');
  });
});
