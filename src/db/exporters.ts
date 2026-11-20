import type { Repo } from './repo';
import { librettoEntries } from '../app/queries';
import { formatGrade } from '../domain/grades';
import { ATTENDANCE_LABELS } from '../domain/attendance';
import { expandEvent } from '../domain/recurrence';
import { addDays, splitLocalDateTime } from '../domain/dates';

/** RFC 4180 field escaping, plus protection against spreadsheet formula injection. */
export function csvField(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return `\uFEFF${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`; // BOM so Excel reads UTF-8
}

export function attendanceCsv(repo: Repo): string {
  const courses = new Map(repo.courses({ includeArchived: true, includeHidden: true }).map((c) => [c.id, c]));
  const rows: Array<Array<string | number | null>> = [['Corso', 'Data', 'Inizio', 'Fine', 'Tipo', 'Stato', 'Annullata', 'Argomento']];
  for (const l of repo.allLessons()) rows.push([courses.get(l.courseId)?.name ?? '', l.date, l.startTime, l.endTime, l.kind === 'extra' ? 'extra' : 'ordinaria', ATTENDANCE_LABELS[l.attendance], l.cancelled ? 'sì' : 'no', l.topic]);
  return toCsv(rows);
}

export function examsCsv(repo: Repo): string {
  const rows: Array<Array<string | number | null>> = [['Corso', 'CFU', 'Data', 'Tipo', 'Esito', 'Voto', 'Prova in itinere', 'Note']];
  const names = new Map(repo.courses({ includeArchived: true, includeHidden: true }).map((c) => [c.id, c]));
  for (const a of repo.attempts()) {
    const c = names.get(a.courseId);
    rows.push([c?.name ?? '', c?.cfu ?? '', a.date ?? '', a.component, a.outcome, a.outcome === 'passed' || a.outcome === 'rejected' || a.outcome === 'failed' ? formatGrade(a) : '', a.isMidterm ? 'sì' : 'no', a.note]);
  }
  void librettoEntries;
  return toCsv(rows);
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (dt: string) => `${dt.slice(0, 10).replace(/-/g, '')}T${dt.slice(11, 16).replace(':', '')}00`;
const fold = (line: string): string => {
  if (line.length <= 73) return line;
  const out: string[] = [];
  for (let i = 0; i < line.length; i += 73) out.push((i ? ' ' : '') + line.slice(i, i + 73));
  return out.join('\r\n');
};

/** iCalendar export (floating local times, like the app's own model). A file export, not the Apple Calendar sync. */
export function calendarIcs(repo: Repo, opts: { from: string; to: string; now?: Date }): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PRCD//IT', 'CALSCALE:GREGORIAN'];
  const created = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const courses = new Map(repo.courses({ includeArchived: true, includeHidden: true }).map((c) => [c.id, c]));
  const add = (uid: string, summary: string, start: string, end: string, allDay: boolean, description = '') => {
    lines.push('BEGIN:VEVENT', `UID:${uid}@prcd.local`, `DTSTAMP:${created}`);
    if (allDay) lines.push(`DTSTART;VALUE=DATE:${start.slice(0, 10).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(end.slice(0, 10), 1).replace(/-/g, '')}`);
    else lines.push(`DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`);
    lines.push(fold(`SUMMARY:${esc(summary)}`));
    if (description) lines.push(fold(`DESCRIPTION:${esc(description)}`));
    lines.push('END:VEVENT');
  };
  for (const l of repo.lessonsInRange(opts.from, opts.to)) {
    if (l.cancelled) continue;
    add(`lesson-${l.id}`, courses.get(l.courseId)?.name ?? 'Lezione', `${l.date}T${l.startTime}`, `${l.date}T${l.endTime}`, false, l.topic);
  }
  const ex = repo.eventExceptions();
  for (const e of repo.eventsMaybeIn(opts.from, opts.to)) {
    for (const o of expandEvent(e, ex, opts.from, opts.to)) {
      const s = splitLocalDateTime(o.start);
      add(`event-${e.id}-${o.originalDate}`, o.title, o.start, o.end, e.allDay, e.description);
      void s;
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
